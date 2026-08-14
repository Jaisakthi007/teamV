import StudioFunctions, { StudioDatabase } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "sync_jobs", version: "2.0.0" });

// ---- config helpers --------------------------------------------------------
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
  if (typeof v === "object") return v.name || v.subject || v.displayName || "";
  return String(v);
}
function extractRecords(j) {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  const cands = [j.data, j.output && j.output.data, j.result && j.result.data, j.response && j.response.data, j.output, j.result];
  for (const c of cands) if (Array.isArray(c)) return c;
  for (const v of Object.values(j)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  return [];
}
async function executeConnectionAction(connectionSlug, actionSlug, input) {
  const base = cfg("CONNECTIONS_URL");
  if (!base) throw new Error("CONNECTIONS_URL not available to this run");
  const url = `${base}/api/v1/connections/${connectionSlug}/actions/${actionSlug}/execute`;
  const token = cfg("CONNECTIONS_TOKEN");
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers["X-Service-Token"] = token;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ input }) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${connectionSlug}.${actionSlug} failed: ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
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
const PRIORITY_RANK = { High: 0, Medium: 1, Signal: 2, Normal: 3, Low: 4 };
const PRIORITY_SQL =
  "case cj.priority when 'High' then 0 when 'Medium' then 1 when 'Signal' then 2 when 'Normal' then 3 when 'Low' then 4 else 5 end";
const OPEN_ONLY = "(js.action_taken is null or js.action_taken = '' or js.action_taken <> 'true')";
const JOIN = "console_jobs cj left join job_state js on js.external_id = cj.external_id";

// A common row builder so every bucket's mapper stays small and consistent.
function baseRow(bucket, module, id, o) {
  return {
    external_id: `${bucket}:${module}:${id}`,
    ref: o.ref || "",
    origin: "facilio_sync",
    source_module: module,
    bucket,
    bucket_label: BUCKET_LABELS[bucket] || bucket,
    title: o.title || "(no subject)",
    priority: o.priority || "Normal",
    tone: o.tone || "",
    flag: o.flag || "",
    meta: o.meta || "",
    ai_note: o.ai_note || "",
    age_label: o.age_label || "",
    status: o.status || "open",
    site: o.site || "",
    tenant: o.tenant || "",
    vendor: o.vendor || "",
    requested_by: o.requested_by || "",
    record_url: o.record_url || "",
    system_modified_time: o.system_modified_time || "",
    actions: JSON.stringify(o.actions || [{ label: "Acknowledge", kind: "primary", act: "action" }, { label: "View", kind: "ghost", act: "toast" }]),
    raw: JSON.stringify(o.raw != null ? o.raw : {}),
  };
}

// ============================================================================
// BUCKET SYNC REGISTRY
// One entry per action bucket. Each defines WHERE its data comes from (module
// + connection action), the incremental modified-time field, any extra fetch
// criteria, and how a Facilio record maps to a console job. Add a bucket here
// and it gets its own watermark + can be scheduled as its own Vibe job.
// ============================================================================
const BUCKET_SYNC = {
  tsr: {
    syncKey: "bucket_tsr",
    connection: "facilio-cmms",
    actionSlug: "list-service-requests",
    modifiedField: "sysModifiedTime",
    baseFilters: "",                 // extra criteria ANDed with the watermark
    expand: "siteId,client,requester",
    module: "servicerequest",
    idField: "id",
    writeBackAction: "add-service-request-comment", // used by the action handler
    urlModule: "servicerequest",
    toRow(r) {
      const id = r.id, state = r.moduleState || "";
      const requester = nameOf(r.requester), site = nameOf(r.siteId) || nameOf(r.site);
      const tenant = nameOf(r.client) || nameOf(r.tenant);
      const meta = ["Service request", state ? "Status " + state : null, site || null,
        requester ? "Raised by " + requester : null, r.sysCreatedTime ? "Created " + r.sysCreatedTime : null].filter(Boolean).join(" · ");
      return baseRow("tsr", "servicerequest", id, {
        ref: "TSR-" + (r.localId && r.localId !== 0 ? r.localId : id),
        title: r.subject, priority: nameOf(r.urgency) || nameOf(r.priority) || "Normal",
        meta, status: state || "open", site, tenant, requested_by: requester,
        record_url: "https://app.facilio.com/maintenance/goto/summary/servicerequest/" + id,
        system_modified_time: r.sysModifiedTime || "", raw: r,
      });
    },
  },
  // ── more buckets are added here as you provide the module + fetch criteria ──
};

const COLS = ["external_id", "ref", "origin", "source_module", "bucket", "bucket_label", "title",
  "priority", "tone", "flag", "meta", "ai_note", "age_label", "status", "site", "tenant", "vendor",
  "requested_by", "record_url", "system_modified_time", "synced_at", "created_at", "updated_at", "actions", "raw"];

function upsertRow(d, row, now) {
  const setCols = COLS.filter((c) => c !== "external_id" && c !== "created_at");
  const setClause = setCols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const updVals = [row.external_id, ...setCols.map((c) => (c === "synced_at" || c === "updated_at" ? now : row[c] ?? ""))];
  const upd = d.query(`update console_jobs set ${setClause} where external_id = $1`, updVals);
  if (upd.rowCount && upd.rowCount > 0) return "updated";
  const placeholders = COLS.map((_, i) => `$${i + 1}`).join(", ");
  const insVals = COLS.map((c) => (c === "synced_at" || c === "updated_at" || c === "created_at" ? now : row[c] ?? ""));
  d.query(`insert into console_jobs (${COLS.join(", ")}) values (${placeholders})`, insVals);
  return "inserted";
}

async function runBucketSync(d, bucketId, sinceOverride) {
  const b = BUCKET_SYNC[bucketId];
  if (!b) throw new Error("no sync configured for bucket '" + bucketId + "'");
  const st = d.query("select last_execution_time from sync_state where sync_key = $1", [b.syncKey]);
  let watermark = sinceOverride || (st.rows[0] && st.rows[0].last_execution_time) || "1970-01-01T00:00:00Z";
  const now = nowIso();
  let processed = 0, inserted = 0, updated = 0, page = 1, maxTs = watermark;
  const pageSize = 200, MAX_PAGES = 50;

  while (page <= MAX_PAGES) {
    let filters = `${b.modifiedField}(is_after)=${watermark}`;
    if (b.baseFilters) filters += "&" + b.baseFilters;
    const input = { filters, sort_by: b.modifiedField, sort_order: "asc", page_size: pageSize, page };
    if (b.expand) input.expand = b.expand;
    const recs = extractRecords(await executeConnectionAction(b.connection, b.actionSlug, input));
    if (!recs.length) break;
    for (const r of recs) {
      const row = b.toRow(r);
      const outcome = upsertRow(d, row, now);
      processed++; outcome === "inserted" ? inserted++ : updated++;
      if (row.system_modified_time && row.system_modified_time > maxTs) maxTs = row.system_modified_time;
    }
    if (recs.length < pageSize) break;
    page++;
  }

  const newWatermark = maxTs > watermark ? maxTs : watermark;
  if (st.rows.length) {
    d.query("update sync_state set last_execution_time = $2, last_run_status = $3, last_run_count = $4, updated_at = $5 where sync_key = $1",
      [b.syncKey, newWatermark, "ok", String(processed), now]);
  } else {
    d.query("insert into sync_state (sync_key, last_execution_time, last_run_status, last_run_count, updated_at) values ($1,$2,$3,$4,$5)",
      [b.syncKey, newWatermark, "ok", String(processed), now]);
  }
  return { bucket: bucketId, previousWatermark: watermark, newWatermark, processed, inserted, updated };
}

// ---- handlers --------------------------------------------------------------

server.addHandler({
  name: "sync",
  description: "Fetch a bucket's Facilio records modified since its last run and upsert into console_jobs. One bucket per scheduled job. Pass bucket='<id>' (or 'all' to run every configured bucket).",
  parameters: {
    bucket: { description: "Bucket id to sync, or 'all' (default 'all')", type: "string" },
    since: { description: "Optional ISO watermark override for a backfill", type: "string" },
  },
  execute: async (args) => {
    const d = db();
    const which = (args && args.bucket && args.bucket !== "all") ? [args.bucket] : Object.keys(BUCKET_SYNC);
    const results = [];
    for (const bk of which) {
      try { results.push(await runBucketSync(d, bk, args && args.since ? args.since : undefined)); }
      catch (e) {
        const msg = String(e && e.message ? e.message : e);
        results.push({ bucket: bk, error: msg });
        try {
          const sk = BUCKET_SYNC[bk] && BUCKET_SYNC[bk].syncKey;
          if (sk) d.query("update sync_state set last_run_status = $2, updated_at = $3 where sync_key = $1", [sk, "error: " + msg.slice(0, 200), nowIso()]);
        } catch (e2) {}
      }
    }
    return { ok: true, ranAt: nowIso(), totalProcessed: results.reduce((a, r) => a + (r.processed || 0), 0), results };
  },
});

server.addHandler({
  name: "list",
  description: "Read OPEN (not yet actioned) console jobs, paginated. Defaults to live (Facilio-synced) rows.",
  parameters: {
    bucket: { description: "Optional bucket id to filter by", type: "string" },
    page: { description: "1-based page number (default 1)", type: "number" },
    pageSize: { description: "Rows per page (default 10, max 100)", type: "number" },
    origin: { description: "Origin filter: 'live' (default), 'design', or 'all'", type: "string" },
  },
  execute: async (args) => {
    const d = db();
    const page = Math.max(1, args && args.page ? Number(args.page) : 1);
    const pageSize = Math.min(Math.max(1, args && args.pageSize ? Number(args.pageSize) : 10), 100);
    const offset = (page - 1) * pageSize;
    const originMode = (args && args.origin) || "live";
    const originFilter = originMode === "all" ? null : originMode === "design" ? "design" : "facilio_sync";
    const conds = [OPEN_ONLY];
    const p = [];
    if (originFilter) { p.push(originFilter); conds.push(`cj.origin = $${p.length}`); }
    if (args && args.bucket) { p.push(args.bucket); conds.push(`cj.bucket = $${p.length}`); }
    const where = "where " + conds.join(" and ");
    const total = d.query(`select count(*)::int as count from ${JOIN} ${where}`, p).rows[0].count;
    const { rows } = d.query(
      `select cj.* from ${JOIN} ${where} order by ${PRIORITY_SQL}, cj.system_modified_time desc limit $${p.length + 1} offset $${p.length + 2}`,
      p.concat([pageSize, offset])
    );
    const jobs = rows.map((r) => {
      let actions = [];
      try { actions = JSON.parse(r.actions || "[]"); } catch (e) {}
      return { ...r, actions, priorityRank: PRIORITY_RANK[r.priority] != null ? PRIORITY_RANK[r.priority] : 3 };
    });
    return { jobs, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  },
});

server.addHandler({
  name: "stats",
  description: "Counts of OPEN console jobs grouped by bucket, plus total and sync state.",
  parameters: { origin: { description: "Origin filter: 'live' (default), 'design', or 'all'", type: "string" } },
  execute: async (args) => {
    const d = db();
    const originMode = (args && args.origin) || "live";
    const originFilter = originMode === "all" ? null : originMode === "design" ? "design" : "facilio_sync";
    const conds = [OPEN_ONLY];
    const p = [];
    if (originFilter) { p.push(originFilter); conds.push(`cj.origin = $${p.length}`); }
    const where = "where " + conds.join(" and ");
    const buckets = d.query(`select cj.bucket, cj.bucket_label, count(*)::int as count from ${JOIN} ${where} group by cj.bucket, cj.bucket_label`, p).rows;
    const total = d.query(`select count(*)::int as count from ${JOIN} ${where}`, p).rows[0].count;
    const syncState = d.query("select sync_key, last_execution_time, last_run_status, last_run_count, updated_at from sync_state").rows;
    const actioned = d.query("select count(*)::int as count from job_state where action_taken = 'true'").rows[0].count;
    return { total, buckets, syncState, actioned };
  },
});

server.addHandler({
  name: "action",
  description: "Record an action against a job, write it back to Facilio IMMEDIATELY (comment on the source record), and — on success — hide it from the console.",
  parameters: {
    external_id: { description: "The job's external_id", type: "string" },
    action_type: { description: "Action taken, e.g. 'Acknowledge'", type: "string" },
    actor: { description: "Optional name/email of who acted", type: "string" },
  },
  execute: async (args) => {
    if (!args || !args.external_id) throw new Error("external_id is required");
    const d = db();
    const found = d.query("select external_id, ref, source_module from console_jobs where external_id = $1", [args.external_id]);
    if (!found.rows.length) throw new Error("job not found: " + args.external_id);
    const row = found.rows[0];
    const actionType = args.action_type || "Actioned";
    const now = nowIso();
    const seg = String(args.external_id).split(":");
    const facilioId = Number(seg[seg.length - 1]);
    const module = row.source_module || seg[seg.length - 2];

    let syncStatus = "synced", syncError = null;
    try {
      const who = args.actor ? " by " + args.actor : "";
      const commentText = `Action "${actionType}"${who} via FM 360 Console at ${now}.`;
      if (module === "servicerequest" && facilioId) {
        await executeConnectionAction("facilio-cmms", "add-service-request-comment", { id: facilioId, commentText });
      } else if (module === "workorder" && facilioId) {
        await executeConnectionAction("facilio-cmms", "add-work-order-comment", { id: facilioId, commentText });
      } else {
        syncStatus = "skipped";
      }
    } catch (e) {
      syncStatus = "failed";
      syncError = String(e && e.message ? e.message : e).slice(0, 300);
    }

    if (syncStatus === "failed") {
      upsertState(d, args.external_id, "", actionType, now, "failed: " + syncError);
      return { ok: false, external_id: args.external_id, syncStatus, error: syncError, hidden: false };
    }
    upsertState(d, args.external_id, "true", actionType, now, syncStatus);
    return { ok: true, external_id: args.external_id, ref: row.ref, action_type: actionType, syncStatus, hidden: true };
  },
});

server.addHandler({
  name: "unaction",
  description: "Undo an action: clears the hidden/actioned state so the job returns to the console. Pass external_id, or all='true'.",
  parameters: {
    external_id: { description: "external_id to restore", type: "string" },
    all: { description: "Set 'true' to clear all action state", type: "string" },
  },
  execute: async (args) => {
    const d = db();
    if (args && args.all === "true") {
      const r = d.query("update job_state set action_taken = '', facilio_sync_status = '' where action_taken = 'true'");
      return { ok: true, cleared: r.rowCount || 0 };
    }
    if (!args || !args.external_id) throw new Error("external_id or all='true' required");
    const r = d.query("update job_state set action_taken = '', facilio_sync_status = '' where external_id = $1", [args.external_id]);
    return { ok: true, external_id: args.external_id, cleared: r.rowCount || 0 };
  },
});

server.addHandler({
  name: "purge",
  description: "Delete synced (facilio_sync) rows from console_jobs, optionally for one bucket. Admin/reset only; does not touch seeded design rows.",
  parameters: { bucket: { description: "Optional bucket id to purge; omit to purge all synced rows", type: "string" } },
  execute: async (args) => {
    const d = db();
    let r;
    if (args && args.bucket) r = d.query("delete from console_jobs where origin = 'facilio_sync' and bucket = $1", [args.bucket]);
    else r = d.query("delete from console_jobs where origin = 'facilio_sync'");
    return { ok: true, deleted: r.rowCount || 0 };
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
