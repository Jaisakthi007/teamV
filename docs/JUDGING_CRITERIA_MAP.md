# FM 360 Console — How the Build Meets the Judging Criteria

Every claim below is grounded in the code on this branch and in behaviour verified against
the live org (2931) during development. Where a criterion is only partially met, that is
stated rather than papered over.

**Production:** https://fm-360-console.vibe.facilio.com/ — ACTIVE, PUBLISHED, deployment #44.
**Live data at the time of writing:** 141 open tenant service requests, 45 permits awaiting
FM approval, 280 stalled work orders, 2 SLA signals, 2 abnormal-quoting signals.

---

## Category 1 — Domain Excellence

### 1.1 Depth of problem understanding, edge cases included
- The service-request queue is ONE queue with per-record state, not two: an unacknowledged
  request offers **Acknowledge & proceed** (one conversation that acknowledges and then
  raises the work order), an acknowledged one offers **Create Work Order** — unless the
  tenant chose the in-house quote path, in which case the button is **Create Tenant Quote**,
  because a chargeable job needs the quote before the work order (`feed.js` tsr loader,
  `App.jsx importantActions`).
- Permit rejection is treated as the safety decision it is: the reason is mandatory,
  validated for substance (min length/word count) before the round trip, and the dialog says
  plainly that it is recorded permanently and is the only thing the contractor is told
  (`App.jsx submitReject`, reject dialog).
- Edge cases handled from real records, not invented ones: state labels that differ from
  stored values ("Submitted" is stored as `Open`, "Acknowledged" as `tsrvalidated`), records
  with no site/tenant/vendor (rendered "—"), 70-character tenant names and 116-character
  subjects (truncate with full-value tooltips), records with no deep-link URL (the View
  button is simply not rendered).

### 1.2 Gap awareness
- SLA targets are **read from the org's configured SLA policy** (policy 3381348, per-priority
  response/resolution durations) rather than re-invented — the app targets only the manual
  work the platform leaves over: cross-queue triage, quote-vs-rate-card comparison,
  invoice-vs-order variance, and per-vendor breach aggregation (`sweep_jobs.js`).
- Where the platform already models something (permits state machine, quotes, POs,
  work-order stateflow), the app drives it through the platform's own actions instead of
  duplicating records.

### 1.3 Right stakeholders, right moment
- Built for the FM/CMMS operator's triage moment: the landing view is the ranked "what
  deserves my next hour" across every queue, and each item carries the reasons it ranked
  (`triage.js` — every score point emits its own reason chip).
- Contractor unblocking (permit decisions) and tenant-recharge decisions are first-class
  one-click flows; vendor-behaviour signals (SLA breaches, abnormal quoting) are explicitly
  labelled as QBR material to note, not approve.

### 1.4 Data realism
- The rate card lives where it really lives in this org: a custom module
  (`custom_ratecard`, display name "Site Preferred Supplier Agreement") joined to quotes on
  **vendor + site because no foreign key exists** — stated on every signal produced from it.
- A real platform defect was discovered and worked around rather than masked: the
  purchase-order list action accepts a `filters` string, reports success, and ignores it —
  PO filtering is done in code (`sweep_jobs.js`, comment "PO_FILTER_IS_BROKEN").
- Every signal row carries `data_confidence` (`native` / `derived` / `seeded`) so a value
  read from a record is never conflated with one computed against an assumed baseline, and
  demo rows can never pass as findings. The FSR-vs-invoice audit path exists but the org has
  no service-report files yet — it reports that honestly instead of inventing content.

### 1.5 Grounded ROI
- The app surfaces the money on the records themselves — order vs invoice variance amounts
  on referral cards, quoted-vs-contracted totals and percentages on quoting signals
  ("Quoted 500 vs rate card 200", "+150%"), tenant-rechargeable flags on requests.
- **Honest gap:** there is no aggregate ROI statistic displayed (e.g. "$ recoverable via
  tenant quotes"). The per-record economics are real; a rolled-up number was not built.

---

## Category 2 — Engineering Excellence

### 2.1 Real data
- Built and demonstrated entirely on org 2931's live records — no mocked data anywhere in
  the shipped app (local dev stubs exist only in throwaway harnesses, never committed).
- Failures are shown, not masked: a failed queue read renders an inline error with the real
  reason and a Retry; a failed ranking keeps the last good ranking and says so; a dead
  job_state read fails the bucket read instead of silently resurrecting actioned cards
  (`hiddenSet` deliberately has no fallback).
- Two real-data bugs were found by verification and fixed rather than hidden: a response
  envelope mis-read produced a phantom "line differs" on every invoice (12 false signals
  written, then retired); permit decisions silently never reached Facilio (fixed with
  before/after record verification).

### 2.2 Efficient calls and queries
- Every list call carries a `page_size`; pagination loops are bounded (`maxPages` caps);
  queue reads are server-side paginated (10/page with Prev/Next).
- One `feed.counts` call covers every queue badge; the browser never makes per-row calls.
  The 30s poll runs only while the tab is visible and reloads a queue page only when its
  count actually changed.
- Detail reads are capped and the cap is logged, never silent (invoice line comparison:
  `invoice_cap`, truncation recorded in the run log). SQL in functions is parameterized
  (`$1, $2`) with explicit limits.
- LLM calls are the exception, not the loop: finding classification runs once per finding
  and is cached for the session; agent payloads are chunked (2–3 items) with one retry.

### 2.3 Security and data scoping
- Secrets never leave the server: DB credentials and connection tokens are read inside
  functions from platform-injected `process.env` / `process.system`; the built browser
  bundle was grep-audited for tokens/keys — none present.
- The app is auth-gated (`vibe.isAuthenticated`; the production URL redirects anonymous
  requests to Facilio identity login). All data access rides the org-scoped connections
  gateway and the app's own isolated database schema.

### 2.4 Failure behaviour
- Loading, empty and error states exist on every view: boot captions, shimmer skeletons in
  the rail, the glance strip, the card list and the drill modal — all shaped like the final
  layout so nothing pops in; a designed "all caught up" empty state that routes onward; a
  context-panel empty state; inline errors with Retry for queue loads, ranking, and the
  paused live feed.
- Writes are guarded against duplicates two ways, chosen per risk:
  - Comment/quote/PO writes check `job_state` first and return `idempotent: true` on a
    retry. **Verified live:** two `act` calls on SR 210641 produced exactly one comment.
  - Permit decisions verify against the **record** (before/after state re-read) — a
    deliberate choice documented in code, because job_state rows from the era when permit
    writes silently failed would wrongly block a real decision.
- Every write button disables in flight. Optimistic removal is used only where the write
  cannot meaningfully fail; permits hold the card until the record is confirmed moved.

### 2.5 Platform-first, right tooling
- Facilio primitives throughout: Vibe app + functions + scheduled job + realtime events;
  Connections (facilio-cmms, cbre-clone, facilio-process-automation, facilio-ai-studio);
  Agent Studio agents driven through an async bridge with runId-matched replies over a
  websocket topic.
- The LLM is used only where judgement is genuinely required: finding responsibility
  (Tenant/FM), signal severity interpretation, quote-line rate-band classification, and the
  Service Request Operations conversation. Arithmetic, joins, filtering and state checks are
  plain code in functions.

---

## Category 3 — User Experience

### 3.1 Clarity and first use
- The app lands on "Important now" — the ranked cross-queue list — with a one-time,
  dismissible three-line intro mapping the three panes (persisted in localStorage; verified
  it shows fresh and never returns after dismissal).
- You always know where you are: the active queue carries an accent bar and tint in the
  rail, the queue header names it, the context panel repeats it as a fact, and a back
  control returns to the landing view.

### 3.2 Effortless core flow
- Every action is one click, in place: full verb buttons inline on every card **and** on
  every ranked row (Acknowledge & proceed / Create Work Order / Create Tenant Quote /
  Approve / Reject) — acting never requires opening the queue or the panel first.
- Forms are minimal and forgiving: the tenant quote asks one number (Enter submits,
  invalid input is caught with a message); the reject dialog validates the reason locally
  before any round trip.
- Lists read easily: one consistent card anatomy, tabular numerals so live-refreshing
  counts never jitter, `+N` chip collapsing, keyboard j/k/Enter/Esc.

### 3.3 Visual craft and consistency
- One severity scale — critical / warning / info / success — is the only colour language:
  every dot, chip, accent bar, age pill and glance cell resolves through a single mapping
  (`sevOf`, `importantSev`); all tokens are declared once in `App.css`.
- Brand purple is reserved for primary actions, AI content and active state. Icons are
  inline SVG on `currentColor`. Motion does work, not decoration: 180ms fade-up when
  content replaces shimmer, 150–200ms eases on hover/selection — all disabled under
  `prefers-reduced-motion`, including the shimmer itself.

### 3.4 Feedback and responsiveness
- Everything clickable has hover, active and focus-visible states; every write confirms
  with a toast plus an inline result (busy → success/failure) in the panel.
- The app feels instant where honesty allows: optimistic removal with server
  reconciliation for comments/quotes/PO updates; deliberately **non**-optimistic for
  permits, where the card holds until the handler confirms the record moved and the toast
  reports the new state.
- Agent replies stream back over the platform websocket with rotating, truthful progress
  captions (a real progress note from the bridge always beats the rotating line).

### 3.5 Resilience, accessibility and copy
- Contrast measured, not assumed: the muted text token was darkened until it clears WCAG
  AA on every surface it sits on (5.15:1 measured on white); all severity pill pairs pass.
- `aria-current` for selection (replacing an invalid `aria-selected` on buttons), toast as
  `role="status"`, keyboard navigation disabled behind open modals, 44px tap targets and no
  horizontal scroll at 375px (measured `scrollWidth == innerWidth`).
- Copy says what will happen: "Create Tenant Quote", "Acknowledge & proceed", "Reject
  permit" — never "Submit". Errors state the real reason and offer Retry; the composer
  says plainly when the operations team cannot act on a record type instead of a dead Send.

---

## Category 4 — Product Readiness

### 4.1 Scope discipline
- The app is a triage-and-act console and nothing else. Deliberately not built, with
  reasons: dashboard charts (it is an action console), a client-side sort control (would
  mislead against server-side pagination), dark mode, and an aggregate ROI widget.

### 4.2 Completeness
- Every visible flow finishes end-to-end on real records: acknowledge → work order through
  the Service Request Operations agent conversation; tenant quote creation (returns the
  real quote id); permit approve/reject (moves the real permit, verified by re-read);
  PO line reconciliation (updates the real purchase order); signal dismiss (flips the
  stored signal row and hides the card everywhere).
- Nothing in the product is mocked. Paths that are data-dormant say so: the FSR-vs-invoice
  audit is wired but reports honestly that no service-report file exists in the org yet.

### 4.3 Architecture soundness
- Clear separation: presentation (three-pane React app) / reads (`feed`, `triage`) /
  writes (`feed` handlers with idempotency and verification) / background detection
  (`sweep_jobs` + daily cron writing `job_to_be_done`, `signal`, `flow_run` tables) /
  agent orchestration (`agent_bridge`, async with runId-matched realtime replies).
- Built to outlast the demo: stable `external_id` convention (`bucket:module:id`) so
  re-runs update rather than duplicate; per-run observability rows (`flow_run` records
  read/written/error per bucket); watermark-based sync; bounded reads and chunked LLM
  calls throughout.

### 4.4 Production readiness
- Deployed and published: production URL live behind Facilio auth, app marked ACTIVE +
  PUBLISHED, deployment #44; all six platform functions rebuilt from the same commit the
  repo carries (verified by diffing live function source against the repo).
- Scheduled detection runs daily (06:00 org time). **Honest note:** the most recent
  automated fire failed with a platform 404 because it hit the window while the function
  was mid-redeploy; the rebuilt function has been verified callable since, and the next
  fire will confirm it end-to-end.

### 4.5 Onboarding and user adoption
- Sensible default: the app opens on the ranked landing view — the next hour's work —
  with no configuration.
- A one-time guided intro (dismissed once, never again) explains the three panes; ranked
  rows explain themselves through reason chips; AI summaries carry the "why this is here";
  FM-specific mechanics are explained where they appear (e.g. the reject dialog states the
  consequence of the reason text; the composer states what the operations team can act on).
- No walkthrough is needed to act: the first screen already carries full-verb buttons on
  every row.
