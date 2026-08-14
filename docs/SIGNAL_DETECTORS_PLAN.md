# FM 360 Console — rebuild the three signal detectors on real data

## Context

The three signal tabs (`quoting`, `invoicing`, `sla`) currently do almost no real detection. `quoting` and `invoicing` are pass-throughs of demo rows from `console_jobs` with **zero detection logic**, and `sla` groups open service requests by tenant against a **4h target I invented**.

That was based on a wrong conclusion from the first discovery pass. A second, deeper pass proved the data **does** exist:

| Thing | Earlier conclusion | Reality |
|---|---|---|
| Rate card | "does not exist" | **Exists** — `custom_ratecard`, display name "Site Preferred Supplier Agreement", 24 rows |
| Invoices | "no invoice module" | **Exists** — `facilio-cmms.list-invoices`, 55 records with real `lineItems` |
| SLA targets | "no SLA data" | **Real policy config exists** (id `3381348`) with per-priority durations |
| FSR | "no source" | Field exists (`service_report_custom_polineinvoices`), **0 records today** |

Goal: replace all three with detectors that read real records, compute the comparison in code, and use an LLM only where genuine judgement is required.

---

## Signal 1 — `quoting`: quote line items vs contracted rate card

**Data confirmed.** One fully-priced rate card (`4833958`, vendor `110897`, site `2316795`) and three quotes built as fixtures for exactly this test: `TEST-ABQ Compliant Quote` (unitPrice 80 ≤ 100 ✓), `TEST-ABQ Violating Quote` and `…Quote 2` (250 > 100 ✗).

**Pipeline:**

1. Read rate cards — `facilio-cmms.list-custom-module-records`, `custom_module: "custom_ratecard"`.
   **`select` must be explicit** or every custom field is dropped from the response:
   `normal_hours_monday___friday__per_hour__custom_ratecard` (note three underscores between monday/friday, two trailing), `after_hours__per_hour__custom_ratecard`, `saturday__per_hour__custom_ratecard`, `sunday__per_hour__custom_ratecard`, `call_out_fee_custom_ratecard`, `vendor_custom_ratecard`, `contract_custom_ratecard`, `siteId`, `moduleState`.
   `filters` **is** honoured on this action (unlike purchase orders).
2. Index rate cards by composite key `vendor_custom_ratecard.id + ":" + siteId`. **There is no foreign key** from quote to rate card — this composite is the only join.
3. Validate the contract — follow `contract_custom_ratecard.id` → `get-custom-module-record` on `custom_contracts`; require `moduleState` = `active` and today inside `contract_start_date_custom_contracts` … `contract_end_date_custom_contracts`. Skip and note if expired.
4. Enumerate quotes — `facilio-cmms.list-quotes` (does **not** return line items), then `facilio-cmms.get-quote` per id. Line items arrive nested at `data.lineItems` with shape `{id, type, description, quantity, unitPrice, cost, taxAmount}`.
5. **Classify each line's rate band** — the only genuinely ambiguous step. Send batched lines to a new no-tool agent `fm360-ratecard-classifier`, which maps each to `normal_hours | after_hours | saturday | sunday | call_out | not_labour | unknown`. Fall back to keyword matching if the agent call fails, so the detector still runs.
6. **Compare in code** — `unitPrice` vs the chosen band rate. Emit a signal only when `unitPrice > rate`, with `metric_value` = quoted, `baseline_value` = rate, `variance_value`, `variance_pct`, `sample_size` = lines checked, `occurrence_count` = lines over.
7. `data_confidence: "native"` (both sides read from real records), but `ai_note` must state that the band mapping was inferred from line text, not read from a structured field.

**Honest limits to encode:** 23 of 24 rate cards have all rate fields null — skip those, don't treat null as zero. `service_category_custom_ratecard` is populated on 0 of 24 and the `service` module has 0 rows, so per-service pricing is unavailable.

---

## Signal 2 — `invoicing`: two detectors

### 2a. Invoice vs purchase order (works today)

**Data confirmed.** 55 invoices, 43 with `purchaseOrder` populated. Best pair: invoice `98761` (6000) ↔ PO `5476` line `82623` (6000).

1. `facilio-cmms.list-invoices`, `expand: "purchaseOrder,vendor"`, sorted by `sysModifiedTime` desc. **Cap at 25 per run** and record the truncation in `flow_run` — no silent capping.
2. `facilio-cmms.get-invoice` per id → `lineItems`; `cbre-clone.get-purchase-order` (`po_id`) → its `lineItems`.
3. Compare in code: header `totalCost` vs PO `totalCost`, then per line `quantity`, `unitPrice`, `cost`. Match lines via the PO line id embedded in the invoice line `description` (observed: `"… | PO Line 1 (PO line item id 82623)"`), falling back to index order.
4. Emit a signal on any mismatch. `data_confidence: "native"`.
5. The 12 invoices with no PO carry `"No matching PO/SO/UO in org 2931 …"` in their description — skip them with an explicit note rather than reporting a false variance.

### 2b. FSR vs invoice (agent; dormant until a file exists)

FSR lives on `custom_polineinvoices` ("Line Documents" — *"store Invoice files/Service Reports against PO/SO/UO Lines"*), joined by `purchase_order_custom_polineinvoices` + `lineid` / `po_line_number_custom_polineinvoices`. **0 records today**, so this path writes nothing until one appears.

1. `list-custom-module-records` on `custom_polineinvoices` filtered to the PO, `select` including `service_report_custom_polineinvoices`.
2. `facilio-cmms.download-a-file-field` with `{module_name: "custom_polineinvoices", record_id, field_name: "service_report_custom_polineinvoices"}`.
   **Trap:** this returns HTTP 400/404 *inside* `ok:true`, base64-encoded with `content_type: application/json`. Decode and inspect before treating it as a file.
   **Trap:** `is_not_empty` silently no-ops on FILE fields — probe the download, don't filter on emptiness.
3. If `content_type` is text-like → decode base64 to UTF-8 and use directly. If PDF/image → `ocr-space.extract-text-from-image-or-pdf` with `base64_image` (data URI), `file_type`, and `table_mode: true`.
4. Send FSR text + the invoice's line items to a new no-tool agent `fm360-fsr-auditor`, which returns per-discrepancy findings: hours/parts/amounts billed vs recorded, direction (over/under), and confidence.
5. `data_confidence: "derived"` when OCR was involved (extraction can misread), `"native"` for clean text.

---

## Signal 3 — `sla`: policy-driven breach + vendor repeat history

**Replaces the invented 4h target entirely.** Real config, read at runtime:

- `facilio-process-automation.list-sla-policies` (`moduleName: "workorder"`) → one policy, `3381348` "Work Assignments SLA"
- `facilio-process-automation.get-sla-policy` → commitments in seconds by priority: **High (`2732`)** 14400 response / 86400 resolution; **Medium (`2733`)** 172800 / 345600; **Low (`2734`)** 259200 / 864000
- `facilio-process-automation.list-sla-entities` → `2751` Response Due Date (target state `184484` "Work in Progress"), `2752` Resolution Due Date (target state `184494` "Resolved")

**Pipeline:**

1. Load and cache the policy + entities each run — targets come from config, never hardcoded.
2. Read work orders (`facilio-cmms.list-work-orders`, `expand: "vendor,priority"`, paged to 200). Service requests are **excluded**: `list-sla-entities(servicerequest)` returns `{"items":[]}` and service requests have **no vendor field at all**, so "by vendor" is impossible there.
3. Detect breaches two ways, kept separate:
   - **Explicit** — `dueDate` populated and in the past (23 of 282 records).
   - **Computed** — `createdTime + commitment(priority, entity)` already passed with no transition to the target state, cross-checked against `list-a-work-order-status-timer-history`.
4. **Encode the pause rule.** States `Submitted` (`184482`) and `Assigned` (`184483`) both carry `pauseSLA: true`, and all 282 work orders sit in one of them — which is exactly why `responseDueDate` is empty everywhere. A computed breach on a paused record must be labelled **advisory**, not asserted as a contractual breach.
5. Group by `workorder.vendor.id` (populated on 117 of 282; 10 distinct vendors).
6. Per vendor, build the history: `breach_count`, `sample_size`, `distinct_breach_days`, first/last breach date, and a repeat flag requiring breaches on **≥2 distinct days**.
7. Set `insufficient_history: true` when `sample_size < 5` or `distinct_breach_days < 2`, and put the real window in `period_label`.
8. Pass to the existing `fm360-signal-analyst` for severity and wording — it is already instructed to discount small samples and disclose assumed baselines.

**Honest limit to encode:** `dueDate` + `vendor` both populated is **11 records across 4 vendors**, all created within one ~10-minute window, with 0 closed records and no state transition ever recorded. A true rate-over-time is not computable today. Every row must say so; the aggregation is built so it becomes correct as data accumulates.

---

## New agents (both no-tool — data passed inline)

Tool-bound agents time out on this platform and never write; only the no-tool, data-in-prompt pattern is reliable.

| Agent | Job | Output schema |
|---|---|---|
| `fm360-ratecard-classifier` | Map each quote line to a rate band | `{items:[{lineId, band, reasoning, confidence}]}` |
| `fm360-fsr-auditor` | Read FSR text, compare against invoice lines | `{discrepancies:[{kind, invoiceValue, reportValue, direction, note, confidence}], summary, readable}` |

Both created via `facilio-ai-studio.v2-create-agent` with `connections: []`, `modelName: "gpt-5.5"`, batched in small chunks with one retry — the proven pattern from `doSignals`.

## New connection actions on `fm-360-console`

Register the three signal handlers individually so each is testable and callable from the UI:
`run-quoting-signal`, `run-invoicing-signal`, `run-sla-signal`.

## Prerequisite

**Activate the `ocr-space` connection** (`FACILIO_MANAGE_CONNECTIONS`, `action: "add"`) — needs browser authorisation. Note that FSR contents will be sent to that provider. The build proceeds without it; only PDF FSRs are blocked until it's active.

---

## Files

- **`fm360/sweep_jobs.js`** — the only substantive change:
  - replace `slaEvidence()` (currently line ~710) with the policy-driven detector
  - add `quotingEvidence()` and `invoicingEvidence()`
  - add `readFsrText()` (download → type sniff → OCR fallback)
  - keep the existing `askAgentRetry()` / chunking helpers and `upsertSignal()` unchanged
  - delete `seedSignalEvidence()` for `quoting` and `invoicing` once their real detectors land; keep the seed fallback only where a source genuinely has no data
  - keep everything in this one file — `daily` must call these as internal functions, since a function cannot invoke another function and cross-calling via a connection action would exceed the ~10s fetch ceiling
- **No schema change** — `signal` already has `metric_name`, `metric_value`, `baseline_value`, `variance_value`, `variance_pct`, `occurrence_count`, `sample_size`, `period_start/end`, `signal_type`, `severity`, `data_confidence`.

## Runtime budget

Estimated ~5 min inside the 900s job ceiling: jobs sweep ~60s, quoting ~20s, invoicing ~90s (capped at 25 invoices), sla ~40s, prioritize ~70s. Each individual `fetch` must stay under ~10s, so agent payloads stay chunked at 2–3 items. If the total approaches the ceiling, split signals into a second job 30 min after the first.

---

## Verification

1. `facilio vibe function run sweep_jobs quoting_signal` → expect **2 signals** (the two 250-vs-100 violating quotes) and the compliant 80 quote **absent**. This is the sharpest test: a known-good and known-bad fixture pair.
2. `facilio vibe function run sweep_jobs invoicing_signal` → expect real invoice/PO comparisons across the 43 linked pairs; verify invoice `98761` vs PO `5476` reports no variance (both 6000), and that the 12 unlinked invoices are skipped with a note.
3. `facilio vibe function run sweep_jobs sla_signal` → expect per-vendor rows for the 4 vendors with breaches, each carrying `insufficient_history: true` and the real one-day window.
4. `facilio vibe function run console_store list_signals` → confirm `metric_value`/`baseline_value`/`variance_value` are populated numerically, `data_confidence` is honest, and no row claims a comparison it did not make.
5. `facilio vibe function run console_store stats` → check `flow_run` rows record read/written counts and any truncation note per signal.
6. FSR path: with 0 records it must write nothing and say so. To prove it end to end, upload a text service report to a `custom_polineinvoices` record and re-run — expect `fm360-fsr-auditor` discrepancies.
7. Confirm the daily job still completes: inspect `flow_run` after `fm360-daily-console` fires (the CLI will 504 on the long handler, but the run completes server-side — verify in the table, not the CLI response).
