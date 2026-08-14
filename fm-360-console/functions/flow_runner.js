import StudioFunctions from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "flow_runner" });

// Filled in once the Agent Studio team exists; overridable per call via args.team.
const DEFAULT_TEAM = "fm360-console-sweep";
const DEFAULT_DISPATCHER = "fm360-daily-dispatcher";

const BUCKET_ORDER = [
  "tsr", "tsrack", "unblock", "referral", "completion", "findings",
  "stalled", "quotes", "spot", "tenant", "sla", "quoting", "invoicing",
];

const BUCKET_AGENT = {
  tsr: "fm360-tsr-agent",
  tsrack: "fm360-tsrack-agent",
  unblock: "fm360-unblock-agent",
  referral: "fm360-referral-agent",
  completion: "fm360-completion-agent",
  findings: "fm360-findings-agent",
  stalled: "fm360-stalled-agent",
  quotes: "fm360-quotes-agent",
  spot: "fm360-spot-agent",
  tenant: "fm360-tenant-agent",
  sla: "fm360-sla-agent",
  quoting: "fm360-quoting-agent",
  invoicing: "fm360-invoicing-agent",
};

function nowIso() {
  return new Date().toISOString();
}

// A flow run id must be stable and traceable but Math.random/Date.now drift is fine here.
function newFlowRunId() {
  return "flow-" + nowIso().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function callAction(connectionSlug, actionSlug, input) {
  const base = process.system.CONNECTIONS_URL;
  if (!base) throw new Error("CONNECTIONS_URL is not available to this run");
  const url = `${base}/api/v1/connections/${connectionSlug}/actions/${actionSlug}/execute`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ input }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${connectionSlug}.${actionSlug} failed ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return { raw: text };
  }
}

function threadIdOf(resp) {
  if (!resp) return null;
  const cands = [resp.id, resp.threadId, resp.thread_id];
  for (const c of cands) if (typeof c === "number") return c;
  const nested = [resp.data, resp.output, resp.result, resp.thread];
  for (const n of nested) {
    if (n && typeof n === "object") {
      const t = threadIdOf(n);
      if (t) return t;
    }
  }
  return null;
}

const SWEEP_MESSAGE =
  "Run the daily FM 360 Console sweep now. Work through every bucket in order and, for each one: read " +
  "its source records from the last day, apply that bucket's qualifying test, and write the qualifying " +
  "records into the job to be done module (or the signal module for sla, quoting and invoicing) with a " +
  "concrete what_needs_to_be_done for each. Call start-bucket-run before each bucket and finish-bucket-run " +
  "after it, using the flow_run_id given below. Never invent a record: if a source returns nothing, write " +
  "nothing for that bucket and say so. Mark data_confidence honestly as native, derived or seeded.";

// -------------------------------------------------------------- whole flow

server.addHandler({
  name: "run_flow",
  description:
    "Trigger the FM 360 Console agentic flow: open a thread with the Agent Studio sweep team and run every bucket agent in sequence.",
  parameters: {
    flow_run_id: { description: "Optional id for this run; generated when omitted", type: "string" },
    team: { description: "Agent Studio team link name (defaults to the console sweep team)", type: "string" },
    message: { description: "Optional override for the instruction sent to the team", type: "string" },
  },
  execute: async (args) => {
    const flowRunId = (args && args.flow_run_id) || newFlowRunId();
    const team = (args && args.team) || DEFAULT_TEAM;
    const startedAt = nowIso();

    let threadId = null;
    try {
      const thread = await callAction("facilio-ai-studio", "create-chat-thread", {
        agent: team,
        title: "FM 360 daily sweep " + flowRunId,
        additionalContext: JSON.stringify({
          flow_run_id: flowRunId,
          buckets: BUCKET_ORDER,
          jobModule: "job_to_be_done",
          signalModule: "signal",
          signalBuckets: ["sla", "quoting", "invoicing"],
          note: "Pass this flow_run_id to start-bucket-run, finish-bucket-run and every add-jobs-to-be-done / add-signals call.",
        }),
      });
      threadId = threadIdOf(thread);
      if (!threadId) throw new Error("no threadId in create-chat-thread response: " + JSON.stringify(thread).slice(0, 300));
    } catch (e) {
      return { ok: false, stage: "create-thread", flowRunId, startedAt, error: String(e.message || e) };
    }

    const message = (args && args.message) || `${SWEEP_MESSAGE}\n\nflow_run_id = ${flowRunId}`;
    try {
      const reply = await callAction("facilio-ai-studio", "run-agent-chat", { threadId, agent: team, message });
      return { ok: true, flowRunId, threadId, startedAt, finishedAt: nowIso(), reply };
    } catch (e) {
      // The team keeps running server-side even when this blocking call gives up,
      // so report the thread id rather than implying the sweep failed.
      return {
        ok: false, stage: "run-chat", flowRunId, threadId, startedAt, finishedAt: nowIso(),
        error: String(e.message || e),
        note: "The sweep may still be running in Agent Studio; check flow_run rows and thread " + threadId,
      };
    }
  },
});

// ------------------------------------------------------------ single bucket

server.addHandler({
  name: "run_bucket",
  description: "Run one bucket agent on its own. Useful for testing a single tab without the whole flow.",
  parameters: {
    bucket: { description: "Bucket id, e.g. tsr", type: "string" },
    flow_run_id: { description: "Optional flow run id", type: "string" },
  },
  execute: async (args) => {
    const bucket = args && args.bucket;
    if (!bucket) throw new Error("bucket is required");
    const agentName = BUCKET_AGENT[bucket];
    if (!agentName) throw new Error(`unknown bucket '${bucket}' (expected one of ${BUCKET_ORDER.join("|")})`);
    const flowRunId = (args && args.flow_run_id) || newFlowRunId();

    const thread = await callAction("facilio-ai-studio", "create-chat-thread", {
      agent: agentName,
      title: `FM 360 ${bucket} ${flowRunId}`,
      additionalContext: JSON.stringify({ flow_run_id: flowRunId, bucket }),
    });
    const threadId = threadIdOf(thread);
    if (!threadId) throw new Error("no threadId returned: " + JSON.stringify(thread).slice(0, 300));

    const reply = await callAction("facilio-ai-studio", "run-agent-chat", {
      agent: agentName,
      threadId,
      message:
        `Run your sweep now for bucket ${bucket}. flow_run_id = ${flowRunId}. ` +
        "Read your sources for the last day, apply your qualifying test, and write the qualifying records. " +
        "Write nothing if there is nothing genuine to write, and say so.",
    });
    return { ok: true, bucket, agent: agentName, flowRunId, threadId, reply };
  },
});

// --------------------------------------------------- sequential fallback driver

server.addHandler({
  name: "sweep",
  description:
    "Sequential fallback: drive each bucket agent directly, one after another, without going through the team. Use when the team run exceeds the request timeout.",
  parameters: {
    flow_run_id: { description: "Optional flow run id", type: "string" },
    from: { description: "Optional bucket to start at (resume a partial sweep)", type: "string" },
    limit: { description: "Optional max number of buckets to run this call", type: "number" },
  },
  execute: async (args) => {
    const flowRunId = (args && args.flow_run_id) || newFlowRunId();
    let order = BUCKET_ORDER.slice();
    if (args && args.from) {
      const i = order.indexOf(args.from);
      if (i < 0) throw new Error(`unknown bucket '${args.from}'`);
      order = order.slice(i);
    }
    const limit = args && args.limit ? Math.max(1, Number(args.limit)) : order.length;
    order = order.slice(0, limit);

    const results = [];
    for (const bucket of order) {
      const agentName = BUCKET_AGENT[bucket];
      try {
        const thread = await callAction("facilio-ai-studio", "create-chat-thread", {
          agent: agentName,
          title: `FM 360 ${bucket} ${flowRunId}`,
          additionalContext: JSON.stringify({ flow_run_id: flowRunId, bucket }),
        });
        const threadId = threadIdOf(thread);
        if (!threadId) throw new Error("no threadId returned");
        const reply = await callAction("facilio-ai-studio", "run-agent-chat", {
          agent: agentName,
          threadId,
          message:
            `Run your sweep now for bucket ${bucket}. flow_run_id = ${flowRunId}. ` +
            "Read your sources for the last day, apply your qualifying test, and write the qualifying records.",
        });
        results.push({ bucket, ok: true, threadId, reply });
      } catch (e) {
        results.push({ bucket, ok: false, error: String(e.message || e) });
      }
    }
    return {
      ok: results.every((r) => r.ok),
      flowRunId,
      ran: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).map((r) => ({ bucket: r.bucket, error: r.error })),
      results,
    };
  },
});

// ------------------------------------------------------------- the scheduler

server.addHandler({
  name: "dispatch",
  description:
    "Scheduler entry point. Asks the daily dispatcher agent to start the console sweep; the dispatcher owns the connection action that triggers the flow.",
  parameters: {
    flow_run_id: { description: "Optional flow run id", type: "string" },
    dispatcher: { description: "Dispatcher agent link name", type: "string" },
  },
  execute: async (args) => {
    const flowRunId = (args && args.flow_run_id) || newFlowRunId();
    const dispatcher = (args && args.dispatcher) || DEFAULT_DISPATCHER;
    const startedAt = nowIso();
    try {
      const thread = await callAction("facilio-ai-studio", "create-chat-thread", {
        agent: dispatcher,
        title: "FM 360 daily dispatch " + flowRunId,
        additionalContext: JSON.stringify({ flow_run_id: flowRunId, scheduledAt: startedAt }),
      });
      const threadId = threadIdOf(thread);
      if (!threadId) throw new Error("no threadId returned: " + JSON.stringify(thread).slice(0, 300));
      const reply = await callAction("facilio-ai-studio", "run-agent-chat", {
        agent: dispatcher,
        threadId,
        message:
          `Start today's FM 360 Console sweep. flow_run_id = ${flowRunId}. ` +
          "Trigger the console sweep flow, then report which buckets ran and what was written.",
      });
      return { ok: true, flowRunId, threadId, dispatcher, startedAt, finishedAt: nowIso(), reply };
    } catch (e) {
      return {
        ok: false, flowRunId, dispatcher, startedAt, finishedAt: nowIso(),
        error: String(e.message || e),
        note: "The dispatch may still be running in Agent Studio; check the flow_run rows.",
      };
    }
  },
});

server.execute();
