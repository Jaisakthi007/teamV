import { useEffect, useMemo, useRef, useState } from "react";
import { createVibe } from "@facilio/vibe-sdk";
import "./App.css";

const vibe = createVibe();
const PAGE_SIZE = 10;
const POLL_MS = 30000; // smart-poll cadence for live counts
const AGENT_TOPIC = "srops";       // where agent_bridge publishes each turn's result
const AGENT_TIMEOUT_MS = 660000;   // just past the run's 600s ceiling; a killed run never publishes
const newRunId = () =>
  (globalThis.crypto?.randomUUID?.() ?? "run-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
// The landing view asks triage for everything it will give (the handler caps at 12).
const IMPORTANT_LIMIT = 12;
// Vibe app agent that decides who must act on a finding (Tenant | FM | Unclear).
const FINDING_CLASSIFIER = "finding-classifier";
// What the composer's header calls each intent's agent; anything unlisted is
// the Service Request Operations team.
const AGENT_TITLES = { review_permit: "Review Work Permits" };

// `tsrack` is gone: "TSR's to acknowledge" and "Acknowledged TSRs" are ONE queue
// ("tsr") now, and each card carries its own state and its own next-step button.
const BUCKET_ORDER = ["tsr", "unblock", "referral", "completion", "findings", "stalled", "quotes", "spot", "tenant", "sla", "quoting", "invoicing"];

/* ---------------------------------------------------------------------------
   Severity is the one visual language in this console. Every dot, chip, accent
   bar and age pill resolves through here, so nothing can drift into an ad-hoc
   colour. The server still speaks in its old tone hexes, so they are mapped
   rather than replaced — the data's meaning is unchanged, only its rendering.
   Purple is the brand accent now, reserved for AI and active state, so a
   "signal" tone reads as info: a signal is a category, not a severity.
--------------------------------------------------------------------------- */
const SEV_VAR = {
  critical: "var(--critical)", warning: "var(--warning)",
  info: "var(--info)", success: "var(--success)",
};
function sevOf(tone, priority) {
  const t = String(tone || "").toUpperCase();
  if (t === "#B61919" || t === "#E5484D") return "critical";
  if (t === "#FFD405" || t === "#8A6D00" || t === "#F5A623") return "warning";
  if (t === "#0F6F06" || t === "#2FA968") return "success";
  if (t === "#5E3ED3" || t === "#5B45E0") return "info"; // signal category, not a severity
  if (t === "#0059D6" || t === "#3E7BFA") return "info";
  if (!t) {
    if (priority === "High" || priority === "Critical") return "critical";
    if (priority === "Medium") return "warning";
  }
  return "info";
}
// Queue dot severities, mapped from the old per-bucket palette.
const BUCKET_SEV = {
  tsr: "critical", tenant: "critical",
  unblock: "warning", referral: "warning", sla: "warning",
  completion: "info", findings: "info", stalled: "info", quotes: "info",
  spot: "info", quoting: "info", invoicing: "info",
};
// Age thresholds match triage.js's own language (>=48h red, >=8h amber) so a
// card and its ranked row can never disagree about how urgent waiting is.
function ageInfo(iso) {
  if (!iso) return { label: "", sev: null, exact: "" };
  const t = Date.parse(iso);
  if (isNaN(t)) return { label: "", sev: null, exact: "" };
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  const hrs = mins / 60;
  let label;
  if (mins < 60) label = mins + "m";
  else if (hrs < 48) label = Math.floor(hrs) + "h";
  else label = Math.floor(hrs / 24) + "d";
  const sev = hrs >= 48 ? "critical" : hrs >= 8 ? "warning" : "info";
  return { label: "Waiting " + label, sev, exact: fmtDateTime(iso) };
}

/**
 * ── Loading captions ──────────────────────────────────────────────────────────
 * Every set's FIRST entry is the plain, informative line, and it is always what a
 * fast load shows; the lighter variants only appear on later rotations, so a
 * 300ms response never gets a joke and a genuinely long wait develops some
 * personality. Nothing here claims progress the app cannot see ("almost there"),
 * blames anyone, or makes light of a hazard, an incident or a tenant's problem.
 * Keep every line under ~60 chars: these sit on one reserved line and a wrap
 * would move the page under the reader.
 */
const LOAD_BOOT = [
  "Loading…",
  "Opening the console",
  "Collecting every queue worth your attention",
];
const LOAD_IMPORTANT = [
  "Reading every action queue and ranking what's open…",
  "Deciding what deserves your next hour",
  "Sorting the urgent from the merely loud",
  "Weighing what waited longest against what starts soonest",
  "Asking every queue to justify its position",
];
const LOAD_QUEUE = [
  "Loading this queue…",
  "Fetching everything still open here",
  "Putting the newest at the top",
  "Turning rows into something you can act on",
];
// The Service Request Operations team delegates across four member agents, which
// is exactly what the later lines describe.
const LOAD_AGENT = [
  "Working…",
  "Reading the record before answering",
  "Consulting four specialists who all want a word",
  "Checking what has already been done on this one",
  "Drafting something you can actually send",
];
// Work-permit review is a safety-critical path: this set stays dry and factual.
const LOAD_PERMIT = [
  "Reviewing this permit…",
  "Reading the permit and its conditions",
  "Checking the evidence on this permit",
];
const LOAD_FINDING = [
  "Classifying responsibility…",
  "Reading the description for who has to act",
  "Deciding whether this one is the tenant's or ours",
];
const LOAD_DRILL = [
  "Loading lines…",
  "Fetching the referred lines on this order",
  "Comparing the order against the invoice",
  "Finding where the two sets of numbers disagree",
];
// One reserved line: the box keeps its height whichever caption is showing, so
// rotation never nudges the content under it.
const LOADER_LINE = { display: "block", minHeight: 20, lineHeight: "20px" };

/**
 * Rotate a loading caption every `intervalMs` while `active`.
 *
 * Deliberately restarts at index 0 on every activation — the plain line is what a
 * quick load shows, and the wit is what a slow one earns. Under
 * prefers-reduced-motion the caption is set once and never changes. No ARIA live
 * region is attached anywhere this is used: a screen reader announcing a new
 * caption every three seconds is worse than silence, and the text is in the DOM
 * to be read on demand.
 *
 * `messages` must be a stable (module-level) array; it is an effect dependency.
 */
function useLoaderLine(messages, active = true, intervalMs = 3000) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (!active || !messages || messages.length < 2) return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return undefined;
    const id = setInterval(() => setI((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, messages]);
  if (!messages || !messages.length) return "";
  return messages[i % messages.length];
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [user, setUser] = useState(null);
  const [counts, setCounts] = useState([]);
  const [tab, setTab] = useState("actions");
  const [bucket, setBucket] = useState(null);
  const [page, setPage] = useState(1);
  const [pageData, setPageData] = useState({ jobs: [], page: 1, totalPages: 1, total: 0 });
  const [loadingPage, setLoadingPage] = useState(false);
  // A failed queue read, rendered inline with a Retry — a 3s toast alone left a
  // dead end. Cleared on every successful load and on switching queues.
  const [pageError, setPageError] = useState(null);
  // False until the first counts read returns: before that the rail must show a
  // loading placeholder, not a premature "Nothing needs action right now".
  const [countsLoaded, setCountsLoaded] = useState(false);
  const [actingId, setActingId] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [agent, setAgent] = useState(null); // { job, threadId, turns[], busy }
  const [drill, setDrill] = useState(null);       // { job }
  const [drillData, setDrillData] = useState(null); // { po, lines, autoMatch }
  const [drillEdits, setDrillEdits] = useState({}); // lineId -> new unit price (string)
  const [drillBusy, setDrillBusy] = useState(false);
  const [important, setImportant] = useState(null); // null = not loaded yet, [] = loaded and empty
  const [importantBusy, setImportantBusy] = useState(false);
  const [importantError, setImportantError] = useState(null);
  const [importantAt, setImportantAt] = useState(null);
  const [toast, setToast] = useState(null);
  // The selected record fills the context panel. The list never unmounts, so the
  // FM never loses their place — this is the point of the three-pane cockpit.
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false); // only meaningful under 1100px
  // Inline outcome for the panel's action button: progress -> success/failure.
  const [result, setResult] = useState(null); // { id, status: busy|ok|err, text }
  const [composerOpen, setComposerOpen] = useState(false);
  // external_id -> { status: "pending"|"done"|"error", actionBy?, reason? }
  const [findingCls, setFindingCls] = useState({});
  const clsInFlight = useRef(new Set());
  const [lastTick, setLastTick] = useState(null);
  const [live, setLive] = useState(true);
  const stateRef = useRef({ bucket: null, page: 1, counts: [], tab: "actions" });
  stateRef.current = { bucket, page, counts, tab };
  const agentTimer = useRef(null);
  const surfaceRef = useRef(null);

  const actor = user?.user?.name || user?.user?.email || "";

  useEffect(() => {
    (async () => {
      try {
        const ok = await vibe.isAuthenticated();
        setAuthed(ok);
        if (ok) {
          setUser(await vibe.getCurrentUser().catch(() => null));
          refreshImportant();
          await refreshCounts();
        }
      } catch (e) { setAuthed(false); }
    })();
  }, []);

  // smart polling: only while the tab is visible; refresh immediately on return
  useEffect(() => {
    if (!authed) return;
    let timer = null;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const prev = stateRef.current.counts;
      // refreshCounts now owns the live flag (true on success, false on failure);
      // an unconditional setLive(true) here used to mask a failed tick as healthy.
      const cs = await refreshCounts();
      const b = stateRef.current.bucket;
      if (b) {
        const before = (prev.find((x) => x.bucket === b) || {}).count;
        const after = (cs.find((x) => x.bucket === b) || {}).count;
        if (before !== after) await loadPage(b, stateRef.current.page);
      } else if (stateRef.current.tab === "actions") {
        await refreshImportant({ quiet: true });
      }
    };
    timer = setInterval(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [authed]);

  // One subscription for the whole console. Every view hears every agent run, so
  // each keeps only the run it started.
  useEffect(() => {
    if (!authed) return;
    const sub = vibe.subscribe(AGENT_TOPIC, (evt) => {
      const p = (evt && evt.payload) || {};
      if (!p.runId) return;
      if (p.progress) {
        setAgent((a) => (a && a.runId === p.runId ? { ...a, note: p.progress } : a));
        return;
      }
      setAgent((a) => {
        if (!a || a.runId !== p.runId) return a;
        clearTimeout(agentTimer.current);
        const turn = p.ok
          ? { role: "agent", text: p.reply || "(no reply)" }
          : { role: "error", text: p.error || "The team could not complete that." };
        return { ...a, busy: false, runId: null, note: null, threadId: a.threadId || p.threadId || null, turns: [...a.turns, turn] };
      });
      if (p.ok) refreshCounts();
    });
    return () => sub.unsubscribe();
  }, [authed]); // eslint-disable-line

  // ── Findings: Tenant/FM responsibility, decided from the description by an LLM ──
  useEffect(() => {
    if (!authed) return;
    for (const j of (pageData.jobs || [])) {
      if (j.bucket === "findings") classifyFinding(j);
    }
  }, [authed, pageData]); // eslint-disable-line

  async function classifyFinding(job) {
    const key = job.external_id;
    if (findingCls[key] || clsInFlight.current.has(key)) return;
    clsInFlight.current.add(key);
    setFindingCls((m) => ({ ...m, [key]: { status: "pending" } }));
    try {
      const input = [
        "Subject: " + (job.title || ""),
        "Description: " + (job.description || ""),
        "Source: " + (job.meta || ""),
      ].join("\n");
      const res = await vibe.executeAgent(FINDING_CLASSIFIER, input);
      const raw = res?.response?.content;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      // Validate the agent's reply before it drives any UI action — never guess.
      const actionBy = ["Tenant", "FM", "Unclear"].includes(parsed?.actionBy) ? parsed.actionBy : "Unclear";
      setFindingCls((m) => ({ ...m, [key]: { status: "done", actionBy, reason: String(parsed?.reason || "") } }));
    } catch {
      setFindingCls((m) => ({ ...m, [key]: { status: "error" } }));
    } finally {
      clsInFlight.current.delete(key);
    }
  }

  function decorateFinding(r) {
    if (r.bucket !== "findings") return r;
    const cls = findingCls[r.external_id];
    const out = { ...r };
    if (!cls || cls.status === "pending") {
      // `findingLine` is the rotating caption; it starts on the plain
      // "Classifying responsibility…" so a quick verdict reads exactly as before.
      out.ai_note = findingLine;
    } else if (cls.status === "done" && cls.actionBy === "Tenant") {
      out.ai_note = "Tenant to action — " + cls.reason;
      out.actions = [{ label: "Raise Letter of Non Compliance", kind: "primary", act: "action" }, ...(r.actions || [])];
    } else if (cls.status === "done" && cls.actionBy === "FM") {
      out.ai_note = "FM to resolve — " + cls.reason;
      out.actions = [{ label: "Create Work Order", kind: "primary", act: "action" }, ...(r.actions || [])];
    } else if (cls.status === "done") {
      out.ai_note = cls.reason ? "Responsibility unclear — " + cls.reason : "Responsibility unclear.";
    } else {
      out.ai_note = "";
    }
    return out;
  }

  async function refreshImportant({ quiet } = {}) {
    if (!quiet) setImportantBusy(true);
    try {
      const r = await vibe.executeFunction("triage", "important", { limit: IMPORTANT_LIMIT });
      setImportant(Array.isArray(r?.items) ? r.items : []);
      setImportantAt(r?.ranAt || new Date().toISOString());
      setImportantError(null);
    } catch (e) {
      setImportant((prev) => (Array.isArray(prev) && prev.length ? prev : []));
      setImportantError(String(e?.message || e || "Triage is unavailable"));
    } finally { if (!quiet) setImportantBusy(false); }
  }

  async function refreshCounts() {
    try {
      const r = await vibe.executeFunction("feed", "counts", {});
      setCounts(r.buckets || []);
      setCountsLoaded(true);
      setLastTick(r.ranAt || new Date().toISOString());
      setLive(true);
      return r.buckets || [];
    } catch (e) { setLive(false); setCountsLoaded(true); return stateRef.current.counts; }
  }
  async function loadPage(b, p) {
    if (!b) return;
    setLoadingPage(true);
    try {
      const r = await vibe.executeFunction("feed", "bucket", { bucket: b, page: p, pageSize: PAGE_SIZE });
      setPageData(r); setPage(r.page);
      setPageError(null);
    } catch (e) {
      // Kept inline (with a Retry) as well as toasted: the toast is gone in 3s,
      // and a failed queue must never read as an empty one.
      setPageError(String(e?.message || e));
      flash("Couldn't load " + b + ": " + (e?.message || e));
    }
    finally { setLoadingPage(false); }
  }

  async function selectBucket(b) {
    setBucket(b); setPage(1); clearSelection();
    // Drop the previous queue's cards NOW: without this they linger dimmed — but
    // still clickable — under the new queue's heading until the load lands.
    setPageData({ jobs: [], page: 1, totalPages: 1, total: 0 });
    setPageError(null);
    await loadPage(b, 1);
  }
  function goHome() {
    setBucket(null);
    setPage(1);
    setPageData({ jobs: [], page: 1, totalPages: 1, total: 0 });
    clearSelection();
    refreshImportant();
  }
  async function gotoPage(p) { if (!bucket || p < 1 || p > pageData.totalPages) return; clearSelection(); await loadPage(bucket, p); }

  function clearSelection() { setSelected(null); setPanelOpen(false); setResult(null); setComposerOpen(false); }
  function pick(job) {
    setSelected(job);
    setPanelOpen(true);
    setResult(null);
    setComposerOpen(false);
  }

  async function takeAction(job, action) {
    if (action.act === "open") { if (job.record_url) window.open(job.record_url, "_blank", "noopener"); return; }
    if (action.act === "quote") { setQuote({ job }); setQuoteAmount(""); return; }
    // Acknowledging a TSR is a conversation with the Service Request Operations
    // team, not a one-shot write.
    if (action.act === "agent") { openAgent(job, action); return; }
    if (action.act === "drill") { openDrill(job); return; }
    if (action.act === "approve" || action.act === "reject") {
      setActingId(job.external_id);
      setResult({ id: job.external_id, status: "busy", text: action.label + "…" });
      setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
      // On the landing view the ranked row is the card — it leaves optimistically too.
      setImportant((prev) => (Array.isArray(prev) ? prev.filter((i) => i.external_id !== job.external_id) : prev));
      setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
      try {
        const res = await vibe.executeFunction("feed", "permit_decision", { external_id: job.external_id, decision: action.act, actor });
        if (res?.ok) {
          setResult({ id: job.external_id, status: "ok", text: `${job.ref} — ${res.permit_status}` });
          flash(`${job.ref} — ${res.permit_status}`); await refreshCounts(); await loadPage(bucket, page);
          if (!bucket) await refreshImportant({ quiet: true });
        } else {
          setResult({ id: job.external_id, status: "err", text: res?.error || "Could not complete that." });
          flash(`Couldn't ${action.label.toLowerCase()}: ${res?.error || "error"}`); await loadPage(bucket, page);
          if (!bucket) await refreshImportant({ quiet: true });
        }
      } catch (e) {
        setResult({ id: job.external_id, status: "err", text: String(e?.message || e) });
        flash(`${action.label} failed: ` + (e?.message || e)); await loadPage(bucket, page);
        if (!bucket) await refreshImportant({ quiet: true });
      }
      finally { setActingId(null); }
      return;
    }
    if (action.act !== "action") { flash(`${action.label} · ${job.ref}`); return; }
    setActingId(job.external_id);
    setResult({ id: job.external_id, status: "busy", text: action.label + "…" });
    // optimistic: remove the card and drop the badge now (ranked row included)
    setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
    setImportant((prev) => (Array.isArray(prev) ? prev.filter((i) => i.external_id !== job.external_id) : prev));
    setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
    try {
      const res = await vibe.executeFunction("feed", "act", { external_id: job.external_id, action_type: action.label, actor });
      if (res?.ok) {
        setResult({ id: job.external_id, status: "ok", text: `${action.label} · synced to Facilio` });
        flash(`${action.label} · ${job.ref} — synced to Facilio`);
        await refreshCounts();
        await loadPage(bucket, page);
        if (!bucket) await refreshImportant({ quiet: true });
      } else {
        setResult({ id: job.external_id, status: "err", text: res?.error || "unknown error" });
        flash(`Couldn't sync to Facilio: ${res?.error || "unknown error"}`);
        await loadPage(bucket, page); // restore
        if (!bucket) await refreshImportant({ quiet: true });
      }
    } catch (e) {
      setResult({ id: job.external_id, status: "err", text: String(e?.message || e) });
      flash("Action failed: " + (e?.message || e)); await loadPage(bucket, page);
      if (!bucket) await refreshImportant({ quiet: true });
    }
    finally { setActingId(null); }
  }

  /**
   * Start one agent turn. The team delegates across four member agents, which
   * routinely outlasts a synchronous call — so the run is fired with
   * executeFunctionAsync and its reply comes back over the 'srops' topic,
   * matched on the runId minted here.
   */
  async function runAgentTurn({ handler, args, job, prompt }) {
    const runId = newRunId();
    setAgent((a) => {
      const base = a || { job, threadId: null, turns: [] };
      return { ...base, job: job || base.job, busy: true, runId, note: null, turns: [...base.turns, { role: "fm", text: prompt }] };
    });

    clearTimeout(agentTimer.current);
    agentTimer.current = setTimeout(() => {
      setAgent((a) => (a && a.runId === runId
        ? { ...a, busy: false, runId: null, turns: [...a.turns, { role: "error", text: "The team is taking longer than expected. It may still be working — reopen this request in a moment to see where it got to." }] }
        : a));
    }, AGENT_TIMEOUT_MS);

    try {
      await vibe.executeFunctionAsync("agent_bridge", handler, { ...args, run_id: runId }, { timeoutSeconds: 600 });
    } catch (e) {
      clearTimeout(agentTimer.current);
      setAgent((a) => (a && a.runId === runId
        ? { ...a, busy: false, runId: null, turns: [...a.turns, { role: "error", text: String(e?.message || e) }] }
        : a));
    }
  }

  function openAgent(job, action) {
    const opening = action.prompt || "Acknowledge this tenant service request.";
    setSelected(job); setPanelOpen(true); setComposerOpen(true); setResult(null);
    setAgent({ job, intent: action.intent, threadId: null, turns: [], busy: false, runId: null });
    runAgentTurn({
      handler: "start_async",
      args: { external_id: job.external_id, actor, intent: action.intent, record_title: job.title, record_ref: job.ref },
      job, prompt: opening,
    });
  }

  /**
   * The bridge only knows how to open a thread for service requests and work
   * permits (agent_bridge start_async: tsr:servicerequest:<id> or
   * unblock:workpermit:<id>). For anything else the composer says so up front
   * instead of letting Send do nothing.
   */
  function composerIntentFor(job) {
    if (!job) return null;
    if (job.bucket === "unblock") return "review_permit";
    const seg = String(job.external_id || "").split(":");
    if (seg[seg.length - 2] !== "servicerequest") return null;
    // Same derivation the card's own button uses: an unacknowledged request goes
    // through the whole flow; an acknowledged one is at the work-order step.
    return String(job.state || job.status || "") === "Acknowledged" || String(job.state || "") === "tsrvalidated"
      ? "create_work_order"
      : "tsr_flow";
  }

  function sendAgent(text) {
    const msg = String(text || "").trim();
    if (!msg || agent?.busy) return;
    // No conversation yet: the composer STARTS one for the selected record, the
    // same way the card's action button would — typing into "Ask / do more" and
    // pressing Send must never be a silent no-op.
    if (!agent) {
      const job = selected;
      const intent = composerIntentFor(job);
      if (!job || !intent) return; // Send is disabled + hinted in this case
      setComposerOpen(true);
      setAgent({ job, intent, threadId: null, turns: [], busy: false, runId: null });
      runAgentTurn({
        handler: "start_async",
        args: { external_id: job.external_id, message: msg, actor, intent, record_title: job.title, record_ref: job.ref },
        job, prompt: msg,
      });
      return;
    }
    const seg = String(agent.job.external_id || "").split(":");
    // The bridge's record-state fast-path reads service requests only.
    const srId = seg[seg.length - 2] === "servicerequest" ? Number(seg[seg.length - 1]) || undefined : undefined;
    const [handler, args] = agent.threadId
      ? ["send_async", { thread_id: agent.threadId, message: msg, sr_id: srId, intent: agent.intent }]
      : ["start_async", { external_id: agent.job.external_id, message: msg, actor, intent: agent.intent, record_title: agent.job.title, record_ref: agent.job.ref }];
    runAgentTurn({ handler, args, job: agent.job, prompt: msg });
  }

  // The team writes to the record, so re-read the feed when the conversation is
  // dismissed: an acknowledged TSR leaves moduleState=Open and drops off on its own.
  async function closeAgent() {
    clearTimeout(agentTimer.current);
    setAgent(null);
    await refreshCounts();
    if (bucket) await loadPage(bucket, page);
  }

  async function submitQuote() {
    const amt = Number(quoteAmount);
    if (!amt || amt <= 0) { flash("Enter a valid quoted amount"); return; }
    const job = quote.job;
    setQuoteBusy(true);
    try {
      const res = await vibe.executeFunction("feed", "create_tenant_quote", { external_id: job.external_id, amount: amt, actor });
      if (res?.ok) {
        flash(`Tenant quote created for ${job.ref}${res.quoteId ? " · #" + res.quoteId : ""}`);
        setResult({ id: job.external_id, status: "ok", text: `Tenant quote created${res.quoteId ? " · #" + res.quoteId : ""}` });
        setQuote(null);
        setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
        setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
        await refreshCounts(); await loadPage(bucket, page);
        if (!bucket) await refreshImportant({ quiet: true });
      } else {
        flash("Couldn't create quote: " + (res?.error || "unknown error"));
      }
    } catch (e) { flash("Create quote failed: " + (e?.message || e)); }
    finally { setQuoteBusy(false); }
  }

  async function openDrill(job) {
    setDrill({ job }); setDrillData(null); setDrillEdits({});
    try {
      const r = await vibe.executeFunction("feed", "po_reconcile_view", { external_id: job.external_id });
      setDrillData(r);
      const init = {};
      (r.lines || []).forEach((l) => { init[l.lineId] = String(l.invoiceUnitPrice != null ? l.invoiceUnitPrice : l.poUnitPrice); });
      setDrillEdits(init);
    } catch (e) { flash("Couldn't load lines: " + (e?.message || e)); setDrill(null); }
  }
  function setAllToInvoice() {
    setDrillEdits((prev) => {
      const next = { ...prev };
      (drillData?.lines || []).forEach((l) => { if (l.invoiceUnitPrice != null) next[l.lineId] = String(l.invoiceUnitPrice); });
      return next;
    });
  }
  async function applyReconcile() {
    const lines = drillData?.lines || [];
    const updates = lines
      .map((l) => ({ lineId: l.lineId, unitPrice: Number(drillEdits[l.lineId]) }))
      .filter((u) => u.lineId != null && !isNaN(u.unitPrice));
    if (!updates.length) { flash("Nothing to update"); return; }
    setDrillBusy(true);
    const job = drill.job;
    try {
      const res = await vibe.executeFunction("feed", "po_reconcile_apply", { external_id: job.external_id, updates: JSON.stringify(updates), actor });
      if (res?.ok) {
        flash(`${job.ref} — ${res.updated} line${res.updated === 1 ? "" : "s"} updated`);
        setDrill(null);
        setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
        setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
        await refreshCounts(); await loadPage(bucket, page);
      } else { flash("Couldn't update PO: " + (res?.error || "error")); }
    } catch (e) { flash("Update failed: " + (e?.message || e)); }
    finally { setDrillBusy(false); }
  }

  function flash(m) { setToast(m); clearTimeout(window.__t); window.__t = setTimeout(() => setToast(null), 3000); }

  const countByBucket = useMemo(() => { const m = {}; counts.forEach((c) => (m[c.bucket] = c.count)); return m; }, [counts]);
  const labelByBucket = useMemo(() => { const m = {}; counts.forEach((c) => (m[c.bucket] = c.label)); return m; }, [counts]);
  const signalByBucket = useMemo(() => { const m = {}; counts.forEach((c) => (m[c.bucket] = !!c.signal)); return m; }, [counts]);
  const visibleBuckets = BUCKET_ORDER.filter((b) => counts.some((c) => c.bucket === b) && (tab === "signals") === !!signalByBucket[b] && (countByBucket[b] || 0) > 0);

  // Keeps the selection honest as counts move and tabs switch.
  useEffect(() => {
    if (!authed) return;
    if (tab === "signals") {
      if (visibleBuckets.length && !visibleBuckets.includes(bucket)) selectBucket(visibleBuckets[0]);
      return;
    }
    if (bucket && !visibleBuckets.includes(bucket)) goHome();
  }, [tab, counts]); // eslint-disable-line

  const actionsTotal = counts.filter((c) => !c.signal).reduce((a, c) => a + (c.count || 0), 0);
  const signalsTotal = counts.filter((c) => c.signal).reduce((a, c) => a + (c.count || 0), 0);
  // Left undecorated here: decorateFinding reads the rotating `findingLine`, which
  // is declared below, so the decoration happens at render time instead. It only
  // touches ai_note and actions, so keyboard navigation over `rows` is unaffected.
  const records = pageData.jobs || [];
  const showLanding = tab === "actions" && !bucket;
  const rows = showLanding ? (important || []) : records;

  // ── keyboard: j/k or arrows move, Enter opens, Esc closes ──
  useEffect(() => {
    function onKey(e) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (quote || drill) return; // j/k must not move the list behind an open modal
      if (e.key === "Escape") { clearSelection(); return; }
      const list = rows;
      if (!list.length) return;
      const isDown = e.key === "j" || e.key === "ArrowDown";
      const isUp = e.key === "k" || e.key === "ArrowUp";
      if (!isDown && !isUp) return;
      e.preventDefault();
      const i = list.findIndex((r) => r.external_id === selected?.external_id);
      const next = isDown ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      const target = list[i < 0 ? 0 : next];
      if (target) {
        pick(target);
        document.getElementById("row-" + target.external_id)?.scrollIntoView({ block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected, quote, drill]); // eslint-disable-line

  // Rotating captions. Each is idle (and its timer unmounted) unless the thing it
  // describes is actually in flight, so nothing here re-renders the console while
  // it is just sitting there.
  const bootLine = useLoaderLine(LOAD_BOOT, authed === null);
  const queueLine = useLoaderLine(LOAD_QUEUE, loadingPage);
  const drillLine = useLoaderLine(LOAD_DRILL, !!drill && !drillData);
  const findingLine = useLoaderLine(
    LOAD_FINDING,
    Object.values(findingCls).some((c) => c && c.status === "pending"),
  );

  if (authed === null) return <Center><span style={LOADER_LINE}>{bootLine}</span></Center>;
  if (authed === false)
    return (
      <Center>
        <div style={{ textAlign: "center" }}>
          <Logo />
          <h1 style={{ margin: "16px 0 6px", fontSize: 22 }}>FM 360 Console</h1>
          <p style={{ color: "var(--ink-2)", marginBottom: 20 }}>Sign in with your Facilio account to continue.</p>
          <button className="btn btn--primary" onClick={() => vibe.login()}>Sign in</button>
        </div>
      </Center>
    );

  const agentForSelected = agent && selected && agent.job?.external_id === selected.external_id ? agent : null;

  return (
    <div className="app">
      <header className="topbar">
        <Logo small dark />
        <span className="topbar__title">FM 360 <em>Console</em></span>
        <LiveDot live={live} lastTick={lastTick} />
        <span className="topbar__spacer" />
        <button className="btn btn--ghost btn--sm" onClick={() => { refreshCounts(); refreshImportant(); if (bucket) loadPage(bucket, page); }}>
          Refresh
        </button>
        <div style={{
          width: 30, height: 30, borderRadius: 9, color: "#fff",
          background: "linear-gradient(135deg, #6a58f2, #4534c4)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,.22)",
          display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
        }} title={actor}>
          {(actor || "U").slice(0, 2).toUpperCase()}
        </div>
      </header>

      <div className="cockpit">
        {/* ─────────────────────────── queue rail ─────────────────────────── */}
        <nav className="rail" aria-label="Queues">
          <div className="seg" role="tablist">
            <button className="seg__btn" role="tab" aria-selected={tab === "actions"} onClick={() => setTab("actions")}>
              Needs action <span className="seg__n tnum">{actionsTotal}</span>
            </button>
            <button className="seg__btn" role="tab" aria-selected={tab === "signals"} onClick={() => setTab("signals")}>
              Signals <span className="seg__n tnum">{signalsTotal}</span>
            </button>
          </div>

          {tab === "actions" && (
            <button className="qrow" aria-current={!bucket} onClick={goHome} style={{ "--qc": "var(--brand)" }}>
              <span className="qrow__dot" />
              <span className="qrow__label">Important now</span>
              <span className="qrow__n tnum">{important ? important.length : "—"}</span>
            </button>
          )}

          <div className="railcap">{tab === "signals" ? "Signals" : "Queues"}</div>

          {visibleBuckets.map((b) => (
            <button
              key={b} className="qrow" aria-current={bucket === b} onClick={() => selectBucket(b)}
              style={{ "--qc": SEV_VAR[BUCKET_SEV[b] || "info"] }}
            >
              <span className="qrow__dot" />
              <span className="qrow__label" title={labelByBucket[b] || b}>{labelByBucket[b] || b}</span>
              <span className="qrow__n tnum">{countByBucket[b]}</span>
            </button>
          ))}
          {/* Before the first counts read lands, the rail is LOADING — showing
              "Nothing needs action" then would be a false empty state. */}
          {!visibleBuckets.length && !countsLoaded && (
            <div aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
                  <span className="skel" style={{ width: 8, height: 8, borderRadius: 8 }} />
                  <span className="skel" style={{ flex: 1, height: 11 }} />
                  <span className="skel" style={{ width: 20, height: 11 }} />
                </div>
              ))}
            </div>
          )}
          {!visibleBuckets.length && countsLoaded && (
            <p style={{ color: "var(--ink-3)", fontSize: 12.5, padding: "6px 10px", lineHeight: 1.5 }}>
              {tab === "signals" ? "No signals are open." : "Nothing needs action right now."}
            </p>
          )}

          <div className="railfoot">
            <LiveDot live={live} lastTick={lastTick} />
            {live ? (
              <div>Auto-refresh {POLL_MS / 1000}s</div>
            ) : (
              // A grey dot alone gave no way back; the retry is the same read the
              // topbar Refresh runs.
              <div>
                Auto-refresh paused ·{" "}
                <button
                  onClick={() => { refreshCounts(); if (bucket) loadPage(bucket, page); }}
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--brand-ink)", font: "inherit", fontWeight: 600, textDecoration: "underline" }}
                >
                  Retry
                </button>
              </div>
            )}
            {lastTick && <div>Updated {fmt(lastTick)}</div>}
          </div>
        </nav>

        {/* ───────────────────────── work surface ───────────────────────── */}
        <main className="surface" ref={surfaceRef}>
          <div className="surface__inner">
            {showLanding ? (
              <>
              <FirstRun />
              <ImportantNow
                items={important} busy={importantBusy} error={importantError} at={importantAt}
                selectedId={selected?.external_id} actingId={actingId}
                onPick={pick} onOpenQueue={selectBucket} onRetry={() => refreshImportant()}
                onAction={(it, a) => takeAction(it, a)}
              />
              </>
            ) : (
              <>
                {tab === "actions" && (
                  <button className="btn btn--ghost btn--sm" onClick={goHome} style={{ marginBottom: 12 }}>
                    ← Important now
                  </button>
                )}
                <div className="qhead">
                  <h1>{bucket ? (labelByBucket[bucket] || bucket) : "—"}</h1>
                  {/* The caption line is already here and already occupied, so the
                      loading state borrows it: no extra vertical space, and the
                      list underneath cannot shift. */}
                  <span className="qhead__sub tnum" style={LOADER_LINE}>
                    {loadingPage
                      ? queueLine
                      : pageData.total > 0
                        ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, pageData.total)} of ${pageData.total} · newest first`
                        : "nothing open"}
                  </span>
                </div>

                {loadingPage && !records.length && <SkeletonList />}

                {/* A failed load is an ERROR with a way back, never a fake empty
                    queue — the toast alone disappeared in three seconds. */}
                {!loadingPage && pageError && (
                  <div className="errbox" style={{ marginTop: 14 }}>
                    <span style={{ flex: 1 }}>
                      Couldn't load this queue. <span style={{ opacity: 0.8 }}>{pageError}</span>
                    </span>
                    <button className="btn btn--sm" onClick={() => loadPage(bucket, page)}>Retry</button>
                  </div>
                )}

                {!loadingPage && !pageError && !records.length && (
                  <div className="empty" style={{ marginTop: 14 }}>
                    <div className="empty__mark">✓</div>
                    <div className="empty__h">You're all caught up in this queue</div>
                    <p className="empty__p">
                      Nothing is open in {labelByBucket[bucket] || "this queue"} right now. Pick another queue,
                      or go back to the ranked list.
                    </p>
                    <button className="btn" onClick={goHome}>Back to Important now</button>
                  </div>
                )}

                <div className="cards" style={{ opacity: loadingPage && records.length ? 0.55 : 1 }}>
                  {records.map((r) => (
                    <Card
                      key={r.external_id} r={decorateFinding(r)}
                      selected={selected?.external_id === r.external_id}
                      acting={actingId === r.external_id}
                      onPick={() => pick(r)}
                      onAction={(a) => takeAction(r, a)}
                    />
                  ))}
                </div>

                {pageData.totalPages > 1 && (
                  <div className="pager">
                    <button className="btn btn--sm" disabled={page <= 1} onClick={() => gotoPage(page - 1)}>← Prev</button>
                    <span className="tnum">Page {page} of {pageData.totalPages}</span>
                    <button className="btn btn--sm" disabled={page >= pageData.totalPages} onClick={() => gotoPage(page + 1)}>Next →</button>
                  </div>
                )}
              </>
            )}

            {!!rows.length && (
              <p className="kbdhint">
                <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> opens the panel · <kbd>Esc</kbd> closes
              </p>
            )}
          </div>
        </main>

        {/* ────────────────────── context + action panel ────────────────────── */}
        {panelOpen && selected && <div className="sheet-scrim" onClick={clearSelection} />}
        <aside className={"panel" + (panelOpen && selected ? " panel--open" : "")} aria-label="Record detail">
          {!selected ? (
            <div className="panel__scroll">
              <div style={{ marginTop: 40, textAlign: "center", color: "var(--ink-3)" }}>
                <div style={{
                  width: 40, height: 40, margin: "0 auto 12px", borderRadius: 10,
                  border: "1px dashed var(--hairline-strong)",
                }} />
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-2)" }}>Nothing selected</div>
                <p style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: "26ch", margin: "6px auto 0" }}>
                  Pick a record to see its context, why it is here, and what to do next.
                </p>
              </div>
            </div>
          ) : (
            <ContextPanel
              job={selected}
              agent={agentForSelected}
              result={result?.id === selected.external_id ? result : null}
              acting={actingId === selected.external_id}
              composerOpen={composerOpen}
              canAsk={!!agentForSelected || !!composerIntentFor(selected)}
              onToggleComposer={() => setComposerOpen((v) => !v)}
              onAction={(a) => takeAction(selected, a)}
              onSend={sendAgent}
              onDismissAgent={closeAgent}
              onClose={clearSelection}
            />
          )}
        </aside>
      </div>

      {quote && (
        <div onClick={() => !quoteBusy && setQuote(null)} style={{ position: "fixed", inset: 0, background: "rgba(16,19,23,.42)", display: "grid", placeItems: "center", zIndex: 80 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "92vw", background: "var(--surface)", borderRadius: 14, padding: "22px 24px", boxShadow: "0 20px 60px rgba(16,19,23,.3)" }}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 2 }}>Create Tenant Quote</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 18 }}>{quote.job.ref} · {quote.job.title}</div>
            <label style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-3)" }}>Quoted amount</label>
            <input
              type="number" min="0" step="0.01" autoFocus value={quoteAmount}
              onChange={(e) => setQuoteAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitQuote(); }}
              placeholder="e.g. 1800"
              style={{ width: "100%", marginTop: 6, padding: "10px 12px", fontSize: 15, border: "1px solid var(--hairline-strong)", borderRadius: 8, outline: "none", font: "inherit" }}
            />
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>Everything else is pulled from the service request.</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
              <button className="btn" disabled={quoteBusy} onClick={() => setQuote(null)}>Cancel</button>
              <button className="btn btn--primary" disabled={quoteBusy} onClick={submitQuote}>{quoteBusy ? "Creating…" : "Create Quote"}</button>
            </div>
          </div>
        </div>
      )}

      {drill && (
        <div onClick={() => !drillBusy && setDrill(null)} style={{ position: "fixed", inset: 0, background: "rgba(16,19,23,.42)", display: "grid", placeItems: "center", zIndex: 80 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 780, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto", background: "var(--surface)", borderRadius: 14, padding: "22px 24px", boxShadow: "0 20px 60px rgba(16,19,23,.3)" }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Referred order · {drill.job.ref}</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 14 }}>Update each referred line's PO unit cost to match the invoice, or edit manually.</div>
            {!drillData && (
              <>
                <p style={{ color: "var(--ink-2)", fontSize: 13, ...LOADER_LINE }}>{drillLine}</p>
                <SkeletonList rows={3} />
              </>
            )}
            {drillData && !drillData.lines.length && <p style={{ color: "var(--ink-2)" }}>No referred lines found on this order.</p>}
            {drillData && drillData.lines.length > 0 && (
              <>
                {!drillData.autoMatch && (
                  <div className="result result--busy" style={{ marginBottom: 12 }}>
                    Invoice line matching isn't available for this order — invoice prices show as “—”. Enter the corrected unit costs manually.
                  </div>
                )}
                <div className="tablewrap">
                <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--ink-3)", borderBottom: "1px solid var(--hairline)" }}>
                      <th style={{ padding: "8px 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>Line</th>
                      <th style={{ padding: "8px 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>Description</th>
                      <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>Qty</th>
                      <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>PO unit</th>
                      <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>Invoice unit</th>
                      <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>New PO cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillData.lines.map((l) => (
                      <tr key={l.lineId} style={{ borderBottom: "1px solid var(--hairline)" }}>
                        <td style={{ padding: "8px 6px" }} className="tnum">{l.lineNo}</td>
                        <td style={{ padding: "8px 6px" }}>{l.description || "—"}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right" }} className="tnum">{l.quantity}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right" }} className="tnum">{l.poUnitPrice}</td>
                        <td className="tnum" style={{ padding: "8px 6px", textAlign: "right", color: l.invoiceUnitPrice != null && Number(l.invoiceUnitPrice) !== Number(l.poUnitPrice) ? "var(--critical)" : "var(--ink)" }}>
                          {l.invoiceUnitPrice != null ? l.invoiceUnitPrice : "—"}
                        </td>
                        <td style={{ padding: "6px", textAlign: "right" }}>
                          <input type="number" min="0" step="0.01" value={drillEdits[l.lineId] ?? ""} onChange={(e) => setDrillEdits((p) => ({ ...p, [l.lineId]: e.target.value }))}
                            className="tnum" style={{ width: 100, padding: "6px 8px", fontSize: 13, textAlign: "right", border: "1px solid var(--hairline-strong)", borderRadius: 6, font: "inherit" }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
                  <button className="btn" disabled={!drillData.autoMatch || drillBusy} onClick={setAllToInvoice}>Set all to invoice cost</button>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="btn" disabled={drillBusy} onClick={() => setDrill(null)}>Cancel</button>
                    <button className="btn btn--primary" disabled={drillBusy} onClick={applyReconcile}>{drillBusy ? "Updating…" : "Apply & Update PO"}</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/* ==========================================================================
   Context + action panel — detail, why it's here, and the action, in one place.
   ========================================================================== */
function ContextPanel({ job, agent, result, acting, composerOpen, canAsk, onToggleComposer, onAction, onSend, onDismissAgent, onClose }) {
  const [draft, setDraft] = useState("");
  const [rtState, setRtState] = useState(vibe.realtimeState);
  const scroller = useRef(null);
  const age = ageInfo(job.created_time);
  const sev = job.tone ? sevOf(job.tone, job.priority) : (age.sev || "info");
  const acts = (job.actions || []).filter((a) => a.act !== "open" || job.record_url);
  const primary = acts.find((a) => a.kind === "primary");
  const others = acts.filter((a) => a !== primary);
  const busy = !!(agent && agent.busy);
  const isPermit = agent?.intent === "review_permit";
  const panelTitle = AGENT_TITLES[agent?.intent] || "Service Request Operations";
  // A real progress note published by the bridge always wins — it says something
  // true about this run. The rotating caption only fills the gap before the first
  // note arrives, and on the permit path it stays factual.
  const waitLine = useLoaderLine(isPermit ? LOAD_PERMIT : LOAD_AGENT, busy && !agent?.note, 3200);

  useEffect(() => vibe.onRealtimeState?.(setRtState), []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent?.turns, busy]);

  function submit() {
    const t = draft.trim();
    if (!t || busy) return;
    setDraft("");
    onSend(t);
  }

  return (
    <>
      <div className="panel__scroll">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="panel__id">{job.ref}{job.local_id ? " · #" + job.local_id : ""}</div>
            <h2 className="panel__title">{job.title || "—"}</h2>
          </div>
          <button className="btn btn--ghost btn--sm panel__close" onClick={onClose} aria-label="Close panel">×</button>
        </div>

        <div className="panel__chips">
          {job.status && <span className={"pill pill--" + sev}><span className="pill__d" />{job.status}</span>}
          {age.label && <span className={"pill pill--" + (age.sev || "info")} title={age.exact}>{age.label}</span>}
          {job.flag && <span className="pill">{job.flag}</span>}
          {job.priority && job.priority !== "Normal" && <span className="pill">{job.priority}</span>}
        </div>

        <div className="facts">
          <Fact k="Site" v={job.site} />
          <Fact k="Tenant" v={job.tenant} />
          <Fact k="Vendor" v={job.vendor} />
          <Fact k="Raised by" v={job.requested_by} />
          <Fact k="Created" v={job.created_time ? fmtDateTime(job.created_time) : ""} />
          <Fact k="Queue" v={job.bucket_label || job.bucket} />
          {job.valid_from && <Fact k="Valid from" v={fmtDateTime(job.valid_from)} />}
          {job.valid_to && <Fact k="Valid to" v={fmtDateTime(job.valid_to)} />}
        </div>

        {job.ai_note && (
          <div className="ai">
            <div className="ai__label"><Icon name="spark" /> AI summary</div>
            {job.ai_note}
          </div>
        )}

        {/* Actions — the exact verb, an inline outcome, and a guard while in flight
            so a double-click can never raise two work orders. */}
        {!!acts.length && (
          <div className="psection">
            <div className="psection__h">Next step</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {primary && (
                <button className="btn btn--primary" disabled={acting || busy} onClick={() => onAction(primary)} style={{ width: "100%" }}>
                  {acting ? "Working…" : primary.label}
                </button>
              )}
              {!!others.length && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {others.map((a, i) => (
                    <button key={i} className="btn btn--sm" disabled={acting || busy} onClick={() => onAction(a)}>{a.label}</button>
                  ))}
                </div>
              )}
            </div>
            {result && (
              <div className={"result result--" + (result.status === "ok" ? "ok" : result.status === "err" ? "err" : "busy")}>
                <span>{result.status === "ok" ? "✓" : result.status === "err" ? "!" : "◌"}</span>
                <span>{result.text}</span>
              </div>
            )}
          </div>
        )}

        {/* The agent conversation, when one is running for this record. */}
        {agent && (
          <div className="psection">
            <div className="psection__h" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{panelTitle}</span>
              <button className="btn btn--ghost btn--sm" onClick={onDismissAgent}>Dismiss</button>
            </div>
            <div ref={scroller} className="turns" style={{ maxHeight: 320, overflowY: "auto" }}>
              {agent.turns.map((t, i) => <Turn key={i} turn={t} />)}
              {busy && (
                <div className="turn turn--agent" style={{ color: "var(--brand-ink)", minHeight: 20 }}>
                  {agent.note || waitLine}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Composer is demoted to a collapsible drawer: the one-click action above is
          the normal path, this is for anything beyond it. */}
      <div className="composer">
        <button className="composer__toggle" onClick={onToggleComposer} aria-expanded={composerOpen}>
          <span>Ask / do more</span>
          <span style={{ color: "var(--ink-3)" }}>{composerOpen ? "▾" : "▸"}</span>
        </button>
        {composerOpen && (canAsk ? (
          <>
            <div className="composer__row">
              <textarea
                rows={2} value={draft} disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                placeholder={busy ? "Waiting for the team…" : "Ask the team to do something — raise the work order, start procurement…"}
              />
              <button className="btn btn--primary" onClick={submit} disabled={busy || !draft.trim()}>Send</button>
            </div>
            <div className="composer__hint">
              Enter to send · Shift+Enter for a new line
              {agent?.threadId ? ` · thread ${agent.threadId}` : ""}
              {rtState && rtState !== "open" ? " · reconnecting…" : ""}
            </div>
          </>
        ) : (
          // Honest, instead of a Send button that silently does nothing: the
          // bridge can only open a conversation on service requests and permits.
          <div className="composer__hint" style={{ marginTop: 8 }}>
            The operations team can act on service requests and work permits — open one of those to ask.
            Use the buttons above for this record.
          </div>
        ))}
      </div>
    </>
  );
}

const Fact = ({ k, v }) => (
  <div className="fact">
    <div className="fact__k">{k}</div>
    <div className={"fact__v" + (v ? "" : " fact__v--muted")} title={v || ""}>{v || "—"}</div>
  </div>
);

function Turn({ turn }) {
  if (turn.role === "fm") return <div className="turn turn--fm">{turn.text}</div>;
  if (turn.role === "error") return <div className="turn turn--error">{turn.text}</div>;
  return <div className="turn turn--agent">{renderMd(turn.text)}</div>;
}

/**
 * The agents answer in light markdown: bold, bullets and — the permit reviewer
 * especially — ATX headings ("## Recommendation").
 */
function renderMd(text) {
  return String(text || "").split("\n").map((line, i) => {
    const heading = /^\s*#{1,6}\s+/.test(line);
    const bullet = !heading && /^\s*[-*•]\s+/.test(line);
    let body = line;
    if (heading) body = line.replace(/^\s*#{1,6}\s+/, "");
    else if (bullet) body = line.replace(/^\s*[-*•]\s+/, "");
    const parts = body.split(/\*\*(.+?)\*\*/g).map((p, j) => (j % 2 ? <strong key={j}>{p}</strong> : p));
    const style = heading
      ? { fontWeight: 600, fontSize: 14, marginTop: i ? 8 : 0, marginBottom: 2 }
      : bullet ? { paddingLeft: 14, textIndent: -9 } : undefined;
    return <div key={i} style={style}>{bullet ? "• " : null}{parts}</div>;
  });
}

/* ==========================================================================
   Important now — the landing view. Ranked across every action queue.
   ========================================================================== */
function ImportantNow({ items, busy, error, at, selectedId, actingId, onPick, onOpenQueue, onRetry, onAction }) {
  const loading = items === null;
  const list = items || [];
  // Ranking three connection reads is the console's longest routine wait, so this
  // is the one caption an FM will actually watch rotate.
  const rankLine = useLoaderLine(LOAD_IMPORTANT, loading, 3400);
  const queues = new Set(list.map((it) => it.bucket)).size;

  // The glance strip counts the ranked list, not every queue — the feed's counts
  // carry no severity breakdown, so anything wider would be invented.
  const glance = useMemo(() => {
    const g = { critical: 0, warning: 0, info: 0 };
    for (const it of (items || [])) {
      const chips = (it.why || []).map((w, j) => (it.why_tones || [])[j] || guessTone(w));
      const worst = worstTone(chips.concat(it.tone ? [it.tone] : []));
      const s = { red: "critical", amber: "warning", purple: "info", blue: "info" }[worst] || "info";
      g[s] += 1;
    }
    return g;
  }, [items]);

  return (
    <section>
      <div className="qhead">
        <h1>Important now</h1>
        <span className="qhead__sub">
          {loading ? "ranking every queue…"
            : list.length ? `top ${list.length} across ${queues} queue${queues === 1 ? "" : "s"}`
              : "nothing ranked"}
        </span>
        <span style={{ flex: 1 }} />
        {at && !loading && <span className="qhead__sub">ranked {fmt(at)}</span>}
      </div>
      <p style={{ margin: "2px 0 16px", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, maxWidth: "70ch" }}>
        Ranked on signals that actually fired — how long it has waited, how close a permit is to its start
        date, hazard wording, tenant recharge. Select a record to act on it here.
      </p>

      {!loading && !!list.length && (
        <div className="glance">
          <GlanceCell n={glance.critical} k="Critical" sev="critical" />
          <GlanceCell n={glance.warning} k="At risk" sev="warning" />
          <GlanceCell n={glance.info} k="Waiting" sev="info" />
        </div>
      )}

      {error && (
        <div className="errbox">
          <span style={{ flex: 1 }}>
            {list.length ? "Couldn't re-rank just now — showing the last ranking." : "Couldn't rank the queues."}{" "}
            <span style={{ opacity: 0.8 }}>{error}</span>
          </span>
          <button className="btn btn--sm" disabled={busy} onClick={onRetry}>{busy ? "Retrying…" : "Retry"}</button>
        </div>
      )}

      {loading && (
        <>
          <p style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 12, ...LOADER_LINE }}>{rankLine}</p>
          <SkeletonList rows={4} />
        </>
      )}

      {!loading && !list.length && !error && (
        <div className="empty">
          <div className="empty__mark">✓</div>
          <div className="empty__h">Nothing urgent right now</div>
          <p className="empty__p">
            Nothing open has waited long enough, sits close enough to its start date, or reads urgent
            enough to jump the queue. Pick a queue on the left to work through the rest.
          </p>
        </div>
      )}

      <div className="cards" style={{ opacity: busy && list.length ? 0.55 : 1 }}>
        {list.map((it, i) => (
          <ImportantRow
            key={it.external_id} it={it} rank={i + 1}
            selected={selectedId === it.external_id}
            acting={actingId === it.external_id}
            onPick={() => onPick(it)} onOpenQueue={() => onOpenQueue(it.bucket)}
            onAction={(a) => onAction(it, a)}
          />
        ))}
      </div>
    </section>
  );
}

const GlanceCell = ({ n, k, sev }) => (
  <div className="glancecell" style={{ "--sev": SEV_VAR[sev] }}>
    <div className="glancecell__n tnum">{n}</div>
    <div className="glancecell__k">{k}</div>
  </div>
);

const TONE_RANK = { blue: 0, purple: 1, amber: 2, red: 3 };
const worstTone = (names) => names.reduce((a, b) => ((TONE_RANK[b] || 0) > (TONE_RANK[a] || 0) ? b : a), "blue");
const TONE_SEV = { red: "critical", amber: "warning", purple: "info", blue: "info" };

/**
 * Fallback for a browser running ahead of the deployed triage build, which sends
 * `why` but not yet `why_tones`. The server hint always wins when present.
 */
function guessTone(reason) {
  const s = String(reason || "").toLowerCase();
  if (s.startsWith("waiting")) {
    const m = s.match(/(\d+)\s*([hd])/);
    if (!m) return "amber";
    if (m[2] === "d") return "red";
    return Number(m[1]) >= 8 ? "amber" : "blue";
  }
  if (s.indexOf("passed") >= 0 || s.indexOf("within 24h") >= 0) return "red";
  if (s.indexOf("starts in") >= 0) return "amber";
  if (s.indexOf("recharge") >= 0 || s.indexOf("quote") >= 0) return "purple";
  if (s.indexOf("tenant") >= 0 || s.indexOf("just raised") >= 0) return "blue";
  return "red"; // everything left is a hazard label (Fire risk, Leak, Electrical, …)
}

/**
 * The record's own next step, derived for the ranked list.
 *
 * triage.js is self-contained and does not compose `actions`, so these mirror
 * feed.js's tsr/unblock verbs exactly — same labels, same act, same intent, so a
 * click here runs the identical flow as a click in the queue. Kept in step with
 * feed.js by hand, which is the same contract triage already has with it.
 *
 * Returns [] when the state is not one this can be sure about, so the row falls
 * back to "Open queue" rather than offering a verb that might be wrong.
 */
function importantActions(it) {
  if (it.bucket === "unblock") {
    // Permits reach the ranked list only from moduleState=awaitingfmapproval.
    // SAME verbs as the queue card, so acting here is one step — not "open the
    // queue, then approve". Review stays for when the FM wants the evidence
    // read to them before deciding.
    return [
      { label: "Approve", kind: "primary", act: "approve" },
      { label: "Reject", kind: "ghost", act: "reject" },
      { label: "Review permit", kind: "ghost", act: "agent", intent: "review_permit",
        prompt: "Review this work permit and recommend whether it can be approved." },
    ];
  }
  if (it.bucket === "tsr") {
    const state = String(it.state || "");
    if (state === "Open") {
      return [{ label: "Acknowledge & proceed", kind: "primary", act: "agent", intent: "tsr_flow",
        prompt: "Acknowledge this tenant service request, then raise the work order for it." }];
    }
    if (state === "tsrvalidated") {
      return it.quote_path === "Provide In-House CBRE Quote"
        ? [{ label: "Create Tenant Quote", kind: "primary", act: "quote" }]
        : [{ label: "Create Work Order", kind: "primary", act: "agent", intent: "create_work_order",
            prompt: "Raise the work order for this request." }];
    }
  }
  return [];
}

function ImportantRow({ it, rank, selected, acting, onPick, onOpenQueue, onAction }) {
  const chips = (it.why || []).map((w, j) => ({ text: w, tone: (it.why_tones || [])[j] || guessTone(w) }));
  const worst = worstTone(chips.map((c) => c.tone).concat(it.tone ? [it.tone] : []));
  const sev = TONE_SEV[worst] || "info";
  const caption = [it.site, it.tenant].filter(Boolean).join(" · ");
  const acts = importantActions(it);
  return (
    <div
      id={"row-" + it.external_id}
      className="card" role="button" tabIndex={0} aria-current={selected}
      style={{ "--sev": SEV_VAR[sev] }}
      onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}
    >
      <span className="card__bar" />
      <div className="card__row">
        <span className={"rank pill--" + sev} aria-hidden="true">{rank}</span>
        <div className="card__body">
          <div className="card__top">
            <span className="card__id">{it.ref}</span>
            {chips.slice(0, 3).map((c, j) => (
              <span key={j} className={"pill pill--" + (TONE_SEV[c.tone] || "info")}>{c.text}</span>
            ))}
            {chips.length > 3 && <span className="pill" title={chips.slice(3).map((c) => c.text).join(" · ")}>+{chips.length - 3}</span>}
          </div>
          <div className="card__title" title={it.title}>{it.title}</div>
          <div className="card__meta">
            <span>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: SEV_VAR[sev], display: "inline-block" }} />
              <em>{it.bucket_label || it.bucket}</em>
            </span>
            {caption && <span><Icon name="site" /><em title={caption}>{caption}</em></span>}
          </div>
          {/* Act on it here. Sending the FM into the queue to press the same button
              made the ranked list a signpost instead of a place of work. */}
          <div className="card__actions">
            {acts.map((a, i) => (
              <button
                key={i}
                className={"btn" + (a.kind === "primary" ? " btn--primary" : "")}
                disabled={acting}
                onClick={(e) => { e.stopPropagation(); onAction(a); }}
              >
                {acting && a.kind === "primary" ? "Working…" : a.label}
              </button>
            ))}
            <button className="btn btn--ghost" onClick={(e) => { e.stopPropagation(); onOpenQueue(); }}>
              Open queue
            </button>
            {it.record_url && (
              <button className="btn btn--ghost" onClick={(e) => { e.stopPropagation(); window.open(it.record_url, "_blank", "noopener"); }}>
                View in Facilio
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   One card anatomy for every queue: accent bar, id + chips, title, meta, verb.
   ========================================================================== */
function Card({ r, selected, acting, onPick, onAction }) {
  const age = ageInfo(r.created_time);
  const sev = r.tone ? sevOf(r.tone, r.priority) : (age.sev || "info");
  const acts = (r.actions || []).filter((a) => a.act !== "open" || r.record_url);
  const chips = [];
  if (r.flag) chips.push(r.flag);
  // flag2 is the record's second fact (e.g. "Chargeable to tenant") — it sits
  // beside the state pill rather than displacing it.
  if (r.flag2) chips.push(r.flag2);
  if (r.priority && r.priority !== "Normal" && r.priority !== "Signal") chips.push(r.priority);

  return (
    <div
      id={"row-" + r.external_id}
      className="card" role="button" tabIndex={0} aria-current={selected}
      style={{ "--sev": SEV_VAR[sev] }}
      onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}
    >
      <span className="card__bar" />
      <div className="card__row">
        <div className="card__body">
          <div className="card__top">
            <span className="card__id">{r.ref}{r.local_id ? " · #" + r.local_id : ""}</span>
            {age.label && <span className={"pill pill--" + (age.sev || "info")} title={age.exact}><span className="pill__d" />{age.label}</span>}
            {chips.slice(0, 2).map((c, i) => <span key={i} className="pill">{c}</span>)}
            {chips.length > 2 && <span className="pill" title={chips.slice(2).join(" · ")}>+{chips.length - 2}</span>}
          </div>
          <div className="card__title" title={r.title}>{r.title || "—"}</div>
          {/* `meta` is composed per bucket on the server and is the only line that
              carries the substance for orders and signals (variance amounts, breach
              counts). The structured site/tenant/vendor breakdown lives in the
              context panel, where it can be labelled. */}
          {r.meta && (
            <div className="card__meta">
              <span><Icon name="info" /><em title={r.meta}>{r.meta}</em></span>
            </div>
          )}
          {r.created_time && (
            <div className="card__meta tnum" style={{ marginTop: 3 }}>
              <span><Icon name="clock" /><em>{fmtDateTime(r.created_time)}</em></span>
              {r.valid_from && <span><Icon name="calendar" /><em>Valid {fmtDateTime(r.valid_from)} → {fmtDateTime(r.valid_to)}</em></span>}
            </div>
          )}
          {r.ai_note && (
            <div className="ai">
              <div className="ai__label"><Icon name="spark" /> AI</div>
              {r.ai_note}
            </div>
          )}
          {/* Every action the server offered, inline. Sending the FM to a panel to
              find the second button turned a one-step job into two. */}
          <div className="card__actions">
            {acts.map((a, i) => (
              <button
                key={i}
                className={"btn" + (a.kind === "primary" ? " btn--primary" : "")}
                disabled={acting}
                onClick={(e) => { e.stopPropagation(); onAction(a); }}
              >
                {acting && a.kind === "primary" ? "Working…" : a.label}
              </button>
            ))}
            <button className="btn btn--ghost" onClick={(e) => { e.stopPropagation(); onPick(); }}>
              Details
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- primitives */

/**
 * Inline SVG icons, replacing the unicode glyphs (⌂ ◇ ⚒ ◷) the metadata rows used.
 * Those render differently on every platform, sit off the text baseline, and were
 * the single biggest thing making a considered layout look unfinished. They use
 * currentColor, so they inherit the row's colour.
 */
const ICON_PATHS = {
  site: "M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  clock: "M12 7v5l3.5 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  calendar: "M7 4v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  info: "M12 16v-5h-1m1-3h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
};
const Icon = ({ name, size = 13 }) => {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg
      className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d={d} />
    </svg>
  );
};

/**
 * One-time orientation for a brand-new operator — three lines mapping the three
 * panes, dismissed once and never seen again (localStorage). Rubric: "a guided
 * first run". Skipped entirely where localStorage is unavailable, rather than
 * nagging on every load.
 */
const INTRO_KEY = "fm360_intro_seen";
function FirstRun() {
  const [seen, setSeen] = useState(() => {
    try { return localStorage.getItem(INTRO_KEY) === "1"; } catch (e) { return true; }
  });
  if (seen) return null;
  function dismiss() {
    try { localStorage.setItem(INTRO_KEY, "1"); } catch (e) {}
    setSeen(true);
  }
  return (
    <div className="ai" style={{ marginTop: 0, marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ai__label"><Icon name="spark" /> Welcome to FM 360</div>
        Everything that needs a human across your maintenance queues, ranked. Queues sit on the left,
        the most pressing work is listed here, and selecting a record shows its context and next step on
        the right — most items resolve in one click.
      </div>
      <button className="btn btn--sm" onClick={dismiss} style={{ flex: "none" }}>Got it</button>
    </div>
  );
}

const SkeletonList = ({ rows = 5 }) => (
  <div className="cards">
    {Array.from({ length: rows }).map((_, i) => (
      <div className="skelcard" key={i}>
        <div className="skel" style={{ width: 84, height: 11, marginBottom: 10 }} />
        <div className="skel" style={{ width: "62%", height: 15, marginBottom: 10 }} />
        <div className="skel" style={{ width: "42%", height: 11 }} />
      </div>
    ))}
  </div>
);

function LiveDot({ live, lastTick }) {
  // Colour comes from CSS (.livedot / .livedot--off), not inline style, so the
  // dark topbar can restyle it without !important.
  return (
    <span className={"livedot" + (live ? "" : " livedot--off")} title={lastTick ? "Updated " + fmt(lastTick) : ""}>
      <span className="livedot__d" />
      {live ? "Live" : "Paused"}
    </span>
  );
}

const Center = ({ children }) => (
  <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)", color: "var(--ink-2)" }}>{children}</div>
);

/**
 * The mark: a 300-degree gradient sweep closed by a dot — the "360" of FM 360,
 * with the gap reading as the one thing still waiting on a human. Replaces the
 * bare CSS ring, which read as a placeholder. `dark` adapts the track for the
 * ink-coloured topbar.
 */
function Logo({ small, dark }) {
  const s = small ? 26 : 46;
  const grad = "fmlg-" + (dark ? "d" : "l");
  return (
    <svg width={s} height={s} viewBox="0 0 44 44" fill="none" aria-hidden="true" style={{ flex: "none", display: "block" }}>
      <defs>
        <linearGradient id={grad} x1="6" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8B7CFF" />
          <stop offset="1" stopColor="#5B45E0" />
        </linearGradient>
      </defs>
      <circle cx="22" cy="22" r="16" stroke={dark ? "rgba(255,255,255,.14)" : "rgba(91,69,224,.16)"} strokeWidth="5" />
      <path d="M22 6 a16 16 0 1 1 -13.86 8" stroke={"url(#" + grad + ")"} strokeWidth="5" strokeLinecap="round" />
      <circle cx="14" cy="8.14" r="2.6" fill="#8B7CFF" />
    </svg>
  );
}

function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return iso; }
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return iso; }
}
