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

const BUCKET_LABELS = {
  tsr: "TSR's to acknowledge", tsrack: "Acknowledged TSRs", unblock: "Unblock vendors",
  referral: "Orders awaiting referral", completion: "Orders awaiting completion",
  findings: "Open findings", stalled: "Stalled work orders", quotes: "Vendor comments",
  spot: "Spot checks", tenant: "Tenant dissatisfaction", sla: "SLA breaches by vendor",
  quoting: "Abnormal quoting", invoicing: "Invoice vs field report",
};

// ============================================================================
// Referred Orders assumptions — VERIFY/FILL once PO + invoice data exists in the org.
// (org 2931 currently has 0 purchase orders, so these field/status names are from
//  the schemas, not from live records.)
const REFERRED_PO_STATE = "Referred";              // PO moduleState value for referred orders
const LINE_REFERRED_STATUS = "Referred";           // per-line Facilio status to include in the drill-down
const PO_LINE_NUMBER_FIELDS = ["lineNumber", "referenceId", "localId"]; // first present = the PO line's number
// The invoice line's field that carries the PO line number (a CUSTOM field — set its API name here):
const INVOICE_LINE_PO_LINE_FIELD = ""; // e.g. "po_line_number_invoiceLineItem" — empty = auto-match disabled
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
// LIVE BUCKET QUERIES
// Each bucket is a LIVE query against Facilio — module + criteria evaluated at
// read time (no stored copy). `filters` is the bucket's qualifying criteria;
// the FM's action changes the source record so it leaves this criteria and
// drops off the feed. Add a bucket here as you give me its module + criteria.
// ============================================================================
const BUCKETS = {
  tsr: {
    label: BUCKET_LABELS.tsr,
    connection: "facilio-cmms",
    action: "list-service-requests",
    modifiedField: "sysModifiedTime",
    filters: "moduleState=Open",              // status = submitted / to be acknowledged
    expand: "siteId,tenant,tenant_serviceRequest_1",
    select: "id,localId,subject,issue_location_serviceRequest,siteId,tenant,tenant_serviceRequest_1,sysCreatedTime,sysModifiedTime",
    module: "servicerequest",
    signal: false,
    toRow(r) {
      const id = r.id;
      const lid = r.localId && r.localId !== 0 ? r.localId : null;
      const site = nameOf(r.siteId);
      const issue = r.issue_location_serviceRequest || "";
      const location = [site, issue].filter(Boolean).join(" · ");
      const tenant = nameOf(r.tenant_serviceRequest_1) || nameOf(r.tenant);
      const meta = [location || null, tenant ? "Tenant: " + tenant : null].filter(Boolean).join(" · ");
      return {
        external_id: "tsr:servicerequest:" + id, ref: "TSR-" + (lid || id),
        bucket: "tsr", bucket_label: BUCKET_LABELS.tsr, source_module: "servicerequest",
        title: r.subject || "(no subject)", priority: "Normal", tone: "", flag: "",
        meta, ai_note: "", age_label: "", status: "Submitted",
        site: location, tenant, requested_by: "",
        local_id: lid ? String(lid) : "",
        created_time: r.sysCreatedTime || "",
        record_url: "https://app.facilio.com/maintenance/tenantservices/servicerequest/all/" + id + "/overview?tabName=properties",
        system_modified_time: r.sysModifiedTime || "",
        // Acknowledge hands the record to the Service Request Operations team in
        // the console's agent panel, which performs the acknowledge and stays open
        // for the follow-on steps (work order, procurement, RFQ).
        actions: [
          { label: "Acknowledge", kind: "primary", act: "agent", prompt: "Acknowledge this tenant service request." },
          { label: "View", kind: "ghost", act: "open" },
        ],
      };
    },
  },
  tsrack: {
    label: BUCKET_LABELS.tsrack,
    connection: "facilio-cmms",
    action: "list-service-requests",
    modifiedField: "sysModifiedTime",
    filters: "moduleState=tsrvalidated",       // status = Acknowledged
    expand: "siteId,tenant,tenant_serviceRequest_1",
    select: "id,localId,subject,issue_location_serviceRequest,siteId,tenant,tenant_serviceRequest_1,sysCreatedTime,sysModifiedTime,tenant_rechargeable__serviceRequest,tenant_quote_path_serviceRequest",
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
      const meta = [location || null, tenant ? "Tenant: " + tenant : null, qp ? "Quote path: " + qp : null].filter(Boolean).join(" · ");

      // Buttons depend on the tenant quote path. Create Work Order hands the record
      // to the Service Request Operations team in the agent panel (intent-based
      // opening), which raises the WO and stays open for procurement + RFQ.
      const woAction = { label: "Create Work Order", kind: "primary", act: "agent", intent: "create_work_order", prompt: "Raise the work order for this request." };
      const actions = [];
      if (qp === "Provide In-House CBRE Quote") actions.push({ label: "Create Tenant Quote", kind: "primary", act: "quote" });
      else actions.push(woAction);
      actions.push({ label: "View", kind: "ghost", act: "open" });

      return {
        external_id: "tsrack:servicerequest:" + id, ref: "TSR-" + (lid || id),
        bucket: "tsrack", bucket_label: BUCKET_LABELS.tsrack, source_module: "servicerequest",
        title: r.subject || "(no subject)", priority: "Normal", tone: "#FFD405",
        flag: rechargeable ? "Chargeable to tenant" : "",
        meta, ai_note: "", age_label: "", status: "Acknowledged",
        site: location, tenant, requested_by: "",
        local_id: lid ? String(lid) : "",
        created_time: r.sysCreatedTime || "",
        record_url: "https://app.facilio.com/maintenance/tenantservices/servicerequest/all/" + id + "/overview?tabName=properties",
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
          record_url: "",
          system_modified_time: iso(r.sysModifiedTime),
          actions: [{ label: "Approve", kind: "primary", act: "approve" }, { label: "Reject", kind: "ghost", act: "reject" }],
        };
      });
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
          record_url: "https://app.facilio.com/maintenance/goto/summary/purchaseorder/" + id,
          system_modified_time: r.sysModifiedTime || "",
          actions: [{ label: "Review lines", kind: "primary", act: "drill" }, { label: "View", kind: "ghost", act: "open" }],
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
          record_url: "https://app.facilio.com/maintenance/goto/summary/finding/" + id,
          system_modified_time: r.sysModifiedTime || "",
          actions: [{ label: "Close Finding", kind: "ghost", act: "action" }], // primary added client-side after AI classify
        };
      });
    },
  },
  // ── more buckets added here as you provide module + criteria ──
};

// id → name map for vendors (fetched once, ~87 records).
async function vendorMap() {
  try {
    const recs = envelope(await callAction("facilio-cmms", "list-vendors", { select: "id,name", page_size: 200 })).records;
    const m = {};
    for (const v of recs) m[v.id] = v.name;
    return m;
  } catch (e) { return {}; }
}

function hiddenSet(d, bucketId) {
  try {
    const { rows } = d.query("select external_id from job_state where action_taken = 'true' and external_id like $1", [bucketId + ":%"]);
    return new Set(rows.map((r) => r.external_id));
  } catch (e) { return new Set(); }
}
function hiddenCount(d, bucketId) {
  try { return d.query("select count(*)::int as c from job_state where action_taken = 'true' and external_id like $1", [bucketId + ":%"]).rows[0].c; }
  catch (e) { return 0; }
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
          const hidden = hiddenSet(d, id);
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
        const hidden = hiddenCount(d, id);
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
      const hidden = hiddenSet(d, id);
      const all = (await b.loadRows()).filter((r) => !hidden.has(r.external_id));
      const total = all.length;
      const jobs = all.slice((page - 1) * pageSize, page * pageSize);
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

    const hidden = hiddenSet(d, id);
    const jobs = records.map((r) => b.toRow(r, ctxFor(r))).filter((row) => !hidden.has(row.external_id));

    let rawTotal;
    if (b.countMode === "length") {
      const cin = { page: 1, page_size: 200, select: "id" };
      if (b.filters) cin.filters = b.filters;
      rawTotal = envelope(await callAction(b.connection, b.action, cin)).records.length;
    } else {
      rawTotal = count || records.length;
    }
    const total = Math.max(0, rawTotal - hiddenCount(d, id));
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
    external_id: { description: "external_id of the job (tsrack:servicerequest:<id>)", type: "string" },
    amount: { description: "The quoted amount entered by the FM", type: "number" },
    actor: { description: "Optional name/email of who created it", type: "string" },
  },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const amount = Number(args.amount);
    if (!amount || amount <= 0) throw new Error("Enter a valid quoted amount");

    const seg = String(args.external_id).split(":");
    const srId = Number(seg[seg.length - 1]);

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
