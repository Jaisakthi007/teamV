import StudioFunctions, { VibeEvents } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "agent_bridge", version: "1.0.0" });
const events = new VibeEvents();

// Every console tab subscribes to this one leaf and keeps only the runs it started.
const TOPIC = "srops";

// The Agent Studio team that owns tenant service request handling: acknowledge,
// raise the work order, start procurement, raise the RFQ.
const DEFAULT_TEAM = "service_request_operations";

// Some intents belong to a different Studio agent than the SR team. The target
// is derived from the intent; an explicit args.team still overrides both.
const INTENT_AGENT = {
  // Work permit reviews go to the standalone Review Work Permits agent (Flow AI
  // 6390) — it reads the permit's safety checklist itself and recommends; it
  // only approves/rejects on the reviewer's explicit per-permit instruction.
  review_permit: "review_work_permits",
};

// ---- helpers (same shape as feed.js so both read alike) ---------------------
function cfg(key) {
  try {
    if (typeof process !== "undefined") {
      if (process.env && process.env[key] != null) return process.env[key];
      if (process.system && process.system[key] != null) return process.system[key];
    }
  } catch (e) {}
  return undefined;
}
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${connectionSlug}.${actionSlug} failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

/** Thread ids come back at different depths depending on the envelope. */
function threadIdOf(resp) {
  if (!resp) return null;
  const cands = [resp.id, resp.threadId, resp.thread_id];
  for (const c of cands) if (typeof c === "number") return c;
  for (const n of [resp.data, resp.output, resp.result, resp.thread]) {
    if (n && typeof n === "object") {
      const t = threadIdOf(n);
      if (t) return t;
    }
  }
  return null;
}

/** The agent's prose reply, wherever the envelope put it. */
function replyOf(resp) {
  if (!resp) return null;
  if (typeof resp === "string") return resp;
  const cands = [resp.content, resp.message, resp.reply, resp.text, resp.response];
  for (const c of cands) if (typeof c === "string" && c.trim()) return c;
  for (const n of [resp.data, resp.output, resp.result]) {
    if (n && typeof n === "object") {
      const r = replyOf(n);
      if (r) return r;
    }
  }
  return null;
}

/** external_id is "<bucket>:<module>:<id>" — the record id is the last segment. */
function recordIdOf(externalId) {
  const seg = String(externalId || "").split(":");
    const n = Number(seg[seg.length - 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The briefing the team reads before it does anything. Everything here is read
 * off the live record, so the team never has to ask the FM to re-type what is
 * already recorded — and can't drift from the record's real state.
 */
/** A lookup's record id, whether it came back as a bare number or an expanded record. */
function idOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  if (typeof v === "object" && typeof v.id === "number") return v.id > 0 ? v.id : null;
  return null;
}

/** Thousands separators without leaning on the runtime's locale data. */
function num(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const [i, f] = String(n).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}

/** Names out of a picklist/list payload, whatever key the module uses for the label. */
function optionNames(resp, limit) {
  const rows = (resp && (resp.items || resp.data)) || envelope(resp).records || [];
  const names = [];
  for (const r of rows) {
    const n = typeof r === "string" ? r : (r && (r.displayName || r.name || r.type || r.priority));
    if (n) names.push(String(n));
  }
  return names.slice(0, limit || 40);
}

/**
 * The option lists the Create Work Order agent would otherwise fetch itself.
 *
 * Each lookup it makes is another round trip inside the team run, which is what
 * made the work-order turn take minutes while acknowledge took seconds. Fetching
 * them here — three cheap parallel reads — lets the team ask the FM immediately.
 * Never fatal: a missing list just means the agent looks that one up as before.
 */
async function workOrderOptions() {
  const [priority, type, permit] = await Promise.all([
    tryAct("facilio-customization", "picklist", { moduleName: "workorder", fieldName: "priority" }),
    tryAct("facilio-customization", "picklist", { moduleName: "workorder", fieldName: "type" }),
    tryAct("facilio-cmms", "list-work-permit-types", {}),
  ]);
  const lines = [];
  const push = (label, names) => {
    if (names.length) lines.push(`${label}: ${names.join(", ")}`);
  };
  push("Work order priorities", optionNames(priority));
  push("Work order types", optionNames(type));
  push("Work permit types", optionNames(permit));
  if (!lines.length) return "";
  return [
    "",
    "=== OPTIONS AVAILABLE (already looked up — do NOT look these up again) ===",
    ...lines,
    "=== END OPTIONS ===",
  ].join("\n");
}

// ---- procurement policy ----------------------------------------------------
//
// The org's procurement thresholds are NOT in a document anywhere. Agent 6327's
// "Procurement Policy" knowledge base (id 13, folder agent_app_procurement_policy)
// is attached but EMPTY — asked to quote it, the agent answers KB-EMPTY — and no
// tool returns the bands. The real numbers live as records in the custom module
// `custom_procurementpathwaymetadata` ("Procurement Pathway Metadata"), which is
// what the pre-raise check reads when it says "Minimum Vendor Quotes Requirements
// are not defined for the estimated cost in the procurement activity".
//
// So nothing here is a hardcoded band: every number below is read live off that
// module at briefing time. If the org has recorded none, the block says so and
// the agent is told to ask rather than to guess.
const PPM = "_custom_procurementpathwaymetadata";

// A Site Preferred Supplier Agreement (custom_ratecard) makes its vendor
// CONTRACTED for that site only while the agreement's contract is in one of
// these states. Rate cards carry no status of their own — the contract does.
// Active 143841, Hold Over 143849, Rolled Over 143852.
const CONTRACTED_CONTRACT_STATES = [143841, 143849, 143852];

/** The recorded cost bands, formatted as the agent should read them out. */
async function thresholdLines() {
  const resp = await tryAct("facilio-cmms", "list-custom-module-records", {
    custom_module: "custom_procurementpathwaymetadata",
    page_size: 200,
    select: [
      "id", "name", "siteId",
      "lower_limit" + PPM, "upper_limit" + PPM,
      "site_contracted_minimum_quotes" + PPM, "uncontracted_minimum_quotes" + PPM,
      "procurement_pathway" + PPM, "client_group" + PPM,
    ].join(","),
    expand: "client_group" + PPM + ",siteId",
  });
  if (!resp) return null; // read failed — say "unknown", never guess
  const lines = [];
  for (const r of envelope(resp).records) {
    const lo = num(r["lower_limit" + PPM]);
    const hi = num(r["upper_limit" + PPM]);
    const contracted = r["site_contracted_minimum_quotes" + PPM];
    const uncontracted = r["uncontracted_minimum_quotes" + PPM];
    const route = r["procurement_pathway" + PPM] || nameOf(r["client_group" + PPM]) || "—";
    const siteName = nameOf(r.siteId);
    const siteId = idOf(r.siteId);
    const scope = siteName || (siteId ? "site #" + siteId : "all sites");
    lines.push(
      `• ${route} · estimated cost ${lo == null ? "—" : lo} to ${hi == null ? "—" : hi} · ${scope} ` +
      `→ at least ${contracted == null ? "?" : contracted} quote(s) from CONTRACTED suppliers ` +
      `and ${uncontracted == null ? "?" : uncontracted} from NON-CONTRACTED suppliers` +
      (r.name ? `  [recorded as: ${r.name}]` : "")
    );
  }
  return lines;
}

/** Suppliers under a live Site Preferred Supplier Agreement at one site. */
async function contractedAtSite(siteId) {
  if (!siteId) return null;
  const resp = await tryAct("facilio-cmms", "list-custom-module-records", {
    custom_module: "custom_ratecard",
    page_size: 200,
    filters: "siteId=" + siteId,
    select: "id,name,siteId,vendor_custom_ratecard,contract_custom_ratecard,service_category_custom_ratecard",
    expand: "vendor_custom_ratecard,contract_custom_ratecard,service_category_custom_ratecard",
  });
  if (!resp) return null;
  const byVendor = new Map(); // vendor name -> Set of service categories on their agreements
  for (const r of envelope(resp).records) {
    const state = idOf((r.contract_custom_ratecard || {}).moduleState);
    if (state == null || CONTRACTED_CONTRACT_STATES.indexOf(state) < 0) continue;
    const vendor = nameOf(r.vendor_custom_ratecard);
    if (!vendor) continue;
    const svc = nameOf(r.service_category_custom_ratecard);
    const seen = byVendor.get(vendor) || new Set();
    if (svc) seen.add(svc);
    byVendor.set(vendor, seen);
  }
  return byVendor;
}

/**
 * The policy facts the procurement initiation and the RFQ both turn on, read
 * once here instead of costing the team a lookup per turn — the same trade
 * workOrderOptions() makes for the work-order picklists.
 *
 * Everything is live data. An empty or failed read prints an honest "not
 * recorded / could not read" line so the agent asks instead of inventing.
 */
async function procurementContext(siteId, siteName) {
  const [bands, contracted] = await Promise.all([thresholdLines(), contractedAtSite(siteId)]);
  const out = ["", "=== PROCUREMENT POLICY, READ LIVE (do NOT look these up again) ==="];

  out.push("Minimum quotes by estimated cost, as the organisation has actually recorded them");
  out.push("(module 'Procurement Pathway Metadata'):");
  if (bands == null) {
    out.push("  Could not be read on this turn. Do NOT state or guess a number of suppliers —");
    out.push("  say the threshold could not be read and let the pre-raise check decide it.");
  } else if (!bands.length) {
    out.push("  NONE RECORDED. The organisation has not recorded a single cost band. Do NOT invent one:");
    out.push("  tell the FM plainly that no minimum-quote threshold is recorded for this cost, that it has to");
    out.push("  be set up in the procurement thresholds, and let the pre-raise check be the authority.");
  } else {
    for (const b of bands) out.push("  " + b);
    out.push("  A cost outside every band above has NO recorded requirement — say so rather than picking the");
    out.push("  nearest band. Read the band names: a band named as a test or placeholder is not a real policy,");
    out.push("  and you should say so when you quote it.");
  }

  if (contracted != null) {
    out.push("");
    out.push(
      "Suppliers CONTRACTED at " + (siteName || "this site") +
      " — they hold a Site Preferred Supplier Agreement whose contract is Active, Hold Over or Rolled Over:"
    );
    if (!contracted.size) {
      out.push("  NONE. No supplier is contracted at this site, so every candidate is NON-CONTRACTED.");
    } else {
      let anyService = false;
      for (const [vendor, services] of contracted) {
        if (services.size) anyService = true;
        out.push("  • " + vendor + (services.size ? " (" + Array.from(services).join(", ") + ")" : ""));
      }
      if (!anyService) {
        out.push("  No service category is recorded on any of these agreements, so this list is site-wide, not");
        out.push("  service-specific. Say that when you present it rather than implying a service match.");
      }
      out.push("  Any supplier NOT named above is NON-CONTRACTED for this site.");
    }
  }

  out.push("=== END PROCUREMENT POLICY ===");
  return out.join("\n");
}

/** Non-fatal read: an option list that fails must not sink the whole turn. */
async function tryAct(connection, action, input) {
  try {
    return await callAction(connection, action, input);
  } catch (e) {
    return null;
  }
}

async function briefingFor(srId) {
  // get-service-request returns the record already expanded; the list action's
  // id= filter does not match, so don't reach for it here.
  const resp = await callAction("facilio-cmms", "get-service-request", { id: srId });
  const sr = (resp && resp.data && typeof resp.data === "object" && !Array.isArray(resp.data))
    ? resp.data
    : envelope(resp).records[0];
  if (!sr || sr.id == null) throw new Error("service request " + srId + " not found");

  // get-service-request nests the site under the building and leaves the top-level
  // siteId unnamed, so read the building first and fall back to whatever is set.
  const building = nameOf(sr.building_serviceRequest);
  const site = nameOf(sr.siteId) || nameOf(sr.building_serviceRequest && sr.building_serviceRequest.site);
  // The site's record id, for the contracted-supplier read. On a service request
  // the top-level siteId comes back null and the id sits under the building.
  const siteId = idOf(sr.siteId) || idOf(sr.building_serviceRequest && sr.building_serviceRequest.site);
  const issue = sr.issue_location_serviceRequest || "";
  const tenant = nameOf(sr.tenant_serviceRequest_1) || nameOf(sr.tenant);
  const yesNo = (v) => (v === true ? "yes" : v === false ? "no" : "—");
  const lines = [
    "=== TENANT SERVICE REQUEST (read from the live record) ===",
    "Record id: " + sr.id,
    "Reference: TSR-" + (sr.localId || sr.id),
    "Subject: " + (sr.subject || "—"),
    "Description: " + (sr.description || "—"),
    "Current state: " + (nameOf(sr.moduleState) || "—"),
    "Building: " + (building || "—"),
    "Site: " + (site || "—"),
    "Issue location: " + (issue || "—"),
    "Tenant: " + (tenant || "—"),
    "Client: " + (nameOf(sr.client) || "—"),
    "Requested by: " + (nameOf(sr.requester) || "—"),
    "TSR type: " + (sr.tsr_type_serviceRequest || "—"),
    "TSR category: " + (nameOf(sr.tsr_category_serviceRequest) || "—"),
    "TSR sub category: " + (nameOf(sr.tsr_sub_category_serviceRequest) || "—"),
    "Tenant rechargeable: " + yesNo(sr.tenant_rechargeable__serviceRequest),
    "Tenant quote path: " + (sr.tenant_quote_path_serviceRequest || "—"),
    "=== END RECORD ===",
    "",
    "This is the record the FM is working on in the FM 360 Console. Act on THIS record.",
    "Never ask the FM to open, select or re-type anything already listed above — those are the record's facts.",
    "The decisions the requested action needs (for an acknowledgement: tenant rechargeable, quote path,",
    "issue-type change; for a work order: execution path, work order type, priority, permits; and so on) are",
    "NOT pre-confirmed: the values above are the record's current values shown for reference. Present them as",
    "defaults or proposals and get the FM's explicit yes/changes in this chat before writing.",
  ];
  return { sr, siteId, site, briefing: lines.join("\n") };
}

/**
 * Standing RFQ instruction, carried on every SR-team thread.
 *
 * The RFQ is raised conversationally several turns after `start`, so this can't
 * be an opening — it has to ride in the briefing (and be re-asserted on the turn
 * that actually asks for the RFQ, see rfqAsk()).
 *
 * It does NOT overrule the Create RFQ agent (Flow AI 6327); it picks the branch
 * the agent's own procedure already offers. Verbatim from its Step 3: "AT LEAST
 * ONE LINE IS ALWAYS REQUIRED, on every route: with none the request is refused
 * with 'Line items cannot be empty'. When the user has not spelled the lines out,
 * propose one sensible line from the activity's description and confirm it." We
 * still supply a line — the refusal condition is never approached — we just stop
 * the confirmation round-trip from blocking, and make the agent state the line it
 * used instead. Closing date and suppliers are deliberately left as questions.
 *
 * Field names/values below are the real line_items shape on
 * cbre-clone.check-rfq-details-before-raising-from-procurement-initiation:
 * service, description, quantity, unitOfMeasure (5 = lump sum), inventoryType
 * (3 = a service being bought in).
 */
const RFQ_LINE_ITEMS = [
  "",
  "=== STANDING INSTRUCTION — RFQ LINE ITEMS (applies whenever an RFQ is raised later in this chat) ===",
  "When a request for quotation is raised in this conversation, do NOT ask the FM for the line items and do",
  "NOT wait for the FM to spell them out. Take the 'propose one sensible line' route your own procedure",
  "already allows: build ONE default line from the records already in hand and go straight on with it —",
  "  • service: the service / service category already recorded on the procurement activity;",
  "  • description: the work order's subject (or its short summary of the work); if neither is recorded, the",
  "    procurement activity's own name or its description of the work. Never ask the FM to retype any of it;",
  "  • quantity: 1;",
  "  • how the quantity is counted (unit of measure): lump sum — the whole job priced as one sum;",
  "  • what kind of line it is: a service being bought in.",
  "The FM asking for the RFQ IS their confirmation of that default line. State the line you used in plain",
  "words in your reply — service, description, quantity and how it is counted — so the FM can correct it, and",
  "change it only if they then say so. If the FM does spell out their own lines, use theirs instead; this",
  "default only fills the silence.",
  "Never put a price, rate or amount on a line. What the RFQ is for is suppliers pricing it.",
  "This changes NOTHING else about raising an RFQ. Keep asking the FM, as you always do, for the things that",
  "cannot be defaulted and that carry real consequences — the closing date by which suppliers must return",
  "their quote, and which suppliers to invite (the Preferred and Other vendors, or the single supplier on",
  "single sourcing) — and keep every check you normally run, including the pre-raise check of the quotation",
  "details.",
  "=== END STANDING INSTRUCTION ===",
].join("\n");

/**
 * Standing procurement-policy instruction, carried on every SR-team thread.
 *
 * Two behaviours the FMs asked for, neither of which the agents do today:
 *
 *  1. Create Procurement Initiation (Flow AI 6296) collects the estimated cost
 *     as a sub-point of Step 3, AFTER the route is chosen — and it has NO
 *     knowledge base and no threshold tool, so it never tells the FM what the
 *     amount actually commits them to. This flips the order and makes it say.
 *  2. Create RFQ (Flow AI 6327) already knows the Preferred/Other split and is
 *     told to read a Procurement Policy knowledge base — but that KB is empty,
 *     so the "read the policy" branch silently yields nothing. This points it at
 *     the recorded thresholds instead, and asks for the split to be shown to the
 *     FM rather than only used internally.
 *
 * It overrules neither agent. The FM's CBRE-policy-read attestation stays exactly
 * as agent 6296 defines it, and the pre-raise check stays the final authority on
 * the minimum — this only decides WHEN the cost is asked and WHAT is said out loud.
 */
const PROCUREMENT_POLICY = [
  "",
  "=== STANDING INSTRUCTION — PROCUREMENT POLICY (applies to the procurement initiation and the RFQ) ===",
  "",
  "STARTING A PROCUREMENT INITIATION — ask what the work is expected to cost FIRST.",
  "Before the procurement route, before the buyer, before permits, before anything else, ask the FM for the",
  "ESTIMATED COST. It is the number the whole policy turns on: how many suppliers have to quote, and who has",
  "to approve, both follow from it, so asking it last makes the FM choose a route blind.",
  "Once the FM gives the amount, and BEFORE you create anything, SAY WHAT THE POLICY REQUIRES AT THAT AMOUNT,",
  "in plain words and in this order:",
  "  • which recorded cost band the amount falls in, and what that band is called;",
  "  • how many quotes it requires from CONTRACTED suppliers and how many from NON-CONTRACTED ones;",
  "  • which of the three routes that points at, and why — several competing quotes means the CBRE standard",
  "    route or the client-directed route; placing the work with one named supplier means single sourcing,",
  "    which invites nobody to compete and so satisfies no minimum-quote requirement;",
  "  • anything the band says about approval. If it says nothing about approval, say nothing about approval.",
  "The bands are recorded on the 'Procurement Pathway Metadata' records (module custom_procurementpathwaymetadata:",
  "lower limit, upper limit, procurement pathway or procurement policy, site contracted minimum quotes,",
  "uncontracted minimum quotes). If a PROCUREMENT POLICY block appears above, those are the live records — use",
  "them and do not look them up again. If no such block appears, read that module yourself before you answer.",
  "If NO band covers the amount, or none is recorded at all, say exactly that: the organisation has not recorded",
  "a minimum-quote requirement for this cost, it has to be set up in the procurement thresholds, and the",
  "pre-raise check on the RFQ will be the one to enforce it. NEVER invent a band, a number of quotes or a",
  "monetary limit, and never round an amount into a band it does not fall in.",
  "Then carry on with your normal confirmation step, unchanged. In particular, the FM's confirmation that they",
  "have READ THE CBRE STANDARD PROCUREMENT POLICY is their own personal attestation: ask it plainly, take only a",
  "real yes, never default it to true, never infer it from silence or from their giving you the cost, and do not",
  "create the record without it. Summarising the policy for them is NOT them having read it.",
  "",
  "RAISING THE RFQ — say how many suppliers are needed, and split the candidates.",
  "Open by stating the required number of suppliers for this activity's estimated cost and route, citing the",
  "band you read it from, exactly as above. Then present the candidate suppliers as TWO NAMED LISTS so the FM",
  "picks knowingly rather than guessing which name is which:",
  "  • CONTRACTED — suppliers holding a Site Preferred Supplier Agreement for this site whose contract is",
  "    Active, Hold Over or Rolled Over. These are the Preferred (contractor) vendors, single select.",
  "  • NON-CONTRACTED — every other eligible supplier. These are the Other vendors, multi select.",
  "Label the two lists in those words to the FM, and say how many to pick from each. If a PROCUREMENT POLICY",
  "block above already lists the contracted suppliers for this site, use it and do not look them up again;",
  "otherwise build the lists with your own eligibility tools as your procedure already describes. If a list is",
  "empty, say it is empty and say what that means for the counts — with no contracted supplier available the",
  "requirement falls entirely on non-contracted quotes.",
  "On single sourcing, none of this applies: exactly one named supplier, no competing suppliers, no split.",
  "",
  "THE PRE-RAISE CHECK REMAINS THE FINAL AUTHORITY on the minimum number of quotes. Everything you say from the",
  "recorded bands is guidance offered up front so the FM can choose well. If the check disagrees with it, the",
  "check wins — relay its wording, correct yourself plainly, and fix the RFQ before raising.",
  "One more thing about the policy documents: the Procurement Policy knowledge base currently holds no",
  "documents. If a search of it returns nothing, do NOT claim to have read a policy and do NOT reconstruct one",
  "from memory — fall back to the recorded bands above and to the pre-raise check, and say which you used.",
  "=== END STANDING INSTRUCTION ===",
].join("\n");

// The phrases that mean the FM is moving into procurement. The briefing carries
// PROCUREMENT_POLICY from message one, but the initiation and the RFQ come
// several turns later and a thread's history can be trimmed by then.
const PROCUREMENT_ASK =
  /\b(procurement|procure|initiate\s+procurement|start\s+(?:the\s+)?buying|bought\s+in|buy\s+(?:this|it)\s+in|source\s+(?:this|it)\s+(?:out|externally)|estimated\s+cost|single\s+sourc\w*|client[-\s]?directed)\b/i;

// The phrases the SR team's own instructions list as meaning 'raise the RFQ'.
// The briefing carries RFQ_LINE_ITEMS from the first message, but a thread's
// history can be trimmed before the FM gets round to the RFQ several turns
// later, so re-assert it on the turn that actually asks for one.
const RFQ_ASK =
  /\b(rfq|request for quotation|quotation request|out to quote|quote(?:s|d)? (?:from|by) suppliers?|suppliers? to price|price this|put this out)\b/i;

/**
 * The permit briefing is deliberately minimal: the Review Work Permits agent
 * fetches its own checklist evidence through its tools — that is its design,
 * and duplicating the read here would just be a second copy to drift. The
 * title/ref ride in from the feed card the panel already holds, so no extra
 * CMMS call is made.
 */
function permitBriefing(permitId, args) {
  const title = nameOf(args && args.record_title);
  const ref = args && args.record_ref ? String(args.record_ref) : "";
  return [
    "=== WORK PERMIT UNDER REVIEW ===",
    "Permit record id: " + permitId,
    ref ? "Console reference: " + ref : null,
    title ? "Permit: " + title : null,
    "=== END ===",
    "",
    "The reviewer is looking at this ONE work permit in the FM 360 Console.",
    "The console has NOT read its checklist for you — fetch this permit's full safety",
    "checklist with your own tools before saying anything about it.",
    "Work only on this permit unless the reviewer explicitly asks about another.",
  ].filter(Boolean).join("\n");
}

// ---- the work --------------------------------------------------------------

/**
 * One chat turn that survives the gateway timeout.
 *
 * run-agent-chat blocks until the team's full reply, but a real team run —
 * four member agents, tool calls — outlives the connections gateway, which
 * aborts the HTTP call while the run itself keeps going server-side (verified:
 * an "aborted" acknowledge still landed on the record). So on abort, ask the
 * same thread for a status report. Each aborted attempt blocks for the
 * gateway's own timeout, so the loop self-paces without needing timers.
 */
function isAbort(e) {
  return /abort/i.test(String((e && e.message) || e));
}

/**
 * An abort is ambiguous: the run may still be going server-side (a verified
 * acknowledge landed after one), or the message may never have arrived (also
 * verified — an instant abort lost the instruction entirely). So after an abort,
 * ask the thread point-blank whether it got the message, with a token we can
 * string-match, and resend the original when it didn't.
 */
function statusProbe(message) {
  return (
    "This is a delivery check, not a new task. My previous message was:\n\"" +
    String(message).slice(-300) +
    "\"\nIf you never received or never acted on that message, reply with exactly: NOT-RECEIVED\n" +
    "Otherwise report plainly what you completed, what failed, and anything you still need from me. Do not redo the task."
  );
}

/**
 * A turn can complete "ok" with no text at all — verified on thread 37006: the
 * Create Work Order tool errored, the team ended its turn without emitting
 * prose, and the panel rendered "(no reply)". An empty success is a hole, not
 * an answer: ask the same thread to say plainly what just happened.
 */
const EMPTY_TURN_FALLBACK =
  "The team finished this turn but sent no text back — ask it for a status update.";

const EMPTY_TURN_PROBE =
  "Your last turn ended without any text. In plain language, report what just happened on this request: " +
  "what succeeded, what failed (with the exact error), and anything you still need from me. " +
  "Do not redo the task and do not create anything new.";

async function recoverEmptyReply(threadId, team) {
  try {
    const run = await callAction("facilio-ai-studio", "run-agent-chat", {
      threadId, agent: team, message: EMPTY_TURN_PROBE,
    });
    return replyOf(run);
  } catch (e) {
    return null; // aborted or failed — the caller falls back to the honest string
  }
}

/** The record's current state label — the fastest truth about whether a write landed. */
async function stateOf(srId) {
  try {
    const resp = await callAction("facilio-cmms", "get-service-request", { id: srId });
    const sr = (resp && resp.data && typeof resp.data === "object" && !Array.isArray(resp.data))
      ? resp.data
      : envelope(resp).records[0];
    return sr ? (nameOf(sr.moduleState) || String(sr.moduleState ?? "")) : null;
  } catch (e) {
    return null;
  }
}

async function chatTurn(threadId, team, message, opts) {
  const progress = (opts && opts.progress) || (async () => {});
  const srId = opts && opts.srId;
  const stateBefore = opts && opts.stateBefore;

  // Up to 2 delivery attempts of the real message, each followed by
  // delivery-check probes when it aborts. Every aborted call blocks for the
  // gateway's own timeout, so the loop self-paces without timers.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const run = await callAction("facilio-ai-studio", "run-agent-chat", { threadId, agent: team, message });
      const reply = replyOf(run);
      if (reply) return { reply, pending: false, resent: attempt > 0 };
      // Completed but silent — never surface an empty turn. Ask the thread what
      // happened and return that; if even that comes back empty, say so honestly.
      const recovered = await recoverEmptyReply(threadId, team);
      return {
        reply: recovered || EMPTY_TURN_FALLBACK,
        pending: false,
        resent: attempt > 0,
        recovered: true,
      };
    } catch (e) {
      if (!isAbort(e)) throw e;
    }

    // Chat probes are slow (each one is another team run). The record itself is
    // the fast truth: if its state already moved, the write landed — say so now.
    if (srId && stateBefore) {
      const now = await stateOf(srId);
      if (now && now !== stateBefore) {
        return {
          reply:
            `Done — the request has moved from **${stateBefore}** to **${now}**. ` +
            "(The team's detailed reply was cut off by a transport timeout; ask for a status update if you want the details.)",
          pending: false,
          fast: true,
        };
      }
    }

    await progress("The team is taking a while — checking whether it received the request…");
    let verdict = null; // "lost" -> resend; anything else is the team's own report
    let emptyProbe = false; // a probe that completed ok but carried no text
    for (let i = 0; i < 4 && verdict == null; i++) {
      try {
        const run = await callAction("facilio-ai-studio", "run-agent-chat", {
          threadId, agent: team, message: statusProbe(message),
        });
        const reply = replyOf(run); // null for empty — an ok-but-silent probe says nothing; try again
        if (reply == null) { emptyProbe = true; continue; }
        verdict = /NOT-RECEIVED/i.test(reply) ? "lost" : reply;
      } catch (e) {
        if (!isAbort(e)) throw e;
      }
    }
    if (verdict != null && verdict !== "lost") {
      return { reply: verdict, pending: false, resumed: true };
    }
    // Every probe that got through was silent: the thread is answering, just not
    // with text. "Still working" would be a lie — return the honest fallback.
    if (verdict == null && emptyProbe) {
      return { reply: EMPTY_TURN_FALLBACK, pending: false, recovered: true };
    }
    if (verdict === "lost") await progress("The request was dropped in transit — resending it…");
    // verdict === "lost": the message never arrived — loop resends it.
    // verdict == null: every probe aborted too — fall through to pending.
    if (verdict == null) break;
  }

  // The team is still at it after every retry. Its writes land regardless; say so.
  return {
    reply:
      "The team is still working on this in the background — its changes will land on the record. " +
      "Ask for a status update in a minute, or close this panel and refresh the feed.",
    pending: true,
  };
}

// The default openings demand confirmation explicitly: a bare "acknowledge this"
// or "raise the work order" reads as pre-consent and lets the team write without
// asking the FM anything. Each intent maps to a present-then-confirm opening.
const OPENINGS = {
  acknowledge:
    "The FM wants to acknowledge this tenant service request. Before writing anything, present the proposed " +
    "acknowledgement details — tenant rechargeable, issue type (keep or change), and quote path if it will be " +
    "handled as a quote — and wait for the FM's explicit confirmation in this chat. Only acknowledge after " +
    "the FM confirms.",
  create_work_order:
    "The FM wants to raise the WORK ORDER for this ALREADY-ACKNOWLEDGED tenant service request — do not " +
    "re-acknowledge it. Before creating anything, gather the work order inputs from the FM in this chat: the " +
    "execution path, the work order type and priority (the valid options are listed in the OPTIONS block " +
    "above — present them by name, do not look them up again), " +
    "whether permits are mandatory (and which permit types if so), and any path-specific details the chosen " +
    "path needs. Present the proposed values and wait for the FM's explicit confirmation in this chat; only " +
    "create the work order after the FM confirms. AFTER it is created, report the work order's id, its " +
    "reference number and a one-line summary of it here in this chat, and tell the FM they can continue in " +
    "this same chat with the procurement initiation and the RFQ if the work is bought in.",
  // Mirrors the Review Work Permits agent's own contract (evidence first, one
  // recommendation, act only on the reviewer's explicit per-permit instruction)
  // rather than replacing it — the reminder reinforces, never weakens, its rules.
  review_permit:
    "The reviewer has opened the ONE work permit named in the briefing above. Read THAT permit's full safety " +
    "checklist with your tools, then give your single recommendation for it with the evidence behind it — " +
    "quoting the checklist questions and their notes exactly as written, including where notes were left " +
    "blank — exactly as your review procedure requires. Do not pull the whole queue and do not review any " +
    "other permit. Your own rules stand in full here: do NOT approve and do NOT reject this permit — or any " +
    "permit — unless the reviewer explicitly instructs that exact decision on that exact permit later in " +
    "this chat. Agreement with a recommendation, an 'ok' or a 'thanks' is not an instruction to act.",
};

async function runStart(args, progress) {
  const recordId = (args && args.sr_id) ? Number(args.sr_id) : recordIdOf(args && args.external_id);
  if (!recordId) throw new Error("external_id or sr_id is required");
  const intent = String((args && args.intent) || "acknowledge");
  // Target agent comes from the intent; an explicit args.team overrides.
  const team = (args && args.team) || INTENT_AGENT[intent] || DEFAULT_TEAM;
  const who = args && args.actor
    ? ` The ${intent === "review_permit" ? "reviewer" : "FM"} acting is ${args.actor}.`
    : "";

  let briefing, stateBefore = null, title;
  if (intent === "review_permit") {
    // Minimal briefing by design — the agent reads its own checklist evidence.
    // The record-state fast-path is SKIPPED for permits: stateOf reads service
    // requests, and no cheap permit-state read exists (the awaiting-approval
    // queue returns ~8KB per permit, unfiltered). Abort recovery still works
    // through the delivery-check probes in chatTurn.
    briefing = permitBriefing(recordId, args);
    title = "FM 360 Console · Permit " + recordId;
  } else {
    const { sr, siteId, site, briefing: record } = await briefingFor(recordId);
    stateBefore = nameOf(sr.moduleState) || String(sr.moduleState ?? "");
    // Raising a work order needs picklists the agent would otherwise fetch one at
    // a time mid-run; acknowledging needs none of them, so only pay for them here.
    // The procurement initiation and the RFQ both follow the work order in this
    // same thread, so the policy reads are worth paying for on the same turn —
    // all of them in parallel, so the extra reads cost no extra wall clock.
    briefing = record;
    if (intent === "create_work_order") {
      const [options, policy] = await Promise.all([
        workOrderOptions(),
        procurementContext(siteId, site),
      ]);
      briefing += options + policy;
    }
    // SR-team threads only. The RFQ is raised conversationally in this same thread
    // after the work order and the procurement initiation, so the guidance has to
    // be standing context, not an opening. It never reaches the permit agent —
    // that intent returns above, from the other arm of this branch.
    briefing += "\n" + RFQ_LINE_ITEMS + "\n" + PROCUREMENT_POLICY;
    title = "FM 360 Console · TSR " + recordId;
  }

  const opening = OPENINGS[intent] || OPENINGS.acknowledge;
  const message =
    (args && args.message && String(args.message).trim()) || opening + who;

  const thread = await callAction("facilio-ai-studio", "create-chat-thread", {
    agent: team,
    title,
    additionalContext: briefing,
  });
  const threadId = threadIdOf(thread);
  if (!threadId) throw new Error("no threadId in create-chat-thread response: " + JSON.stringify(thread).slice(0, 300));

  // The briefing rides along with the first message too, so the agent acts on the
  // record's real state even if one-shot context is trimmed.
  const turn = await chatTurn(threadId, team, `${briefing}\n\n${message}`, {
    srId: stateBefore != null ? recordId : null,
    stateBefore,
    progress,
  });

  return { ok: true, srId: recordId, team, threadId, ...turn, sentAt: nowIso() };
}

async function runSend(args, progress) {
  const threadId = Number(args && args.thread_id);
  if (!threadId) throw new Error("thread_id is required");
  const message = String((args && args.message) || "").trim();
  if (!message) throw new Error("message is required");
  const intent = String((args && args.intent) || "");
  const team = (args && args.team) || INTENT_AGENT[intent] || DEFAULT_TEAM;

  // Snapshot the record's state up front so an aborted turn can detect the
  // write landing without waiting out the slow chat recovery. Service requests
  // only: stateOf reads get-service-request, so a permit id here would silently
  // read a different module's record — permit turns skip the fast-path.
  const srId = intent !== "review_permit" && args && args.sr_id ? Number(args.sr_id) : null;
  const stateBefore = srId ? await stateOf(srId) : null;

  // Re-assert the standing guidance on the turn that actually reaches for it: the
  // briefing carries both blocks from message one, but either can fall out of a
  // trimmed history by the time the FM gets to procurement. SR team only —
  // review_permit routes to a different agent whose contract this must not touch.
  let outgoing = message;
  if (team === DEFAULT_TEAM && intent !== "review_permit") {
    const rfq = RFQ_ASK.test(message);
    // The RFQ turn needs the policy too: that is where the supplier counts and
    // the contracted/non-contracted split are actually used.
    if (rfq) outgoing += "\n" + RFQ_LINE_ITEMS;
    if (rfq || PROCUREMENT_ASK.test(message)) outgoing += "\n" + PROCUREMENT_POLICY;
  }

  const turn = await chatTurn(threadId, team, outgoing, { srId, stateBefore, progress });
  return { ok: true, threadId, team, ...turn, sentAt: nowIso() };
}

/**
 * Do the work, then announce the outcome on the console's topic.
 *
 * The team can spend minutes delegating across its four member agents, which
 * outlasts a synchronous browser call — so the panel starts these with
 * executeFunctionAsync and waits for this publish instead. run_id is the panel's
 * own correlation value: the server's runId is not visible in here.
 */
async function publishResult(kind, args, work) {
  const runId = String((args && args.run_id) || "");
  // A dropped turn costs a gateway timeout plus a resend, so the panel can sit on
  // a silent spinner for over a minute. Publish interim notes so the wait is legible.
  const progress = async (note) => {
    if (!runId) return;
    await events.publish(TOPIC, { runId, kind, progress: note });
  };
  let payload;
  try {
    payload = { ...(await work(progress)), runId, kind };
  } catch (e) {
    payload = { ok: false, runId, kind, error: String((e && e.message) || e).slice(0, 500) };
  }
  // publish never throws; a lost notification must not look like failed work.
  const sent = await events.publish(TOPIC, payload);
  return { ...payload, published: sent && sent.ok === true, receivers: sent && sent.receivers };
}

// ---- handlers --------------------------------------------------------------

const START_PARAMS = {
  external_id: { description: "external_id of the job (e.g. tsr:servicerequest:<id> or unblock:workpermit:<id>)", type: "string" },
  sr_id: { description: "Record id, when external_id isn't handy", type: "number" },
  message: { description: "Opening instruction (defaults to the intent's opening)", type: "string" },
  intent: { description: "What is being started: 'acknowledge' (default), 'create_work_order', or 'review_permit'", type: "string" },
  team: { description: "Agent Studio agent link name (overrides the intent's default target)", type: "string" },
  actor: { description: "Optional name/email of the person acting", type: "string" },
  record_title: { description: "Optional record title the panel already shows (rides into the briefing)", type: "string" },
  record_ref: { description: "Optional console reference (e.g. PMT-12) for the briefing", type: "string" },
};
const SEND_PARAMS = {
  thread_id: { description: "Thread id returned by 'start'", type: "number" },
  message: { description: "The user's prompt", type: "string" },
  sr_id: { description: "Service request record id, for fast state-change detection on aborted turns (service requests only)", type: "number" },
  intent: { description: "The intent the thread was opened with — routes the turn to the same agent", type: "string" },
  team: { description: "Agent Studio agent link name (overrides the intent's default target)", type: "string" },
};

server.addHandler({
  name: "start",
  description:
    "Blocking variant: open an Agent Studio thread for one record with the intent's agent (SR team, or review_work_permits for review_permit) and return the first reply. Fine from the CLI; the console uses start_async because an agent run outlasts a browser call.",
  parameters: START_PARAMS,
  execute: (args) => runStart(args),
});

server.addHandler({
  name: "send",
  description:
    "Blocking variant of a follow-up prompt into an existing agent thread.",
  parameters: SEND_PARAMS,
  execute: (args) => runSend(args),
});

server.addHandler({
  name: "start_async",
  description:
    "What the console calls: open the intent's agent thread for a record and publish the first reply to the 'srops' topic, tagged with run_id. Started with executeFunctionAsync so a long agent run can't time the browser out.",
  parameters: { ...START_PARAMS, run_id: { description: "The panel's correlation id, echoed back on the event", type: "string" } },
  execute: (args) => publishResult("start", args, (progress) => runStart(args, progress)),
});

server.addHandler({
  name: "send_async",
  description:
    "What the console calls for follow-up prompts: run the prompt in the existing thread and publish the agent's reply to the 'srops' topic, tagged with run_id.",
  parameters: { ...SEND_PARAMS, run_id: { description: "The panel's correlation id, echoed back on the event", type: "string" } },
  execute: (args) => publishResult("send", args, (progress) => runSend(args, progress)),
});

server.execute();
