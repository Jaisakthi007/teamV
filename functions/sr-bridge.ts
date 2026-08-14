import StudioFunctions from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "sr-bridge" });

/** Run a saved Connection Action. Internal *.facilio.* host — the host injects the service token. */
async function act(connection: string, action: string, input: unknown): Promise<any> {
  const res = await fetch(
    `${process.system.CONNECTIONS_URL}/api/v1/connections/${connection}/actions/${action}/execute`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${connection}.${action} failed: ${res.status} ${text.slice(0, 400)}`);
  }
  // Connections wrap results; unwrap the common envelopes.
  return body?.output ?? body?.data ?? body;
}

/** Non-fatal variant — a missing related record must not sink the whole context. */
async function tryAct(connection: string, action: string, input: unknown): Promise<any> {
  try {
    return await act(connection, action, input);
  } catch (e: any) {
    return { _error: e?.message || String(e) };
  }
}

/** Pull an id out of whatever shape a lookup came back in (number, {id}, or nested record). */
function idOf(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && typeof v.id === "number") return v.id;
  return null;
}

/** A short human label for a related record. */
function nameOf(v: any): string | null {
  if (v == null || typeof v !== "object") return null;
  return v.name ?? v.displayName ?? v.subject ?? null;
}

/** Only enrich when the record gave us a bare id rather than an expanded object. */
function needsEnrich(v: any): boolean {
  if (v == null) return false;
  if (typeof v === "number") return true;
  if (typeof v === "object") return nameOf(v) == null && typeof v.id === "number";
  return false;
}

/**
 * One server-side pass that gathers everything an agent needs to reason about a
 * service request: the record, its related site/client/tenant/building/space and
 * TSR taxonomy, and the buttons the record's own state machine will accept right now.
 */
async function assembleContext(srId: number) {
  const srRes = await act("facilio-cmms", "get-service-request", { id: srId });
  const sr = srRes?.data ?? srRes;
  if (!sr || typeof sr !== "object" || sr.id == null) {
    throw new Error(`service request ${srId} not found`);
  }

  // The org uses both base and custom lookups for the same concepts; prefer whichever is set.
  const siteV = sr.site ?? sr.siteId;
  const clientV = sr.client_serviceRequest ?? sr.client;
  const tenantV = sr.tenant_serviceRequest_1 ?? sr.tenant;
  const buildingV = sr.building_serviceRequest;
  const spaceV = sr.affected_location_serviceRequest;

  const related: Record<string, any> = {
    site: siteV ?? null,
    client: clientV ?? null,
    tenant: tenantV ?? null,
    building: buildingV ?? null,
    affectedSpace: spaceV ?? null,
  };

  // Enrich only what came back as a bare id. Calls are serialized in the sandbox anyway.
  const enrich: [string, any, string][] = [
    ["site", siteV, "get-site"],
    ["client", clientV, "get-client"],
    ["tenant", tenantV, "get-tenant"],
    ["building", buildingV, "get-building"],
    ["affectedSpace", spaceV, "get-space"],
  ];
  for (const [key, val, action] of enrich) {
    if (!needsEnrich(val)) continue;
    const id = idOf(val);
    if (id == null) continue;
    const r = await tryAct("facilio-cmms", action, { id });
    related[key] = r?.data ?? r ?? val;
  }

  const btnRes = await tryAct(
    "facilio-record-level-button-actions",
    "get-executable-buttons-for-a-record",
    { moduleName: "serviceRequest", recordId: srId },
  );
  const b = btnRes?.data ?? btnRes ?? {};
  const buttons = [
    ...(b.stateTransitions ?? []).map((x: any) => ({ ...x, buttonType: "stateTransition" })),
    ...(b.approvalTransitions ?? []).map((x: any) => ({ ...x, buttonType: "approval" })),
    ...(b.customButtons ?? []).map((x: any) => ({ ...x, buttonType: "customButton" })),
    ...(b.systemButtons ?? []).map((x: any) => ({ ...x, buttonType: "systemButton" })),
  ];

  return {
    serviceRequest: sr,
    related,
    currentState: b.currentState ?? sr.moduleState ?? null,
    availableButtons: buttons,
    buttonsError: b._error ?? null,
  };
}

/** Render the context as a compact briefing the model reads reliably. */
function renderContext(ctx: any): string {
  const sr = ctx.serviceRequest;
  const r = ctx.related;
  const rel = (k: string) => {
    const v = r[k];
    if (v == null) return "—";
    return nameOf(v) ?? (idOf(v) != null ? `#${idOf(v)}` : "—");
  };
  const state =
    typeof ctx.currentState === "object" && ctx.currentState
      ? (ctx.currentState.displayName ?? ctx.currentState.status ?? JSON.stringify(ctx.currentState))
      : String(ctx.currentState ?? "unknown");

  const lines = [
    "=== SERVICE REQUEST CONTEXT (authoritative, read-only) ===",
    `Record id: ${sr.id}`,
    `Subject: ${sr.subject ?? "—"}`,
    `Description: ${sr.description ?? "—"}`,
    `Current state: ${state}`,
    `Site: ${rel("site")}`,
    `Client: ${rel("client")}`,
    `Tenant: ${rel("tenant")}`,
    `Building: ${rel("building")}`,
    `Affected space: ${rel("affectedSpace")}`,
    `TSR Type: ${sr.tsr_type_serviceRequest ?? "—"}`,
    `TSR Category: ${nameOf(sr.tsr_category_serviceRequest) ?? "—"}`,
    `TSR Sub Category: ${nameOf(sr.tsr_sub_category_serviceRequest) ?? "—"}`,
    `Issue Location: ${sr.issue_location_serviceRequest ?? "—"}`,
    `Tenant Rechargeable?: ${sr.tenant_rechargeable__serviceRequest ?? "—"}`,
    `Tenant Quote Path: ${sr.tenant_quote_path_serviceRequest ?? "—"}`,
    `Urgency: ${sr.urgency ?? "—"}`,
    "",
    "Buttons this record's state machine will accept right now:",
  ];
  if (ctx.availableButtons.length === 0) {
    lines.push("  (none returned)");
  } else {
    for (const btn of ctx.availableButtons) {
      lines.push(
        `  - "${btn.displayName ?? btn.name ?? btn.buttonName ?? "?"}" (buttonType=${btn.buttonType}, buttonId=${btn.id ?? btn.buttonId})`,
      );
    }
  }
  lines.push("=== END CONTEXT ===");
  return lines.join("\n");
}

server.addHandler({
  name: "sr-context",
  description:
    "Assemble the full context for one service request (record, related site/client/tenant/building/space, and the buttons its state machine accepts now) in a single server-side pass.",
  parameters: {
    srId: { description: "Service request record id", type: "number" },
  },
  execute: async (args) => {
    const ctx = await assembleContext(Number(args.srId));
    return { ...ctx, briefing: renderContext(ctx) };
  },
});

server.addHandler({
  name: "ask-studio-agent",
  description:
    "Bridge: assemble full service-request context server-side, then call a Facilio Studio agent with that context attached to every message. Returns the agent's reply and the thread id to reuse.",
  parameters: {
    srId: { description: "Service request record id", type: "number" },
    question: { description: "What to ask the Studio agent", type: "string" },
    agent: {
      description: "Studio agent link name (default acknowledge_service_request)",
      type: "string",
    },
    threadId: {
      description: "Existing Studio chat thread id to continue; 0 or omitted starts a new thread",
      type: "number",
    },
  },
  execute: async (args) => {
    const srId = Number(args.srId);
    const question = String(args.question ?? "").trim();
    const agent = String(args.agent || "acknowledge_service_request");
    if (!question) throw new Error("question is required");

    const ctx = await assembleContext(srId);
    const briefing = renderContext(ctx);

    let threadId = Number(args.threadId ?? 0);
    let createdThread = false;
    if (!threadId) {
      const t = await act("facilio-ai-studio", "create-chat-thread", {
        agent,
        title: `SR #${srId} — Vibe bridge`,
        additionalContext: briefing,
      });
      threadId = Number((t?.thread ?? t)?.id);
      createdThread = true;
      if (!threadId) throw new Error("could not create Studio chat thread");
    }

    // Full context on EVERY call, not just at thread creation — the agent never has
    // to remember, and a reused thread can't drift from the record's real state.
    const message = `${briefing}\n\nUser request: ${question}`;

    const run = await act("facilio-ai-studio", "run-agent-chat", {
      threadId,
      agent,
      message,
    });

    return {
      srId,
      agent,
      threadId,
      createdThread,
      status: run?.status ?? null,
      reply: run?.content ?? null,
      contextSent: briefing,
      currentState: ctx.currentState,
      availableButtons: ctx.availableButtons,
    };
  },
});

/** Call any flow-ai agent (Studio agent or Vibe agent) with a fresh thread. */
async function askAgent(agent: string, message: string, additionalContext?: string) {
  const t = await act("facilio-ai-studio", "create-chat-thread", {
    agent,
    title: "Vibe bridge",
    ...(additionalContext ? { additionalContext } : {}),
  });
  const threadId = Number((t?.thread ?? t)?.id);
  if (!threadId) throw new Error(`could not create chat thread for ${agent}`);
  const run = await act("facilio-ai-studio", "run-agent-chat", { threadId, agent, message });
  return { threadId, status: run?.status ?? null, content: run?.content ?? null };
}

server.addHandler({
  name: "route-and-run",
  description:
    "The full bridge in one server-side pass: assemble full service-request context, let the Vibe router agent pick the right Facilio Studio agent, then call that Studio agent with the same full context. One browser call.",
  parameters: {
    srId: { description: "Service request record id", type: "number" },
    question: { description: "The user's plain-language instruction", type: "string" },
    routerAgent: {
      description: "Vibe router agent link name",
      type: "string",
    },
  },
  execute: async (args) => {
    const srId = Number(args.srId);
    const question = String(args.question ?? "").trim();
    if (!question) throw new Error("question is required");
    const routerAgent = String(args.routerAgent || process.env.ROUTER_AGENT_LINK_NAME || "");
    if (!routerAgent) throw new Error("routerAgent link name is required");

    // 1. Full context, assembled once, server-side.
    const ctx = await assembleContext(srId);
    const briefing = renderContext(ctx);

    // 2. The Vibe agent in the middle decides which Studio agent should act.
    const routed = await askAgent(routerAgent, `${briefing}\n\nUser request: ${question}`);
    let decision: any = null;
    try {
      decision = JSON.parse(String(routed.content ?? ""));
    } catch {
      decision = null;
    }

    const studioAgent = decision?.studioAgent || "acknowledge_service_request";
    const forwarded = decision?.message || question;

    // 3. The Studio agent gets the SAME full context, not just the routed sentence.
    const studio = await askAgent(
      studioAgent,
      `${briefing}\n\nUser request: ${forwarded}`,
      briefing,
    );

    return {
      srId,
      currentState: ctx.currentState,
      availableButtons: ctx.availableButtons,
      router: { agent: routerAgent, threadId: routed.threadId, decision, raw: routed.content },
      studio: {
        agent: studioAgent,
        threadId: studio.threadId,
        status: studio.status,
        reply: studio.content,
      },
      contextSent: briefing,
    };
  },
});

server.addHandler({
  name: "agent-smoke",
  description:
    "Connectivity check for the Studio-agent leg of the bridge: creates a thread and sends one message, with no service request involved.",
  parameters: {
    agent: {
      description: "Studio agent link name (default acknowledge_service_request)",
      type: "string",
    },
    question: { description: "Message to send", type: "string" },
  },
  execute: async (args) => {
    const agent = String(args.agent || "acknowledge_service_request");
    const question = String(args.question || "Connectivity check from the Vibe bridge. Reply in one short sentence.");
    const t = await act("facilio-ai-studio", "create-chat-thread", {
      agent,
      title: "Vibe bridge smoke",
    });
    const threadId = Number((t?.thread ?? t)?.id);
    if (!threadId) throw new Error("could not create Studio chat thread");
    const run = await act("facilio-ai-studio", "run-agent-chat", {
      threadId,
      agent,
      message: question,
    });
    return { agent, threadId, status: run?.status ?? null, reply: run?.content ?? null };
  },
});

server.execute();
