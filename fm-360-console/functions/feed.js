import StudioFunctions, { StudioDatabase } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "feed", version: "1.0.0" });

// ---- helpers ---------------------------------------------------------------
function cfg(key) {
  try {
    if (typeof process !== "undefined") {
      if (process.env && process.env[key] != null) return process.env[key];
      if (process.system && process.system[key] != null) return process.system[key];
    }
  } catch (e) {}
  return undefined;
}
function db() {
  return new StudioDatabase({
    userName: cfg("DB_USER") || cfg("DB_USERNAME"),
    password: cfg("DB_PASSWORD"),
    schema: cfg("SCHEMA"),
  });
}
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function nameOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.name || v.subject || v.displayName || v.primaryValue || "";
  return String(v);
}
function envelope(j) {
  // returns { records, count } from whatever shape the connections endpoint gives
  if (!j) return { records: [], count: null };
  const out = { records: [], count: null };
  if (typeof j.count === "number") out.count = j.count;
  const cands = [j.data, j.output && j.output.data, j.result && j.result.data, j.response && j.response.data, j.output, j.result];
  for (const c of cands) { if (Array.isArray(c)) { out.records = c; break; } }
  if (!out.records.length && Array.isArray(j)) out.records = j;
  // nested count locations
  if (out.count == null) {
    const co = [j.count, j.output && j.output.count, j.pagination && j.pagination.totalCount, j.data && j.data.count];
    for (const c of co) if (typeof c === "number") { out.count = c; break; }
  }
  return out;
}
async function callAction(connectionSlug, actionSlug, input) {
  const base = cfg("CONNECTIONS_URL");
  if (!base) throw new Error("CONNECTIONS_URL not available to this run");
  const url = `${base}/api/v1/connections/${connectionSlug}/actions/${actionSlug}/execute`;
  const token = cfg("CONNECTIONS_TOKEN");
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers["X-Service-Token"] = token;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ input }) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${connectionSlug}.${actionSlug} failed: ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ---- record deep links -----------------------------------------------------
// Facilio's web app registers ONE generic deep-link resolver route:
//     /:app/goto/summary/:moduleName/:id      (component RedirctToSummary)
// It calls findRouteForModule(moduleName, OVERVIEW) against the route table,
// fetches the module's first view, and redirects to that record's overview
// page; ANY failure falls through to `pagenotfound`. Verified in the live
// production bundle (static.facilio.com/v10601/js/app.js + chunk 53245.js) and
// matched by the backend's own URL builders — V3RecordAPI.getRecordUrl() and
// SendTechnicianNotificationCommand.buildRecordUrl() both emit
// <base>/<appLinkName>/goto/summary/<moduleName>/<recordId> for an arbitrary
// module name.
//
// Two things the resolver is strict about:
//  1. moduleName must be the module's CANONICAL API name, matched exactly.
//     The route table registers `serviceRequest` — lowercase `servicerequest`
//     is not in it and lands on pagenotfound.
//  2. the module must actually have an OVERVIEW route. Modules with no summary
//     page (and modules absent from the org, e.g. `finding`) can never be
//     linked, so we return "" and the caller omits the View button entirely.
const APP_BASE_URL = "https://app.facilio.com/maintenance";

// Canonical module name (as registered with pageType OVERVIEW in the web app's
// route table) keyed by the loose names used across this codebase.
const LINKABLE_MODULES = {
  servicerequest: "serviceRequest",
  serviceRequest: "serviceRequest",
  workorder: "workorder",
  workpermit: "workpermit",
  purchaseorder: "purchaseorder",
  quote: "quote",
  // `finding` is deliberately absent: the module does not exist in this org and
  // has no OVERVIEW route, so no summary URL can be built for it.
};

// Build the summary URL for a record, or "" when no record page can exist.
function recordUrl(module, id) {
  const canonical = LINKABLE_MODULES[String(module || "")];
  if (!canonical) return "";
  if (id == null || id === "" || String(id) === "0") return "";
  return APP_BASE_URL + "/goto/summary/" + canonical + "/" + id;
}

// Append the View action only when there is a real page to open — a dead
// "View" button is worse than no button.
const VIEW_ACTION = { label: "View", kind: "ghost", act: "open" };
function withView(actions, url) {
  return url ? actions.concat([VIEW_ACTION]) : actions;
}

const BUCKET_LABELS = {
  // One queue, both states. Named for the RECORD rather than for a step in the
  // flow ("...to acknowledge" would be a lie about half the rows in it now).
  tsr: "Tenant service requests", unblock: "Unblock vendors",
  referral: "Orders awaiting referral", completion: "Orders awaiting completion",
  findings: "Open findings", stalled: "Stalled work orders", quotes: "Vendor comments",
  spot: "Spot checks", tenant: "Tenant dissatisfaction", sla: "SLA breaches by vendor",
  quoting: "Abnormal quoting", invoicing: "Invoice vs field report",
};

// ============================================================================
// Referred Orders — VERIFIED against org 2931 (Team V, US) on 2026-08-14.
//
// DIRECTION OF THE UPDATE: the PO line is corrected to the invoice cost
// (PO line <- invoice). This is not an interpretation of the prose — it is what
// the org actually supports. The ONLY write action that touches a line price is
// `cbre-clone.update-purchase-order`, whose own contract reads "Correct one OR
// MORE purchase order line items' amounts so they match the related MRI
// invoice ... the corrected amount taken from the invoice." There is no action
// anywhere in this org that updates an invoice line. The schema agrees: the
// split-line module below carries `unit_cost` (the PO's own) next to
// `mri_unit_cost` (the value that arrives from MRI/invoicing) — the MRI number
// is the source, the PO number is the target.
//
// PO-level "Referred" — org 2931 has TWO independent notions, and only the
// second one is populated:
//   1. moduleState. The purchaseorder state flow DOES define a `referred` state
//      (id 153879, status string "referred", displayName "Referred"), but 0 of
//      the org's 1247 POs sit in it — every single one is `draft`.
//   2. po_mri_status_purchaseorder ("MRI Status", ENUM). Its "Referred" option
//      (enum id 6) is set on 12 POs. This is the real signal today.
// We accept EITHER so the bucket keeps working if the state flow starts being
// driven. NOTE list-purchase-orders returns moduleState as the LOWERCASE status
// string ("draft"), never the displayName — the previous `=== "Referred"`
// comparison could never have matched, so the comparison here is lowercased.
const REFERRED_PO_STATE = "referred";              // moduleState.status (lowercase); state id 153879
const PO_MRI_STATUS_FIELD = "po_mri_status_purchaseorder";
const REFERRED_PO_MRI_STATUS = "Referred";         // po_mri_status_purchaseorder enum label (id 6)
// list-purchase-orders drops custom fields from its default projection, so every
// custom field we rely on must be named in `select`; `expand` is only honoured
// for lookups that also appear in `select` (verified — omitting `vendor` from
// select silently drops the expansion).
const PO_SELECT = "id,name,description,moduleState,localId,vendor,subTotal,totalCost," +
  PO_MRI_STATUS_FIELD + ",sysCreatedTime,sysModifiedTime";

// Per-line "Facilio status = Referred". The built-in `purchaseorderlineitems`
// module has NO status field whatsoever — its 17 fields are all built-in (cost,
// description, inventoryType, itemType, purchaseOrder, quantity,
// quantityReceived, quantityStocked, referenceId, service, sysModifiedBy,
// sysModifiedTime, tax, taxAmount, toolType, unitOfMeasure, unitPrice). The
// line-level status the requirement describes lives on the CUSTOM module
// `custom_polineitemssplit` ("Line Items Building Split"), field
// `facilio_status_custom_polineitemssplit` — display name literally "Facilio
// Status" — whose "Referred" option is enum id 4. That module also carries BOTH
// numbers we need side by side, so when split rows exist no invoice cross-join
// is needed at all. It currently holds 0 records, so the built-in lineItems
// path below is what actually runs today.
const SPLIT_MODULE = "custom_polineitemssplit";
const SPLIT_STATUS_FIELD = "facilio_status_custom_polineitemssplit";
const SPLIT_REFERRED = "Referred";                              // enum id 4
const SPLIT_PO_FIELD = "purchase_order_custom_polineitemssplit"; // LOOKUP -> purchaseorder
const SPLIT_UNIT_COST = "unit_cost_custom_polineitemssplit";     // the PO line's own unit cost
const SPLIT_MRI_UNIT_COST = "mri_unit_cost_custom_polineitemssplit"; // the invoice/MRI unit cost
const SPLIT_LINE_NO = "linenumber";
const SPLIT_SELECT = "id,name," + SPLIT_LINE_NO + "," + SPLIT_STATUS_FIELD + "," + SPLIT_PO_FIELD +
  "," + SPLIT_UNIT_COST + "," + SPLIT_MRI_UNIT_COST + ",quantity_custom_polineitemssplit," +
  "mri_line_status_custom_polineitemssplit,po_line_number_custom_polineitemssplit";

// The PO line's number. `purchaseorderlineitems` has no line-number field at
// all; `referenceId` (STRING) is the only line-level identifier, and it is null
// on every record sampled. So this degrades to the 1-based position, which is
// exactly what the CBRE invoice descriptions call "PO Line N".
const PO_LINE_NUMBER_FIELDS = ["referenceId"];

// The invoice line's field that carries the PO line number. THE CUSTOM FIELD THE
// REQUIREMENT ASSUMES DOES NOT EXIST: `invoicelineitems` has 19 fields and every
// one of them is built-in (isCustom=false) — contractService, cost,
// costWithMarkup, description, invoice, itemType, labour, markup, quantity,
// rawData, referenceId, service, tax, taxAmount, toolType, type, unitOfMeasure,
// unitPrice, unitPriceWithMarkup. The only shared line-level key is the built-in
// STRING `referenceId`, which exists on BOTH invoicelineitems and
// purchaseorderlineitems and is the correct join key — but it is null on every
// invoice line in the org today. `invoice.ponumber` (custom STRING "PO Number")
// exists at the invoice HEADER, not the line, and is null on all 55 invoices.
// What IS populated at line level is a text encoding the CBRE import stamps into
// the invoice line description, e.g.
//     "CBRE MRI PO8001531_220501 - order total | PO Line 1 (PO line item id 81581)"
// so referenceId is tier 1 and that description parse is tier 2. Nothing else is
// used: an unmatched line stays unmatched rather than being guessed by position.
const INVOICE_LINE_PO_LINE_FIELD = "referenceId";
const INVOICE_SELECT = "id,localId,invoiceNumber,subject,purchaseOrder,ponumber,mriinvoicekey,totalCost,invoiceStatus";
// ============================================================================

// ============================================================================
// Open Findings assumptions — VERIFY/FILL once finding data exists (org 2931 has 0).
// list-findings maps to moduleName "finding". Field names are best-guesses.
const FINDING_CREATED_STATE = "created";           // moduleState for Open Findings
function findingField(r, kind) {
  const map = {
    subject: ["subject", "name", "title"],
    source: ["source", "findingSource", "raisedThrough", "raisedFrom", "findingType", "category"],
    location: ["location", "affectedLocation", "space", "siteId"],
    priority: ["priority", "severity"],
    description: ["description", "details", "observation"],
  };
  for (const f of (map[kind] || [])) if (r[f] != null && r[f] !== "") return nameOf(r[f]);
  return "";
}
function findingTone(priority) {
  const p = String(priority || "").toLowerCase();
  if (p.indexOf("critical") >= 0 || p.indexOf("high") >= 0) return "#B61919";
  if (p.indexOf("medium") >= 0 || p.indexOf("moderate") >= 0) return "#FFD405";
  if (p.indexOf("low") >= 0) return "#0059D6";
  return "";
}
// ============================================================================

// ============================================================================
// STALLED WORK ORDERS — the design's subtitle defines it: "No PI or order
// raised". An open work order with no Procurement Initiation and no Purchase
// Order behind it is a job nobody is buying anything for.
//
// HOW THE LINK IS ACTUALLY MODELLED IN THIS ORG (verified 2026-08-14, org 2931)
//   • PI → WO   custom_procurementinitiation.workorder_custom_procurementinitiation
//               LOOKUP → workorder.  POPULATED: 21 PI records, 15 of which carry
//               a work-order id (6 distinct work orders).  This is the only
//               direction that actually holds data, so "has a PI?" must be
//               answered by scanning procurement initiations and inverting the
//               reference — it cannot be read off the work order.
//   • WO → PI   workorder.associated_procurement_activity_workorder exists in the
//               schema but is EMPTY on all 283 work orders (confirmed both by
//               projection and by the server-side filter
//               `associated_procurement_activity_workorder(is_empty)=true`,
//               which returns the full 283).
//   • PO → WO   purchaseorder.associated_work_order_purchaseorder exists in the
//               schema but is EMPTY on all 1,247 purchase orders, as is
//               associated_procurement_activity_purchaseorder. The PO set in
//               this org is an orphaned import: 368 of them name a work order in
//               their title ("Purchase Order for WO#14668") referencing numbers
//               8832–41574, none of which is a work-order id or serialNumber
//               that exists here. So NO purchase order is attached to any work
//               order by any route today.
//   • WO → PO   workorder.purchase_order_workorder / po_id_workorder /
//               restrict_work_order_cancellation_workorder ("PO Created?") are
//               likewise empty on all 283.
//
// CONSEQUENCE, STATED PLAINLY: the "no order raised" half of this predicate
// excludes NOTHING today — every work order in the org trivially satisfies it.
// Only the PI half discriminates, and it removes just 6 records. The bucket is
// therefore large (277 of 283) rather than empty. The scans below are still
// written the correct way round so the bucket tightens by itself the moment
// real PO↔WO links exist; nothing here needs changing when they do.
//
// Work orders carry no `localId` (that field does not exist on the module) —
// the human-facing number is `serialNumber`, and the modified-time field is
// `modifiedTime`, not `sysModifiedTime`.
//
// State ids: the connections filter validates moduleState against the status
// STRING and rejects the numeric id outright ("Invalid value '184483' for field
// 'moduleState'"), so the criteria below must be status names. Ids are recorded
// in the comment for traceability.
//
// Open = live jobs only. Facilio reports Resolved/Closed/Cancelled as type OPEN
// on this module, so the terminal states have to be excluded by name rather than
// by type; PRE_OPEN states (Requested/Rejected/Scheduled/…) are excluded too, as
// no procurement is expected before a work order is actually opened.
const WO_OPEN_STATES = [
  "pendingsocreation",    // 153893 Pending SO Activation
  "inspectioncompleted",  // 153898 Inspection Completed
  "Submitted",            // 184482 Created
  "Assigned",             // 184483
  "Work in Progress",     // 184484
  "Incomplete",           // 184485
  "Yet to Start",         // 184491
  "In Progress",          // 184492
  "On Hold",              // 184493 Work On Hold
  "Re-Opened",            // 184498
];
// Excluded terminal: Resolved 184494, Closed 184495, Cancelled 184496, Skipped 184497.
// Excluded PRE_OPEN: preopen 184486, Requested 184487, Rejected 184488,
//                    Processing 184489, Scheduled 184490.

// A cancelled or rejected procurement is not a procurement — the job is stuck
// again — so those PIs do not clear a work order out of this bucket.
const PI_DEAD_STATES = ["procurementcancelled", "rejected", "close"];

// Purchase orders can only be scanned by paging (list-purchase-orders IGNORES
// `filters`: moduleState=poapproved still returns the full 1,247), so the sweep
// is bounded. 7 pages covers the current 1,247 with room to grow.
const STALLED_PO_SCAN_PAGES = 8;

/* ---- PURE-STALLED-START — extracted verbatim and exercised by the offline
   verifier against real Facilio payloads; keep this block free of I/O. ---- */
function stalledStateIsOpen(wo) {
  return WO_OPEN_STATES.indexOf(String(nameOf(wo.moduleState) || wo.moduleState || "")) >= 0;
}
function lookupId(v) {
  if (v == null) return null;
  const id = typeof v === "object" ? v.id : v;
  const n = Number(id);
  return n ? n : null;
}
// Work orders that a live procurement initiation points at.
function procuredWorkOrderIds(piRecords) {
  const ids = new Set();
  for (const p of piRecords || []) {
    if (PI_DEAD_STATES.indexOf(String(nameOf(p.moduleState) || p.moduleState || "")) >= 0) continue;
    const id = lookupId(p.workorder_custom_procurementinitiation);
    if (id) ids.add(id);
  }
  return ids;
}
// Work orders that a purchase order points at.
function orderedWorkOrderIds(poRecords) {
  const ids = new Set();
  for (const p of poRecords || []) {
    const id = lookupId(p.associated_work_order_purchaseorder);
    if (id) ids.add(id);
  }
  return ids;
}
// The bucket's qualifying test. `piWoIds` / `poWoIds` are the Sets above.
function workOrderIsStalled(wo, piWoIds, poWoIds) {
  if (!stalledStateIsOpen(wo)) return false;
  const id = Number(wo.id);
  if (piWoIds && piWoIds.has(id)) return false;                        // procurement initiated
  if (poWoIds && poWoIds.has(id)) return false;                        // a PO points here
  if (lookupId(wo.associated_procurement_activity_workorder)) return false;
  if (lookupId(wo.purchase_order_workorder)) return false;
  if (wo.po_id_workorder) return false;
  if (wo.restrict_work_order_cancellation_workorder === true) return false; // "PO Created?"
  return true;
}
/* ---- PURE-STALLED-END ---- */

// ============================================================================
// SPOT CHECKS
// A work assignment the vendor is actively working, where that SAME vendor has
// had OTHER work reopened — grounds for the FM to spot-check the job in flight.
//
// Reference implementation is the work order module's "Initiate Spot Check"
// custom button (id 3380565, buttonType `customButton`, active, restricted to
// 7 FM roles), whose live criteria read verbatim:
//     ( work_assignment_type_workorder = 2                       // Work Execution
//       AND moduleState NOT IN (184495, 153893, 184496)          // Closed / Pending SO Activation / Cancelled
//       AND inspection_workorder IS NULL                         // no spot check triggered yet
//       AND type != 517 )
// It fires workflow action 5889906 ("Initiate Spot Check_WORKFLOW_ACTION_Action").
// NOTE the button gates on `work_assignment_type_workorder = Work Execution`,
// NOT on `work_classification_workorder`; the criteria below follow the stated
// requirement (Work Classification = Work Assignment), which in this org selects
// the same 17 records — every Work Assignment is also a Work Execution.
//
// Field names verified against workorder metadata:
//   work_classification_workorder   ENUM  "Work Order" | "Work Assignment"
//   reason_for_reopening_workorder  LARGE_TEXT (max 2000) — the reopen reason
//   vendor                          LOOKUP -> vendors
//   inspection_workorder            LOOKUP -> inspectionResponse (set once checked)
//   spot_check_initiated__workorder BOOLEAN
//
// State ids for reference: Work in Progress 184484, In Progress 184492.
// `filters` DOES work on list-work-orders (unlike list-purchase-orders /
// list-quotes), so the classification predicate is pushed server-side — but
// `reason_for_reopening_workorder(is_not_empty)` makes the backend throw
// ("Unknown column 'WorkOrders.null' in 'where clause'"), and the vendor test is
// a cross-record join anyway, so both are computed here over one fetched page.
const SPOT_WORK_CLASSIFICATION = "Work Assignment";
const SPOT_INPROGRESS_STATES = ["Work in Progress", "In Progress"];

/* ---- PURE-SPOT-START — no I/O; exercised by the offline verifier against real
   Facilio payloads. ---- */
function spotIsWorkAssignment(wo) {
  return String(wo.work_classification_workorder || "") === SPOT_WORK_CLASSIFICATION;
}
function spotIsInProgress(wo) {
  return SPOT_INPROGRESS_STATES.indexOf(String(nameOf(wo.moduleState) || wo.moduleState || "")) >= 0;
}
function spotReopenReason(wo) {
  return String(wo.reason_for_reopening_workorder == null ? "" : wo.reason_for_reopening_workorder).trim();
}
// A spot check already exists on this record, so it needs no further action.
function spotAlreadyChecked(wo) {
  return wo.spot_check_initiated__workorder === true || !!lookupId(wo.inspection_workorder);
}
// vendorId -> array of the vendor's work assignments that carry a reopen reason.
// Only work assignments count as evidence, matching the stated criteria.
function spotReopenedByVendor(waRecords) {
  const m = new Map();
  for (const w of waRecords || []) {
    if (!spotIsWorkAssignment(w)) continue;
    if (!spotReopenReason(w)) continue;
    const v = lookupId(w.vendor);
    if (!v) continue;                       // no vendor = no vendor-level evidence
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(w);
  }
  return m;
}
// The bucket's qualifying test. Returns null when the record does not qualify,
// otherwise the record plus the evidence that flagged it — so the card can state
// the real reason and never an invented one.
function spotCheckCandidate(wo, reopenedByVendor) {
  if (!spotIsWorkAssignment(wo)) return null;
  if (!spotIsInProgress(wo)) return null;
  if (spotAlreadyChecked(wo)) return null;
  const vendorId = lookupId(wo.vendor);
  if (!vendorId) return null;
  const evidence = (reopenedByVendor && reopenedByVendor.get(vendorId)) || [];
  // "some OTHER work assignment" — the record cannot be its own evidence.
  const others = evidence.filter((e) => Number(e.id) !== Number(wo.id));
  if (!others.length) return null;
  return { wo, vendorId, reopened: others };
}
function qualifyingSpotChecks(waRecords) {
  const reopenedByVendor = spotReopenedByVendor(waRecords);
  const out = [];
  for (const w of waRecords || []) {
    const c = spotCheckCandidate(w, reopenedByVendor);
    if (c) out.push(c);
  }
  return out;
}
/* ---- PURE-SPOT-END ---- */
// ============================================================================

function ageLabelFrom(t) {
  if (!t) return "";
  const ms = Date.now() - new Date(t).getTime();
  if (isNaN(ms) || ms < 0) return "";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return "new";
  if (h < 24) return h + "h old";
  return Math.floor(h / 24) + "d old";
}
// ============================================================================

// ============================================================================
// SIGNAL BUCKETS — stored analytical rows read from the app DB's `signal`
// table (written by sweep_jobs.signals / console_store.upsert_signals), NOT
// live Facilio queries. Each row carries data_confidence (native | derived |
// seeded); that provenance is surfaced on the card's flag so a seeded demo
// row is never mistaken for a live finding.
// ============================================================================
const SIGNAL_BUCKET_IDS = ["sla", "quoting", "invoicing"];
function signalTone(severity) {
  const s = String(severity || "").toLowerCase();
  if (s === "critical" || s === "high") return "#B61919";
  if (s === "medium" || s === "warn" || s === "warning") return "#FFD405";
  return "#5E3ED3";
}
// The signal table was provisioned by CSV import, so numeric columns come back
// as text ("250", "25") — coerce before arithmetic or display.
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function signalCard(r) {
  const metric = numOrNull(r.metric_value);
  const baseline = numOrNull(r.baseline_value);
  const pct = numOrNull(r.variance_pct);
  const parts = [];
  // Lead quoting cards with the variance story so it survives the meta line's ellipsis.
  if (r.bucket === "quoting" && metric != null && baseline != null) {
    parts.push("Quoted " + metric + " vs rate card " + baseline + (pct != null ? " · " + (pct > 0 ? "+" : "") + pct + "%" : ""));
  }
  if (r.meta) parts.push(r.meta);
  // Signals store a record_url, but rows written before the module names were
  // canonicalised hold a stale one. Rebuild it from source_module +
  // source_record_id whenever both are present; only fall back to the stored
  // value when we cannot derive one. Grouped signals (e.g. SLA, which
  // aggregates many requests per client) carry no source_record_id at all, so
  // they correctly end up with no link and no View button.
  const url = recordUrl(r.source_module, r.source_record_id) || (r.source_record_id == null ? String(r.record_url || "") : "");
  return {
    external_id: r.external_id, ref: r.ref || "", bucket: r.bucket,
    bucket_label: r.bucket_label || BUCKET_LABELS[r.bucket] || r.bucket,
    source_module: r.source_module || "",
    title: r.title || "(untitled signal)",
    meta: parts.join(" · "),
    ai_note: r.ai_note || "",
    tone: signalTone(r.severity),
    flag: r.data_confidence === "seeded" ? "Seeded demo" : (r.data_confidence === "derived" ? "Derived" : ""),
    priority: "Signal",
    site: r.site || "", tenant: r.tenant || "", vendor: r.vendor || "", requested_by: "",
    local_id: "",
    created_time: r.detected_at || "",
    record_url: url,
    system_modified_time: r.updated_at || "",
    actions: withView([], url).concat([{ label: "Dismiss", kind: "ghost", act: "action" }]),
  };
}
function signalBucketDef(id) {
  return {
    label: BUCKET_LABELS[id],
    module: "signal",
    signal: true,
    custom: true, // reuses the custom-bucket path: loadRows + in-memory paging
    async loadRows() {
      const d = db();
      const { rows } = d.query(
        "select * from signal where bucket = $1 and status = 'open' and external_id <> '__seed__' order by detected_at desc",
        [id]
      );
      return rows.map(signalCard);
    },
  };
}

// ---- work-permit evidence tag ----------------------------------------------
// The "Unblock vendors" cards carry a suggestion computed from the permit's own
// checklist rather than from an LLM. That is a deliberate call, not a shortcut:
// across the live queue the pre-work checklists collapse to two distinct
// contents — 50 Electrical permits whose three items carry byte-identical canned
// notes, and one Hot Work permit (PMT-319) with 27 blank items. An LLM asked to
// judge those would return the same sentence 50 times and one other; the reading
// that actually separates the queue ("is there evidence here at all?") is a count,
// and a count cannot hallucinate. The Studio reviewer agent still exists for the
// deep read — it is just no longer a per-card button.

// The connections endpoint hands this action back flat, but tolerate the
// {data:{...}} envelope the list actions use so a gateway change can't blank the tag.
function unwrapChecklist(resp) {
  if (!resp || typeof resp !== "object") return null;
  if (resp.pre_work_checklist || resp.pre_work_items_total != null) return resp;
  if (resp.data && typeof resp.data === "object") return resp.data;
  return resp;
}

// Pure: checklist payload -> { flag, tone, ai_note } | null. Only ever reports
// what was counted. Nothing here can say a permit is safe to approve — a full
// set of notes is reported as "evidenced", which is a statement about the
// paperwork, not a recommendation.
function permitEvidence(c) {
  if (!c || typeof c !== "object") return null;
  // A payload carrying neither of these is not a checklist read (a gateway error
  // body, a shape change). Untagged beats a red badge invented from nothing.
  if (!Array.isArray(c.pre_work_checklist) && !Number.isFinite(c.pre_work_items_total)) return null;
  const pre = Array.isArray(c.pre_work_checklist) ? c.pre_work_checklist : [];
  const total = Number.isFinite(c.pre_work_items_total) ? c.pre_work_items_total : pre.length;
  if (!total) {
    return { flag: "No pre-work checklist", tone: "#B61919",
      ai_note: "This permit type has no pre-work checklist items — there is nothing recorded to verify before approval." };
  }
  const blank = Number.isFinite(c.pre_work_items_with_no_notes)
    ? c.pre_work_items_with_no_notes
    : pre.filter((i) => !String(i.notes_written_by_the_person_who_filled_it_in || "").trim()).length;
  const filled = Math.max(0, total - blank);
  const signed = pre.filter((i) => i.already_signed_off_by_a_reviewer).length;
  const files = pre.reduce((n, i) => n + (Number(i.evidence_files_attached) || 0), 0);
  const eviNote = files ? files + " evidence file" + (files === 1 ? "" : "s") + " attached" : "no evidence files attached";

  if (filled === 0) {
    return { flag: "No checklist evidence", tone: "#B61919",
      ai_note: "None of the " + total + " pre-work checks carry notes — there is no evidence on this permit to review." };
  }
  if (filled < total) {
    return { flag: filled + "/" + total + " checks evidenced", tone: "#FFD405",
      ai_note: blank + " of " + total + " pre-work checks have no notes; " + signed + " signed off, " + eviNote + "." };
  }
  return { flag: total + "/" + total + " checks evidenced", tone: "#0059D6",
    ai_note: "All " + total + " pre-work checks have notes (" + signed + " signed off) — notes only, " + eviNote + "." };
}

// ============================================================================
// LIVE BUCKET QUERIES
// Each bucket is a LIVE query against Facilio — module + criteria evaluated at
// read time (no stored copy). `filters` is the bucket's qualifying criteria;
// the FM's action changes the source record so it leaves this criteria and
// drops off the feed. Add a bucket here as you give me its module + criteria.
// ============================================================================

// The two states a tenant service request passes through while it is still the
// FM's to move: "Open" = submitted, waiting to be acknowledged; "tsrvalidated" =
// acknowledged, waiting for the work order (or the tenant quote). A request that
// has left both has left this queue.
const TSR_STATE_NEW = "Open";
const TSR_STATE_ACK = "tsrvalidated";
const TSR_STATES = [TSR_STATE_NEW, TSR_STATE_ACK];

const BUCKETS = {
  // ONE queue for the whole tenant service request, not one per state. The FM used
  // to acknowledge in "TSR's to acknowledge", then hunt the same record down again
  // in "Acknowledged TSRs" to raise its work order; the two buckets were a seam in
  // the tool, never a seam in the job. Both states are read in a SINGLE server-side
  // call and each row picks its own button from the state it is actually in.
  tsr: {
    label: BUCKET_LABELS.tsr,
    connection: "facilio-cmms",
    action: "list-service-requests",
    modifiedField: "sysModifiedTime",
    // Comma-separated values on one field are an IN/OR on this action — VERIFIED
    // against org 2931: moduleState=Open counts 136, moduleState=tsrvalidated 19,
    // and moduleState=Open,tsrvalidated 155 (= 136 + 19, against 158 for the whole
    // module). So no client-side merge is needed, `include_count` stays honest and
    // paging stays server-side, sorted by sysModifiedTime across both states.
    filters: "moduleState=" + TSR_STATES.join(","),
    // Rows actioned while the queues were still split were recorded under the old
    // `tsrack:` external_id. Without this they would come back from the dead in the
    // merged bucket, so those ids are normalised onto `tsr:` when hiding.
    aliases: ["tsrack"],
    expand: "siteId,tenant,tenant_serviceRequest_1",
    // moduleState is in the projection now — it is what each row branches on.
    select: "id,localId,subject,moduleState,issue_location_serviceRequest,siteId,tenant,tenant_serviceRequest_1,sysCreatedTime,sysModifiedTime,tenant_rechargeable__serviceRequest,tenant_quote_path_serviceRequest",
    module: "servicerequest",
    signal: false,
    toRow(r) {
      const id = r.id;
      const lid = r.localId && r.localId !== 0 ? r.localId : null;
      const site = nameOf(r.siteId);
      const issue = r.issue_location_serviceRequest || "";
      const location = [site, issue].filter(Boolean).join(" · ");
      const tenant = nameOf(r.tenant_serviceRequest_1) || nameOf(r.tenant);
      const rechargeable = r.tenant_rechargeable__serviceRequest === true;
      const qp = r.tenant_quote_path_serviceRequest || "";
      // list-service-requests returns moduleState as the bare status string once it
      // is named in `select` ("Open" / "tsrvalidated") — verified on a live page.
      const state = String(nameOf(r.moduleState) || r.moduleState || "");
      const acknowledged = state === TSR_STATE_ACK;
      const meta = [location || null, tenant ? "Tenant: " + tenant : null, qp ? "Quote path: " + qp : null].filter(Boolean).join(" · ");
      const url = recordUrl("serviceRequest", id);

      // The button is the record's own next step, so a merged queue never asks the
      // FM to work out which half of the flow a row is in:
      //   • not yet acknowledged → the whole flow in one conversation. The
      //     `tsr_flow` intent acknowledges (on the FM's explicit confirmation) and
      //     then carries straight on to the work order in the SAME chat, instead of
      //     ending the turn and making the FM come back for the second button.
      //   • acknowledged, in-house CBRE quote → the local amount dialog, exactly as
      //     before. This one deliberately does NOT go to the agent.
      //   • acknowledged, any other quote path → the work order alone.
      let actions = [];
      if (!acknowledged) {
        actions.push({
          label: "Acknowledge & proceed", kind: "primary", act: "agent", intent: "tsr_flow",
          prompt: "Acknowledge this tenant service request, then raise the work order for it.",
        });
      } else if (qp === "Provide In-House CBRE Quote") {
        actions.push({ label: "Create Tenant Quote", kind: "primary", act: "quote" });
      } else {
        actions.push({ label: "Create Work Order", kind: "primary", act: "agent", intent: "create_work_order", prompt: "Raise the work order for this request." });
      }
      actions = withView(actions, url);

      return {
        external_id: "tsr:servicerequest:" + id, ref: "TSR-" + (lid || id),
        bucket: "tsr", bucket_label: BUCKET_LABELS.tsr, source_module: "servicerequest",
        title: r.subject || "(no subject)", priority: "Normal",
        // Acknowledged rows keep their amber tone; unacknowledged ones stay
        // untinted and take the card's age colour, so the two halves of the merged
        // queue are still distinguishable at a glance before you read a word.
        tone: acknowledged ? "#FFD405" : "",
        // The state is the FIRST pill, because in a merged list it is the thing the
        // FM has to know before anything else. "Chargeable to tenant" keeps its own
        // pill beside it rather than being displaced by the state.
        flag: acknowledged ? "Acknowledged" : "To acknowledge",
        flag2: rechargeable ? "Chargeable to tenant" : "",
        meta, ai_note: "", age_label: "",
        status: acknowledged ? "Acknowledged" : "Submitted",
        site: location, tenant, requested_by: "",
        local_id: lid ? String(lid) : "",
        created_time: r.sysCreatedTime || "",
        record_url: url,
        system_modified_time: r.sysModifiedTime || "",
        actions,
      };
    },
  },
  unblock: {
    label: BUCKET_LABELS.unblock,
    module: "workpermit",
    signal: false,
    custom: true,   // uses cbre-clone's awaiting-approval queue (list-work-permits ignores filters)
    async loadRows() {
      const resp = await callAction("cbre-clone", "list-work-permits-awaiting-approval", { page: 1, results_per_page: 200 });
      const data = (resp && resp.data) || {};
      const all = data.workpermit || [];
      const sup = (((resp || {}).meta || {}).supplements || {}).workpermit || {};
      const vend = sup.vendor || {}, types = sup.workPermitType || {}, sites = sup.siteId || {}, states = sup.moduleState || {};
      // keep only permits genuinely Awaiting FM Approval (queue can include already-decided ones)
      const recs = all.filter((r) => {
        const s = states[String((r.moduleState || {}).id)] || {};
        return (s.status || s.displayName || "") === "awaitingfmapproval";
      });
      const iso = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "");
      return recs.map((r) => {
        const id = r.id;
        const lid = r.localId && r.localId !== 0 ? r.localId : null;
        const vName = ((vend[String(r.vendor && r.vendor.id)]) || {}).name || "";
        const tName = ((types[String(r.workPermitType && r.workPermitType.id)]) || {}).name || "";
        const sName = ((sites[String(r.siteId)]) || {}).name || "";
        const meta = [tName || null, vName ? "Vendor: " + vName : "Vendor: —", sName || null].filter(Boolean).join(" · ");
        return {
          external_id: "unblock:workpermit:" + id, ref: "PMT-" + (lid || id),
          bucket: "unblock", bucket_label: BUCKET_LABELS.unblock, source_module: "workpermit",
          title: r.name || ("Work permit " + id), priority: "Normal", tone: "#FFD405", flag: "Permit",
          meta, ai_note: "", age_label: "", status: "Awaiting FM Approval",
          site: sName, tenant: "", requested_by: "",
          local_id: lid ? String(lid) : "",
          created_time: iso(r.sysCreatedTime),
          valid_from: iso(r.expectedStartTime), valid_to: iso(r.expectedEndTime),
          record_url: recordUrl("workpermit", id),
          system_modified_time: iso(r.sysModifiedTime),
          permit_id: id,   // enrichPage needs the raw record id for the checklist read
          actions: withView(
            [
              { label: "Approve", kind: "ghost", act: "approve" },
              { label: "Reject", kind: "ghost", act: "reject" },
            ],
            recordUrl("workpermit", id)
          ),
        };
      });
    },
    // The suggestion tag is computed per VISIBLE PAGE, not in loadRows: loadRows
    // also backs the 30s counts poll (see the `bucket_counts` handler), so a
    // checklist read per permit there would fire ~50 calls every half minute for
    // a number nobody reads. Ten reads when a page is actually opened is the
    // cheap, honest place for it.
    async enrichPage(jobs) {
      await Promise.all(jobs.map(async (row) => {
        try {
          const resp = await callAction("cbre-clone", "get-work-permit-with-checklist", { permit_id: row.permit_id });
          const tag = permitEvidence(unwrapChecklist(resp));
          if (tag) { row.flag = tag.flag; row.tone = tag.tone; row.ai_note = tag.ai_note; }
        } catch {
          // A failed checklist read must leave the card untagged rather than
          // tagged wrongly — an absent badge is honest, a guessed one is not.
        }
      }));
    },
  },
  referral: {
    label: BUCKET_LABELS.referral,
    module: "purchaseorder",
    signal: false,
    custom: true,   // filter POs to the referred state in code (module filters are unreliable)
    async loadRows() {
      const recs = envelope(await callAction("facilio-cmms", "list-purchase-orders",
        { page_size: 200, expand: "vendor", sort_by: "sysModifiedTime", sort_order: "desc" })).records;
      const referred = recs.filter((r) => String(nameOf(r.moduleState) || r.moduleState) === REFERRED_PO_STATE);
      return referred.map((r) => {
        const id = r.id;
        const vendor = nameOf(r.vendor);
        const poNo = r.poNumber || r.name || ("PO-" + id);
        const orderVal = r.totalCost != null ? r.totalCost : (r.subTotal != null ? r.subTotal : "");
        const meta = [vendor ? "Vendor: " + vendor : null, orderVal !== "" ? "Order value: " + orderVal : null].filter(Boolean).join(" · ");
        return {
          external_id: "referral:purchaseorder:" + id, ref: String(poNo),
          bucket: "referral", bucket_label: BUCKET_LABELS.referral, source_module: "purchaseorder",
          title: String(poNo) + (vendor ? " — " + vendor : ""), priority: "Normal", tone: "#FFD405", flag: "Referred",
          meta, ai_note: "", age_label: "", status: "Referred",
          site: "", tenant: "", requested_by: "",
          local_id: "", created_time: r.sysCreatedTime || "", valid_from: "", valid_to: "",
          record_url: recordUrl("purchaseorder", id),
          system_modified_time: r.sysModifiedTime || "",
          actions: withView([{ label: "Review lines", kind: "primary", act: "drill" }], recordUrl("purchaseorder", id)),
        };
      });
    },
  },
  findings: {
    label: BUCKET_LABELS.findings,
    module: "finding",
    signal: false,
    custom: true,   // filter to the created state in code
    async loadRows() {
      // NOTE: no connection action currently lists the "finding" module in this org.
      // Wire the correct action here once available; fail safe to empty meanwhile.
      let recs = [];
      try {
        recs = envelope(await callAction("facilio-cmms", "list-findings",
          { page_size: 200, sort_by: "sysModifiedTime", sort_order: "desc" })).records;
      } catch (e) { recs = []; }
      const created = recs.filter((r) => String(nameOf(r.moduleState) || r.moduleState) === FINDING_CREATED_STATE);
      return created.map((r) => {
        const id = r.id;
        const lid = r.localId && r.localId !== 0 ? r.localId : null;
        const subject = findingField(r, "subject") || ("Finding " + id);
        const source = findingField(r, "source");
        const location = findingField(r, "location");
        const priority = findingField(r, "priority");
        const description = findingField(r, "description");
        const meta = [source || null, location || null].filter(Boolean).join(" · ");
        return {
          external_id: "findings:finding:" + id, ref: "FND-" + (lid || id),
          bucket: "findings", bucket_label: BUCKET_LABELS.findings, source_module: "finding",
          title: subject, priority: priority || "Normal", tone: findingTone(priority),
          flag: "", meta, ai_note: "", age_label: "", status: "Created",
          site: location, tenant: "", requested_by: "",
          local_id: lid ? String(lid) : "",
          created_time: r.sysCreatedTime || "", valid_from: "", valid_to: "",
          description: description,   // used by the browser for Tenant/FM classification
          // "" today: `finding` has no OVERVIEW route (and no module in this
          // org), so no summary page exists to link to. If the module is ever
          // added, register its canonical name in LINKABLE_MODULES and the
          // View button reappears here with no other change.
          record_url: recordUrl("finding", id),
          system_modified_time: r.sysModifiedTime || "",
          // The primary responsibility button (Raise Letter of Non Compliance /
          // Create Work Order) is added CLIENT-SIDE once the finding-classifier
          // agent's verdict lands; Unclear gets no primary — View/Close only.
          // NOTE: no add-finding-comment action exists in this org, so the `act`
          // handler's write step honestly reports syncStatus "skipped" for findings;
          // the card still leaves the feed.
          actions: withView([{ label: "Close Finding", kind: "ghost", act: "action" }], recordUrl("finding", id)),
        };
      });
    },
  },
  stalled: {
    label: BUCKET_LABELS.stalled,
    module: "workorder",
    signal: false,
    // custom: the qualifying test is a REVERSE join — "has no PI" can only be
    // answered from the procurement-initiation side (see STALLED WORK ORDERS
    // above), which no per-record `filters` expression can express. Open state
    // IS pushed server-side; the PI/PO exclusion is computed here.
    custom: true,
    async loadRows() {
      // Open work orders, newest-modified first. No `expand`: expanding lookups
      // returns whole nested records and blows the payload up ~3x, so site and
      // vendor names come from small id→name maps instead.
      const wos = [];
      for (let page = 1; page <= 3; page++) {
        const { records } = envelope(await callAction("facilio-cmms", "list-work-orders", {
          page, page_size: 200,
          filters: "moduleState=" + WO_OPEN_STATES.join(","),
          sort_by: "modifiedTime", sort_order: "desc",
          select: "id,serialNumber,subject,moduleState,priority,siteId,vendor,createdTime,modifiedTime," +
            "associated_procurement_activity_workorder,purchase_order_workorder,po_id_workorder," +
            "restrict_work_order_cancellation_workorder",
        }));
        wos.push(...records);
        if (records.length < 200) break;
      }

      // Every procurement initiation, inverted to the work orders they cover.
      let piWoIds = new Set();
      try {
        piWoIds = procuredWorkOrderIds(envelope(await callAction("facilio-cmms", "list-custom-module-records", {
          custom_module: "custom_procurementinitiation", page_size: 200,
          select: "id,moduleState,workorder_custom_procurementinitiation",
        })).records);
      } catch { piWoIds = new Set(); }

      // Same inversion for purchase orders. Excludes nothing in this org today
      // (no PO carries a work-order link) — kept so the bucket is correct the
      // moment one does. Best-effort: a failed sweep must not empty the bucket.
      let poWoIds = new Set();
      try {
        const pos = [];
        for (let page = 1; page <= STALLED_PO_SCAN_PAGES; page++) {
          const { records } = envelope(await callAction("facilio-cmms", "list-purchase-orders", {
            page, page_size: 200, select: "id,associated_work_order_purchaseorder",
          }));
          pos.push(...records);
          if (records.length < 200) break;
        }
        poWoIds = orderedWorkOrderIds(pos);
      } catch { poWoIds = new Set(); }

      const stalled = wos.filter((w) => workOrderIsStalled(w, piWoIds, poWoIds));
      const sites = stalled.length ? await siteMap() : {};
      const vendors = stalled.some((w) => lookupId(w.vendor)) ? await vendorMap() : {};

      return stalled.map((w) => {
        const id = w.id;
        const ref = "WO-" + (w.serialNumber || id);
        const site = sites[lookupId(w.siteId)] || "";
        const vendor = vendors[lookupId(w.vendor)] || "";
        const age = ageLabelFrom(w.createdTime);
        const state = String(nameOf(w.moduleState) || w.moduleState || "");
        // `assignedTo` is empty on every work order in this org and the Building
        // lookup on all but 11, so neither is put in the meta line — an empty
        // "Assignee: —" teaches the reader nothing.
        const meta = [site || null, vendor ? "Vendor: " + vendor : null, age || null].filter(Boolean).join(" · ");
        const url = recordUrl("workorder", id);
        return {
          external_id: "stalled:workorder:" + id, ref,
          bucket: "stalled", bucket_label: BUCKET_LABELS.stalled, source_module: "workorder",
          title: w.subject || "(no subject)",
          // Priority is genuinely populated here (High/Medium/Low across 281 of
          // 283), so the tone is read off the record rather than invented. No
          // flag: nothing in the data supports an urgency claim beyond priority
          // — in particular every work order in this org is under 24h old, so
          // there is no "idle for N days" story to tell.
          priority: nameOf(w.priority) || "Normal",
          tone: findingTone(nameOf(w.priority)), flag: "",
          meta, ai_note: "", age_label: age, status: state,
          site, tenant: "", vendor, requested_by: "",
          local_id: w.serialNumber ? String(w.serialNumber) : "",
          created_time: w.createdTime || "", valid_from: "", valid_to: "",
          record_url: url,
          system_modified_time: w.modifiedTime || "",
          // No primary action. The natural next step is "initiate procurement",
          // but agent_bridge's start_async resolves every non-permit intent's
          // record as a SERVICE REQUEST (it reads sr.moduleState and passes
          // sr_id), so pointing an `act: "agent"` button at a workorder id would
          // open the panel on the wrong record — and adding a work-order intent
          // means editing agent_bridge.js, which is out of scope here. Dismiss
          // uses the generic `act: "action"` path, which already has a real
          // workorder branch (facilio-cmms.add-work-order-comment).
          actions: withView([{ label: "Dismiss", kind: "ghost", act: "action" }], url),
        };
      });
    },
  },
  spot: {
    label: BUCKET_LABELS.spot,
    module: "workorder",
    signal: false,
    // custom: the qualifying test is a CROSS-RECORD join ("the same vendor has
    // ANOTHER reopened work assignment"), which no per-record `filters`
    // expression can express — see SPOT CHECKS above. Classification IS pushed
    // server-side; the in-progress, reopen and vendor tests run here over the
    // one page that comes back.
    custom: true,
    async loadRows() {
      // Every work assignment, in one sweep: the same set supplies both the
      // candidates and the reopen evidence, so no second query is needed. No
      // `expand` (it triples the payload); names come from id→name maps.
      const was = [];
      for (let page = 1; page <= 3; page++) {
        const { records } = envelope(await callAction("facilio-cmms", "list-work-orders", {
          page, page_size: 200,
          filters: "work_classification_workorder=" + SPOT_WORK_CLASSIFICATION,
          sort_by: "modifiedTime", sort_order: "desc",
          select: "id,serialNumber,subject,moduleState,priority,siteId,vendor,createdTime,modifiedTime," +
            "work_classification_workorder,reason_for_reopening_workorder," +
            "inspection_workorder,spot_check_initiated__workorder",
        }));
        was.push(...records);
        if (records.length < 200) break;
      }

      const candidates = qualifyingSpotChecks(was);
      const sites = candidates.length ? await siteMap() : {};
      const vendors = candidates.length ? await vendorMap() : {};

      return candidates.map((c) => {
        const w = c.wo;
        const id = w.id;
        const ref = "WA-" + (w.serialNumber || id);
        const site = sites[lookupId(w.siteId)] || "";
        const vendor = vendors[c.vendorId] || "";
        const age = ageLabelFrom(w.createdTime);
        const state = String(nameOf(w.moduleState) || w.moduleState || "");
        const n = c.reopened.length;
        // The flag reason is COUNTED from the evidence records, never asserted.
        const why = "Vendor has " + n + " reopened work assignment" + (n === 1 ? "" : "s");
        const refs = c.reopened.slice(0, 3).map((e) => "WA-" + (e.serialNumber || e.id));
        const meta = [why, site || null, vendor ? "Vendor: " + vendor : null, age || null]
          .filter(Boolean).join(" · ");
        const url = recordUrl("workorder", id);
        return {
          external_id: "spot:workorder:" + id, ref,
          bucket: "spot", bucket_label: BUCKET_LABELS.spot, source_module: "workorder",
          title: w.subject || "(no subject)",
          priority: nameOf(w.priority) || "Normal",
          tone: "#FFD405", flag: "Vendor reopens",
          meta,
          // Cites the actual evidence records so the FM can check the claim.
          ai_note: why + (refs.length ? " — reopened elsewhere: " + refs.join(", ") + (n > refs.length ? " (+" + (n - refs.length) + " more)" : "") : ""),
          age_label: age, status: state,
          site, tenant: "", vendor, requested_by: "",
          local_id: w.serialNumber ? String(w.serialNumber) : "",
          created_time: w.createdTime || "", valid_from: "", valid_to: "",
          record_url: url,
          system_modified_time: w.modifiedTime || "",
          // VIEW ONLY — deliberately no "Initiate Spot Check" primary. The real
          // button (3380565) would be run via
          //   facilio-cmms.execute-record-action
          //   { moduleName:"workorder", recordId, buttonType:"customButton", buttonId:3380565 }
          // but that path is NOT verified: `get-record-actions` returns an EMPTY
          // customButtons list for every work assignment probed (the button is
          // gated on `type != 517` and on 7 FM roles this session's user is not
          // in), and the org holds ZERO published inspection templates, so the
          // workflow it fires has nothing to raise the inspection from. Wiring a
          // write that cannot be proven to work would be worse than a dead
          // button. Restore the primary once a probe shows the button in
          // `customButtons` for a live record.
          actions: withView([], url),
        };
      });
    },
  },
  // ── signal buckets (stored rows from the app DB, see SIGNAL BUCKETS above) ──
  sla: signalBucketDef("sla"),
  quoting: signalBucketDef("quoting"),
  invoicing: signalBucketDef("invoicing"),
  // ── more buckets added here as you provide module + criteria ──
};

// id → name map for sites (fetched once, 15 records).
async function siteMap() {
  try {
    const recs = envelope(await callAction("facilio-cmms", "list-sites", { select: "id,name", page_size: 200 })).records;
    const m = {};
    for (const s of recs) m[s.id] = s.name;
    return m;
  } catch { return {}; }
}

// id → name map for vendors (fetched once, ~87 records).
async function vendorMap() {
  try {
    const recs = envelope(await callAction("facilio-cmms", "list-vendors", { select: "id,name", page_size: 200 })).records;
    const m = {};
    for (const v of recs) m[v.id] = v.name;
    return m;
  } catch (e) { return {}; }
}

// The external_ids already actioned in this bucket, as the bucket spells them
// TODAY. `aliases` are bucket ids this one absorbed (tsr absorbed tsrack): their
// rows are rewritten onto the current prefix, so a request actioned back when the
// queues were split stays hidden instead of reappearing under its new id.
function hiddenSet(d, bucketId, aliases) {
  const out = new Set();
  // No try/catch: a dead job_state read used to fall back to an empty set, which
  // silently RESURRECTED every already-actioned card as open work. Failing the
  // bucket read is the honest outcome — counts already surfaces a per-bucket
  // error, and the console shows an inline error with a retry.
  for (const prefix of [bucketId].concat(aliases || [])) {
    const { rows } = d.query("select external_id from job_state where action_taken = 'true' and external_id like $1", [prefix + ":%"]);
    for (const r of rows) {
      const eid = String(r.external_id);
      out.add(bucketId + ":" + eid.slice(eid.indexOf(":") + 1));
    }
  }
  return out;
}

// True when this job was already actioned — the guard every write handler runs
// FIRST, so a browser retry after a timeout (or a double-submit that slipped past
// the UI's disabled state) never writes the same comment/quote/decision twice.
// The Facilio write used to run before job_state was recorded, which made every
// retry a duplicate.
function alreadyActioned(d, externalId) {
  try {
    const { rows } = d.query("select action_taken, action_type from job_state where external_id = $1", [externalId]);
    return rows.length && rows[0].action_taken === "true" ? (rows[0].action_type || "Actioned") : null;
  } catch (e) {
    // If the guard itself cannot read, let the write proceed — a possible
    // duplicate comment beats definitely losing the action.
    return null;
  }
}
// Deliberately the size of the (deduped, rewritten) set rather than its own
// count(*): with aliases in play the same record can be recorded under two
// prefixes, and counting rows would subtract it twice from the bucket total.
function hiddenCount(d, bucketId, aliases) {
  return hiddenSet(d, bucketId, aliases).size;
}

// ---- handlers --------------------------------------------------------------

// Cheap: one live count per bucket (include_count + page_size 1). Powers the rail.
server.addHandler({
  name: "counts",
  description: "Live per-bucket counts straight from Facilio (cheap: include_count, no rows). Excludes items already actioned this session.",
  parameters: {},
  execute: async () => {
    const d = db();
    const out = [];
    for (const [id, b] of Object.entries(BUCKETS)) {
      try {
        let count;
        if (b.custom) {
          const rows = await b.loadRows();
          const hidden = hiddenSet(d, id, b.aliases);
          count = rows.filter((r) => !hidden.has(r.external_id)).length;
          out.push({ bucket: id, label: b.label, signal: !!b.signal, count });
          continue;
        }
        if (b.countMode === "length") {
          const input = { page: 1, page_size: 200, select: "id" };
          if (b.filters) input.filters = b.filters;
          count = envelope(await callAction(b.connection, b.action, input)).records.length;
        } else {
          const input = { page: 1, page_size: 1, include_count: true, select: "id" };
          if (b.filters) input.filters = b.filters;
          count = envelope(await callAction(b.connection, b.action, input)).count || 0;
        }
        const hidden = hiddenCount(d, id, b.aliases);
        out.push({ bucket: id, label: b.label, signal: !!b.signal, count: Math.max(0, count - hidden) });
      } catch (e) {
        out.push({ bucket: id, label: b.label, signal: !!b.signal, count: null, error: String(e.message || e).slice(0, 160) });
      }
    }
    return { ranAt: nowIso(), buckets: out };
  },
});

// Lazy: full card details for ONE bucket, one page. Only the visible bucket is fetched.
server.addHandler({
  name: "bucket",
  description: "Live page of records for one bucket (projection + expand), most-recently-modified first. Actioned items are filtered out.",
  parameters: {
    bucket: { description: "Bucket id", type: "string" },
    page: { description: "1-based page (default 1)", type: "number" },
    pageSize: { description: "Rows per page (default 10, max 50)", type: "number" },
  },
  execute: async (args) => {
    const id = args && args.bucket;
    const b = BUCKETS[id];
    if (!b) throw new Error("unknown bucket: " + id);
    const d = db();
    const page = Math.max(1, args && args.page ? Number(args.page) : 1);
    const pageSize = Math.min(Math.max(1, args && args.pageSize ? Number(args.pageSize) : 10), 50);

    if (b.custom) {
      const hidden = hiddenSet(d, id, b.aliases);
      const all = (await b.loadRows()).filter((r) => !hidden.has(r.external_id));
      const total = all.length;
      const jobs = all.slice((page - 1) * pageSize, page * pageSize);
      // Per-page enrichment: extra reads a bucket only wants for rows actually
      // on screen. Deliberately outside loadRows(), which the counts poll shares.
      if (b.enrichPage) await b.enrichPage(jobs);
      return { bucket: id, jobs, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), ranAt: nowIso() };
    }

    const input = {
      page, page_size: pageSize, include_count: true,
      sort_by: b.modifiedField, sort_order: "desc",
    };
    if (b.filters) input.filters = b.filters;
    if (b.expand) input.expand = b.expand;
    if (b.select) input.select = b.select;
    const { records, count } = envelope(await callAction(b.connection, b.action, input));

    // context resolvers (e.g. vendor id -> name)
    let ctxFor = () => ({});
    if (b.resolveVendors) { const vm = await vendorMap(); ctxFor = (r) => ({ vendorName: vm[r.vendor && r.vendor.id] }); }

    const hidden = hiddenSet(d, id, b.aliases);
    const jobs = records.map((r) => b.toRow(r, ctxFor(r))).filter((row) => !hidden.has(row.external_id));

    let rawTotal;
    if (b.countMode === "length") {
      const cin = { page: 1, page_size: 200, select: "id" };
      if (b.filters) cin.filters = b.filters;
      rawTotal = envelope(await callAction(b.connection, b.action, cin)).records.length;
    } else {
      rawTotal = count || records.length;
    }
    const total = Math.max(0, rawTotal - hiddenCount(d, id, b.aliases));
    return { bucket: id, jobs, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), ranAt: nowIso() };
  },
});

// Take an action: write back to Facilio immediately, then hide it from the feed.
server.addHandler({
  name: "act",
  description: "Record an action, write it back to Facilio immediately (comment on the source record), and hide the job from the live feed.",
  parameters: {
    external_id: { description: "external_id of the job (bucket:module:id)", type: "string" },
    action_type: { description: "Action taken, e.g. 'Acknowledge'", type: "string" },
    actor: { description: "Optional name/email of who acted", type: "string" },
  },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const d = db();
    const seg = String(args.external_id).split(":");
    const facilioId = Number(seg[seg.length - 1]);
    const module = seg[seg.length - 2];
    const actionType = args.action_type || "Actioned";
    const now = nowIso();

    // Retry / double-submit: already actioned means already commented — succeed
    // without writing a second comment.
    const done = alreadyActioned(d, args.external_id);
    if (done) return { ok: true, external_id: args.external_id, action_type: done, syncStatus: "synced", idempotent: true };

    let syncStatus = "synced", syncError = null;
    try {
      const who = args.actor ? " by " + args.actor : "";
      const commentText = `Action "${actionType}"${who} via FM 360 Console at ${now}.`;
      if (module === "servicerequest" && facilioId) await callAction("facilio-cmms", "add-service-request-comment", { id: facilioId, commentText });
      else if (module === "workorder" && facilioId) await callAction("facilio-cmms", "add-work-order-comment", { id: facilioId, commentText });
      else syncStatus = "skipped";
    } catch (e) { syncStatus = "failed"; syncError = String(e.message || e).slice(0, 300); }

    if (syncStatus === "failed") {
      upsertState(d, args.external_id, "", actionType, now, "failed: " + syncError);
      return { ok: false, external_id: args.external_id, syncStatus, error: syncError };
    }
    // A dismissed signal is a stored row, not a live query — flip its status in
    // the signal table too so it stays gone everywhere, not just via job_state.
    // Idempotent: only open rows are touched.
    if (SIGNAL_BUCKET_IDS.indexOf(seg[0]) >= 0) {
      try {
        d.query("update signal set status = 'dismissed', updated_at = $2 where external_id = $1 and status = 'open'", [args.external_id, now]);
      } catch { /* job_state still hides it from the feed */ }
    }
    upsertState(d, args.external_id, "true", actionType, now, syncStatus);
    return { ok: true, external_id: args.external_id, action_type: actionType, syncStatus };
  },
});

server.addHandler({
  name: "permit_decision",
  description: "Approve or reject a work permit awaiting FM approval, then drop it from the feed. decision = 'approve' | 'reject'.",
  parameters: {
    external_id: { description: "external_id (unblock:workpermit:<id>)", type: "string" },
    decision: { description: "'approve' or 'reject'", type: "string" },
    actor: { description: "Optional name/email of who decided", type: "string" },
  },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const seg = String(args.external_id).split(":");
    const permitId = Number(seg[seg.length - 1]);
    const decision = (args.decision || "").toLowerCase();
    if (decision !== "approve" && decision !== "reject") throw new Error("decision must be 'approve' or 'reject'");
    const permit_status = decision === "approve" ? "Permit Approved" : "Permit Rejected";

    // Retry / double-submit: the decision was already applied — do not push a
    // second status change at the permit.
    const dGuard = db();
    const done = alreadyActioned(dGuard, args.external_id);
    if (done) return { ok: true, external_id: args.external_id, decision, permit_status: done, idempotent: true };

    let syncStatus = "synced", syncError = null;
    try {
      await callAction("facilio-cmms", "change-permit-status", { work_permit_id: permitId, permit_status });
    } catch (e) { syncStatus = "failed"; syncError = String(e && e.message ? e.message : e).slice(0, 300); }

    const d = db();
    if (syncStatus === "failed") {
      upsertState(d, args.external_id, "", permit_status, nowIso(), "failed: " + syncError);
      return { ok: false, external_id: args.external_id, error: syncError };
    }
    upsertState(d, args.external_id, "true", permit_status, nowIso(), "synced");
    return { ok: true, external_id: args.external_id, decision, permit_status };
  },
});

server.addHandler({
  name: "unact",
  description: "Undo an action so the job returns to the live feed. Pass external_id, or all='true'.",
  parameters: {
    external_id: { description: "external_id to restore", type: "string" },
    all: { description: "Set 'true' to clear all", type: "string" },
  },
  execute: async (args) => {
    const d = db();
    if (args && args.all === "true") { const r = d.query("update job_state set action_taken = '' where action_taken = 'true'"); return { ok: true, cleared: r.rowCount || 0 }; }
    if (!args || !args.external_id) throw new Error("external_id or all='true' required");
    const r = d.query("update job_state set action_taken = '' where external_id = $1", [args.external_id]);
    return { ok: true, cleared: r.rowCount || 0 };
  },
});

// The predefined "Other s" service id, once located in the services catalog.
// null → the line item is an ad-hoc service line (description-only, no catalog ref).
const OTHER_SERVICE_ID = null;

// Build the tenant-quote payload from the service request + the entered amount.
function buildTenantQuotePayload(sr, amount) {
  const tenantId = sr.tenant && sr.tenant.id;
  const clientId = sr.client && sr.client.id;
  const siteId = sr.siteId && sr.siteId.id;
  const lineItem = {
    type: "service",
    description: sr.subject || ("Service request " + sr.id),
    quantity: 1,
    unitPrice: amount,
  };
  if (OTHER_SERVICE_ID) lineItem.service = OTHER_SERVICE_ID; // "Other s"
  const quote = {
    subject: "Tenant Quote - " + (sr.subject || ("SR " + sr.id)),
    tenant: tenantId,
    client: clientId,
    siteId: siteId,
    associated_service_request_quote: sr.id,
    lineItems: [lineItem],
  };
  return { quote };
}

server.addHandler({
  name: "create_tenant_quote",
  description: "Create a tenant quote record in Facilio for a service request. The FM enters only the amount; every other field is pulled from the SR.",
  parameters: {
    external_id: { description: "external_id of the job (tsr:servicerequest:<id>; legacy tsrack:servicerequest:<id> still parses)", type: "string" },
    amount: { description: "The quoted amount entered by the FM", type: "number" },
    actor: { description: "Optional name/email of who created it", type: "string" },
  },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const amount = Number(args.amount);
    if (!amount || amount <= 0) throw new Error("Enter a valid quoted amount");

    const seg = String(args.external_id).split(":");
    const srId = Number(seg[seg.length - 1]);

    // Retry / double-submit: a quote already exists for this request — creating a
    // second one is the worst duplicate in the console, so this guard runs before
    // anything else.
    const done = alreadyActioned(db(), args.external_id);
    if (done) return { ok: true, external_id: args.external_id, amount, quoteId: null, idempotent: true };

    // pull the full service request to source the rest of the payload
    const resp = await callAction("facilio-cmms", "list-service-requests", {
      filters: "id=" + srId,
      expand: "siteId,tenant,tenant_serviceRequest_1,client,requester",
      page_size: 1,
    });
    const sr = envelope(resp).records[0];
    if (!sr) throw new Error("service request " + srId + " not found");

    const payload = buildTenantQuotePayload(sr, amount);

    let created, syncError = null;
    try {
      created = await callAction("facilio-cmms", "create-quote", payload);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) };
    }

    // hide the SR from the feed now that the quote is raised
    const d = db();
    upsertState(d, args.external_id, "true", "Create Tenant Quote (" + amount + ")", nowIso(), "synced");
    let quoteId = null;
    try { const rec = envelope(created).records[0]; quoteId = rec && rec.id; } catch (e) {}
    return { ok: true, external_id: args.external_id, amount, quoteId };
  },
});

function poLineNo(line, idx) {
  for (const f of PO_LINE_NUMBER_FIELDS) if (line[f] != null && line[f] !== 0) return String(line[f]);
  return String(idx + 1);
}

// Build a map of PO-line-number -> invoice unit price, matched via the invoice
// line's PO-line-number custom field. Stubbed off until that field name is known.
async function invoicePricesForPO(po) {
  if (!INVOICE_LINE_PO_LINE_FIELD) return {};
  try {
    // Fetch invoices and match their lines to this PO's lines by the custom field.
    const invs = envelope(await callAction("facilio-cmms", "list-invoices",
      { page_size: 50, expand: "lineItems", sort_by: "sysModifiedTime", sort_order: "desc" })).records;
    const map = {};
    for (const inv of invs) {
      const lines = inv.lineItems || [];
      for (const l of lines) {
        const key = l[INVOICE_LINE_PO_LINE_FIELD];
        if (key != null && map[String(key)] == null) map[String(key)] = l.unitPrice;
      }
    }
    return map;
  } catch (e) { return {}; }
}

server.addHandler({
  name: "po_reconcile_view",
  description: "Drill into a referred PO: return its referred line items with the PO unit price and the matched invoice unit price (by PO line number).",
  parameters: { external_id: { description: "referral:purchaseorder:<id>", type: "string" } },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const seg = String(args.external_id).split(":");
    const poId = Number(seg[seg.length - 1]);
    const po = envelope(await callAction("facilio-cmms", "get-purchase-order", { id: poId, expand: "lineItems,vendor" })).records[0]
      || (await callAction("facilio-cmms", "get-purchase-order", { id: poId, expand: "lineItems,vendor" })).data;
    const rec = (po && po.lineItems) ? po : ((po && po.data) || po);
    const allLines = (rec && rec.lineItems) || [];
    const referred = allLines.filter((l) => !LINE_REFERRED_STATUS || String(nameOf(l.moduleState) || l.moduleState || "") === LINE_REFERRED_STATUS);
    const lines = (referred.length ? referred : allLines);
    const invMap = await invoicePricesForPO(rec || {});
    const rows = lines.map((l, idx) => {
      const no = poLineNo(l, idx);
      const inv = invMap[no];
      return {
        lineId: l.id, lineNo: no, description: l.description || "", quantity: l.quantity != null ? l.quantity : "",
        poUnitPrice: l.unitPrice != null ? l.unitPrice : "", invoiceUnitPrice: inv != null ? inv : null,
      };
    });
    const poNo = (rec && (rec.poNumber || rec.name)) || ("PO-" + poId);
    return { po: { id: poId, ref: String(poNo) }, autoMatch: !!INVOICE_LINE_PO_LINE_FIELD, lineCount: rows.length, lines: rows };
  },
});

server.addHandler({
  name: "po_reconcile_apply",
  description: "Update PO line unit prices (to invoice cost or manual values) and drop the PO from the feed. `updates` is a JSON array of {lineId, unitPrice}.",
  parameters: {
    external_id: { description: "referral:purchaseorder:<id>", type: "string" },
    updates: { description: "JSON array string: [{\"lineId\":123,\"unitPrice\":450}]", type: "string" },
    actor: { description: "Optional name/email", type: "string" },
  },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const seg = String(args.external_id).split(":");
    const poId = Number(seg[seg.length - 1]);
    let updates = [];
    try { updates = JSON.parse(args.updates || "[]"); } catch (e) { throw new Error("updates must be a JSON array"); }
    if (!updates.length) throw new Error("no line updates provided");

    // Retry / double-submit: the PO lines were already corrected in a previous
    // call — re-applying would overwrite any later manual edits made in Facilio.
    const done = alreadyActioned(db(), args.external_id);
    if (done) return { ok: true, external_id: args.external_id, updated: 0, idempotent: true };

    const lineItems = updates.map((u) => ({ id: u.lineId, unitPrice: Number(u.unitPrice) }));
    let syncStatus = "synced", syncError = null;
    try {
      await callAction("facilio-cmms", "update-purchase-order", { id: poId, purchaseorder: { lineItems } });
    } catch (e) { syncStatus = "failed"; syncError = String(e && e.message ? e.message : e).slice(0, 300); }

    const d = db();
    if (syncStatus === "failed") {
      upsertState(d, args.external_id, "", "Reconcile PO", nowIso(), "failed: " + syncError);
      return { ok: false, external_id: args.external_id, error: syncError };
    }
    upsertState(d, args.external_id, "true", "Reconcile PO (" + updates.length + " lines)", nowIso(), "synced");
    return { ok: true, external_id: args.external_id, updated: updates.length };
  },
});

function upsertState(d, externalId, actionTaken, actionType, now, syncStatus) {
  const upd = d.query(
    "update job_state set action_taken = $2, action_type = $3, action_taken_at = $4, facilio_sync_status = $5, facilio_synced_at = $4 where external_id = $1",
    [externalId, actionTaken, actionType, now, syncStatus]
  );
  if (!upd.rowCount || upd.rowCount === 0) {
    d.query(
      "insert into job_state (external_id, action_taken, action_type, action_taken_at, facilio_sync_status, facilio_synced_at) values ($1,$2,$3,$4,$5,$4)",
      [externalId, actionTaken, actionType, now, syncStatus]
    );
  }
}

server.execute();
