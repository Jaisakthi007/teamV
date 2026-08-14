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
        actions: [{ label: "Acknowledge", kind: "primary", act: "action" }, { label: "View", kind: "ghost", act: "open" }],
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

      // Buttons depend on the tenant quote path
      const actions = [];
      if (qp === "Procure Vendor Quotes") actions.push({ label: "Create Work Order", kind: "primary", act: "action" });
      else if (qp === "Provide In-House CBRE Quote") actions.push({ label: "Create Tenant Quote", kind: "primary", act: "quote" });
      else actions.push({ label: "Create Work Order", kind: "primary", act: "action" });
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
    connection: "facilio-cmms",
    action: "list-work-permits",
    modifiedField: "sysModifiedTime",
    filters: "moduleState=awaitingfmapproval",   // Awaiting FM Approval
    expand: "vendor,siteId",
    module: "workpermit",
    signal: false,
    countMode: "length",       // include_count isn't populated for permits
    resolveVendors: true,      // vendor comes back as an id; resolve to a name
    toRow(r, ctx) {
      const id = r.id;
      const lid = r.localId && r.localId !== 0 ? r.localId : null;
      const type = typeof r.workPermitType === "string" ? r.workPermitType : nameOf(r.workPermitType);
      const vendorName = (ctx && ctx.vendorName) || "";
      const meta = [type || null, vendorName ? "Vendor: " + vendorName : null].filter(Boolean).join(" · ");
      return {
        external_id: "unblock:workpermit:" + id, ref: "PMT-" + (lid || id),
        bucket: "unblock", bucket_label: BUCKET_LABELS.unblock, source_module: "workpermit",
        title: r.name || ("Work permit " + id), priority: "Normal", tone: "#FFD405", flag: "Permit",
        meta, ai_note: "", age_label: "", status: "Awaiting FM Approval",
        site: nameOf(r.siteId), tenant: "", requested_by: "",
        local_id: lid ? String(lid) : "",
        created_time: r.sysCreatedTime || "",
        valid_from: r.expectedStartTime || "", valid_to: r.expectedEndTime || "",
        record_url: "",
        system_modified_time: r.sysModifiedTime || "",
        actions: [{ label: "Approve", kind: "primary", act: "approve" }, { label: "Reject", kind: "ghost", act: "reject" }],
      };
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
