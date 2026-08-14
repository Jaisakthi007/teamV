import StudioFunctions, { StudioDatabase } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "sweep_jobs" });

/* ------------------------------------------------------------------ infra */

function db() {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

const nowIso = () => new Date().toISOString();
const isoAgo = (h) => new Date(Date.now() - h * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function callAction(connectionSlug, actionSlug, input) {
  const base = process.system.CONNECTIONS_URL;
  if (!base) throw new Error("CONNECTIONS_URL not available to this run");
  const res = await fetch(`${base}/api/v1/connections/${connectionSlug}/actions/${actionSlug}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ input }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${connectionSlug}.${actionSlug} ${res.status}: ${text.slice(0, 250)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const cmms = (slug, input) => callAction("facilio-cmms", slug, input);

function rowsOf(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  for (const c of [resp.data, resp.records, resp.list, resp.result, resp.output]) {
    if (Array.isArray(c)) return c;
  }
  for (const v of Object.values(resp)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }
  return [];
}

async function listAll(slug, input, maxPages) {
  const pages = maxPages || 3;
  const size = input.page_size || 100;
  let out = [];
  for (let page = 1; page <= pages; page++) {
    const rows = rowsOf(await cmms(slug, { ...input, page, page_size: size }));
    out = out.concat(rows);
    if (rows.length < size) break;
  }
  return out;
}

const nameOf = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.name || v.displayName || v.subject || v.primaryValue || "";
  return String(v);
};

const stateOf = (r) => {
  const s = r && r.moduleState;
  if (s == null) return "";
  if (typeof s === "string") return s;
  if (typeof s === "object") return s.status || s.name || s.displayName || "";
  return String(s);
};

function ageLabel(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return Math.max(1, Math.floor(ms / 60000)) + " m old";
  if (h < 48) return h + " h old";
  return Math.floor(h / 24) + " d old";
}

function hoursSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return isNaN(ms) ? null : ms / 3600000;
}

const recUrl = (mod, id) => `https://app.facilio.com/maintenance/goto/summary/${mod}/${id}`;
const money = (n) => (n == null || isNaN(Number(n)) ? "" : Number(n).toLocaleString());

/* --------------------------------------------------------- org constants */
/* Confirmed against module metadata. Labels and stored values differ — an
   earlier `moduleState=Submitted` filter silently matched nothing because the
   stored value is actually "Open". */
const SR_SUBMITTED = "Open";
const SR_ACKNOWLEDGED = "tsrvalidated";
const SR_CLOSED = "Closed";
const PO_REFERRED = "referred";
const PO_ACTIVE = "active";
const WO_DEAD = ["Closed", "Cancelled", "Rejected", "Skipped"];
const SR_RATING_FIELD = "feedback_rating_serviceRequest";

/* The purchase-order list action ACCEPTS a `filters` string, reports success and
   then ignores it — asking for `referred` returns `draft` rows. Verified live.
   So every PO bucket pages the module and filters in code instead. */

/* ------------------------------------------------------------- db writing */

const JOB_COLS = [
  "external_id", "bucket", "bucket_label", "source_module", "source_record_id", "ref", "title", "meta",
  "what_needs_to_be_done", "ai_note", "ai_confidence", "data_confidence", "tone", "flag", "priority",
  "priority_rank", "age_label", "age_color", "status", "source_state", "site", "building", "floor", "space",
  "tenant", "client", "vendor", "requested_by", "assigned_to", "action_suggestions", "record_url", "raw",
  "agent_name", "flow_run_id", "reported_at", "due_at", "acknowledged_at", "detected_at",
];

const BUCKET_LABELS = {
  tsr: "TSR's to acknowledge", tsrack: "Acknowledged TSRs", unblock: "Unblock vendors",
  referral: "Orders awaiting referral", completion: "Orders awaiting completion",
  findings: "Open findings", stalled: "Stalled work orders", quotes: "Vendor comments",
  spot: "Spot checks", tenant: "Tenant dissatisfaction",
};

const NUMC = { source_record_id: true, ai_confidence: true, priority_rank: true };
const JSONC = { action_suggestions: true, raw: true };

function coerce(col, v) {
  if (JSONC[col]) return v == null || v === "" ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (NUMC[col]) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Normal: 3, Low: 4 };
const rankOf = (p) => (PRIORITY_RANK[p] != null ? PRIORITY_RANK[p] : 3);

// The tables were provisioned by CSV import, so there is no unique index on
// external_id and ON CONFLICT is unavailable — update first, insert if absent.
// Shared by the job and signal upserts, which differ only in table, column list
// and coercer; each caller applies its own defaults before calling.
function upsertRow(d, table, allCols, coerceFn, r, now) {
  const setCols = allCols.filter((c) => c !== "external_id");
  const upd = d.query(
    `update ${table} set ${setCols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = $${setCols.length + 2} where external_id = $1`,
    [r.external_id].concat(setCols.map((c) => coerceFn(c, r[c]))).concat([now])
  );
  if (upd.rowCount && upd.rowCount > 0) return "updated";
  const cols = allCols.concat(["created_at", "updated_at"]);
  d.query(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => (c === "created_at" || c === "updated_at" ? now : coerceFn(c, r[c])))
  );
  return "inserted";
}

function upsertJob(d, row, now, flowRunId) {
  const r = { ...row };
  r.bucket_label = r.bucket_label || BUCKET_LABELS[r.bucket] || r.bucket;
  r.status = r.status || "open";
  r.detected_at = r.detected_at || now;
  r.priority = r.priority || "Normal";
  r.priority_rank = rankOf(r.priority);
  r.flow_run_id = r.flow_run_id || flowRunId || "";
  r.agent_name = r.agent_name || "sweep_jobs";
  return upsertRow(d, "job_to_be_done", JOB_COLS, coerce, r, now);
}

/* Seed fallback for buckets with no live source in this org. Rows are marked
   data_confidence='seeded' so a demo row is never mistaken for a real finding. */
function seedRows(d, bucket, limit) {
  const { rows } = d.query(
    "select external_id, ref, title, meta, priority, tone, flag, ai_note, site, tenant, vendor, requested_by, record_url from console_jobs where bucket = $1 limit $2",
    [bucket, limit || 25]
  );
  return rows;
}

/* ---------------------------------------------------------- action sets */

const ACT = {
  tsr: [
    { label: "Acknowledge", kind: "primary", act: "agent", agent: "sr-router", prompt: "{id} - acknowledge this service request" },
    { label: "View", kind: "ghost", act: "open" },
  ],
  tsrack: [
    { label: "Create Tenant Quote", kind: "primary", act: "agent", agent: "sr-router", prompt: "{id} - create a tenant quote for this service request" },
    { label: "Create WO", kind: "ghost", act: "agent", agent: "sr-router", prompt: "{id} - create a work order for this service request" },
    { label: "Close Request", kind: "ghost", act: "open" },
  ],
  referral: [
    { label: "Edit Order", kind: "primary", act: "open" },
    { label: "View Invoice", kind: "ghost", act: "open" },
  ],
  completion: [
    { label: "Complete Order", kind: "primary", act: "open" },
    { label: "View", kind: "ghost", act: "open" },
  ],
  tenant: [
    { label: "Issue Rework Work Order", kind: "primary", act: "agent", agent: "sr-router", prompt: "{id} - issue a rework work order for this service request" },
    { label: "View", kind: "ghost", act: "open" },
  ],
  stalled: [
    { label: "Initiate Procurement", kind: "primary", act: "agent", agent: "sr-router", prompt: "{id} - initiate procurement for this work order" },
    { label: "Raise Direct PO", kind: "ghost", act: "open" },
    { label: "Cancel WO", kind: "ghost", act: "open" },
  ],
  findings: [
    { label: "Create Work Order", kind: "primary", act: "agent", agent: "sr-router" },
    { label: "Raise Letter of Non-compliance", kind: "ghost", act: "open" },
    { label: "Close Finding", kind: "ghost", act: "open" },
  ],
  unblock: [
    { label: "Approve", kind: "primary", act: "open" },
    { label: "Reject", kind: "ghost", act: "open" },
  ],
  quotes: [
    { label: "Reply", kind: "primary", act: "open" },
    { label: "View RFQ", kind: "ghost", act: "open" },
  ],
  spot: [
    { label: "Initiate Spot Check", kind: "primary", act: "open" },
    { label: "Dismiss", kind: "ghost", act: "open" },
  ],
};

const withId = (bucket, id) =>
  (ACT[bucket] || []).map((a) => (a.prompt ? { ...a, prompt: a.prompt.replace("{id}", String(id)) } : a));

/* -------------------------------------------------------------- buckets */

const COLLECTORS = {};

/* tsr — service requests still awaiting acknowledgement. */
COLLECTORS.tsr = async (ctx) => {
  const recs = await listAll(
    "list-service-requests",
    {
      filters: `moduleState=${SR_SUBMITTED}&sysCreatedTime(is_after)=${isoAgo(ctx.windowHours)}`,
      sort_by: "sysCreatedTime", sort_order: "desc",
      expand: "siteId,client,requester", page_size: 100,
    },
    3
  );
  const out = recs.map((r) => {
    const age = hoursSince(r.sysCreatedTime);
    const urgency = nameOf(r.urgency) || nameOf(r.priority);
    const priority = /critical|high/i.test(urgency) ? "High" : age != null && age > 4 ? "Medium" : "Normal";
    return {
      external_id: `tsr:servicerequest:${r.id}`,
      bucket: "tsr", source_module: "servicerequest", source_record_id: r.id,
      ref: "TSR-" + (r.localId || r.id),
      title: r.subject || "(no subject)",
      meta: ["Service request", nameOf(r.siteId) || nameOf(r.site), nameOf(r.requester) ? "Raised by " + nameOf(r.requester) : "", r.sysCreatedTime].filter(Boolean).join(" · "),
      what_needs_to_be_done:
        "Acknowledge this request — confirm whether it is a problem to fix or a price to prepare, and whether the cost is rechargeable to the tenant.",
      priority, tone: priority === "High" ? "critical" : "info",
      flag: age != null && age > 4 ? "Waiting " + Math.floor(age) + " h" : "",
      age_label: ageLabel(r.sysCreatedTime), source_state: stateOf(r),
      site: nameOf(r.siteId) || nameOf(r.site), tenant: nameOf(r.client), client: nameOf(r.client),
      requested_by: nameOf(r.requester), reported_at: r.sysCreatedTime || "",
      data_confidence: "native",
      action_suggestions: withId("tsr", r.id),
      record_url: recUrl("servicerequest", r.id), raw: r,
    };
  });
  return { read: recs.length, rows: out, note: "" };
};

/* tsrack — acknowledged requests with no work order or quote yet. */
COLLECTORS.tsrack = async (ctx) => {
  const srs = await listAll(
    "list-service-requests",
    { filters: `moduleState=${SR_ACKNOWLEDGED}`, sort_by: "sysModifiedTime", sort_order: "desc", expand: "siteId,client,requester", page_size: 100 },
    3
  );
  // No native "requests without a work order" action exists, so the exclusion is
  // an anti-join done here. Match on any work-order/quote field that references
  // the request id; unlinked records simply do not exclude anything.
  const wos = await listAll("list-work-orders", { page_size: 100 }, 2);
  const quotes = await listAll("list-quotes", { page_size: 100 }, 2);
  const linked = new Set();
  const collect = (list) => {
    for (const w of list) {
      for (const k of ["serviceRequest", "serviceRequestId", "sourceId", "requestId", "tsr"]) {
        const v = w[k];
        const id = v && typeof v === "object" ? v.id : v;
        if (id != null) linked.add(Number(id));
      }
    }
  };
  collect(wos); collect(quotes);

  const pending = srs.filter((r) => !linked.has(Number(r.id)));
  const rows = pending.map((r) => ({
    external_id: `tsrack:servicerequest:${r.id}`,
    bucket: "tsrack", source_module: "servicerequest", source_record_id: r.id,
    ref: "TSR-" + (r.localId || r.id),
    title: r.subject || "(no subject)",
    meta: ["Acknowledged", nameOf(r.siteId) || nameOf(r.site), nameOf(r.client), "No WO or quote yet"].filter(Boolean).join(" · "),
    what_needs_to_be_done:
      "Raise the next step for this acknowledged request — a tenant quote if it is chargeable to the tenant, otherwise a work order.",
    priority: "Medium", tone: "warning",
    age_label: ageLabel(r.sysModifiedTime || r.sysCreatedTime), source_state: stateOf(r),
    site: nameOf(r.siteId) || nameOf(r.site), tenant: nameOf(r.client), client: nameOf(r.client),
    requested_by: nameOf(r.requester),
    ai_note: `No linked work order or quote found across ${wos.length} work orders and ${quotes.length} quotes. The link is inferred, not read from a dedicated field.`,
    data_confidence: "derived",
    action_suggestions: withId("tsrack", r.id),
    record_url: recUrl("servicerequest", r.id), raw: r,
  }));
  return {
    read: srs.length, rows,
    note: `${srs.length} acknowledged, ${srs.length - pending.length} already linked to a work order or quote.`,
  };
};

/* referral + completion — purchase orders, filtered in code because the
   module's own filters param is ignored. */
async function poBucket(wantState, build) {
  const all = await listAll("list-purchase-orders", { sort_by: "sysModifiedTime", sort_order: "desc", expand: "vendor", page_size: 200 }, 5);
  const matched = all.filter((p) => stateOf(p) === wantState);
  return {
    read: all.length,
    rows: matched.map(build),
    note: `Scanned ${all.length} purchase orders and matched ${matched.length} in state '${wantState}'. The module ignores its filters parameter, so this was filtered in code.`,
  };
}

COLLECTORS.referral = () =>
  poBucket(PO_REFERRED, (p) => ({
    external_id: `referral:purchaseorder:${p.id}`,
    bucket: "referral", source_module: "purchaseorder", source_record_id: p.id,
    ref: "PO-" + (p.localId || p.id),
    title: p.name || p.description || "(no name)",
    meta: ["Purchase order", nameOf(p.vendor), p.totalCost != null ? "Order " + money(p.totalCost) : ""].filter(Boolean).join(" · "),
    what_needs_to_be_done: "Refer this order on with the variance and justification attached, then send it for approval.",
    priority: "Medium", tone: "warning", flag: "Referral",
    age_label: ageLabel(p.sysModifiedTime), source_state: stateOf(p),
    vendor: nameOf(p.vendor),
    ai_note: "This org exposes no invoice module, so the invoice-vs-order variance cannot be read and is not shown.",
    data_confidence: "native",
    action_suggestions: ACT.referral,
    record_url: recUrl("purchaseorder", p.id), raw: p,
  }));

COLLECTORS.completion = () =>
  poBucket(PO_ACTIVE, (p) => ({
    external_id: `completion:purchaseorder:${p.id}`,
    bucket: "completion", source_module: "purchaseorder", source_record_id: p.id,
    ref: "PO-" + (p.localId || p.id),
    title: p.name || p.description || "(no name)",
    meta: ["Purchase order", nameOf(p.vendor), p.totalCost != null ? money(p.totalCost) : ""].filter(Boolean).join(" · "),
    what_needs_to_be_done: "Confirm the work is signed off and the invoice matched, then complete this order to release payment.",
    priority: "Normal", tone: "info",
    age_label: ageLabel(p.sysModifiedTime), source_state: stateOf(p),
    vendor: nameOf(p.vendor),
    ai_note: "This org has no 'ready to complete' state; 'active' is the closest real state and is used here.",
    data_confidence: "derived",
    action_suggestions: ACT.completion,
    record_url: recUrl("purchaseorder", p.id), raw: p,
  }));

/* tenant — closed requests the tenant was dissatisfied with. */
COLLECTORS.tenant = async () => {
  const recs = await listAll(
    "list-service-requests",
    {
      filters: `moduleState=${SR_CLOSED}`,
      select: `id,localId,subject,moduleState,client,requester,sysModifiedTime,${SR_RATING_FIELD}`,
      sort_by: "sysModifiedTime", sort_order: "desc", expand: "client,requester", page_size: 100,
    },
    2
  );
  const bad = recs.filter((r) => String(r[SR_RATING_FIELD] || "").toLowerCase() === "dissatisfied");
  return {
    read: recs.length,
    rows: bad.map((r) => ({
      external_id: `tenant:servicerequest:${r.id}`,
      bucket: "tenant", source_module: "servicerequest", source_record_id: r.id,
      ref: "TSR-" + (r.localId || r.id),
      title: r.subject || "(no subject)",
      meta: ["Closed", nameOf(r.client), "Rated Dissatisfied"].filter(Boolean).join(" · "),
      what_needs_to_be_done: "Review what was actually done and issue a rework work order if the original fix did not hold.",
      priority: "High", tone: "critical", flag: "Dissatisfied",
      age_label: ageLabel(r.sysModifiedTime), source_state: stateOf(r),
      tenant: nameOf(r.client), client: nameOf(r.client), requested_by: nameOf(r.requester),
      data_confidence: "native",
      action_suggestions: withId("tenant", r.id),
      record_url: recUrl("servicerequest", r.id), raw: r,
    })),
    note: `Rating field is ${SR_RATING_FIELD} with values Satisfied/Neutral/Dissatisfied — there is no star rating in this org.`,
  };
};

/* stalled — work orders idle past 48h with no purchase order raised. */
COLLECTORS.stalled = async (ctx) => {
  const wos = await listAll("list-work-orders", { sort_by: "createdTime", sort_order: "desc", expand: "siteId,vendor", page_size: 100 }, 3);
  const alive = wos.filter((w) => WO_DEAD.indexOf(stateOf(w)) < 0);
  const stale = alive
    .map((w) => ({ w, idleH: hoursSince(w.createdTime || w.sysCreatedTime) }))
    .filter(({ idleH }) => idleH != null && idleH > 48);
  const rows = stale.map(({ w, idleH }) => ({
    external_id: `stalled:workorder:${w.id}`,
    bucket: "stalled", source_module: "workorder", source_record_id: w.id,
    ref: "WO-" + (w.localId || w.id),
    title: w.subject || "(no subject)",
    meta: ["Work order", stateOf(w), nameOf(w.siteId) || nameOf(w.site)].filter(Boolean).join(" · "),
    what_needs_to_be_done: "Initiate procurement for this work order — it has been idle since it was raised.",
    priority: "Medium", tone: "warning",
    flag: "Idle " + Math.floor(idleH / 24) + " d",
    age_label: ageLabel(w.createdTime || w.sysCreatedTime), source_state: stateOf(w),
    site: nameOf(w.siteId) || nameOf(w.site), vendor: nameOf(w.vendor),
    ai_note: "This org exposes no procurement-initiation or RFQ list action, so only the missing purchase order could be verified.",
    data_confidence: "derived",
    action_suggestions: withId("stalled", w.id),
    record_url: recUrl("workorder", w.id), raw: w,
  }));
  return { read: wos.length, rows, note: `${wos.length} work orders scanned, ${stale.length} idle past 48h.` };
};

/* What the console should tell an FM to do for a bucket, when the row came from
   seed data rather than a live record. */
const SEED_TODO = {
  tsr: "Acknowledge this request and confirm how it will be handled.",
  tsrack: "Raise the tenant quote or the work order for this acknowledged request.",
  unblock: "Approve or reject this vendor document so the crew is not held up.",
  referral: "Refer this order on with the variance and justification attached.",
  completion: "Complete this order to release payment.",
  findings: "Assign an owner and raise the corrective work order for this finding.",
  stalled: "Initiate procurement for this work order — it has been idle.",
  quotes: "Reply to the vendor's question on this RFQ.",
  spot: "Initiate a spot check on this vendor.",
  tenant: "Review what was done and issue a rework work order if needed.",
};

/* Why a bucket has no live source in this org. Surfaced on the row so an empty
   or seeded tab is explained rather than looking like a clean live result. */
const LIMITATION = {
  unblock: "list-work-permits returned 0 records and this org exposes no SWMS source.",
  findings: "list-inspections returned 0 records and this org has no findings module.",
  quotes: "list-quotes returned 0 records and this org has no quote/RFQ comment reader.",
  spot: "This org exposes no vendor reopen-rate or review-score source.",
  referral: "No purchase order is in the 'referred' state in this org.",
  completion: "No purchase order is in the 'active' state in this org.",
  stalled: "No work order is older than 48h, and this org exposes no procurement-initiation or RFQ list action.",
  tenant: "No service request is in the 'Closed' state, so no tenant rating exists to read.",
};

function toSeedRow(bucket, s) {
  return {
    external_id: `${bucket}:seed:${s.external_id || s.ref}`,
    bucket, source_module: "console_seed", ref: s.ref, title: s.title,
    meta: s.meta,
    what_needs_to_be_done: SEED_TODO[bucket] || "Review this item.",
    priority: s.priority || "Normal", tone: s.tone || "info", flag: s.flag || "",
    ai_note: s.ai_note || "", data_confidence: "seeded",
    site: s.site, tenant: s.tenant, vendor: s.vendor, requested_by: s.requested_by,
    action_suggestions: ACT[bucket] || [],
    record_url: s.record_url || "", raw: {},
  };
}

/* Buckets with no live source at all in this org. */
function seededCollector(bucket) {
  return async (ctx) => {
    const seeds = seedRows(ctx.d, bucket, 25);
    return { read: 0, rows: seeds.map((s) => toSeedRow(bucket, s)), note: LIMITATION[bucket] || "" };
  };
}

COLLECTORS.unblock = seededCollector("unblock");
COLLECTORS.findings = seededCollector("findings");
COLLECTORS.quotes = seededCollector("quotes");
COLLECTORS.spot = seededCollector("spot");

const JOB_BUCKETS = ["tsr", "tsrack", "unblock", "referral", "completion", "findings", "stalled", "quotes", "spot", "tenant"];

/* -------------------------------------------------------------- handlers */

const runId = (prefix, now) => prefix + now.replace(/[-:.TZ]/g, "").slice(0, 14);

/* flow_run bookkeeping shared by the job sweep and the signal pass. */
function flowRunStart(d, flowRunId, bucket, agent) {
  d.query(
    `insert into flow_run (flow_run_id, bucket, agent_name, status, records_read, records_written, error, started_at, finished_at) values ($1,$2,'${agent}','running',0,0,'',$3,'')`,
    [flowRunId, bucket, nowIso()]
  );
}

function flowRunOk(d, flowRunId, bucket, read, written, note) {
  d.query(
    "update flow_run set status='ok', records_read=$3, records_written=$4, error=$5, finished_at=$6 where flow_run_id=$1 and bucket=$2",
    [flowRunId, bucket, read, written, note, nowIso()]
  );
}

function flowRunError(d, flowRunId, bucket, msg) {
  d.query(
    "update flow_run set status='error', error=$3, finished_at=$4 where flow_run_id=$1 and bucket=$2",
    [flowRunId, bucket, msg, nowIso()]
  );
}

async function doRun(args) {
    const d = db();
    const now = nowIso();
    const flowRunId = (args && args.flow_run_id) || runId("sweep-", now);
    const windowHours = Number(args && args.window_hours) || 24;
    const want = args && args.buckets
      ? String(args.buckets).split(",").map((s) => s.trim()).filter(Boolean)
      : JOB_BUCKETS;

    const ctx = { d, windowHours, flowRunId };
    const results = [];
    let inserted = 0, updated = 0;

    for (const bucket of want) {
      const collect = COLLECTORS[bucket];
      if (!collect) { results.push({ bucket, ok: false, error: "unknown bucket" }); continue; }
      flowRunStart(d, flowRunId, bucket, "sweep_jobs");
      try {
        const res = await collect(ctx);
        const read = res.read;
        let rows = res.rows;
        let note = res.note || "";
        // A live source that qualifies nothing falls back to seed rows so the tab
        // still demonstrates end to end. Provenance stays visible: these rows are
        // written with data_confidence 'seeded', never 'native'.
        let seeded = false;
        if (!rows.length) {
          const seeds = seedRows(d, bucket, 25);
          if (seeds.length) {
            rows = seeds.map((s) => toSeedRow(bucket, s));
            seeded = true;
            note = [note, LIMITATION[bucket] || "", `No live record qualified; fell back to ${seeds.length} seeded rows.`]
              .filter(Boolean).join(" ");
          }
        }
        let ins = 0, upd = 0;
        for (const row of rows) {
          upsertJob(d, row, now, flowRunId) === "inserted" ? ins++ : upd++;
        }
        inserted += ins; updated += upd;
        flowRunOk(d, flowRunId, bucket, read, rows.length, note || "");
        results.push({ bucket, ok: true, read, written: rows.length, inserted: ins, updated: upd, seeded, note });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).slice(0, 300);
        flowRunError(d, flowRunId, bucket, msg);
        results.push({ bucket, ok: false, error: msg });
      }
    }

    return {
      ok: results.every((r) => r.ok),
      flowRunId, ranAt: now,
      bucketsRun: results.length,
      totalInserted: inserted, totalUpdated: updated,
      failed: results.filter((r) => !r.ok).map((r) => ({ bucket: r.bucket, error: r.error })),
      results,
    };
}

server.addHandler({
  name: "run",
  description:
    "Sweep every job bucket: read source records, apply each bucket's qualifying test in code, and upsert the qualifying rows into job_to_be_done.",
  parameters: {
    buckets: { description: "Comma-separated bucket ids; omit to run all ten", type: "string" },
    flow_run_id: { description: "Optional id stamped on every row written", type: "string" },
    window_hours: { description: "Look-back window in hours (default 24)", type: "number" },
  },
  execute: async (args) => doRun(args || {}),
});

server.addHandler({
  name: "counts",
  description: "Count candidate source records per bucket without writing anything.",
  parameters: {},
  execute: async () => {
    const day = isoAgo(24);
    // The eight reads are independent, so they run concurrently. Each resolves to
    // a [key, value] pair and `out` is filled in the array's fixed order, keeping
    // the returned JSON identical to the old sequential version.
    const tryIt = async (k, fn) => { try { return [k, await fn()]; } catch (e) { return [k, "ERROR: " + String(e.message || e).slice(0, 140)]; } };
    const pairs = await Promise.all([
      tryIt("sr_submitted_last_day", async () => rowsOf(await cmms("list-service-requests", { filters: `moduleState=${SR_SUBMITTED}&sysCreatedTime(is_after)=${day}`, page_size: 200 })).length),
      tryIt("sr_acknowledged", async () => rowsOf(await cmms("list-service-requests", { filters: `moduleState=${SR_ACKNOWLEDGED}`, page_size: 200 })).length),
      tryIt("sr_closed", async () => rowsOf(await cmms("list-service-requests", { filters: `moduleState=${SR_CLOSED}`, page_size: 200 })).length),
      tryIt("workorders", async () => rowsOf(await cmms("list-work-orders", { page_size: 200 })).length),
      tryIt("inspections", async () => rowsOf(await cmms("list-inspections", { page_size: 200 })).length),
      tryIt("workpermits", async () => rowsOf(await cmms("list-work-permits", { page_size: 200 })).length),
      tryIt("quotes", async () => rowsOf(await cmms("list-quotes", { page_size: 200 })).length),
      tryIt("po_states", async () => {
        const all = await listAll("list-purchase-orders", { page_size: 200 }, 5);
        const byState = {};
        for (const p of all) { const s = stateOf(p) || "(none)"; byState[s] = (byState[s] || 0) + 1; }
        return { scanned: all.length, byState };
      }),
    ]);
    const out = {};
    for (const [k, v] of pairs) out[k] = v;
    return { checkedAt: nowIso(), counts: out };
  },
});

server.addHandler({
  name: "probe",
  description: "Inspect the real field shape of one source module.",
  parameters: { module: { description: "servicerequest | workorder | purchaseorder | inspection | workpermit | quote", type: "string" } },
  execute: async (args) => {
    const which = (args && args.module) || "servicerequest";
    const map = {
      servicerequest: ["list-service-requests", { expand: "siteId,client,requester" }],
      workorder: ["list-work-orders", { expand: "siteId,vendor" }],
      purchaseorder: ["list-purchase-orders", { expand: "vendor" }],
      inspection: ["list-inspections", {}],
      workpermit: ["list-work-permits", {}],
      quote: ["list-quotes", { expand: "vendor" }],
    };
    const spec = map[which];
    if (!spec) throw new Error("unknown module " + which);
    const rows = rowsOf(await cmms(spec[0], { ...spec[1], page_size: 3 }));
    return { module: which, count: rows.length, sample: rows.map((r) => ({ id: r.id, moduleState: stateOf(r), keys: Object.keys(r) })) };
  },
});

/* ------------------------------------------------------------- signals */

const SIGNAL_COLS = [
  "external_id", "bucket", "bucket_label", "source_module", "source_record_id", "ref", "title", "meta",
  "signal_type", "severity", "tone", "what_needs_to_be_done", "ai_note", "ai_confidence", "data_confidence",
  "vendor", "vendor_id", "site", "tenant", "client", "metric_name", "metric_value", "metric_unit",
  "baseline_value", "variance_value", "variance_pct", "occurrence_count", "sample_size", "period_label",
  "period_start", "period_end", "action_suggestions", "qbr_flag", "status", "record_url", "raw",
  "agent_name", "flow_run_id", "detected_at",
];

const SIGNAL_NUMC = {
  source_record_id: true, ai_confidence: true, vendor_id: true, metric_value: true, baseline_value: true,
  variance_value: true, variance_pct: true, occurrence_count: true, sample_size: true,
};

const SIGNAL_LABELS = {
  sla: "SLA breaches by vendor", quoting: "Abnormal quoting", invoicing: "Invoice vs field report",
};

function coerceSignal(col, v) {
  if (JSONC[col]) return v == null || v === "" ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (SIGNAL_NUMC[col]) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  if (col === "qbr_flag") return v === true || v === "true" ? "true" : "false";
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function upsertSignal(d, row, now, flowRunId) {
  const r = { ...row };
  r.bucket_label = r.bucket_label || SIGNAL_LABELS[r.bucket] || r.bucket;
  r.status = r.status || "open";
  r.detected_at = r.detected_at || now;
  r.flow_run_id = r.flow_run_id || flowRunId || "";
  r.agent_name = r.agent_name || "fm360-signal-analyst";
  return upsertRow(d, "signal", SIGNAL_COLS, coerceSignal, r, now);
}

/* A no-tool agent call: the data goes IN through the prompt and structured
   judgement comes back. Tool-bound agents time out on this platform, so nothing
   here asks the agent to fetch anything. */
function threadIdOf(resp) {
  if (!resp || typeof resp !== "object") return null;
  if (typeof resp.id === "number") return resp.id;
  for (const k of ["threadId", "thread_id"]) if (typeof resp[k] === "number") return resp[k];
  for (const n of [resp.thread, resp.data, resp.result, resp.output]) {
    const t = threadIdOf(n);
    if (t) return t;
  }
  return null;
}

// Agent latency sits close to the ~10s per-fetch ceiling, so a single abort is
// normal rather than a real failure. One retry recovers most of them.
async function askAgentRetry(agentLink, title, message, attempts) {
  const tries = attempts || 2;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await askAgent(agentLink, `${title} try${i + 1}`, message);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function askAgent(agentLink, title, message) {
  const thread = await callAction("facilio-ai-studio", "create-chat-thread", { agent: agentLink, title });
  const threadId = threadIdOf(thread);
  if (!threadId) throw new Error("no threadId from create-chat-thread: " + JSON.stringify(thread).slice(0, 200));
  const reply = await callAction("facilio-ai-studio", "run-agent-chat", { agent: agentLink, threadId, message });
  const content = reply && (reply.content || (reply.result && reply.result.content) || (reply.response && reply.response.content));
  if (reply && reply.error) throw new Error(String(reply.error).slice(0, 200));
  if (!content) throw new Error("no content in agent reply: " + JSON.stringify(reply).slice(0, 200));
  try {
    return typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw new Error("agent reply was not JSON: " + String(content).slice(0, 200));
  }
}

/* ------------------------------------------------- shared signal helpers */

const idOf = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v.id != null) return Number(v.id);
  const n = Number(v);
  return isNaN(n) ? null : n;
};

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

const round2 = (n) => (n == null ? null : Number(Number(n).toFixed(2)));

async function listCustom(module, input, maxPages) {
  const pages = maxPages || 2;
  const size = (input && input.page_size) || 200;
  let out = [];
  for (let page = 1; page <= pages; page++) {
    const rows = rowsOf(await cmms("list-custom-module-records", { ...input, custom_module: module, page, page_size: size }));
    out = out.concat(rows);
    if (rows.length < size) break;
  }
  return out;
}

/* ============================== QUOTING ==============================
   Quote line items compared against the vendor's contracted rate card.
   The rate card is the custom module `custom_ratecard`, whose display name is
   "Site Preferred Supplier Agreement". There is NO foreign key from a quote to
   a rate card, so the join is composed on vendor + site. */

const RATE_FIELDS = {
  // Field names are exact; note the triple underscore between monday and friday.
  normal_hours: "normal_hours_monday___friday__per_hour__custom_ratecard",
  after_hours: "after_hours__per_hour__custom_ratecard",
  saturday: "saturday__per_hour__custom_ratecard",
  sunday: "sunday__per_hour__custom_ratecard",
  call_out: "call_out_fee_custom_ratecard",
};

const BAND_LABEL = {
  normal_hours: "Normal hours (Mon-Fri)", after_hours: "After hours",
  saturday: "Saturday", sunday: "Sunday", call_out: "Call out fee",
};

// Fallback when the classifier agent is unavailable, so the detector still runs.
function bandByKeyword(li) {
  const t = ((li.description || "") + " " + (li.type || "")).toLowerCase();
  if (/call\s*-?\s*out|callout|attendance fee|mobilis|truck fee|service call fee/.test(t)) return "call_out";
  if (/sunday/.test(t)) return "sunday";
  if (/saturday/.test(t)) return "saturday";
  if (/after\s*hours|out of hours|overnight|night shift|public holiday/.test(t)) return "after_hours";
  if (/\bpart|material|supply|filter|valve|cable|hire|disposal|freight|equipment|consumable/.test(t)) return "not_labour";
  if (/labour|labor|technician|electrician|plumber|per hour|hourly|\bhrs?\b/.test(t)) return "normal_hours";
  return "unknown";
}

/* ---------------- Supporting document as a rate source ----------------
   The agreement also carries an uploaded rate card in a FILE field. Reading it
   needs raw DEFLATE, because PDF content streams are Flate-compressed and this
   sandbox has no zlib, no Buffer and no npm inflate. The implementation below is
   RFC 1951 by hand; it is verified byte-exact against zlib on the org's real
   documents. Nothing here fabricates a rate: a document that yields no number
   yields no baseline, and the structured columns are used instead. */

const RATE_DOC_FIELD = "rate_card_supporting_document_custom_ratecard";

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function inflateRaw(input) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  const out = [];

  function bits(n) {
    while (bitCnt < n) {
      if (pos >= input.length) throw new Error("inflate: input exhausted");
      bitBuf |= input[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  }

  function buildHuff(lengths) {
    const count = [], offs = [];
    for (let i = 0; i <= 15; i++) count.push(0);
    for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
    count[0] = 0;
    for (let i = 0; i <= 16; i++) offs.push(0);
    for (let len = 1; len <= 15; len++) offs[len + 1] = offs[len] + count[len];
    const symbols = [];
    for (let i = 0; i < lengths.length; i++) symbols.push(0);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { count, symbols };
  }

  function decodeSym(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const cnt = h.count[len];
      if (code - first < cnt) return h.symbols[index + (code - first)];
      index += cnt;
      first = (first + cnt) << 1;
      code <<= 1;
    }
    throw new Error("inflate: bad huffman code");
  }

  let fixedLit = null, fixedDist = null;
  function fixedTables() {
    if (fixedLit) return;
    const l = [], d = [];
    for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
    for (let i = 0; i < 30; i++) d.push(5);
    fixedLit = buildHuff(l);
    fixedDist = buildHuff(d);
  }

  function block(lit, dist) {
    for (;;) {
      const sym = decodeSym(lit);
      if (sym < 256) { out.push(sym); continue; }
      if (sym === 256) return;
      const si = sym - 257;
      if (si >= LBASE.length) throw new Error("inflate: bad length code");
      const len = LBASE[si] + bits(LEXT[si]);
      const ds = decodeSym(dist);
      if (ds >= DBASE.length) throw new Error("inflate: bad distance code");
      const back = DBASE[ds] + bits(DEXT[ds]);
      if (back > out.length) throw new Error("inflate: distance too far back");
      const start = out.length - back;
      for (let i = 0; i < len; i++) out.push(out[start + i]);
    }
  }

  for (;;) {
    const last = bits(1), type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      if (pos + 4 > input.length) throw new Error("inflate: truncated stored block");
      const len = input[pos] | (input[pos + 1] << 8);
      pos += 4;
      if (pos + len > input.length) throw new Error("inflate: truncated stored data");
      for (let i = 0; i < len; i++) out.push(input[pos++]);
    } else if (type === 1) {
      fixedTables();
      block(fixedLit, fixedDist);
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const clen = [];
      for (let i = 0; i < 19; i++) clen.push(0);
      for (let i = 0; i < hclen; i++) clen[CLORDER[i]] = bits(3);
      const clh = buildHuff(clen);
      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const sym = decodeSym(clh);
        if (sym < 16) { lengths.push(sym); continue; }
        let n, val = 0;
        if (sym === 16) {
          if (!lengths.length) throw new Error("inflate: no previous length");
          val = lengths[lengths.length - 1];
          n = 3 + bits(2);
        } else if (sym === 17) { n = 3 + bits(3); } else { n = 11 + bits(7); }
        while (n--) lengths.push(val);
      }
      block(buildHuff(lengths.slice(0, hlit)), buildHuff(lengths.slice(hlit, hlit + hdist)));
    } else {
      throw new Error("inflate: bad block type");
    }
    if (last) break;
  }

  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out[i];
  return res;
}

// Accepts a zlib-wrapped (RFC 1950) or bare DEFLATE payload.
function inflateAuto(bytes) {
  if (bytes.length > 2 && (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    try { return inflateRaw(bytes.subarray(2)); } catch { /* not zlib after all */ }
  }
  return inflateRaw(bytes);
}

function ascii85Decode(str) {
  let s = String(str).replace(/\s/g, "");
  if (s.slice(0, 2) === "<~") s = s.slice(2);
  const end = s.indexOf("~>");
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let tuple = 0, count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) === "z" && count === 0) { out.push(0, 0, 0, 0); continue; }
    const c = s.charCodeAt(i) - 33;
    if (c < 0 || c > 84) continue;
    tuple = tuple * 85 + c;
    if (++count === 5) {
      out.push((tuple / 16777216) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const b = [(tuple / 16777216) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    for (let i = 0; i < count - 1; i++) out.push(b[i]);
  }
  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out[i];
  return res;
}

function asciiHexDecode(str) {
  const s = String(str).replace(/[^0-9A-Fa-f>]/g, "");
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) {
    if (s.charAt(i) === ">") break;
    out.push(parseInt(s.substr(i, 2), 16));
  }
  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out[i];
  return res;
}

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    let part = "";
    const end = Math.min(i + 8192, bytes.length);
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    s += part;
  }
  return s;
}

function bytesFromLatin1(str) {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 255;
  return b;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// No Buffer or atob in this sandbox, so base64 is decoded by hand. Shared by the
// quoting rate-card document reader and the invoicing FSR reader.
function b64ToBytes(s) {
  const clean = String(s || "").replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_ALPHABET.indexOf(clean.charAt(i)), c1 = B64_ALPHABET.indexOf(clean.charAt(i + 1));
    const h2 = clean.charAt(i + 2), h3 = clean.charAt(i + 3);
    const c2 = h2 ? B64_ALPHABET.indexOf(h2) : 0, c3 = h3 ? B64_ALPHABET.indexOf(h3) : 0;
    if (c0 < 0 || c1 < 0) break;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((n >> 16) & 255);
    if (h2) out.push((n >> 8) & 255);
    if (h3) out.push(n & 255);
  }
  return new Uint8Array(out);
}

function bytesToText(bytes) {
  try { return new TextDecoder("utf-8").decode(bytes); } catch { return ""; }
}

function unescapePdfString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c !== "\\") { out += c; continue; }
    const n = s.charAt(++i);
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n >= "0" && n <= "7") {
      let oct = n;
      for (let k = 0; k < 2 && i + 1 < s.length; k++) {
        const d = s.charAt(i + 1);
        if (d >= "0" && d <= "7") { oct += d; i++; } else break;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 255);
    } else if (n !== "\n") out += n;
  }
  return out;
}

// Show-text operands of a content stream, in drawing order.
function pdfContentTokens(content) {
  const tokens = [];
  const re = /\(((?:\\[\s\S]|[^\\()])*)\)\s*(?:Tj|'|")|\[((?:[^\][]|\\.)*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) {
      tokens.push(unescapePdfString(m[1]));
    } else if (m[2] !== undefined) {
      const sre = /\(((?:\\[\s\S]|[^\\()])*)\)/g;
      let sm, joined = "";
      while ((sm = sre.exec(m[2])) !== null) joined += unescapePdfString(sm[1]);
      if (joined) tokens.push(joined);
    }
  }
  return tokens;
}

/* Text of every decodable content stream. Image streams are skipped; a PDF with
   no text layer (a scan) simply returns no tokens, which the caller treats as
   "not parseable" rather than as an empty rate card. */
function pdfTextTokens(bytes) {
  const s = latin1(bytes);
  const tokens = [];
  let idx = 0, streams = 0, decoded = 0;
  for (;;) {
    const i = s.indexOf("stream", idx);
    if (i < 0) break;
    const dictStart = s.lastIndexOf("<<", i);
    const dict = dictStart >= 0 ? s.slice(dictStart, i) : "";
    let st = i + 6;
    if (s.charAt(st) === "\r") st++;
    if (s.charAt(st) === "\n") st++;
    const e = s.indexOf("endstream", st);
    if (e < 0) break;
    streams++;
    const raw = s.slice(st, e);
    idx = e + 9;
    if (/\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) continue;
    try {
      let data;
      if (/ASCII85Decode|\/A85/.test(dict)) data = ascii85Decode(raw);
      else if (/ASCIIHexDecode|\/AHx/.test(dict)) data = asciiHexDecode(raw);
      else data = bytesFromLatin1(raw);
      if (/FlateDecode|\/Fl\b/.test(dict)) data = inflateAuto(data);
      const t = pdfContentTokens(latin1(data));
      if (t.length) { decoded++; for (let k = 0; k < t.length; k++) tokens.push(t[k]); }
    } catch { /* undecodable stream — skip, do not guess */ }
  }
  return { tokens, streams, decoded };
}

/* Band labels as they appear in a written rate card. Ordered: first match wins,
   so "Saturday" cannot be swallowed by the normal-hours pattern. */
const DOC_BANDS = [
  { band: "call_out", re: /call\s*-?\s*out|callout|attendance\s*fee|mobilisation/i },
  { band: "saturday", re: /saturday|\bsat\b/i },
  { band: "sunday", re: /sunday|\bsun\b|public\s*holiday/i },
  { band: "after_hours", re: /after\s*hours|out\s*of\s*hours|overtime|night\s*shift|non[-\s]*business\s*hours/i },
  { band: "normal_hours", re: /normal\s*hours|ordinary\s*hours|standard\s*(hours|rate)|business\s*hours|mon(day)?\s*[-–—to\s]+\s*fri(day)?/i },
];

function bandOfLabel(s) {
  for (let i = 0; i < DOC_BANDS.length; i++) if (DOC_BANDS[i].re.test(s)) return DOC_BANDS[i].band;
  return null;
}

// Money-ish number. "Not specified" / "N/A" are absent values, never zero.
function parseMoney(s) {
  if (s == null) return null;
  const t = String(s);
  if (/not\s*specified|n\/?a\b|nil\b|tbc|tbd|-{2,}/i.test(t)) return null;
  const m = t.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ""));
  return isFinite(v) ? v : null;
}

/* Ordered text fragments -> rates. Works for PDF show-text operands and for
   CSV/text lines alike. Also lifts the provenance line the generator writes. */
function parseRateCardCells(cells) {
  const seen = {};
  for (let i = 0; i < cells.length; i++) {
    const cell = String(cells[i] == null ? "" : cells[i]);
    const band = bandOfLabel(cell);
    if (!band || seen[band] !== undefined) continue;
    let v = null;
    const selfTail = cell.replace(/^[^0-9]*/, "");
    // A same-cell number only counts when the cell is delimited ("Saturday, 120").
    if (/[,;:\t|]/.test(cell) && parseMoney(selfTail) != null) v = parseMoney(selfTail);
    if (v == null) {
      for (let k = 1; k <= 2 && i + k < cells.length; k++) {
        const nxt = String(cells[i + k] == null ? "" : cells[i + k]);
        if (bandOfLabel(nxt)) break;
        const p = parseMoney(nxt);
        if (p != null) { v = p; break; }
        if (/not\s*specified|n\/?a\b/i.test(nxt)) break;
      }
    }
    seen[band] = v;
  }
  const rates = {};
  let found = 0;
  for (const b in seen) if (seen[b] != null) { rates[b] = seen[b]; found++; }

  const joined = cells.join("\n");
  const pc = joined.match(/Rate\s*Card\s*#(\d+)/i);
  const cur = joined.match(/\b(AUD|USD|GBP|EUR|NZD|SGD|INR)\b/);
  return {
    rates, found,
    labelsSeen: Object.keys(seen).length,
    declaredCardId: pc ? Number(pc[1]) : null,
    currency: cur ? cur[1] : null,
  };
}

function textToCells(text) {
  const cells = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    cells.push(line);
    const parts = line.split(/\s*[,;\t|]\s*/);
    if (parts.length > 1) for (const p of parts) if (p.trim()) cells.push(p.trim());
  }
  return cells;
}

/* Reads the agreement's supporting document and returns the rates it states.
   Cached per rate card so one sweep downloads each document at most once. */
async function rateCardDocRates(card, cache) {
  const key = String(card.id);
  if (cache[key]) return cache[key];
  let res;
  const fail = (reason) => { cache[key] = { ok: false, reason }; return cache[key]; };

  try {
    res = await cmms("download-a-file-field", {
      module_name: "custom_ratecard", record_id: card.id, field_name: RATE_DOC_FIELD,
    });
  } catch (e) {
    return fail("download failed: " + String(e.message || e).slice(0, 90));
  }
  const ct = String((res && res.content_type) || "").toLowerCase();
  const b64 = res && res.file_base64;
  if (!b64) return fail("no file content returned");
  // A missing file comes back as a JSON error envelope wearing a file's clothes.
  if (ct.indexOf("application/json") >= 0) return fail("no document on the field");

  const bytes = b64ToBytes(b64);
  let cells = null, via = null;
  if (ct.indexOf("pdf") >= 0 || (bytes.length > 4 && latin1(bytes.subarray(0, 5)) === "%PDF-")) {
    const ex = pdfTextTokens(bytes);
    if (!ex.tokens.length) {
      return fail(`PDF has no extractable text layer (${ex.streams} stream(s), ${ex.decoded} decoded) — likely a scan, which needs OCR`);
    }
    cells = ex.tokens;
    via = "pdf-text-layer";
    // Matched precisely: an XLSX reports itself as ...openxmlformats..., which a
    // bare "xml" substring test would wrongly accept as readable text.
  } else if (/^text\//.test(ct) || /\/(csv|tsv|json|xml|plain)\b/.test(ct) || /\+(json|xml)\b/.test(ct)) {
    const txt = bytesToText(bytes);
    if (!txt.trim()) return fail("document decoded to empty text");
    cells = textToCells(txt);
    via = "text";
  } else {
    // XLSX and images are zip/binary containers this sandbox cannot open.
    return fail(`unsupported document type '${ct || "unknown"}' — only PDF text layers and text/CSV can be read in-sandbox`);
  }

  const parsed = parseRateCardCells(cells);
  parsed.ok = true;
  parsed.via = via;
  parsed.contentType = ct;
  cache[key] = parsed;
  return parsed;
}

/* Chooses the baseline for one agreement: the supporting document when it is
   readable, self-consistent and priced; the structured columns otherwise.
   A document that names a DIFFERENT agreement is rejected outright — in this org
   the uploaded files are cross-attached, and trusting them would benchmark a
   quote against another vendor's rates. */
async function resolveCardRates(card, cache) {
  const structured = card.rates || {};
  const nStruct = Object.keys(structured).length;
  const fallback = (why) => ({
    rates: structured, source: "columns", confidence: "native",
    sourceLabel: "agreement rate columns",
    note: `Baseline read from the agreement's rate columns (${nStruct} band(s)). ${why}`,
  });

  if (!card.hasDoc) return fallback("No supporting document is attached to this agreement.");

  const doc = await rateCardDocRates(card, cache);
  if (!doc.ok) return fallback(`Supporting document could not be used: ${doc.reason}.`);

  if (doc.declaredCardId != null && doc.declaredCardId !== card.id) {
    return fallback(
      `Supporting document "${card.docName || "attached file"}" was REJECTED: it states it was generated for ` +
      `Rate Card #${doc.declaredCardId}, not this agreement (#${card.id}), so it describes a different vendor/site. ` +
      `This is a data problem on the agreement record, not a parsing failure.`
    );
  }
  if (!doc.found) {
    return fallback(
      `Supporting document "${card.docName || "attached file"}" was read (${doc.labelsSeen} rate row(s) found) but states no ` +
      `numeric rate — every band reads as not specified.`
    );
  }

  const provenance = doc.declaredCardId != null
    ? `Its provenance line names Rate Card #${doc.declaredCardId}, matching this agreement.`
    : `It carries no provenance line, so the match to this agreement rests on the file being attached to it.`;
  const diffs = [];
  for (const b in doc.rates) {
    if (structured[b] != null && structured[b] !== doc.rates[b]) {
      diffs.push(`${BAND_LABEL[b] || b} ${structured[b]}→${doc.rates[b]}`);
    }
  }
  return {
    rates: doc.rates, source: "document", confidence: "derived",
    sourceLabel: `supporting document (${card.docName || "attached file"})`,
    note:
      `Baseline read from the agreement's SUPPORTING DOCUMENT "${card.docName || "attached file"}" ` +
      `via its ${doc.via === "text" ? "text content" : "PDF text layer"} — ${doc.found} rate(s) parsed` +
      `${doc.currency ? " in " + doc.currency : ""}. ${provenance} ` +
      `Label-to-rate matching is heuristic, so this baseline is marked derived rather than native.` +
      (diffs.length ? ` It DISAGREES with the rate columns on: ${diffs.join(", ")}.` : nStruct ? " It agrees with the rate columns." : ""),
    disagreements: diffs,
  };
}

async function loadRateCards() {
  const select = ["id", "name", "moduleState", "siteId", "vendor_custom_ratecard", "contract_custom_ratecard", RATE_DOC_FIELD]
    .concat(Object.keys(RATE_FIELDS).map((k) => RATE_FIELDS[k])).join(",");
  const rows = await listCustom("custom_ratecard", { select, page_size: 200 }, 2);
  const index = {};
  let priced = 0, unpriced = 0, withDoc = 0, docOnly = 0;
  for (const r of rows) {
    const rates = {};
    let has = false;
    for (const band of Object.keys(RATE_FIELDS)) {
      const v = num(r[RATE_FIELDS[band]]);
      if (v != null) { rates[band] = v; has = true; }
    }
    const docMeta = r[RATE_DOC_FIELD];
    const hasDoc = !!(docMeta && docMeta.fileId);
    if (hasDoc) withDoc++;
    // A card with no rate columns is not a zero-priced card. It is still worth
    // keeping when a supporting document might supply the rates instead.
    if (!has) {
      unpriced++;
      if (!hasDoc) continue;
      docOnly++;
    } else {
      priced++;
    }
    const vId = idOf(r.vendor_custom_ratecard), sId = idOf(r.siteId);
    if (vId == null || sId == null) continue;
    const slot = vId + ":" + sId;
    // Several agreements can share a vendor+site. The long-standing behaviour is
    // "last priced card wins"; a card that only has a document must not displace
    // one that carries real rate columns.
    const prior = index[slot];
    if (prior && !has && Object.keys(prior.rates).length) continue;
    index[slot] = {
      id: r.id, name: r.name, rates, contractId: idOf(r.contract_custom_ratecard),
      hasDoc, docName: hasDoc ? docMeta.fileName : null, docType: hasDoc ? docMeta.fileContentType : null,
    };
  }
  return { index, priced, unpriced, withDoc, docOnly, scanned: rows.length };
}

// Contract validity gate. Dates are frequently unset in this org, so an absent
// window is reported rather than treated as either valid or expired.
async function contractStatus(contractId, cache) {
  if (contractId == null) return { ok: false, note: "rate card has no linked contract" };
  if (cache[contractId]) return cache[contractId];
  let res;
  try {
    const r = await cmms("get-custom-module-record", { custom_module: "custom_contracts", id: contractId });
    const c = (r && r.data) || {};
    const state = typeof c.moduleState === "string" ? c.moduleState : nameOf(c.moduleState);
    const from = c.contract_start_date_custom_contracts, to = c.contract_end_date_custom_contracts;
    const active = /active|hold\s*over|roll(ed)?\s*over/i.test(String(state || ""));
    let note = `contract ${c.name || contractId} state '${state || "unknown"}'`;
    if (!from && !to) note += ", no start/end dates set";
    res = { ok: active, state, from, to, name: c.name, note };
  } catch (e) {
    res = { ok: false, note: "contract lookup failed: " + String(e.message || e).slice(0, 80) };
  }
  cache[contractId] = res;
  return res;
}

async function quotingEvidence() {
  const cards = await loadRateCards();
  if (!cards.priced && !cards.docOnly) {
    return {
      items: [],
      note: `Scanned ${cards.scanned} rate cards; none carry a rate value or a readable supporting document, so no quote could be compared.`,
    };
  }

  const quotes = await listAll("list-quotes", {
    expand: "vendor,siteId", sort_by: "sysModifiedTime", sort_order: "desc", page_size: 200,
  }, 2);

  // Pull line items (list-quotes does not return them) and keep only quotes that
  // have a rate card for their vendor+site.
  const candidates = [];
  let noCard = 0;
  for (const q of quotes) {
    const vId = idOf(q.vendor), sId = idOf(q.siteId);
    const card = (vId != null && sId != null) ? cards.index[vId + ":" + sId] : null;
    if (!card) { noCard++; continue; }
    let lines = [];
    try {
      const full = await cmms("get-quote", { id: q.id });
      lines = ((full && full.data && full.data.lineItems) || []);
    } catch {
      continue;
    }
    if (!lines.length) continue;
    candidates.push({ quote: q, card, lines, vendorId: vId, siteId: sId });
  }
  if (!candidates.length) {
    return { items: [], note: `${quotes.length} quotes read; ${noCard} had no rate card for their vendor+site combination.` };
  }

  // Classify each line's rate band. This is the one genuinely ambiguous step —
  // the band is only inferable from the line's own text.
  const allLines = [];
  for (const c of candidates) {
    for (const li of c.lines) {
      allLines.push({ lineId: String(li.id), type: li.type || "", description: li.description || "", quantity: li.quantity, unitPrice: li.unitPrice });
    }
  }
  const bands = {};
  let classifier = "keyword-fallback";
  const CHUNK = 4;
  let okChunks = 0, failChunks = 0;
  for (let i = 0; i < allLines.length; i += CHUNK) {
    const chunk = allLines.slice(i, i + CHUNK);
    try {
      const out = await askAgentRetry(
        "fm360-ratecard-classifier",
        `FM360 ratecard #${Math.floor(i / CHUNK) + 1}`,
        "Classify each of these quote line items into a rate card band.\n\n" + JSON.stringify(chunk)
      );
      for (const it of (out && out.items) || []) {
        if (it.lineId) bands[String(it.lineId)] = { band: it.band, reasoning: it.reasoning, confidence: it.confidence, by: "agent" };
      }
      okChunks++;
    } catch {
      failChunks++;
    }
  }
  if (okChunks && !failChunks) classifier = "agent";
  else if (okChunks) classifier = "agent-partial";
  for (const l of allLines) {
    if (!bands[l.lineId]) bands[l.lineId] = { band: bandByKeyword(l), reasoning: "keyword fallback", confidence: 0.4, by: "keyword" };
  }

  const contractCache = {};
  const docCache = {};
  const baselineCache = {};
  const items = [];
  let quotesChecked = 0, linesChecked = 0;
  const sourceTally = { document: 0, columns: 0 };
  for (const c of candidates) {
    const contract = await contractStatus(c.card.contractId, contractCache);
    // Where this agreement's baseline comes from — the uploaded rate card when it
    // is usable, otherwise the structured columns. Resolved once per agreement.
    let baseline = baselineCache[c.card.id];
    if (!baseline) {
      baseline = await resolveCardRates(c.card, docCache);
      baselineCache[c.card.id] = baseline;
    }
    const cardRates = baseline.rates || {};
    quotesChecked++;
    const over = [];
    let checked = 0, quotedTotal = 0, expectedTotal = 0;
    const skipped = [];
    for (const li of c.lines) {
      const b = bands[String(li.id)] || {};
      const rate = b.band && cardRates[b.band] != null ? cardRates[b.band] : null;
      if (rate == null) { skipped.push({ id: li.id, band: b.band || "unknown", why: b.band === "not_labour" ? "not priced by the rate card" : "no rate for band" }); continue; }
      checked++;
      const unit = num(li.unitPrice), qty = num(li.quantity) || 1;
      if (unit == null) continue;
      quotedTotal += unit * qty;
      expectedTotal += rate * qty;
      if (unit > rate) {
        over.push({ id: li.id, description: li.description, band: b.band, bandLabel: BAND_LABEL[b.band] || b.band,
          unitPrice: unit, rate, quantity: qty, lineVariance: round2((unit - rate) * qty),
          pct: round2(((unit - rate) / rate) * 100), by: b.by, confidence: b.confidence });
      }
    }
    linesChecked += checked;
    if (!over.length) continue;
    sourceTally[baseline.source] = (sourceTally[baseline.source] || 0) + 1;

    const variance = round2(quotedTotal - expectedTotal);
    const pct = expectedTotal > 0 ? round2((variance / expectedTotal) * 100) : null;
    const worst = over.slice().sort((a, b2) => (b2.pct || 0) - (a.pct || 0))[0];
    const inferred = over.filter((o) => o.by === "agent").length;

    items.push({
      external_id: `quoting:quote:${c.quote.id}`,
      bucket: "quoting", source_module: "quote", source_record_id: c.quote.id,
      ref: "QT-" + (c.quote.localId || c.quote.id),
      title: `${nameOf(c.quote.vendor) || "Vendor"} quoted ${pct != null ? pct + "% " : ""}above the contracted rate card`,
      meta: [c.quote.subject, nameOf(c.quote.siteId), `Quoted ${money(quotedTotal)} vs rate card ${money(expectedTotal)}`,
        `Rate card ${c.card.name}`, `Baseline from ${baseline.sourceLabel}`].filter(Boolean).join(" · "),
      signal_type: "abnormal_quote",
      vendor: nameOf(c.quote.vendor), vendor_id: c.vendorId, site: nameOf(c.quote.siteId),
      metric_name: "Quoted vs contracted rate", metric_unit: "currency",
      metric_value: round2(quotedTotal), baseline_value: round2(expectedTotal),
      variance_value: variance, variance_pct: pct,
      occurrence_count: over.length, sample_size: checked,
      period_label: "Current quote", record_url: recUrl("quote", c.quote.id),
      // A document-derived baseline rests on a heuristic label-to-rate match, so
      // it is never claimed as native.
      data_confidence: baseline.confidence,
      baseline_source: baseline.sourceLabel,
      dataConfidenceNote:
        `Baseline source: ${baseline.sourceLabel}. ${baseline.note} ` +
        `Quote line unitPrice is read from the real quote record; the agreement is ${c.card.name} (id ${c.card.id}). ` +
        `Worst line: ${worst.bandLabel} quoted ${worst.unitPrice} against a contracted ${worst.rate}. ` +
        `The rate BAND for each line was inferred from the line's own text (${inferred} of ${over.length} by the classifier agent), ` +
        `because line items carry no structured day/rate discriminator. ` +
        `Quote-to-rate-card join is composed on vendor + site; there is no foreign key. ${contract.note}.` +
        (contract.ok ? "" : " CONTRACT IS NOT ACTIVE — treat the benchmark as indicative only.") +
        (skipped.length ? ` ${skipped.length} line(s) not comparable.` : ""),
      overLines: over,
    });
  }
  const rejected = [];
  for (const k in baselineCache) {
    const b = baselineCache[k];
    if (b.source === "columns" && /REJECTED/.test(b.note)) rejected.push(k);
  }
  return {
    items,
    note: `${quotes.length} quotes, ${quotesChecked} with a rate card, ${linesChecked} lines compared, ${items.length} over rate. ` +
      `Rate cards: ${cards.priced} priced of ${cards.scanned} scanned (${cards.unpriced} have no rates, ${cards.withDoc} carry a supporting document). ` +
      `Baselines used: ${sourceTally.document} from the supporting document, ${sourceTally.columns} from the rate columns` +
      (rejected.length ? `; ${rejected.length} document(s) rejected for naming a different agreement` : "") +
      `. Band classifier: ${classifier}.`,
  };
}

/* ============================== INVOICING ==============================
   Two detectors. (a) invoice vs purchase order, deterministic, real data today.
   (b) field service report vs invoice, agent-read, dormant until an FSR file
   is uploaded to custom_polineinvoices. */

/* Reads an FSR file field and returns plain text.
   Two verified traps handled here:
   - download-a-file-field returns HTTP 400/404 INSIDE ok:true, base64-encoded
     with content_type application/json, so a failure looks like a success.
   - is_not_empty silently no-ops on FILE fields, so emptiness is discovered by
     probing the download rather than by filtering. */
async function readFileFieldText(moduleName, recordId, fieldName) {
  let res;
  try {
    res = await cmms("download-a-file-field", { module_name: moduleName, record_id: recordId, field_name: fieldName });
  } catch (e) {
    return { ok: false, reason: "download failed: " + String(e.message || e).slice(0, 120) };
  }
  const ct = String((res && res.content_type) || "").toLowerCase();
  const b64 = res && res.file_base64;
  if (!b64) return { ok: false, reason: "no file content returned" };

  if (ct.indexOf("application/json") >= 0) {
    // Error envelope masquerading as a file.
    const txt = bytesToText(b64ToBytes(b64)).slice(0, 300);
    return { ok: false, reason: "no file set on the field (" + txt + ")" };
  }
  if (ct.indexOf("text/") >= 0 || ct.indexOf("json") >= 0 || ct.indexOf("csv") >= 0 || ct.indexOf("xml") >= 0) {
    const txt = bytesToText(b64ToBytes(b64));
    if (!txt.trim()) return { ok: false, reason: "file decoded to empty text" };
    return { ok: true, text: txt, via: "text", contentType: ct };
  }
  // Binary — PDF or image. Needs OCR, which is a separate connection.
  const isPdf = ct.indexOf("pdf") >= 0;
  const fileType = isPdf ? "PDF" : ct.indexOf("png") >= 0 ? "PNG" : ct.indexOf("tif") >= 0 ? "TIF" : ct.indexOf("bmp") >= 0 ? "BMP" : ct.indexOf("gif") >= 0 ? "GIF" : "JPG";
  try {
    const ocr = await callAction("ocr-space", "extract-text-from-image-or-pdf", {
      base64_image: "data:" + ct + ";base64," + b64,
      file_type: fileType,
      table_mode: true,
      detect_orientation: true,
      upscale_low_quality: true,
    });
    const text = (ocr && (ocr.text || ocr.ParsedText || ocr.parsed_text)) ||
      (ocr && ocr.pages && ocr.pages.map ? ocr.pages.map((p) => p.text || p.ParsedText || "").join("\n") : "");
    if (!text || !String(text).trim()) return { ok: false, reason: "OCR returned no text from the " + fileType };
    return { ok: true, text: String(text), via: "ocr", contentType: ct };
  } catch (e) {
    return { ok: false, reason: `FSR is a ${fileType} and OCR is unavailable (${String(e.message || e).slice(0, 90)})`, binary: true, contentType: ct };
  }
}

// FSR records for a purchase order. Empty in this org today.
async function fsrForPo(poId) {
  try {
    const rows = await listCustom("custom_polineinvoices", {
      filters: `purchase_order_custom_polineinvoices=${poId}`,
      select: "id,name,moduleState,lineid,po_line_number_custom_polineinvoices,purchase_order_custom_polineinvoices,service_report_custom_polineinvoices",
      page_size: 50,
    }, 1);
    return rows;
  } catch {
    return [];
  }
}

async function invoicingEvidence(opts) {
  const cap = (opts && opts.cap) || 25;
  const invoices = await listAll("list-invoices", {
    expand: "purchaseOrder,vendor", sort_by: "sysModifiedTime", sort_order: "desc", page_size: 200,
  }, 1);

  const linked = [], unlinked = [];
  for (const inv of invoices) {
    (idOf(inv.purchaseOrder) != null ? linked : unlinked).push(inv);
  }

  // Header totals arrive on the list response, so the first pass costs nothing.
  // A matching total does NOT mean the lines agree — quantity and unit price can
  // offset each other — so lines are checked too, header mismatches first.
  const headerMismatch = [], headerMatch = [];
  for (const inv of linked) {
    const po = inv.purchaseOrder || {};
    const iTot = num(inv.totalCost), pTot = num(po.totalCost);
    if (iTot == null || pTot == null) continue;
    (Math.abs(iTot - pTot) > 0.01 ? headerMismatch : headerMatch).push({ inv, po, iTot, pTot });
  }

  const ordered = headerMismatch.concat(headerMatch);
  const truncated = ordered.length > cap;
  const work = ordered.slice(0, cap);
  const items = [];
  let fsrSeen = 0;

  for (const m of work) {
    const poId = idOf(m.po);
    let invLines = [], poLines = [];
    try {
      const full = await cmms("get-invoice", { id: m.inv.id });
      invLines = (full && full.data && full.data.lineItems) || [];
    } catch { /* header totals still compare below */ }
    let poReadError = null;
    try {
      const poFull = await callAction("cbre-clone", "get-purchase-order", { po_id: poId });
      // Shape is { code, data: { purchaseorder: { lineItems: [...] } } } — the
      // purchaseorder level is easy to miss, and missing it silently yields zero
      // lines, which previously looked like a discrepancy on every invoice.
      const pd = (poFull && poFull.data) || poFull || {};
      const poObj = pd.purchaseorder || pd.purchaseOrder || pd;
      poLines = (poObj && poObj.lineItems) || [];
    } catch (e) {
      poReadError = String(e.message || e).slice(0, 100);
    }

    // Invoice lines name their PO line id in the description, e.g.
    // "... | PO Line 1 (PO line item id 82623)".
    const poById = {};
    for (const pl of poLines) poById[String(pl.id)] = pl;
    const lineFindings = [];
    // Not being able to read the order's lines is a gap in evidence, NOT a
    // discrepancy. Treating it as one produced a false positive on every invoice.
    const linesComparable = poLines.length > 0;
    for (let i = 0; linesComparable && i < invLines.length; i++) {
      const il = invLines[i];
      const m2 = /PO line item id\s*(\d+)/i.exec(String(il.description || ""));
      const pl = (m2 && poById[m2[1]]) || poLines[i] || null;
      if (!pl) { lineFindings.push({ invoiceLine: il.id, issue: "invoice has more lines than the order", invoiceCost: num(il.cost) }); continue; }
      const dq = (num(il.quantity) || 0) - (num(pl.quantity) || 0);
      const du = (num(il.unitPrice) || 0) - (num(pl.unitPrice) || 0);
      const dc = (num(il.cost) || 0) - (num(pl.cost) || 0);
      if (Math.abs(dq) > 0.001 || Math.abs(du) > 0.01 || Math.abs(dc) > 0.01) {
        lineFindings.push({
          invoiceLine: il.id, poLine: pl.id, description: il.description,
          invoiceQty: num(il.quantity), poQty: num(pl.quantity),
          invoiceUnitPrice: num(il.unitPrice), poUnitPrice: num(pl.unitPrice),
          invoiceCost: num(il.cost), poCost: num(pl.cost),
          qtyDelta: round2(dq), unitPriceDelta: round2(du), costDelta: round2(dc),
        });
      }
    }

    // FSR path. Nothing exists in this org yet, so this normally adds nothing.
    let fsr = null;
    const fsrRows = await fsrForPo(poId);
    fsrSeen += fsrRows.length;
    if (fsrRows.length) {
      for (const fr of fsrRows) {
        const got = await readFileFieldText("custom_polineinvoices", fr.id, "service_report_custom_polineinvoices");
        if (!got.ok) { fsr = { present: true, readable: false, reason: got.reason, recordId: fr.id }; continue; }
        try {
          const audit = await askAgentRetry(
            "fm360-fsr-auditor",
            "FM360 FSR " + m.inv.id,
            "Compare this field service report against the invoice line items.\n\nFSR TEXT:\n" + String(got.text).slice(0, 6000) +
            "\n\nINVOICE LINE ITEMS:\n" + JSON.stringify(invLines.map((l) => ({ id: l.id, type: l.type, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, cost: l.cost })))
          );
          fsr = { present: true, readable: !!(audit && audit.readable), via: got.via, recordId: fr.id, audit };
          break;
        } catch (e) {
          fsr = { present: true, readable: false, reason: "auditor agent failed: " + String(e.message || e).slice(0, 90), recordId: fr.id };
        }
      }
    }

    const variance = round2(m.iTot - m.pTot);
    const pct = m.pTot > 0 ? round2((variance / m.pTot) * 100) : null;
    const dirWord = variance > 0 ? "above" : "below";
    const hasHeaderVariance = Math.abs(m.iTot - m.pTot) > 0.01;
    const fsrFindings = (fsr && fsr.audit && fsr.audit.discrepancies) || [];

    // Nothing disagreed — an invoice that matches its order is not a signal.
    if (!hasHeaderVariance && !lineFindings.length && !fsrFindings.length) continue;

    const headline = hasHeaderVariance
      ? `${nameOf(m.inv.vendor) || "Vendor"} invoiced ${money(Math.abs(variance))} ${dirWord} the order value`
      : fsrFindings.length
        ? `${nameOf(m.inv.vendor) || "Vendor"} invoice disagrees with the field service report on ${fsrFindings.length} point(s)`
        : `${nameOf(m.inv.vendor) || "Vendor"} invoice matches the order total but ${lineFindings.length} line(s) differ`;

    const fsrNote = !fsrRows.length
      ? "No field service report is attached to this order, so hours and parts could not be verified against a report."
      : fsr && fsr.readable
        ? `Field service report read via ${fsr.via}; ${fsrFindings.length} discrepancy(ies) found.`
        : `A field service report is attached but could not be read: ${(fsr && fsr.reason) || "unknown reason"}.`;

    items.push({
      external_id: `invoicing:invoice:${m.inv.id}`,
      bucket: "invoicing", source_module: "invoice", source_record_id: m.inv.id,
      ref: m.inv.invoiceNumber || ("INV-" + (m.inv.localId || m.inv.id)),
      title: headline,
      meta: [m.inv.subject, `Invoice ${money(m.iTot)} vs order ${money(m.pTot)}`,
        `PO ${m.po.name || poId}`, `${lineFindings.length} line difference(s)`,
        fsrFindings.length ? `${fsrFindings.length} report discrepancy(ies)` : ""].filter(Boolean).join(" · "),
      signal_type: "invoice_variance",
      vendor: nameOf(m.inv.vendor), vendor_id: idOf(m.inv.vendor),
      metric_name: "Invoiced vs ordered", metric_unit: "currency",
      metric_value: round2(m.iTot), baseline_value: round2(m.pTot),
      variance_value: variance, variance_pct: pct,
      occurrence_count: lineFindings.length, sample_size: invLines.length,
      period_label: m.inv.billDate || "Current invoice",
      record_url: recUrl("invoice", m.inv.id),
      data_confidence: fsr && fsr.readable && fsr.via === "ocr" ? "derived" : "native",
      dataConfidenceNote:
        `Invoice total ${m.iTot} against purchase order total ${m.pTot}, both read directly from their records. ` +
        (!linesComparable
          ? `The order's line items could not be read${poReadError ? " (" + poReadError + ")" : ""}, so only the header totals were compared — no line-level check was possible. `
          : lineFindings.length
            ? `${lineFindings.length} line-level difference(s) identified across ${invLines.length} invoice line(s) and ${poLines.length} order line(s). `
            : `All ${invLines.length} invoice line(s) reconcile to the order lines; the variance is at header level only. `) +
        fsrNote,
      lineFindings, fsr,
    });
  }

  return {
    items,
    note: `${invoices.length} invoices read, ${linked.length} linked to a purchase order, ${unlinked.length} skipped as unlinked ` +
      `(their description records no matching PO/SO/UO in this org). ${headerMismatch.length} had a header variance; ` +
      `${work.length} compared line by line` +
      (truncated ? `, capped at ${cap} this run — ${ordered.length - cap} linked invoices not examined.` : ".") +
      ` ${items.length} signal(s) raised.` +
      (fsrSeen ? "" : " No field service report records exist in this org yet, so the FSR audit path found nothing to read."),
  };
}

/* ================================= SLA =================================
   Targets come from the org's real SLA policy, not a hardcoded number.
   Breaches are grouped per vendor and a repeat-history flag is computed. */

/* PRODUCT RULE: a vendor becomes an SLA signal only once it has breached at
   least this many times. One or two late work orders is noise, not a pattern
   worth putting in front of an FM. A vendor below the threshold produces
   NOTHING — not a low-severity card, not a muted row. Single named constant so
   the rule can be retuned in one place. */
const SLA_MIN_BREACHES_PER_VENDOR = 4;

/* Pure: breach rows -> vendors split by the threshold. No I/O and no clock, so
   it can be exercised against real payloads under plain node without deploying.
   `belowThreshold` is returned rather than discarded so the run note can state
   honestly how much was suppressed. */
function groupBreachesByVendor(breaches, minBreaches) {
  const min = minBreaches == null ? SLA_MIN_BREACHES_PER_VENDOR : minBreaches;
  const byVendor = {};
  for (const b of breaches || []) {
    if (!byVendor[b.vendorId]) byVendor[b.vendorId] = { vendorId: b.vendorId, name: b.vendorName, list: [] };
    byVendor[b.vendorId].list.push(b);
  }
  const qualifying = [], belowThreshold = [];
  for (const vId of Object.keys(byVendor)) {
    const g = byVendor[vId];
    (g.list.length >= min ? qualifying : belowThreshold).push(g);
  }
  // Loudest first, so a truncated read still shows the worst offender.
  qualifying.sort((a, b) => b.list.length - a.list.length);
  return { qualifying, belowThreshold, min };
}

async function loadSlaConfig() {
  const pols = await callAction("facilio-process-automation", "list-sla-policies", { moduleName: "workorder" });
  const active = ((pols && pols.items) || []).filter((p) => p.active !== false && p.status !== false);
  if (!active.length) return null;

  const policyId = active[0].id;
  const detail = await callAction("facilio-process-automation", "get-sla-policy", { moduleName: "workorder", policyId });
  const ents = await callAction("facilio-process-automation", "list-sla-entities", { moduleName: "workorder" });

  const entities = {};
  for (const e of (ents && ents.items) || []) {
    entities[String(e.id)] = { name: e.name, toStateId: e.toStateId, breachType: e.breachType };
  }
  // commitments carry their priority in a criteria string, e.g. "( priority = 2732 )"
  const byPriority = {};
  for (const c of (detail && detail.commitments) || []) {
    const m = /priority\s*=\s*(\d+)/.exec(String(c.criteria || ""));
    if (!m) continue;
    const durations = {};
    for (const se of c.slaEntities || []) {
      const secs = num(se.durationPlaceHolder);
      if (secs != null) durations[String(se.slaEntityId)] = secs;
    }
    byPriority[m[1]] = { name: c.name, durations };
  }

  // States that pause the SLA clock. This is why no due date is ever written in
  // this org: every work order sits in a paused state.
  // Work orders report moduleState as a STRING ("Submitted"), not an object with
  // an id, so states must be resolvable by name as well as by id.
  const paused = {}, stateName = {}, idByName = {};
  try {
    const st = await callAction("facilio-process-automation", "list-states", { moduleName: "workorder" });
    for (const s of (st && st.items) || []) {
      const label = s.displayName || s.status || String(s.id);
      stateName[String(s.id)] = label;
      if (s.status) idByName[String(s.status).toLowerCase()] = s.id;
      if (s.displayName) idByName[String(s.displayName).toLowerCase()] = s.id;
      if (s.pauseSLA === true) paused[String(s.id)] = true;
    }
  } catch { /* state list is an enrichment; the policy still evaluates without it */ }

  return { policyId, policyName: detail && detail.name, criteria: detail && detail.criteria, entities, byPriority, paused, stateName, idByName };
}

async function slaEvidence() {
  const cfg = await loadSlaConfig();
  if (!cfg) {
    return { items: [], note: "No active SLA policy is configured for work orders, so no breach could be evaluated." };
  }

  const wos = await listAll("list-work-orders", {
    expand: "vendor,priority,moduleState", sort_by: "createdTime", sort_order: "desc", page_size: 200,
  }, 2);

  const nowMs = Date.now();
  const breaches = [];
  const totalByVendor = {};
  let noVendorBreaches = 0, pausedBreaches = 0, noPolicyMatch = 0;

  for (const w of wos) {
    const vId = idOf(w.vendor);
    if (vId != null) totalByVendor[vId] = (totalByVendor[vId] || 0) + 1;

    // moduleState comes back as a string on work orders, so resolve by name first
    // and fall back to an id if a future response nests the object.
    const stateStr = stateOf(w);
    const stateId = (stateStr && cfg.idByName[String(stateStr).toLowerCase()]) != null
      ? cfg.idByName[String(stateStr).toLowerCase()]
      : idOf(w.moduleState);
    const isPaused = stateId != null && cfg.paused[String(stateId)] === true;
    const created = w.createdTime || w.sysCreatedTime;
    const pId = idOf(w.priority);
    const commitment = pId != null ? cfg.byPriority[String(pId)] : null;

    let kind = null, entityName = null, targetIso = null, overdueH = null;

    // Explicit: a due date the record itself carries, already in the past.
    if (w.dueDate) {
      const t = new Date(w.dueDate).getTime();
      if (!isNaN(t) && t < nowMs) {
        kind = "explicit"; entityName = "Due date"; targetIso = w.dueDate; overdueH = (nowMs - t) / 3600000;
      }
    }
    // Computed: createdTime + the policy duration for this priority, where the
    // record has not reached the entity's target state.
    if (!kind && commitment && created) {
      for (const eid of Object.keys(commitment.durations)) {
        const ent = cfg.entities[eid] || {};
        const reached = ent.toStateId != null && stateId === ent.toStateId;
        const target = new Date(created).getTime() + commitment.durations[eid] * 1000;
        if (!reached && !isNaN(target) && target < nowMs) {
          kind = "computed"; entityName = ent.name || ("entity " + eid);
          targetIso = new Date(target).toISOString(); overdueH = (nowMs - target) / 3600000;
          break;
        }
      }
    }
    if (!kind && !commitment) noPolicyMatch++;
    if (!kind) continue;
    if (isPaused) pausedBreaches++;
    if (vId == null) { noVendorBreaches++; continue; }

    breaches.push({
      woId: w.id, ref: "WO-" + (w.localId || w.id), subject: w.subject || "",
      vendorId: vId, vendorName: nameOf(w.vendor) || ("Vendor " + vId),
      kind, entityName, targetIso, overdueH: round2(overdueH),
      paused: isPaused, created, priorityName: commitment ? commitment.name : "",
      stateName: cfg.stateName[String(stateId)] || "",
    });
  }

  // Vendors under SLA_MIN_BREACHES_PER_VENDOR are dropped here and never reach
  // the item list, so they cannot surface as a quiet low-severity row either.
  const { qualifying, belowThreshold, min: minBreaches } = groupBreachesByVendor(breaches);

  const items = [];
  for (const g of qualifying) {
    const vId = g.vendorId;
    const list = g.list;
    const days = {};
    for (const b of list) days[String(b.created || "").slice(0, 10)] = true;
    const distinctDays = Object.keys(days).filter(Boolean).length;
    const sample = totalByVendor[vId] || list.length;
    const avgOver = list.reduce((a, b) => a + (b.overdueH || 0), 0) / list.length;
    const worst = list.slice().sort((a, b) => (b.overdueH || 0) - (a.overdueH || 0))[0];
    const allPaused = list.every((b) => b.paused);
    const explicit = list.filter((b) => b.kind === "explicit").length;
    const sorted = list.map((b) => String(b.created || "")).filter(Boolean).sort();
    const insufficient = sample < 5 || distinctDays < 2;
    const repeat = distinctDays >= 2;
    const breachPct = sample > 0 ? round2((list.length / sample) * 100) : null;

    items.push({
      external_id: `sla:vendor:${vId}`,
      bucket: "sla", source_module: "workorder", source_record_id: worst ? worst.woId : null,
      ref: g.name,
      title: `${g.name} breached ${entityLabel(list)} on ${list.length} of ${sample} work order${sample === 1 ? "" : "s"}`,
      meta: [`${list.length} of ${sample} work orders breached (${breachPct}%)`,
        `across ${distinctDays} day(s)`,
        `average overrun ${round2(avgOver)} h`,
        repeat ? "repeat offender" : "single-day occurrence",
        allPaused ? "SLA clock paused on every record" : ""].filter(Boolean).join(" · "),
      signal_type: "sla_breach",
      vendor: g.name, vendor_id: Number(vId),
      metric_name: "Average hours past SLA target", metric_unit: "hours",
      metric_value: round2(avgOver), baseline_value: 0,
      variance_value: round2(avgOver),
      // Deliberately null. In the quoting signal variance_pct means "how far above
      // the benchmark price"; a percentage against a zero-hour target is
      // meaningless, and putting the breach RATE here would make the same column
      // mean two different things. The rate lives in occurrence_count/sample_size.
      variance_pct: null,
      occurrence_count: list.length, sample_size: sample,
      period_label: sorted.length ? `${sorted[0].slice(0, 10)} to ${sorted[sorted.length - 1].slice(0, 10)} (${distinctDays} day(s))` : "Current",
      period_start: sorted.length ? sorted[0] : "", period_end: sorted.length ? sorted[sorted.length - 1] : "",
      record_url: worst ? recUrl("workorder", worst.woId) : "",
      data_confidence: "derived",
      dataConfidenceNote:
        `Targets read from SLA policy "${cfg.policyName}" (id ${cfg.policyId}) — ${explicit} of ${list.length} breach(es) came from a due date on the record, the rest were computed as createdTime plus the policy duration for the record's priority. ` +
        (allPaused
          ? `ADVISORY ONLY: every breaching record sits in a state that PAUSES the SLA clock (${worst ? worst.stateName : "paused state"}), which is why no due date was ever written by the platform. These are not asserted contractual breaches. `
          : "") +
        (insufficient
          ? `INSUFFICIENT HISTORY: ${list.length} breach(es) over a sample of ${sample} across ${distinctDays} day(s). A breach rate over time cannot be established from this — do not read it as a trend. `
          : `${list.length} breaches across ${distinctDays} distinct days indicates a repeat pattern. `) +
        `Vendor attribution is via workorder.vendor; service requests carry no vendor field and have no SLA policy, so they are excluded. ` +
        `Raised because this vendor breached ${list.length} time(s), meeting the product rule of at least ${minBreaches} breaches by the same vendor; vendors under that count are not reported at all.`,
      insufficient_history: insufficient,
      repeat_offender: repeat,
      breaches: list.slice(0, 10),
    });
  }

  return {
    items,
    note: `Policy "${cfg.policyName}" (${cfg.policyId}). ${wos.length} work orders scanned, ${breaches.length} breaching with a vendor, ` +
      `${noVendorBreaches} breaching without a vendor (excluded), ${pausedBreaches} on a paused SLA clock, ` +
      `${noPolicyMatch} with no priority commitment in the policy. ` +
      `${qualifying.length + belowThreshold.length} vendor(s) breached at least once; ` +
      `${belowThreshold.length} suppressed for breaching fewer than ${minBreaches} time(s)` +
      (belowThreshold.length
        ? ` (${belowThreshold.map((g) => `${g.name} ${g.list.length}`).join(", ")})`
        : "") +
      `. ${items.length} vendor signal(s).`,
  };
}

function entityLabel(list) {
  const names = {};
  for (const b of list) if (b.entityName) names[b.entityName] = true;
  const k = Object.keys(names);
  return k.length === 1 ? k[0].replace(/ Due Date$/i, "").toLowerCase() + " SLA" : "SLA";
}

async function doSignals(args) {
    const d = db();
    const now = nowIso();
    const flowRunId = (args && args.flow_run_id) || runId("sweep-", now);

    // Each detector reads real records and computes its own comparison. There is
    // no seed fallback here: a detector that finds nothing writes nothing and
    // says so, rather than padding the tab with demo rows.
    const want = args && args.buckets
      ? String(args.buckets).split(",").map((s) => s.trim()).filter(Boolean)
      : ["quoting", "invoicing", "sla"];

    const DETECTORS = {
      quoting: () => quotingEvidence(),
      invoicing: () => invoicingEvidence({ cap: Number(args && args.invoice_cap) || 25 }),
      sla: () => slaEvidence(),
    };

    let evidence = [];
    const notes = {};
    for (const bucket of want) {
      const run = DETECTORS[bucket];
      if (!run) { notes[bucket] = "unknown signal bucket"; continue; }
      flowRunStart(d, flowRunId, bucket, "sweep_signals");
      try {
        const res = await run();
        evidence = evidence.concat(res.items || []);
        notes[bucket] = res.note || "";
        flowRunOk(d, flowRunId, bucket, (res.items || []).length, (res.items || []).length, res.note || "");
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).slice(0, 300);
        notes[bucket] = "ERROR: " + msg;
        flowRunError(d, flowRunId, bucket, msg);
      }
    }

    // Retiring must also happen when nothing qualified — that is exactly the case
    // where yesterday's signals have been resolved and must leave the tab.
    const retireStale = () => {
      let n = 0;
      for (const bucket of want) {
        if (notes[bucket] && String(notes[bucket]).indexOf("ERROR") === 0) continue; // a failed detector must not retire anything
        const r = d.query(
          "update signal set status='resolved', updated_at=$3 where bucket=$1 and status='open' and (flow_run_id is null or flow_run_id <> $2)",
          [bucket, flowRunId, now]
        );
        n += r.rowCount || 0;
      }
      return n;
    };

    if (!evidence.length) {
      return {
        ok: true, flowRunId, evidence: 0, inserted: 0, updated: 0,
        retired: retireStale(), notes,
        message: "No signal qualified; nothing written.",
      };
    }

    let judged = {};
    let agentStatus = "skipped";
    if (!(args && args.skip_agent === "true")) {
      const packet = evidence.map((e) => ({
        external_id: e.external_id, bucket: e.bucket, title: e.title, meta: e.meta,
        metric_name: e.metric_name, metric_value: e.metric_value, metric_unit: e.metric_unit,
        baseline_value: e.baseline_value, variance_value: e.variance_value,
        occurrence_count: e.occurrence_count, sample_size: e.sample_size,
        dataConfidence: e.data_confidence, limitation: e.dataConfidenceNote,
      }));
      // Each fetch is capped at ~10s, and the cost is in generated output, so the
      // packet goes in small chunks. A chunk that fails leaves its rows with the
      // computed evidence and no agent judgement, rather than losing the run.
      const CHUNK = 3;
      let okChunks = 0, failedChunks = 0;
      const errors = [];
      for (let i = 0; i < packet.length; i += CHUNK) {
        const chunk = packet.slice(i, i + CHUNK);
        try {
          const out = await askAgentRetry(
            "fm360-signal-analyst",
            `FM360 signals ${flowRunId} #${Math.floor(i / CHUNK) + 1}`,
            "Interpret this evidence packet and return one entry per item.\n\n" + JSON.stringify(chunk)
          );
          for (const it of (out && out.items) || []) judged[it.external_id] = it;
          okChunks++;
        } catch (e) {
          failedChunks++;
          errors.push(String(e.message || e).slice(0, 120));
        }
      }
      agentStatus = failedChunks === 0 ? "ok" : okChunks === 0 ? "failed: " + errors[0] : `partial (${okChunks} ok, ${failedChunks} failed)`;
    }

    let inserted = 0, updated = 0;
    for (const e of evidence) {
      const j = judged[e.external_id] || {};
      const row = {
        ...e,
        signal_type: j.signal_type || (e.bucket === "sla" ? "sla_breach" : e.bucket === "quoting" ? "abnormal_quote" : "invoice_variance"),
        severity: j.severity || "info",
        tone: j.severity === "critical" || j.severity === "high" ? "critical" : "info",
        what_needs_to_be_done: j.what_needs_to_be_done || "Note this for the quarterly review.",
        ai_note: j.ai_note || e.dataConfidenceNote || "",
        ai_confidence: j.ai_confidence != null ? j.ai_confidence : null,
        action_suggestions: [
          { label: "Snapshot for QBR", kind: "primary", act: "open" },
          { label: "View Detail", kind: "ghost", act: "open" },
        ],
        // Keep the working: the offending lines, the SLA breaches or the FSR audit
        // are what make a signal auditable rather than a bare number.
        raw: {
          overLines: e.overLines, lineFindings: e.lineFindings, fsr: e.fsr,
          breaches: e.breaches, insufficient_history: e.insufficient_history,
          repeat_offender: e.repeat_offender,
          // Where a quoting baseline came from, so the comparison stays auditable.
          baseline_source: e.baseline_source,
        },
      };
      upsertSignal(d, row, now, flowRunId) === "inserted" ? inserted++ : updated++;
    }

    // Retire signals this run no longer detects. Without this a resolved issue
    // stays on the tab forever, because a detector can only ever add rows.
    const retired = retireStale();

    return { ok: true, flowRunId, evidence: evidence.length, inserted, updated, retired, agentStatus, notes };
}

server.addHandler({
  name: "signals",
  description:
    "Detect all three signal types from real records — quote vs rate card, invoice vs purchase order (and FSR when present), and SLA breaches per vendor — then have the signal analyst interpret them.",
  parameters: {
    flow_run_id: { description: "Optional id stamped on every row written", type: "string" },
    buckets: { description: "Comma-separated subset of quoting,invoicing,sla; omit for all three", type: "string" },
    invoice_cap: { description: "Max invoices to examine in detail per run (default 25)", type: "number" },
    skip_agent: { description: "Set 'true' to write the computed evidence without the interpretation pass", type: "string" },
  },
  execute: async (args) => doSignals(args || {}),
});

server.addHandler({
  name: "quoting_signal",
  description: "Detect quote line items priced above the vendor's contracted rate card.",
  parameters: {
    flow_run_id: { description: "Optional flow run id", type: "string" },
    skip_agent: { description: "Set 'true' to skip the interpretation pass", type: "string" },
  },
  execute: async (args) => doSignals({ ...(args || {}), buckets: "quoting" }),
});

server.addHandler({
  name: "invoicing_signal",
  description: "Detect invoices that differ from their purchase order, and audit any attached field service report against the invoice.",
  parameters: {
    flow_run_id: { description: "Optional flow run id", type: "string" },
    invoice_cap: { description: "Max invoices to examine in detail (default 25)", type: "number" },
    skip_agent: { description: "Set 'true' to skip the interpretation pass", type: "string" },
  },
  execute: async (args) => doSignals({ ...(args || {}), buckets: "invoicing" }),
});

server.addHandler({
  name: "sla_signal",
  description: "Detect SLA breaches against the org's real SLA policy and aggregate them per vendor with a repeat-offender history.",
  parameters: {
    flow_run_id: { description: "Optional flow run id", type: "string" },
    skip_agent: { description: "Set 'true' to skip the interpretation pass", type: "string" },
  },
  execute: async (args) => doSignals({ ...(args || {}), buckets: "sla" }),
});

/* ---------------------------------------------------------- prioritize */

async function doPrioritize(args) {
    const d = db();
    const now = nowIso();
    const limit = Math.min(Math.max(1, Number(args && args.limit) || 25), 60);
    const { rows } = d.query(
      // Live rows first, so the agent's ranking budget is spent on real work
      // rather than on seeded demonstration rows.
      "select external_id, bucket, ref, title, meta, priority, flag, age_label, data_confidence, what_needs_to_be_done, site, tenant, vendor from job_to_be_done where status = 'open' and external_id <> '__seed__' order by (case when data_confidence = 'seeded' then 1 else 0 end) asc, coalesce(priority_rank,3) asc, detected_at desc limit $1",
      [limit]
    );
    if (!rows.length) return { ok: true, ranked: 0, message: "No open jobs to prioritize." };

    const packet = rows.map((r) => ({
      external_id: r.external_id, bucket: r.bucket, ref: r.ref, title: r.title, meta: r.meta,
      basePriority: r.priority, flag: r.flag, age: r.age_label, dataConfidence: r.data_confidence,
      currentNextStep: r.what_needs_to_be_done, site: r.site, tenant: r.tenant, vendor: r.vendor,
    }));

    // Chunked for the same ~10s per-fetch reason as the signal pass. A failed
    // chunk simply keeps its deterministic priority.
    const CHUNK = 2;
    const ranked = [];
    const topThree = [];
    const summaries = [];
    let okChunks = 0, failedChunks = 0;
    const errors = [];
    for (let i = 0; i < packet.length; i += CHUNK) {
      const chunk = packet.slice(i, i + CHUNK);
      try {
        const out = await askAgentRetry(
          "fm360-prioritizer",
          `FM360 prioritize ${now} #${Math.floor(i / CHUNK) + 1}`,
          "Re-rank these open jobs and sharpen each next step. Return one entry per job.\n\n" + JSON.stringify(chunk)
        );
        for (const r of (out && out.ranked) || []) ranked.push(r);
        for (const t of (out && out.topThree) || []) topThree.push(t);
        if (out && out.summary) summaries.push(out.summary);
        okChunks++;
      } catch (e) {
        failedChunks++;
        errors.push(String(e.message || e).slice(0, 120));
      }
    }

    if (!ranked.length) {
      return {
        ok: false, ranked: 0, considered: rows.length,
        error: errors[0] || "no ranking returned",
        note: "Deterministic priority from the sweep is unchanged and still valid.",
      };
    }

    let applied = 0;
    for (const r of ranked) {
      if (!r.external_id) continue;
      const p = ["Critical", "High", "Medium", "Normal", "Low"].indexOf(r.priority) >= 0 ? r.priority : null;
      if (!p) continue;
      const res = d.query(
        "update job_to_be_done set priority=$2, priority_rank=$3, what_needs_to_be_done=coalesce(nullif($4,''), what_needs_to_be_done), ai_note=case when $5='' then ai_note else $5 end, agent_name='fm360-prioritizer', updated_at=$6 where external_id=$1",
        [r.external_id, p, rankOf(p), r.what_needs_to_be_done || "", r.reason || "", now]
      );
      applied += res.rowCount || 0;
    }
    return {
      ok: failedChunks === 0, considered: rows.length, ranked: ranked.length, applied,
      chunks: { ok: okChunks, failed: failedChunks },
      errors: errors.slice(0, 3),
      topThree: topThree.slice(0, 3),
      // Each chunk returns its own summary; concatenating them reads as repetitive
      // noise, so report the first and count the rest.
      summary: summaries[0] || "",
      chunkSummaries: summaries.length,
    };
}

server.addHandler({
  name: "prioritize",
  description:
    "Send the top open jobs to the no-tool prioritizer agent and write back its ranking and sharpened next step. Deterministic priority stays in place if the agent fails.",
  parameters: {
    limit: { description: "How many jobs to re-rank (default 25, max 60)", type: "number" },
    flow_run_id: { description: "Optional flow run id", type: "string" },
  },
  execute: async (args) => doPrioritize(args || {}),
});

/* ------------------------------------------------------------- the daily run */

server.addHandler({
  name: "daily",
  description:
    "Scheduler entry point: sweep all ten job buckets, compute and interpret the three signal buckets, then re-rank the queue.",
  parameters: {
    window_hours: { description: "Look-back window in hours (default 24)", type: "number" },
    rank_limit: { description: "How many jobs the prioritizer re-ranks (default 25)", type: "number" },
    invoice_cap: { description: "How many invoices to compare line by line (default 10 here, to keep the whole run inside the job timeout)", type: "number" },
  },
  execute: async (args) => {
    const now = nowIso();
    const flowRunId = runId("daily-", now);
    const out = { flowRunId, ranAt: now };

    // Each stage is independent: a failure in one must not lose the others.
    try {
      out.sweep = await doRun({ flow_run_id: flowRunId, window_hours: args && args.window_hours });
    } catch (e) {
      out.sweep = { ok: false, error: String(e.message || e).slice(0, 250) };
    }
    try {
      // Invoicing is the slowest detector (two extra reads per invoice), so the
      // daily run caps it lower than a manual run to stay inside the job timeout.
      out.signals = await doSignals({ flow_run_id: flowRunId, invoice_cap: Number(args && args.invoice_cap) || 10 });
    } catch (e) {
      out.signals = { ok: false, error: String(e.message || e).slice(0, 250) };
    }
    try {
      out.prioritize = await doPrioritize({ flow_run_id: flowRunId, limit: args && args.rank_limit });
    } catch (e) {
      out.prioritize = { ok: false, error: String(e.message || e).slice(0, 250) };
    }
    out.ok = !!(out.sweep && out.sweep.ok);
    return out;
  },
});

server.execute();
