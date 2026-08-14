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
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
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
const PO_FILTER_IS_BROKEN = true;

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

const rankOf = (p) => ({ Critical: 0, High: 1, Medium: 2, Normal: 3, Low: 4 }[p] != null ? { Critical: 0, High: 1, Medium: 2, Normal: 3, Low: 4 }[p] : 3);

// The tables were provisioned by CSV import, so there is no unique index on
// external_id and ON CONFLICT is unavailable — update first, insert if absent.
function upsertJob(d, row, now, flowRunId) {
  const r = { ...row };
  r.bucket_label = r.bucket_label || BUCKET_LABELS[r.bucket] || r.bucket;
  r.status = r.status || "open";
  r.detected_at = r.detected_at || now;
  r.priority = r.priority || "Normal";
  r.priority_rank = rankOf(r.priority);
  r.flow_run_id = r.flow_run_id || flowRunId || "";
  r.agent_name = r.agent_name || "sweep_jobs";

  const setCols = JOB_COLS.filter((c) => c !== "external_id");
  const upd = d.query(
    `update job_to_be_done set ${setCols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = $${setCols.length + 2} where external_id = $1`,
    [r.external_id].concat(setCols.map((c) => coerce(c, r[c]))).concat([now])
  );
  if (upd.rowCount && upd.rowCount > 0) return "updated";
  const cols = JOB_COLS.concat(["created_at", "updated_at"]);
  d.query(
    `insert into job_to_be_done (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => (c === "created_at" || c === "updated_at" ? now : coerce(c, r[c])))
  );
  return "inserted";
}

/* Seed fallback for buckets with no live source in this org. Rows are marked
   data_confidence='seeded' so a demo row is never mistaken for a real finding. */
function seedRows(d, bucket, limit) {
  const { rows } = d.query(
    "select external_id, ref, title, meta, priority, tone, flag, ai_note, site, tenant, vendor, requested_by, record_url, actions, status from console_jobs where bucket = $1 limit $2",
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
async function poBucket(bucket, wantState, build) {
  const all = await listAll("list-purchase-orders", { sort_by: "sysModifiedTime", sort_order: "desc", expand: "vendor", page_size: 200 }, 5);
  const matched = all.filter((p) => stateOf(p) === wantState);
  return {
    read: all.length,
    rows: matched.map(build),
    note: `Scanned ${all.length} purchase orders and matched ${matched.length} in state '${wantState}'. The module ignores its filters parameter, so this was filtered in code.`,
  };
}

COLLECTORS.referral = () =>
  poBucket("referral", PO_REFERRED, (p) => ({
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
  poBucket("completion", PO_ACTIVE, (p) => ({
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
  const stale = alive.filter((w) => {
    const h = hoursSince(w.createdTime || w.sysCreatedTime);
    return h != null && h > 48;
  });
  const rows = stale.map((w) => ({
    external_id: `stalled:workorder:${w.id}`,
    bucket: "stalled", source_module: "workorder", source_record_id: w.id,
    ref: "WO-" + (w.localId || w.id),
    title: w.subject || "(no subject)",
    meta: ["Work order", stateOf(w), nameOf(w.siteId) || nameOf(w.site)].filter(Boolean).join(" · "),
    what_needs_to_be_done: "Initiate procurement for this work order — it has been idle since it was raised.",
    priority: "Medium", tone: "warning",
    flag: "Idle " + Math.floor(hoursSince(w.createdTime || w.sysCreatedTime) / 24) + " d",
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

async function doRun(args) {
    const d = db();
    const now = nowIso();
    const flowRunId = (args && args.flow_run_id) || "sweep-" + now.replace(/[-:.TZ]/g, "").slice(0, 14);
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
      const startedAt = nowIso();
      d.query(
        "insert into flow_run (flow_run_id, bucket, agent_name, status, records_read, records_written, error, started_at, finished_at) values ($1,$2,'sweep_jobs','running',0,0,'',$3,'')",
        [flowRunId, bucket, startedAt]
      );
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
        d.query(
          "update flow_run set status='ok', records_read=$3, records_written=$4, error=$5, finished_at=$6 where flow_run_id=$1 and bucket=$2",
          [flowRunId, bucket, read, rows.length, note || "", nowIso()]
        );
        results.push({ bucket, ok: true, read, written: rows.length, inserted: ins, updated: upd, seeded, note });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).slice(0, 300);
        d.query(
          "update flow_run set status='error', error=$3, finished_at=$4 where flow_run_id=$1 and bucket=$2",
          [flowRunId, bucket, msg, nowIso()]
        );
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
    const out = {};
    const day = isoAgo(24);
    const tryIt = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = "ERROR: " + String(e.message || e).slice(0, 140); } };
    await tryIt("sr_submitted_last_day", async () => rowsOf(await cmms("list-service-requests", { filters: `moduleState=${SR_SUBMITTED}&sysCreatedTime(is_after)=${day}`, page_size: 200 })).length);
    await tryIt("sr_acknowledged", async () => rowsOf(await cmms("list-service-requests", { filters: `moduleState=${SR_ACKNOWLEDGED}`, page_size: 200 })).length);
    await tryIt("sr_closed", async () => rowsOf(await cmms("list-service-requests", { filters: `moduleState=${SR_CLOSED}`, page_size: 200 })).length);
    await tryIt("workorders", async () => rowsOf(await cmms("list-work-orders", { page_size: 200 })).length);
    await tryIt("inspections", async () => rowsOf(await cmms("list-inspections", { page_size: 200 })).length);
    await tryIt("workpermits", async () => rowsOf(await cmms("list-work-permits", { page_size: 200 })).length);
    await tryIt("quotes", async () => rowsOf(await cmms("list-quotes", { page_size: 200 })).length);
    await tryIt("po_states", async () => {
      const all = await listAll("list-purchase-orders", { page_size: 200 }, 5);
      const byState = {};
      for (const p of all) { const s = stateOf(p) || "(none)"; byState[s] = (byState[s] || 0) + 1; }
      return { scanned: all.length, byState };
    });
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

  const setCols = SIGNAL_COLS.filter((c) => c !== "external_id");
  const upd = d.query(
    `update signal set ${setCols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = $${setCols.length + 2} where external_id = $1`,
    [r.external_id].concat(setCols.map((c) => coerceSignal(c, r[c]))).concat([now])
  );
  if (upd.rowCount && upd.rowCount > 0) return "updated";
  const cols = SIGNAL_COLS.concat(["created_at", "updated_at"]);
  d.query(
    `insert into signal (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => (c === "created_at" || c === "updated_at" ? now : coerceSignal(c, r[c])))
  );
  return "inserted";
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
  } catch (e) {
    throw new Error("agent reply was not JSON: " + String(content).slice(0, 200));
  }
}

/* Assumed, not configured. This org has no populated responseDueDate, so there
   is no contractual target to read — the number below is a stated assumption and
   every row derived from it is written as data_confidence 'derived'. */
const ASSUMED_RESPONSE_TARGET_H = 4;

async function slaEvidence(d) {
  const open = await listAll(
    "list-service-requests",
    { filters: `moduleState=${SR_SUBMITTED}`, expand: "client,siteId", sort_by: "sysCreatedTime", sort_order: "desc", page_size: 200 },
    3
  );
  const groups = {};
  for (const r of open) {
    const h = hoursSince(r.sysCreatedTime);
    if (h == null) continue;
    const key = nameOf(r.client) || nameOf(r.siteId) || "Unattributed";
    if (!groups[key]) groups[key] = { total: 0, over: 0, hours: [] };
    groups[key].total++;
    groups[key].hours.push(h);
    if (h > ASSUMED_RESPONSE_TARGET_H) groups[key].over++;
  }
  const items = [];
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    if (!g.over) continue;
    const avg = g.hours.reduce((a, b) => a + b, 0) / g.hours.length;
    items.push({
      external_id: `sla:acknowledgement:${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      bucket: "sla", source_module: "servicerequest",
      ref: key, title: `${key} — ${g.over} of ${g.total} requests unacknowledged beyond target`,
      meta: `Open service requests · average age ${avg.toFixed(1)} h · assumed ${ASSUMED_RESPONSE_TARGET_H} h response target`,
      metric_name: "Requests unacknowledged beyond target",
      metric_value: Number(avg.toFixed(2)), metric_unit: "hours",
      baseline_value: ASSUMED_RESPONSE_TARGET_H,
      variance_value: Number((avg - ASSUMED_RESPONSE_TARGET_H).toFixed(2)),
      occurrence_count: g.over, sample_size: g.total,
      period_label: "Currently open", client: key, tenant: key,
      data_confidence: "derived",
      dataConfidenceNote:
        `Computed from real sysCreatedTime values, but the ${ASSUMED_RESPONSE_TARGET_H} h target is ASSUMED — this org has no populated responseDueDate or configured SLA. Vendor attribution is not possible because service requests carry no vendor.`,
    });
  }
  return items;
}

/* quoting — quotes flagged ispricediffered_quote=true by workflow rule 3401207,
   compared against the vendor's rate card (custom_ratecard).
   The list-quotes action ignores its `filters` param entirely — verified live:
   both `ispricediffered_quote=true` and a plain subject(contains) filter returned
   every quote — so this pages the module and filters in code. The custom boolean
   is only present in the payload when explicitly selected. */
const RATECARD_RATE_FIELDS = [
  ["Normal hours (Mon-Fri)", "normal_hours_monday___friday__per_hour__custom_ratecard"],
  ["After hours", "after_hours__per_hour__custom_ratecard"],
  ["Saturday", "saturday__per_hour__custom_ratecard"],
  ["Sunday", "sunday__per_hour__custom_ratecard"],
  ["Call-out fee", "call_out_fee_custom_ratecard"],
];

async function quotingEvidence(d) {
  // The two pre-live seeded rows carried an ai_note claiming this org has no
  // rate card source. custom_ratecard now exists, so that claim is false —
  // retire them rather than keep showing fiction beside real signals.
  const retired = d.query(
    "update signal set status = 'retired', updated_at = $1 where bucket = 'quoting' and data_confidence = 'seeded' and status <> 'retired'",
    [nowIso()]
  );

  const quotes = await listAll(
    "list-quotes",
    {
      select: "id,localId,subject,vendor,siteId,subTotal,totalCost,sysCreatedTime,ispricediffered_quote",
      sort_by: "sysCreatedTime", sort_order: "desc", page_size: 100,
    },
    3
  );
  const flagged = quotes.filter((q) => q.ispricediffered_quote === true);

  const cards = flagged.length
    ? await listAll(
        "list-custom-module-records",
        {
          custom_module: "custom_ratecard",
          select: "id,name,vendor_custom_ratecard,siteId," + RATECARD_RATE_FIELDS.map((f) => f[1]).join(","),
          page_size: 100,
        },
        3
      )
    : [];

  const items = [];
  for (const q of flagged) {
    const resp = await cmms("get-quote", { id: q.id });
    const full = resp && resp.data ? resp.data : resp;
    const lines = Array.isArray(full.lineItems) ? full.lineItems : [];
    let maxLine = null;
    for (const li of lines) {
      if (li.unitPrice != null && (maxLine == null || Number(li.unitPrice) > Number(maxLine.unitPrice))) maxLine = li;
    }
    const quoted = maxLine != null ? Number(maxLine.unitPrice) : null;

    const vendorId = full.vendor && full.vendor.id != null ? Number(full.vendor.id) : null;
    const vendorName = nameOf(full.vendor);
    const siteIdNum = full.siteId && full.siteId.id != null ? Number(full.siteId.id) : null;
    const siteName = nameOf(full.siteId);

    // Prefer a card for this vendor at this site; fall back to any card for the
    // vendor. Baseline is the HIGHEST rate on the card — conservative: a quote
    // above it exceeds every rate the vendor ever agreed to.
    const vendorCards = cards.filter((c) => c.vendor_custom_ratecard && Number(c.vendor_custom_ratecard.id) === vendorId);
    const siteCards = vendorCards.filter((c) => c.siteId && Number(c.siteId.id) === siteIdNum);
    const pool = siteCards.length ? siteCards : vendorCards;
    let card = null, baseline = null, baselineLabel = "";
    for (const c of pool) {
      for (const [label, f] of RATECARD_RATE_FIELDS) {
        const v = c[f];
        if (v != null && !isNaN(Number(v)) && (baseline == null || Number(v) > baseline)) {
          baseline = Number(v);
          baselineLabel = label;
          card = c;
        }
      }
    }

    const variance = quoted != null && baseline != null ? Number((quoted - baseline).toFixed(2)) : null;
    const variancePct = variance != null && baseline ? Number(((variance / baseline) * 100).toFixed(2)) : null;

    const cardRates = {};
    if (card) for (const [label, f] of RATECARD_RATE_FIELDS) { if (card[f] != null) cardRates[label] = Number(card[f]); }

    items.push({
      external_id: `quoting:quote:${q.id}`,
      bucket: "quoting", source_module: "quote", source_record_id: q.id,
      ref: "Q-" + (q.localId || q.id),
      title: card
        ? `${vendorName || "Vendor"} quoted above their rate card`
        : `${vendorName || "Vendor"} quote flagged as price-differed (no rate card found)`,
      meta: [
        full.subject || "(no subject)",
        siteName,
        quoted != null ? `Quoted ${money(quoted)}/unit` + (maxLine && maxLine.description ? ` (${maxLine.description})` : "") : "",
        baseline != null ? `Rate card max ${money(baseline)} (${baselineLabel})` : "No rate card for this vendor",
      ].filter(Boolean).join(" · "),
      vendor: vendorName, vendor_id: vendorId, site: siteName,
      metric_name: "max_quoted_rate",
      metric_value: quoted, metric_unit: "per hour",
      baseline_value: baseline,
      variance_value: variance,
      variance_pct: variancePct,
      period_label: "Current open quotes",
      data_confidence: "native",
      dataConfidenceNote: card
        ? `Flagged natively by workflow rule (ispricediffered_quote=true) at quote creation. Baseline read from rate card '${card.name}' (#${card.id}); ${baseline != null ? `highest agreed rate is ${baseline} (${baselineLabel})` : "no rates set"}. Quoted line prices are real; which rate class applies to each line is inferred from the line description, not a structured field.`
        : "Flagged natively by workflow rule (ispricediffered_quote=true) at quote creation, but no custom_ratecard row matches this vendor, so no baseline or variance could be computed.",
      record_url: recUrl("quote", q.id),
      raw: {
        quoteId: q.id, subject: full.subject, subTotal: full.subTotal, totalCost: full.totalCost,
        lineItems: lines.map((li) => ({ description: li.description, quantity: li.quantity, unitPrice: li.unitPrice, cost: li.cost })),
        ratecard: card ? { id: card.id, name: card.name, rates: cardRates } : null,
      },
    });
  }

  return {
    items,
    retiredSeeds: retired.rowCount || 0,
    note:
      `${flagged.length} of ${quotes.length} quotes carry ispricediffered_quote=true` +
      (flagged.length ? "." : "; no abnormal-quoting signals this run.") +
      (retired.rowCount ? ` Retired ${retired.rowCount} seeded placeholder row(s).` : "") +
      " list-quotes ignores its filters param (verified), so quotes were paged and filtered in code.",
  };
}

function seedSignalEvidence(d, bucket, unavailable) {
  return seedRows(d, bucket, 10).map((s) => ({
    external_id: `${bucket}:seed:${s.external_id || s.ref}`,
    bucket, source_module: "console_seed", ref: s.ref, title: s.title, meta: s.meta,
    vendor: s.vendor || "", data_confidence: "seeded",
    dataConfidenceNote: unavailable,
  }));
}

async function doSignals(args) {
    const d = db();
    const now = nowIso();
    const flowRunId = (args && args.flow_run_id) || "sweep-" + now.replace(/[-:.TZ]/g, "").slice(0, 14);

    let evidence = [];
    const notes = {};
    try {
      const sla = await slaEvidence(d);
      evidence = evidence.concat(sla);
      notes.sla = `${sla.length} tenant/site groups over the assumed ${ASSUMED_RESPONSE_TARGET_H}h target.`;
    } catch (e) {
      notes.sla = "ERROR: " + String(e.message || e).slice(0, 160);
    }
    try {
      const q = await quotingEvidence(d);
      evidence = evidence.concat(q.items);
      notes.quoting = q.note;
    } catch (e) {
      notes.quoting = "ERROR: " + String(e.message || e).slice(0, 160);
    }
    const invoicing = seedSignalEvidence(d, "invoicing", "This org has no invoice module and no field service report source, so the comparison cannot be made.");
    evidence = evidence.concat(invoicing);
    notes.invoicing = `${invoicing.length} seeded rows (no invoice source exists).`;

    if (!evidence.length) return { ok: true, flowRunId, written: 0, notes, message: "No signal evidence to write." };

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
        raw: e.raw || {},
      };
      upsertSignal(d, row, now, flowRunId) === "inserted" ? inserted++ : updated++;
    }
    return { ok: true, flowRunId, evidence: evidence.length, inserted, updated, agentStatus, notes };
}

server.addHandler({
  name: "signals",
  description:
    "Compute evidence for the three signal tabs, have the no-tool signal analyst interpret it, and upsert the result into the signal module.",
  parameters: {
    flow_run_id: { description: "Optional id stamped on every row written", type: "string" },
    skip_agent: { description: "Set 'true' to write the computed evidence without the agent pass", type: "string" },
  },
  execute: async (args) => doSignals(args || {}),
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
  },
  execute: async (args) => {
    const now = nowIso();
    const flowRunId = "daily-" + now.replace(/[-:.TZ]/g, "").slice(0, 14);
    const out = { flowRunId, ranAt: now };

    // Each stage is independent: a failure in one must not lose the others.
    try {
      out.sweep = await doRun({ flow_run_id: flowRunId, window_hours: args && args.window_hours });
    } catch (e) {
      out.sweep = { ok: false, error: String(e.message || e).slice(0, 250) };
    }
    try {
      out.signals = await doSignals({ flow_run_id: flowRunId });
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
