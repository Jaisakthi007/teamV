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
  return { sr, briefing: lines.join("\n") };
}

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
    const { sr, briefing: record } = await briefingFor(recordId);
    stateBefore = nameOf(sr.moduleState) || String(sr.moduleState ?? "");
    // Raising a work order needs picklists the agent would otherwise fetch one at
    // a time mid-run; acknowledging needs none of them, so only pay for them here.
    briefing = intent === "create_work_order" ? record + (await workOrderOptions()) : record;
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

  const turn = await chatTurn(threadId, team, message, { srId, stateBefore, progress });
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
