import StudioFunctions from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "triage", version: "1.0.0" });

// Self-contained on purpose: feed.js is edited often and by other hands, so this
// copies the few helpers it needs rather than sharing them.
function cfg(key) {
  try {
    if (typeof process !== "undefined") {
      if (process.env && process.env[key] != null) return process.env[key];
      if (process.system && process.system[key] != null) return process.system[key];
    }
  } catch (e) {}
  return undefined;
}
function nameOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.name || v.subject || v.displayName || v.primaryValue || "";
  return String(v);
}
function envelope(j) {
  if (!j) return { records: [], count: null };
  const out = { records: [], count: null };
  if (typeof j.count === "number") out.count = j.count;
  const cands = [j.data, j.output && j.output.data, j.result && j.result.data, j.response && j.response.data, j.output, j.result];
  for (const c of cands) { if (Array.isArray(c)) { out.records = c; break; } }
  if (!out.records.length && Array.isArray(j)) out.records = j;
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
    throw new Error(`${connectionSlug}.${actionSlug} failed: ${res.status} ${t.slice(0, 160)}`);
  }
  return res.json();
}
/** A dead source must never sink the strip — an empty bucket is a legitimate answer. */
async function tryRecords(connection, action, input) {
  try {
    return envelope(await callAction(connection, action, input)).records || [];
  } catch (e) {
    return null; // null = the read failed, distinct from "read fine, nothing there"
  }
}

function nowMs() { return Date.now(); }
function hoursSince(iso) {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return null;
  return Math.max(0, (nowMs() - t) / 3600000);
}
function hoursUntil(iso) {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return null;
  return (t - nowMs()) / 3600000;
}
function ageLabel(h) {
  if (h == null) return null;
  if (h >= 48) return `Waiting ${Math.floor(h / 24)}d`;
  if (h >= 1) return `Waiting ${Math.floor(h)}h`;
  return "Just raised";
}

/**
 * Words that change how fast something has to be looked at. Deliberately narrow:
 * a keyword list that fires on everything ranks nothing.
 */
const HAZARD = [
  ["fire", "Fire risk"], ["smoke", "Fire risk"], ["gas", "Gas"], ["leak", "Leak"],
  ["flood", "Flooding"], ["burst", "Leak"], ["power", "Power"], ["outage", "Outage"],
  ["electric", "Electrical"], ["lift", "Lift entrapment risk"], ["elevator", "Lift entrapment risk"],
  ["trip", "Safety hazard"], ["hazard", "Safety hazard"], ["injur", "Safety hazard"],
  ["security", "Security"], ["asbestos", "Asbestos"],
];
function hazardOf(text) {
  const s = String(text || "").toLowerCase();
  for (const [needle, label] of HAZARD) if (s.indexOf(needle) >= 0) return label;
  return null;
}

/**
 * Score one candidate. Every point added must also add its own reason chip, so a
 * ranking can always be read back to the FM as the reasons that actually fired.
 *
 * Weights are grounded in what this org's records really carry: `urgency` comes
 * back empty on every row and `priority` is always "Normal", so neither is scored
 * — scoring them would invent a signal that does not exist.
 */
function score(item) {
  let n = 0;
  const why = [];

  const age = hoursSince(item.created_time);
  if (age != null) {
    if (age >= 48) { n += 40; why.push(ageLabel(age)); }
    else if (age >= 24) { n += 30; why.push(ageLabel(age)); }
    else if (age >= 8) { n += 18; why.push(ageLabel(age)); }
    else if (age >= 4) { n += 8; why.push(ageLabel(age)); }
  }

  // A permit whose window opens imminently blocks a crew that is already booked.
  if (item.valid_from) {
    const until = hoursUntil(item.valid_from);
    if (until != null) {
      if (until < 0) { n += 50; why.push("Start date passed"); }
      else if (until <= 24) { n += 45; why.push("Starts within 24h"); }
      else if (until <= 72) { n += 20; why.push("Starts in " + Math.round(until / 24) + "d"); }
    }
  }

  const hz = hazardOf(item.title);
  if (hz) { n += 35; why.push(hz); }

  if (item.rechargeable) { n += 15; why.push("Rechargeable to tenant"); }
  if (item.quote_path) { n += 12; why.push("Quote path set"); }
  if (item.tenant) { n += 6; why.push("Tenant-facing"); }

  return { n, why };
}

const SOURCES = [
  {
    bucket: "tsr", label: "TSR's to acknowledge", connection: "facilio-cmms",
    action: "list-service-requests",
    input: {
      filters: "moduleState=Open", expand: "siteId,tenant,tenant_serviceRequest_1",
      select: "id,localId,subject,siteId,tenant,tenant_serviceRequest_1,sysCreatedTime",
      page: 1, page_size: 50, sort_by: "sysCreatedTime", sort_order: "asc",
    },
    map: (r) => ({
      external_id: "tsr:servicerequest:" + r.id,
      ref: "TSR-" + (r.localId && r.localId !== 0 ? r.localId : r.id),
      title: r.subject || "(no subject)",
      created_time: r.sysCreatedTime || "",
      tenant: nameOf(r.tenant_serviceRequest_1) || nameOf(r.tenant),
      site: nameOf(r.siteId),
      record_url: "https://app.facilio.com/maintenance/tenantservices/servicerequest/all/" + r.id + "/overview?tabName=properties",
    }),
  },
  {
    bucket: "tsrack", label: "Acknowledged TSRs", connection: "facilio-cmms",
    action: "list-service-requests",
    input: {
      filters: "moduleState=tsrvalidated", expand: "siteId,tenant,tenant_serviceRequest_1",
      select: "id,localId,subject,siteId,tenant,tenant_serviceRequest_1,sysCreatedTime,tenant_rechargeable__serviceRequest,tenant_quote_path_serviceRequest",
      page: 1, page_size: 50, sort_by: "sysCreatedTime", sort_order: "asc",
    },
    map: (r) => ({
      external_id: "tsrack:servicerequest:" + r.id,
      ref: "TSR-" + (r.localId && r.localId !== 0 ? r.localId : r.id),
      title: r.subject || "(no subject)",
      created_time: r.sysCreatedTime || "",
      tenant: nameOf(r.tenant_serviceRequest_1) || nameOf(r.tenant),
      site: nameOf(r.siteId),
      rechargeable: r.tenant_rechargeable__serviceRequest === true,
      quote_path: r.tenant_quote_path_serviceRequest || "",
      record_url: "https://app.facilio.com/maintenance/tenantservices/servicerequest/all/" + r.id + "/overview?tabName=properties",
    }),
  },
  {
    bucket: "unblock", label: "Unblock vendors", connection: "facilio-cmms",
    action: "list-work-permits",
    input: { filters: "moduleState=awaitingfmapproval", expand: "vendor,siteId", page: 1, page_size: 50 },
    map: (r) => ({
      external_id: "unblock:workpermit:" + r.id,
      ref: "PMT-" + (r.localId && r.localId !== 0 ? r.localId : r.id),
      title: r.name || "Work permit " + r.id,
      created_time: r.sysCreatedTime || "",
      valid_from: r.expectedStartTime || "",
      site: nameOf(r.siteId),
      record_url: "",
    }),
  },
];

server.addHandler({
  name: "important",
  description:
    "The most actionable items across the console's action buckets right now, ranked by explainable signals (age waiting, permit start imminent, hazard wording, tenant recharge, quote path) with the reasons that fired.",
  parameters: {
    limit: { description: "How many items to return (default 6, max 12)", type: "number" },
  },
  execute: async (args) => {
    const limit = Math.min(Math.max(1, Number((args && args.limit) || 6)), 12);
    const scanned = {};
    const errors = {};
    const items = [];

    for (const src of SOURCES) {
      const rows = await tryRecords(src.connection, src.action, src.input);
      if (rows == null) { scanned[src.bucket] = null; errors[src.bucket] = "read failed"; continue; }
      scanned[src.bucket] = rows.length;
      for (const r of rows) {
        const base = src.map(r);
        const s = score(base);
        if (!s.why.length) continue; // nothing to say about it is a reason to leave it out
        items.push({ ...base, bucket: src.bucket, bucket_label: src.label, score: s.n, why: s.why, age_h: hoursSince(base.created_time) || 0 });
      }
    }

    // Oldest first inside a tie: fifty permits raised the same afternoon score
    // identically, and the one waiting longest is the one to look at.
    items.sort((a, b) => (b.score - a.score) || ((b.age_h || 0) - (a.age_h || 0)));

    // Cap any one bucket's share. Without this the widest queue fills the strip
    // with near-duplicates and hides the single urgent item in a smaller bucket —
    // which defeats the point of ranking across buckets at all.
    const perBucket = Math.max(2, Math.ceil(limit / 2));
    const seen = {};
    const picked = [];
    for (const it of items) {
      const n = seen[it.bucket] || 0;
      if (n >= perBucket) continue;
      seen[it.bucket] = n + 1;
      picked.push(it);
      if (picked.length >= limit) break;
    }
    // If capping left room (few buckets have data), backfill by rank.
    if (picked.length < limit) {
      for (const it of items) {
        if (picked.indexOf(it) >= 0) continue;
        picked.push(it);
        if (picked.length >= limit) break;
      }
    }

    return {
      ranAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      scanned,
      errors: Object.keys(errors).length ? errors : undefined,
      items: picked,
    };
  },
});

server.execute();
