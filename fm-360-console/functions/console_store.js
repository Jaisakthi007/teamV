import StudioFunctions, { StudioDatabase } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "console_store" });

function db() {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

function nowIso() {
  return new Date().toISOString();
}

// Handler params may only be "number" or "string", so structured input arrives
// as a JSON string and is parsed here.
function parseJson(raw, what) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${what} must be valid JSON: ${e.message}`);
  }
}

const BUCKET_LABELS = {
  tsr: "TSR's to acknowledge",
  tsrack: "Acknowledged TSRs",
  unblock: "Unblock vendors",
  referral: "Orders awaiting referral",
  completion: "Orders awaiting completion",
  findings: "Open findings",
  stalled: "Stalled work orders",
  quotes: "Vendor comments",
  spot: "Spot checks",
  tenant: "Tenant dissatisfaction",
  sla: "SLA breaches by vendor",
  quoting: "Abnormal quoting",
  invoicing: "Invoice vs field report",
};

const JOB_BUCKETS = ["tsr", "tsrack", "unblock", "referral", "completion", "findings", "stalled", "quotes", "spot", "tenant"];
const SIGNAL_BUCKETS = ["sla", "quoting", "invoicing"];

const JOB_COLS = [
  "external_id", "bucket", "bucket_label", "source_module", "source_record_id", "ref", "title", "meta",
  "what_needs_to_be_done", "ai_note", "ai_confidence", "data_confidence", "tone", "flag", "priority",
  "priority_rank", "age_label", "age_color", "status", "source_state", "site", "building", "floor", "space",
  "tenant", "client", "vendor", "requested_by", "assigned_to", "action_suggestions", "record_url", "raw",
  "agent_name", "flow_run_id", "reported_at", "due_at", "acknowledged_at", "detected_at",
];

const SIGNAL_COLS = [
  "external_id", "bucket", "bucket_label", "source_module", "source_record_id", "ref", "title", "meta",
  "signal_type", "severity", "tone", "what_needs_to_be_done", "ai_note", "ai_confidence", "data_confidence",
  "vendor", "vendor_id", "site", "tenant", "client", "metric_name", "metric_value", "metric_unit",
  "baseline_value", "variance_value", "variance_pct", "occurrence_count", "sample_size", "period_label",
  "period_start", "period_end", "action_suggestions", "qbr_flag", "status", "record_url", "raw",
  "agent_name", "flow_run_id", "detected_at",
];

// The table was provisioned by CSV import, so these are the only non-text columns.
const NUM_COLS = {
  source_record_id: true, ai_confidence: true, priority_rank: true, vendor_id: true, metric_value: true,
  baseline_value: true, variance_value: true, variance_pct: true, occurrence_count: true, sample_size: true,
};
// Serialized as JSON strings — the CSV-provisioned table has only text columns.
const JSON_COLS = { action_suggestions: true, raw: true };

const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Signal: 3, Normal: 3, Low: 4 };

function coerce(col, v) {
  if (JSON_COLS[col]) {
    if (v == null || v === "") return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  if (NUM_COLS[col]) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  if (col === "qbr_flag") {
    return v === true || v === "true" || v === 1 || v === "1" ? "true" : "false";
  }
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

// There is no unique index on external_id (CSV import cannot create one), so
// ON CONFLICT is unavailable — update first, insert only if nothing matched.
function upsert(d, table, cols, row, flowRunId, now) {
  if (!row.external_id) throw new Error("external_id is required on every record");
  if (!row.bucket) throw new Error("bucket is required on every record");

  const r = {};
  for (const k of Object.keys(row)) r[k] = row[k];
  if (!r.bucket_label) r.bucket_label = BUCKET_LABELS[r.bucket] || r.bucket;
  if (flowRunId && !r.flow_run_id) r.flow_run_id = flowRunId;
  if (!r.status) r.status = "open";
  if (!r.detected_at) r.detected_at = now;
  if (r.priority && r.priority_rank == null) r.priority_rank = PRIORITY_RANK[r.priority] != null ? PRIORITY_RANK[r.priority] : 3;

  const setCols = cols.filter((c) => c !== "external_id");
  const setClause = setCols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const updVals = [r.external_id].concat(setCols.map((c) => coerce(c, r[c])));
  const upd = d.query(`update ${table} set ${setClause}, updated_at = $${setCols.length + 2} where external_id = $1`, updVals.concat([now]));
  if (upd.rowCount && upd.rowCount > 0) return "updated";

  const insCols = cols.concat(["created_at", "updated_at"]);
  const placeholders = insCols.map((_, i) => `$${i + 1}`).join(", ");
  const insVals = insCols.map((c) => (c === "created_at" || c === "updated_at" ? now : coerce(c, r[c])));
  d.query(`insert into ${table} (${insCols.join(", ")}) values (${placeholders})`, insVals);
  return "inserted";
}

// ---------------------------------------------------------------- housekeeping

server.addHandler({
  name: "purge_seed",
  description: "Remove the placeholder rows left by the CSV import that provisioned the tables. Idempotent.",
  parameters: {},
  execute: async () => {
    const d = db();
    const a = d.query("delete from job_to_be_done where external_id = '__seed__'");
    const b = d.query("delete from signal where external_id = '__seed__'");
    const c = d.query("delete from flow_run where flow_run_id = '__seed__'");
    return {
      ok: true,
      removed: { job_to_be_done: a.rowCount || 0, signal: b.rowCount || 0, flow_run: c.rowCount || 0 },
    };
  },
});

server.addHandler({
  name: "schema",
  description: "Report the columns of job_to_be_done, signal and flow_run so an agent can build a valid record.",
  parameters: {},
  execute: async () => {
    const d = db();
    const { rows } = d.query(
      "select table_name, column_name, data_type from information_schema.columns where table_schema = current_schema() and table_name in ('job_to_be_done','signal','flow_run') order by table_name, ordinal_position"
    );
    const out = {};
    for (const r of rows) {
      if (!out[r.table_name]) out[r.table_name] = [];
      out[r.table_name].push({ column: r.column_name, type: r.data_type });
    }
    return { tables: out, jobBuckets: JOB_BUCKETS, signalBuckets: SIGNAL_BUCKETS };
  },
});

// ------------------------------------------------------------------- writes

// upsert_jobs and upsert_signals differ only in whitelist, table, columns and
// the noun in the rejection message — one body so fixes land in both.
function bulkUpsert(args, table, cols, buckets, noun) {
  let list = parseJson(args.items, "items");
  if (!list) {
    const one = parseJson(args.item, "item");
    if (one) list = [one];
  }
  if (!list || !list.length) throw new Error("Provide items (JSON array) or item (JSON object)");
  if (!Array.isArray(list)) throw new Error("items must be a JSON array");
  const d = db();
  const now = nowIso();
  let inserted = 0, updated = 0;
  const rejected = [];
  for (const row of list) {
    if (buckets.indexOf(row.bucket) < 0) {
      rejected.push({ external_id: row.external_id, reason: `bucket '${row.bucket}' is not a ${noun} bucket (${buckets.join("|")})` });
      continue;
    }
    upsert(d, table, cols, row, args.flow_run_id, now) === "inserted" ? inserted++ : updated++;
  }
  return { ok: true, total: list.length, inserted, updated, rejected };
}

server.addHandler({
  name: "upsert_jobs",
  description:
    "Insert or update job_to_be_done records. Pass `items` as a JSON array string (or `item` as a single JSON object string). Deduplicates on external_id.",
  parameters: {
    items: { description: "JSON array string of job records", type: "string" },
    item: { description: "JSON object string for a single job record", type: "string" },
    flow_run_id: { description: "Optional flow run id stamped on every record", type: "string" },
  },
  execute: async (args) => bulkUpsert(args, "job_to_be_done", JOB_COLS, JOB_BUCKETS, "job"),
});

server.addHandler({
  name: "upsert_signals",
  description:
    "Insert or update signal records. Pass `items` as a JSON array string (or `item` as a single JSON object string). Deduplicates on external_id.",
  parameters: {
    items: { description: "JSON array string of signal records", type: "string" },
    item: { description: "JSON object string for a single signal record", type: "string" },
    flow_run_id: { description: "Optional flow run id stamped on every record", type: "string" },
  },
  execute: async (args) => bulkUpsert(args, "signal", SIGNAL_COLS, SIGNAL_BUCKETS, "signal"),
});

// -------------------------------------------------------------------- reads

// list_jobs and list_signals differ only in table, sort order and result key.
function listTable(args, table, orderBy, key) {
  const d = db();
  const conds = ["external_id <> '__seed__'"];
  const p = [];
  const status = args.status || "open";
  if (status !== "all") { p.push(status); conds.push(`status = $${p.length}`); }
  if (args.bucket) { p.push(args.bucket); conds.push(`bucket = $${p.length}`); }
  const where = "where " + conds.join(" and ");
  const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200);
  const offset = Math.max(0, Number(args.offset) || 0);
  const total = d.query(`select count(*)::int as c from ${table} ${where}`, p).rows[0].c;
  const { rows } = d.query(
    `select * from ${table} ${where} order by ${orderBy} limit $${p.length + 1} offset $${p.length + 2}`,
    p.concat([limit, offset])
  );
  for (const r of rows) {
    try { r.action_suggestions = JSON.parse(r.action_suggestions || "[]"); } catch { r.action_suggestions = []; }
  }
  return { total, limit, offset, [key]: rows };
}

server.addHandler({
  name: "list_jobs",
  description: "List job_to_be_done records. Filter by bucket and/or status (default 'open', 'all' for everything).",
  parameters: {
    bucket: { description: "Optional bucket id", type: "string" },
    status: { description: "Status filter, default 'open'; 'all' for everything", type: "string" },
    limit: { description: "Max rows (default 50, max 200)", type: "number" },
    offset: { description: "Rows to skip (default 0)", type: "number" },
  },
  execute: async (args) =>
    listTable(
      args,
      "job_to_be_done",
      // Live records always outrank seeded demo rows, whatever their priority —
      // a demonstration row must never sit above real work.
      "(case when data_confidence = 'seeded' then 1 else 0 end) asc, coalesce(priority_rank,3) asc, detected_at desc",
      "jobs"
    ),
});

server.addHandler({
  name: "list_signals",
  description: "List signal records. Filter by bucket and/or status (default 'open', 'all' for everything).",
  parameters: {
    bucket: { description: "Optional bucket id", type: "string" },
    status: { description: "Status filter, default 'open'; 'all' for everything", type: "string" },
    limit: { description: "Max rows (default 50, max 200)", type: "number" },
    offset: { description: "Rows to skip (default 0)", type: "number" },
  },
  execute: async (args) => listTable(args, "signal", "detected_at desc", "signals"),
});

server.addHandler({
  name: "stats",
  description: "Counts of open job_to_be_done and signal records grouped by bucket, plus the most recent flow runs.",
  parameters: {},
  execute: async () => {
    const d = db();
    const jobs = d.query(
      "select bucket, bucket_label, count(*)::int as count from job_to_be_done where status = 'open' and external_id <> '__seed__' group by bucket, bucket_label order by bucket"
    ).rows;
    const signals = d.query(
      "select bucket, bucket_label, count(*)::int as count from signal where status = 'open' and external_id <> '__seed__' group by bucket, bucket_label order by bucket"
    ).rows;
    const runs = d.query(
      "select flow_run_id, bucket, agent_name, status, records_read, records_written, error, started_at, finished_at from flow_run where flow_run_id <> '__seed__' order by started_at desc limit 25"
    ).rows;
    return {
      jobsTotal: jobs.reduce((a, b) => a + b.count, 0),
      signalsTotal: signals.reduce((a, b) => a + b.count, 0),
      jobs, signals, runs,
    };
  },
});

// ------------------------------------------------------------- run tracking

server.addHandler({
  name: "start_run",
  description: "Record the start of one bucket agent's run within a flow.",
  parameters: {
    flow_run_id: { description: "Flow run id", type: "string" },
    bucket: { description: "Bucket id", type: "string" },
    agent_name: { description: "Agent that is running", type: "string" },
  },
  execute: async (args) => {
    if (!args.flow_run_id) throw new Error("flow_run_id is required");
    const d = db();
    const now = nowIso();
    d.query(
      "insert into flow_run (flow_run_id, bucket, agent_name, status, records_read, records_written, error, started_at, finished_at) values ($1,$2,$3,'running',0,0,'',$4,'')",
      [args.flow_run_id, args.bucket || "", args.agent_name || "", now]
    );
    return { ok: true, flow_run_id: args.flow_run_id, bucket: args.bucket || "", started_at: now };
  },
});

server.addHandler({
  name: "finish_run",
  description: "Record the outcome of one bucket agent's run, matched on flow_run_id + bucket.",
  parameters: {
    flow_run_id: { description: "Flow run id", type: "string" },
    bucket: { description: "Bucket id", type: "string" },
    status: { description: "ok | error", type: "string" },
    records_read: { description: "How many source records were read", type: "number" },
    records_written: { description: "How many rows were written", type: "number" },
    error: { description: "Error message when status is error", type: "string" },
  },
  execute: async (args) => {
    if (!args.flow_run_id) throw new Error("flow_run_id is required");
    const d = db();
    const r = d.query(
      "update flow_run set status=$3, records_read=$4, records_written=$5, error=$6, finished_at=$7 where flow_run_id=$1 and bucket=$2",
      [args.flow_run_id, args.bucket || "", args.status || "ok", Number(args.records_read) || 0,
       Number(args.records_written) || 0, args.error || "", nowIso()]
    );
    return { ok: true, updated: r.rowCount || 0 };
  },
});

server.addHandler({
  name: "set_job_status",
  description: "Update a job's status (open | in_progress | done | dismissed) and record who acted on it.",
  parameters: {
    external_id: { description: "The job's external_id", type: "string" },
    status: { description: "New status", type: "string" },
    action_taken: { description: "Which suggested action was taken", type: "string" },
    actor: { description: "Who acted", type: "string" },
  },
  execute: async (args) => {
    if (!args.external_id) throw new Error("external_id is required");
    const allowed = ["open", "in_progress", "done", "dismissed"];
    const status = args.status || "done";
    if (allowed.indexOf(status) < 0) throw new Error(`status must be one of ${allowed.join("|")}`);
    const d = db();
    const now = nowIso();
    const r = d.query(
      "update job_to_be_done set status=$2, action_taken=$3, actioned_by=$4, actioned_at=$5, updated_at=$5 where external_id=$1",
      [args.external_id, status, args.action_taken || "", args.actor || "", now]
    );
    if (!r.rowCount) throw new Error("job not found: " + args.external_id);
    return { ok: true, external_id: args.external_id, status };
  },
});

server.execute();
