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
 * Presentation hint only. The UI colours each reason chip, and the row's urgency
 * bar, from these — so the meaning of a chip is decided next to the rule that
 * fired it rather than re-derived by string-matching in the browser.
 * Vocabulary is deliberately tiny: red | amber | purple | blue.
 */
const TONE_RANK = { blue: 0, purple: 1, amber: 2, red: 3 };
function worstTone(tones) {
  let out = "blue";
  for (const t of tones || []) if ((TONE_RANK[t] || 0) > TONE_RANK[out]) out = t;
  return out;
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
  const tones = [];
  // One call site per signal keeps points, label and colour impossible to
  // desync — `why[i]` and `why_tones[i]` are written together or not at all.
  const add = (points, label, tone) => { n += points; why.push(label); tones.push(tone); };

  const age = hoursSince(item.created_time);
  if (age != null) {
    if (age >= 48) add(40, ageLabel(age), "red");
    else if (age >= 24) add(30, ageLabel(age), "amber");
    else if (age >= 8) add(18, ageLabel(age), "amber");
    else if (age >= 4) add(8, ageLabel(age), "blue");
  }

  // A permit whose window opens imminently blocks a crew that is already booked.
  if (item.valid_from) {
    const until = hoursUntil(item.valid_from);
    if (until != null) {
      if (until < 0) add(50, "Start date passed", "red");
      else if (until <= 24) add(45, "Starts within 24h", "red");
      else if (until <= 72) add(20, "Starts in " + Math.round(until / 24) + "d", "amber");
    }
  }

  const hz = hazardOf(item.title);
  if (hz) add(35, hz, "red");

  if (item.rechargeable) add(15, "Rechargeable to tenant", "purple");
  if (item.quote_path) add(12, "Quote path set", "purple");
  if (item.tenant) add(6, "Tenant-facing", "blue");

  return { n, why, tones, tone: worstTone(tones) };
}

// Record deep links. Deliberately duplicated from feed.js rather than imported
// — this function is self-contained. See feed.js for the full evidence note:
// the web app's only generic resolver route is /:app/goto/summary/:moduleName/:id,
// it matches moduleName EXACTLY against the route table (so `serviceRequest`,
// not `servicerequest`), and anything unmatched lands on pagenotfound.
const APP_BASE_URL = "https://app.facilio.com/maintenance";
const LINKABLE_MODULES = {
  servicerequest: "serviceRequest",
  serviceRequest: "serviceRequest",
  workorder: "workorder",
  workpermit: "workpermit",
  purchaseorder: "purchaseorder",
  quote: "quote",
};
function recordUrl(module, id) {
  const canonical = LINKABLE_MODULES[String(module || "")];
  if (!canonical) return "";
  if (id == null || id === "" || String(id) === "0") return "";
  return APP_BASE_URL + "/goto/summary/" + canonical + "/" + id;
}

const SOURCES = [
  // ONE service-request source, matching the console's single queue. The two
  // states used to be scanned as two buckets, which meant the per-bucket cap in
  // `important` handed service requests twice the strip's share of any other
  // queue, and "Open queue →" could land the FM in the half the record was not in.
  // Comma-separated values are an IN/OR on this action (verified on org 2931:
  // 136 Open + 19 tsrvalidated = 155 for the pair), so one read covers both.
  // Kept in step with feed.js by hand — this function is self-contained on purpose.
  {
    bucket: "tsr", label: "Tenant service requests", connection: "facilio-cmms",
    action: "list-service-requests",
    input: {
      filters: "moduleState=Open,tsrvalidated", expand: "siteId,tenant,tenant_serviceRequest_1",
      select: "id,localId,subject,moduleState,siteId,tenant,tenant_serviceRequest_1,sysCreatedTime,tenant_rechargeable__serviceRequest,tenant_quote_path_serviceRequest",
      page: 1, page_size: 50, sort_by: "sysCreatedTime", sort_order: "asc",
    },
    map: (r) => ({
      external_id: "tsr:servicerequest:" + r.id,
      ref: "TSR-" + (r.localId && r.localId !== 0 ? r.localId : r.id),
      title: r.subject || "(no subject)",
      created_time: r.sysCreatedTime || "",
      tenant: nameOf(r.tenant_serviceRequest_1) || nameOf(r.tenant),
      site: nameOf(r.siteId),
      // moduleState was already read; passing it lets the ranked list offer the
      // record's OWN next step ("Acknowledge & proceed" vs "Create Work Order")
      // instead of only a link into the queue. Inferring it from `rechargeable`
      // would be wrong: that is false both when unset and when explicitly false.
      state: nameOf(r.moduleState) || String(r.moduleState || ""),
      // Only acknowledged requests carry these, so they score only where they are
      // real — an unacknowledged row simply has nothing to say on either.
      rechargeable: r.tenant_rechargeable__serviceRequest === true,
      quote_path: r.tenant_quote_path_serviceRequest || "",
      record_url: recordUrl("serviceRequest", r.id),
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
      record_url: recordUrl("workpermit", r.id),
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
        // `why` stays a plain string[] on the wire — the UI already renders it and
        // the two hint fields below are additive, so an older client is unaffected.
        items.push({
          ...base, bucket: src.bucket, bucket_label: src.label, score: s.n,
          why: s.why, why_tones: s.tones, tone: s.tone,
          age_h: hoursSince(base.created_time) || 0,
        });
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
