import { useEffect, useMemo, useRef, useState } from "react";
import { createVibe } from "@facilio/vibe-sdk";

const vibe = createVibe();
const PAGE_SIZE = 10;
const POLL_MS = 30000; // smart-poll cadence for live counts
const AGENT_TOPIC = "srops";       // where agent_bridge publishes each turn's result
const AGENT_TIMEOUT_MS = 660000;   // just past the run's 600s ceiling; a killed run never publishes
const newRunId = () =>
  (globalThis.crypto?.randomUUID?.() ?? "run-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
const BUILD = "v19 · unblock: Review with AI (review_work_permits)";
// Vibe app agent that decides who must act on a finding (Tenant | FM | Unclear).
const FINDING_CLASSIFIER = "finding-classifier";
// What the agent panel's header calls each intent's agent; anything unlisted is
// the Service Request Operations team.
const AGENT_TITLES = { review_permit: "Review Work Permits" };

const C = {
  bg: "#F7F9FC", card: "#FFFFFF", border: "#D8E3F1", ink: "#283648",
  muted: "#607796", indigo: "#3C229D", blue: "#0059D6", blueSoft: "#EAF2FF",
  red: "#B61919", redSoft: "#FDE7E7", amber: "#8A6D00", amberSoft: "#FFF8D6",
  purple: "#5E3ED3", purpleSoft: "#F3EFFF", green: "#0F6F06",
};
const BUCKET_ORDER = ["tsr", "tsrack", "unblock", "referral", "completion", "findings", "stalled", "quotes", "spot", "tenant", "sla", "quoting", "invoicing"];
const DOT = {
  tsr: C.red, tsrack: "#FFD405", unblock: "#FFD405", referral: "#FFD405", completion: C.blue,
  findings: C.blue, stalled: C.blue, quotes: C.blue, spot: C.purple, tenant: C.red,
  sla: C.amber, quoting: C.purple, invoicing: C.purple,
};
function toneStyle(tone, priority) {
  const t = tone || ({ High: C.red, Medium: "#FFD405", Signal: C.purple }[priority] || C.blue);
  if (t === C.red) return { bar: C.red, bg: C.redSoft, fg: "#8E1313" };
  if (t === "#FFD405" || t === C.amber) return { bar: "#FFD405", bg: C.amberSoft, fg: C.amber };
  if (t === C.purple) return { bar: C.purple, bg: C.purpleSoft, fg: C.purple };
  return { bar: C.blue, bg: C.blueSoft, fg: C.blue };
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
  const [actingId, setActingId] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [agent, setAgent] = useState(null); // { job, threadId, turns[], busy }
  const [drill, setDrill] = useState(null);       // { job }
  const [drillData, setDrillData] = useState(null); // { po, lines, autoMatch }
  const [drillEdits, setDrillEdits] = useState({}); // lineId -> new unit price (string)
  const [drillBusy, setDrillBusy] = useState(false);
  const [important, setImportant] = useState([]);
  const [toast, setToast] = useState(null);
  // external_id -> { status: "pending"|"done"|"error", actionBy?, reason? }
  // Cached for the session so a finding is classified once, not per page render.
  const [findingCls, setFindingCls] = useState({});
  const clsInFlight = useRef(new Set());
  const [lastTick, setLastTick] = useState(null);
  const [live, setLive] = useState(true);
  const stateRef = useRef({ bucket: null, page: 1, counts: [] });
  stateRef.current = { bucket, page, counts };
  const agentTimer = useRef(null);

  const actor = user?.user?.name || user?.user?.email || "";

  useEffect(() => {
    (async () => {
      try {
        const ok = await vibe.isAuthenticated();
        setAuthed(ok);
        if (ok) {
          setUser(await vibe.getCurrentUser().catch(() => null));
          refreshImportant();
          const cs = await refreshCounts();
          const first = firstVisible(cs, "actions");
          if (first) { setBucket(first); await loadPage(first, 1); }
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
      const cs = await refreshCounts();
      setLive(true);
      // if the bucket the FM is viewing changed, refresh its page too
      const b = stateRef.current.bucket;
      if (b) {
        const before = (prev.find((x) => x.bucket === b) || {}).count;
        const after = (cs.find((x) => x.bucket === b) || {}).count;
        if (before !== after) await loadPage(b, stateRef.current.page);
      }
    };
    timer = setInterval(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [authed]);

  // One subscription for the whole console. Every tab hears every agent run, so
  // each keeps only the run it started; the functional update also dodges the
  // stale-closure problem a long-lived callback would otherwise have.
  useEffect(() => {
    if (!authed) return;
    const sub = vibe.subscribe(AGENT_TOPIC, (evt) => {
      const p = (evt && evt.payload) || {};
      if (!p.runId) return;
      // Interim note from a slow turn: replace the spinner's caption, don't end the turn.
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
  // The feed's bucket handler stays synchronous; classification happens lazily
  // from the browser after the page renders — once per finding, cached in state.
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
      // Failed classification = no special button (same as Unclear), no retry storm.
      setFindingCls((m) => ({ ...m, [key]: { status: "error" } }));
    } finally {
      clsInFlight.current.delete(key);
    }
  }

  // Merge a finding's classification into its card: the responsibility button is
  // added client-side when the verdict lands; before that a subtle placeholder shows.
  function decorateFinding(r) {
    if (r.bucket !== "findings") return r;
    const cls = findingCls[r.external_id];
    const out = { ...r };
    if (!cls || cls.status === "pending") {
      out.ai_note = "Classifying responsibility…";
    } else if (cls.status === "done" && cls.actionBy === "Tenant") {
      out.ai_note = "Tenant to action — " + cls.reason;
      out.actions = [{ label: "Raise Letter of Non Compliance", kind: "primary", act: "action" }, ...(r.actions || [])];
    } else if (cls.status === "done" && cls.actionBy === "FM") {
      out.ai_note = "FM to resolve — " + cls.reason;
      out.actions = [{ label: "Create Work Order", kind: "primary", act: "action" }, ...(r.actions || [])];
    } else if (cls.status === "done") {
      out.ai_note = cls.reason ? "Responsibility unclear — " + cls.reason : "Responsibility unclear.";
    } else {
      out.ai_note = ""; // classification failed: keep the card usable, add nothing
    }
    return out;
  }

  // Ranked cross-bucket triage. Never allowed to break the feed: on any failure
  // the strip simply renders nothing.
  async function refreshImportant() {
    try {
      const r = await vibe.executeFunction("triage", "important", { limit: 6 });
      setImportant(Array.isArray(r?.items) ? r.items : []);
    } catch (e) { setImportant([]); }
  }

  async function refreshCounts() {
    try {
      const r = await vibe.executeFunction("feed", "counts", {});
      setCounts(r.buckets || []);
      setLastTick(r.ranAt || new Date().toISOString());
      return r.buckets || [];
    } catch (e) { setLive(false); return stateRef.current.counts; }
  }
  async function loadPage(b, p) {
    setLoadingPage(true);
    try {
      const r = await vibe.executeFunction("feed", "bucket", { bucket: b, page: p, pageSize: PAGE_SIZE });
      setPageData(r); setPage(r.page);
    } catch (e) { flash("Couldn't load " + b + ": " + (e?.message || e)); }
    finally { setLoadingPage(false); }
  }

  function firstVisible(cs, whichTab) {
    return BUCKET_ORDER.find((b) => {
      const c = cs.find((x) => x.bucket === b);
      return c && (whichTab === "signals") === !!c.signal && (c.count || 0) > 0;
    });
  }
  async function selectBucket(b) { setBucket(b); setPage(1); await loadPage(b, 1); }
  async function gotoPage(p) { if (p < 1 || p > pageData.totalPages) return; await loadPage(bucket, p); }

  async function takeAction(job, action) {
    if (action.act === "open") { if (job.record_url) window.open(job.record_url, "_blank", "noopener"); return; }
    if (action.act === "quote") { setQuote({ job }); setQuoteAmount(""); return; }
    // Acknowledging a TSR is a conversation with the Service Request Operations
    // team, not a one-shot write: the team performs the acknowledge and stays open
    // for the follow-on steps (work order, procurement, RFQ).
    if (action.act === "agent") { openAgent(job, action); return; }
    if (action.act === "drill") { openDrill(job); return; }
    if (action.act === "approve" || action.act === "reject") {
      setActingId(job.external_id);
      setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
      setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
      try {
        const res = await vibe.executeFunction("feed", "permit_decision", { external_id: job.external_id, decision: action.act, actor });
        if (res?.ok) { flash(`${job.ref} — ${res.permit_status}`); await refreshCounts(); await loadPage(bucket, page); }
        else { flash(`Couldn't ${action.label.toLowerCase()}: ${res?.error || "error"}`); await loadPage(bucket, page); }
      } catch (e) { flash(`${action.label} failed: ` + (e?.message || e)); await loadPage(bucket, page); }
      finally { setActingId(null); }
      return;
    }
    if (action.act !== "action") { flash(`${action.label} · ${job.ref}`); return; }
    setActingId(job.external_id);
    // optimistic: remove the card and drop the badge now
    setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
    setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
    try {
      const res = await vibe.executeFunction("feed", "act", { external_id: job.external_id, action_type: action.label, actor });
      if (res?.ok) {
        flash(`${action.label} · ${job.ref} — synced to Facilio`);
        await refreshCounts();
        await loadPage(bucket, page);
      } else {
        flash(`Couldn't sync to Facilio: ${res?.error || "unknown error"}`);
        await loadPage(bucket, page); // restore
      }
    } catch (e) { flash("Action failed: " + (e?.message || e)); await loadPage(bucket, page); }
    finally { setActingId(null); }
  }

  /**
   * Start one agent turn.
   *
   * The team delegates across four member agents, which routinely outlasts a
   * synchronous call — so the run is fired with executeFunctionAsync and its reply
   * comes back over the 'srops' topic, matched on the runId minted here.
   */
  async function runAgentTurn({ handler, args, job, prompt }) {
    const runId = newRunId();
    setAgent((a) => {
      const base = a || { job, threadId: null, turns: [] };
      return { ...base, job: job || base.job, busy: true, runId, note: null, turns: [...base.turns, { role: "fm", text: prompt }] };
    });

    // A run killed from outside (timeout ceiling, deploy mid-run) can never publish,
    // so the panel needs its own deadline or it waits for ever.
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
    // The bubble shows the FM's intent; the message itself is omitted so the
    // bridge's intent-based opening applies — it instructs the agent to present
    // the action's details and wait for explicit confirmation before writing
    // (for permits: recommend with evidence, decide only when told to).
    const opening = action.prompt || "Acknowledge this tenant service request.";
    setAgent({ job, intent: action.intent, threadId: null, turns: [], busy: false, runId: null });
    runAgentTurn({
      handler: "start_async",
      args: { external_id: job.external_id, actor, intent: action.intent, record_title: job.title, record_ref: job.ref },
      job, prompt: opening,
    });
  }

  function sendAgent(text) {
    const msg = String(text || "").trim();
    if (!msg || !agent || agent.busy) return;
    // Before the first reply lands there is no thread yet, so this prompt opens one.
    const seg = String(agent.job.external_id || "").split(":");
    // The bridge's record-state fast-path reads service requests only — a permit
    // id sent as sr_id would read the wrong module, so gate it on the module here.
    const srId = seg[seg.length - 2] === "servicerequest" ? Number(seg[seg.length - 1]) || undefined : undefined;
    const [handler, args] = agent.threadId
      ? ["send_async", { thread_id: agent.threadId, message: msg, sr_id: srId, intent: agent.intent }]
      : ["start_async", { external_id: agent.job.external_id, message: msg, actor, intent: agent.intent, record_title: agent.job.title, record_ref: agent.job.ref }];
    runAgentTurn({ handler, args, job: agent.job, prompt: msg });
  }

  // The team writes to the record, so re-read the feed on close: an acknowledged
  // TSR leaves moduleState=Open and drops off this bucket on its own.
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
        setQuote(null);
        setPageData((pd) => ({ ...pd, jobs: pd.jobs.filter((j) => j.external_id !== job.external_id), total: Math.max(0, pd.total - 1) }));
        setCounts((cs) => cs.map((c) => (c.bucket === job.bucket ? { ...c, count: Math.max(0, (c.count || 0) - 1) } : c)));
        await refreshCounts(); await loadPage(bucket, page);
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

  useEffect(() => {
    if (authed && visibleBuckets.length && !visibleBuckets.includes(bucket)) selectBucket(visibleBuckets[0]);
  }, [tab, counts]); // eslint-disable-line

  const actionsTotal = counts.filter((c) => !c.signal).reduce((a, c) => a + (c.count || 0), 0);
  const signalsTotal = counts.filter((c) => c.signal).reduce((a, c) => a + (c.count || 0), 0);
  const records = pageData.jobs || [];

  if (authed === null) return <Center>Loading…</Center>;
  if (authed === false)
    return (
      <Center>
        <div style={{ textAlign: "center" }}>
          <Logo />
          <h1 style={{ margin: "16px 0 6px", color: C.ink, fontSize: 22 }}>FM 360 Console</h1>
          <p style={{ color: C.muted, marginBottom: 20 }}>Sign in with your Facilio account to continue.</p>
          <button style={btn(true)} onClick={() => vibe.login()}>Sign in</button>
        </div>
      </Center>
    );

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", color: C.ink }}>
      <div style={{ height: 60, background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 24px", gap: 14, position: "sticky", top: 0, zIndex: 5 }}>
        <Logo small />
        <strong style={{ fontSize: 16 }}>FM 360 Console</strong>
        <LiveDot live={live} lastTick={lastTick} />
        <div style={{ flex: 1 }} />
        <button style={btn(false)} onClick={() => { refreshCounts(); refreshImportant(); if (bucket) loadPage(bucket, page); }}>Refresh</button>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: C.indigo, color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600 }}>
          {(actor || "U").slice(0, 2).toUpperCase()}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "330px 1fr", alignItems: "start" }}>
        <div style={{ borderRight: `1px solid ${C.border}`, minHeight: "calc(100vh - 60px)", background: C.card, padding: "18px 16px" }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <Tab active={tab === "actions"} onClick={() => setTab("actions")} label="Needs action" count={actionsTotal} />
            <Tab active={tab === "signals"} onClick={() => setTab("signals")} label="Signals" count={signalsTotal} />
          </div>
          {visibleBuckets.map((b) => (
            <button key={b} onClick={() => selectBucket(b)} style={{
              width: "100%", textAlign: "left", border: `1px solid ${bucket === b ? "#A2C8FE" : "transparent"}`,
              background: bucket === b ? C.blueSoft : "transparent", borderRadius: 10, padding: "10px 12px",
              marginBottom: 4, cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: DOT[b] || C.blue, flex: "none" }} />
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: bucket === b ? 600 : 500 }}>{labelByBucket[b] || b}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: bucket === b ? C.blue : C.muted }}>{countByBucket[b]}</span>
            </button>
          ))}
          {!visibleBuckets.length && <p style={{ color: C.muted, fontSize: 13, padding: 8 }}>Nothing needs action right now.</p>}

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px dashed ${C.border}`, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: C.ink, marginBottom: 4 }}>Live feed · Facilio</div>
            <div>Auto-refreshing every {POLL_MS / 1000}s while open</div>
            {lastTick && <div>Updated {fmt(lastTick)}</div>}
            <div style={{ marginTop: 6, opacity: 0.7 }}>Build {BUILD}</div>
          </div>
        </div>

        <div style={{ padding: "22px 28px" }}>
          {tab === "actions" && <ImportantNow items={important} onPick={selectBucket} />}
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>{bucket ? (labelByBucket[bucket] || bucket) : "—"}</h1>
            <span style={{ color: C.muted, fontSize: 13 }}>
              {pageData.total > 0
                ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, pageData.total)} of ${pageData.total} · live, newest first`
                : "No open items"}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12, maxWidth: 900, opacity: loadingPage ? 0.55 : 1 }}>
            {records.map((r) => (
              <Card key={r.external_id} r={decorateFinding(r)} acting={actingId === r.external_id} onAction={(a) => takeAction(r, a)} />
            ))}
            {!loadingPage && !records.length && <p style={{ color: C.muted }}>Nothing open in this bucket.</p>}
          </div>

          {pageData.totalPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, maxWidth: 900, justifyContent: "center" }}>
              <button style={pbtn(page <= 1)} disabled={page <= 1} onClick={() => gotoPage(page - 1)}>← Prev</button>
              <span style={{ fontSize: 13, color: C.muted }}>Page {page} of {pageData.totalPages}</span>
              <button style={pbtn(page >= pageData.totalPages)} disabled={page >= pageData.totalPages} onClick={() => gotoPage(page + 1)}>Next →</button>
            </div>
          )}
        </div>
      </div>

      {quote && (
        <div onClick={() => !quoteBusy && setQuote(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,32,52,.45)", display: "grid", placeItems: "center", zIndex: 60 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "92vw", background: C.card, borderRadius: 14, padding: "22px 24px", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>Create Tenant Quote</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>{quote.job.ref} · {quote.job.title}</div>
            <label style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>Quoted amount</label>
            <input
              type="number" min="0" step="0.01" autoFocus value={quoteAmount}
              onChange={(e) => setQuoteAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitQuote(); }}
              placeholder="e.g. 1800"
              style={{ width: "100%", marginTop: 6, padding: "10px 12px", fontSize: 15, border: `1px solid ${C.border}`, borderRadius: 8, outline: "none" }}
            />
            <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Everything else is pulled from the service request.</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
              <button style={btn(false)} disabled={quoteBusy} onClick={() => setQuote(null)}>Cancel</button>
              <button style={{ ...btn(true), opacity: quoteBusy ? 0.6 : 1 }} disabled={quoteBusy} onClick={submitQuote}>{quoteBusy ? "Creating…" : "Create Quote"}</button>
            </div>
          </div>
        </div>
      )}

      {agent && <AgentPanel agent={agent} onSend={sendAgent} onClose={closeAgent} />}
      {drill && (
        <div onClick={() => !drillBusy && setDrill(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,32,52,.45)", display: "grid", placeItems: "center", zIndex: 60 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 760, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto", background: C.card, borderRadius: 14, padding: "22px 24px", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Referred order · {drill.job.ref}</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>Update each referred line's PO unit cost to match the invoice, or edit manually.</div>
            {!drillData && <p style={{ color: C.muted }}>Loading lines…</p>}
            {drillData && !drillData.lines.length && <p style={{ color: C.muted }}>No referred lines found on this order.</p>}
            {drillData && drillData.lines.length > 0 && (
              <>
                {!drillData.autoMatch && (
                  <div style={{ background: C.amberSoft, color: C.amber, border: `1px solid #F0D98A`, borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12 }}>
                    Invoice matching isn't wired yet (the invoice line's PO-line-number field name is pending) — invoice prices show as “—”; you can still edit costs manually.
                  </div>
                )}
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: C.muted, borderBottom: `1px solid ${C.border}` }}>
                      <th style={{ padding: "8px 6px" }}>Line</th>
                      <th style={{ padding: "8px 6px" }}>Description</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>Qty</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>PO unit price</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>Invoice unit price</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>New PO cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillData.lines.map((l) => (
                      <tr key={l.lineId} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: "8px 6px" }}>{l.lineNo}</td>
                        <td style={{ padding: "8px 6px" }}>{l.description || "—"}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right" }}>{l.quantity}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right" }}>{l.poUnitPrice}</td>
                        <td style={{ padding: "8px 6px", textAlign: "right", color: l.invoiceUnitPrice != null && Number(l.invoiceUnitPrice) !== Number(l.poUnitPrice) ? C.red : C.ink }}>{l.invoiceUnitPrice != null ? l.invoiceUnitPrice : "—"}</td>
                        <td style={{ padding: "6px", textAlign: "right" }}>
                          <input type="number" min="0" step="0.01" value={drillEdits[l.lineId] ?? ""} onChange={(e) => setDrillEdits((p) => ({ ...p, [l.lineId]: e.target.value }))}
                            style={{ width: 100, padding: "6px 8px", fontSize: 13, textAlign: "right", border: `1px solid ${C.border}`, borderRadius: 6 }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 18 }}>
                  <button style={{ ...btn(false), opacity: drillData.autoMatch ? 1 : 0.5 }} disabled={!drillData.autoMatch || drillBusy} onClick={setAllToInvoice}>Set all to invoice cost</button>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button style={btn(false)} disabled={drillBusy} onClick={() => setDrill(null)}>Cancel</button>
                    <button style={{ ...btn(true), opacity: drillBusy ? 0.6 : 1 }} disabled={drillBusy} onClick={applyReconcile}>{drillBusy ? "Updating…" : "Apply & Update PO"}</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", padding: "11px 18px", borderRadius: 10, fontSize: 13.5, boxShadow: "0 6px 24px rgba(0,0,0,.22)", zIndex: 50 }}>{toast}</div>}
    </div>
  );
}

/**
 * The intent's Studio agent, docked on the right of the record it is working on.
 * For service requests that is the Service Request Operations team (acknowledge,
 * then the follow-on steps); for a work permit review it is the standalone
 * Review Work Permits agent — recommendation with evidence first, approve or
 * reject only when the reviewer explicitly says so in this chat.
 */
function AgentPanel({ agent, onSend, onClose }) {
  const [draft, setDraft] = useState("");
  const [rtState, setRtState] = useState(vibe.realtimeState);
  const scroller = useRef(null);
  const { job, turns, busy, threadId } = agent;
  const isPermit = agent.intent === "review_permit";
  const panelTitle = AGENT_TITLES[agent.intent] || "Service Request Operations";

  // Replies arrive over the socket, so its health is worth showing while waiting.
  useEffect(() => vibe.onRealtimeState?.(setRtState), []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  function submit() {
    const t = draft.trim();
    if (!t || busy) return;
    setDraft("");
    onSend(t);
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(20,32,52,.35)" }} />
      <aside style={{
        position: "relative", width: 460, maxWidth: "94vw", background: C.card, height: "100%",
        borderLeft: `1px solid ${C.border}`, boxShadow: "-8px 0 40px rgba(16,42,80,.16)",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: C.purple, flex: "none" }} />
              <strong style={{ fontSize: 14.5 }}>{panelTitle}</strong>
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {job.ref} · {job.title}
            </div>
          </div>
          <button onClick={onClose} style={{ ...btn(false), padding: "4px 10px", fontSize: 16, lineHeight: 1.1 }}>×</button>
        </div>

        <div ref={scroller} style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {turns.map((t, i) => <Turn key={i} turn={t} />)}
          {busy && (
            <div style={{ alignSelf: "flex-start", background: C.purpleSoft, border: "1px solid #E4DBFF", color: C.purple, borderRadius: 12, padding: "9px 13px", fontSize: 13, maxWidth: "92%", lineHeight: 1.5 }}>
              {agent.note || "Working…"}
            </div>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 16px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              rows={2} value={draft} disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder={busy
                ? (isPermit ? "Waiting for the agent…" : "Waiting for the team…")
                : (isPermit
                  ? "Ask about the evidence, or give your explicit decision on this permit…"
                  : "Ask the team to do something — raise the work order, start procurement…")}
              style={{
                flex: 1, resize: "none", padding: "9px 12px", fontSize: 13.5, fontFamily: "inherit",
                border: `1px solid ${C.border}`, borderRadius: 9, outline: "none", background: busy ? C.bg : C.card, color: C.ink,
              }}
            />
            <button onClick={submit} disabled={busy || !draft.trim()} style={{ ...btn(true), padding: "9px 16px", opacity: busy || !draft.trim() ? 0.5 : 1 }}>Send</button>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 7 }}>
            Enter to send · Shift+Enter for a new line{threadId ? ` · thread ${threadId}` : ""}
            {rtState && rtState !== "open" ? ` · reconnecting…` : ""}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Turn({ turn }) {
  if (turn.role === "fm") {
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "85%", background: C.blue, color: "#fff", borderRadius: "12px 12px 3px 12px", padding: "9px 13px", fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {turn.text}
      </div>
    );
  }
  if (turn.role === "error") {
    return (
      <div style={{ alignSelf: "flex-start", maxWidth: "92%", background: C.redSoft, color: "#8E1313", border: "1px solid #F3C9C9", borderRadius: 12, padding: "9px 13px", fontSize: 13, lineHeight: 1.5 }}>
        {turn.text}
      </div>
    );
  }
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "92%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: "12px 12px 12px 3px", padding: "10px 13px", fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
      {renderMd(turn.text)}
    </div>
  );
}

/**
 * The agents answer in light markdown: bold, bullets and — the permit reviewer
 * especially — ATX headings ("## Recommendation"). Without the heading case the
 * hashes render literally in the panel, so strip them and show the line as a
 * heading instead.
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
    return (
      <div key={i} style={style}>
        {bullet ? "• " : null}{parts}
      </div>
    );
  });
}

/**
 * The few things across every action bucket that most deserve the FM's next hour,
 * ranked server-side. Each chip is a signal that actually fired for that record —
 * never filler — so the ordering can always be read back as its reasons. Renders
 * nothing at all when triage is empty or failed; it must never block the feed.
 */
function ImportantNow({ items, onPick }) {
  if (!items || !items.length) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, margin: 0, letterSpacing: 0.3, textTransform: "uppercase", color: C.indigo }}>Important now</h2>
        <span style={{ fontSize: 12, color: C.muted }}>across every queue · most pressing first</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 900 }}>
        {items.map((it, i) => (
          <button
            key={it.external_id}
            onClick={() => onPick(it.bucket)}
            title={`Go to ${it.bucket_label}`}
            style={{
              display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
              background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "9px 14px", cursor: "pointer", font: "inherit", color: C.ink,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, width: 16, flex: "none" }}>{i + 1}</span>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: C.muted, width: 78, flex: "none" }}>{it.ref}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.title}
            </span>
            <span style={{ display: "flex", gap: 5, flex: "none", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {it.why.slice(0, 3).map((w, j) => (
                <Pill key={j} bg={C.blueSoft} fg={C.blue}>{w}</Pill>
              ))}
            </span>
            <span style={{ fontSize: 11.5, color: C.muted, width: 108, flex: "none", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.bucket_label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Card({ r, acting, onAction }) {
  const age = ageOf(r.created_time);
  const barColor = r.tone ? toneStyle(r.tone, r.priority).bar : age.color;
  const flagS = r.tone ? toneStyle(r.tone, r.priority) : { bg: age.soft, fg: age.color };
  const line = [r.meta, r.created_time ? fmtDateTime(r.created_time) : null].filter(Boolean).join(" · ");
  return (
    <div style={{ position: "relative", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px 16px 24px", display: "flex", alignItems: "center", gap: 18, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,42,80,.04)" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5, background: barColor }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.muted, letterSpacing: 0.3 }}>{r.ref}</span>
          {r.local_id && <span style={{ fontSize: 11.5, color: C.muted }}>#{r.local_id}</span>}
          {r.flag && <Pill bg={flagS.bg} fg={flagS.fg}>{r.flag}</Pill>}
          {r.priority && r.priority !== "Normal" && <Pill bg={flagS.bg} fg={flagS.fg}>{r.priority}</Pill>}
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 5, lineHeight: 1.3, color: C.ink }}>{r.title}</div>
        {line && <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.45, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{line}</div>}
        {r.valid_from && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>Valid {fmtDateTime(r.valid_from)} → {fmtDateTime(r.valid_to)}</div>}
        {r.ai_note && (
          <div style={{ marginTop: 8, background: C.purpleSoft, border: `1px solid #E4DBFF`, borderRadius: 8, padding: "8px 10px", fontSize: 12.5, color: "#3D2A86", lineHeight: 1.5 }}>
            <strong style={{ color: C.purple }}>AI</strong> &nbsp;{r.ai_note}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "space-between", alignSelf: "stretch", gap: 12, flex: "none" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: age.color, whiteSpace: "nowrap" }}>{age.label}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {(r.actions || []).map((a, i) => (
            <button key={i} disabled={acting} onClick={() => onAction(a)}
              style={{ ...btn(a.kind === "primary"), padding: "8px 16px", opacity: acting ? 0.6 : 1, whiteSpace: "nowrap" }}>
              {acting && a.kind === "primary" ? "…" : a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
function ageOf(iso) {
  if (!iso) return { label: "", color: C.muted, soft: C.blueSoft };
  const t = Date.parse(iso);
  if (isNaN(t)) return { label: "", color: C.muted, soft: C.blueSoft };
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  let label;
  if (mins < 60) label = mins + " m old";
  else if (mins < 1440) { const h = Math.floor(mins / 60), m = mins % 60; label = h + " h" + (m ? " " + m + " m" : "") + " old"; }
  else { const d = Math.floor(mins / 1440); label = d + " d old"; }
  if (mins >= 120) return { label, color: C.red, soft: C.redSoft };
  if (mins >= 60) return { label, color: C.amber, soft: C.amberSoft };
  return { label, color: C.blue, soft: C.blueSoft };
}

const Pill = ({ children, bg, fg }) => (
  <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20 }}>{children}</span>
);
const Tab = ({ active, onClick, label, count }) => (
  <button onClick={onClick} style={{
    flex: 1, border: "none", background: "transparent", cursor: "pointer", padding: "8px 6px",
    borderBottom: `2px solid ${active ? C.blue : "transparent"}`, color: active ? C.blue : C.muted,
    fontWeight: active ? 600 : 500, fontSize: 13.5,
  }}>{label} <span style={{ opacity: 0.8 }}>{count}</span></button>
);
function LiveDot({ live, lastTick }) {
  return (
    <span title={lastTick ? "Updated " + fmt(lastTick) : ""} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: live ? C.green : C.muted, marginLeft: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: 8, background: live ? "#22A722" : C.muted, boxShadow: live ? "0 0 0 3px rgba(34,167,34,.15)" : "none" }} />
      {live ? "Live" : "Paused"}
    </span>
  );
}
const Center = ({ children }) => (
  <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", color: C.muted }}>{children}</div>
);
function Logo({ small }) {
  const s = small ? 26 : 44;
  return <div style={{ width: s, height: s, borderRadius: "50%", border: `${small ? 4 : 6}px solid ${C.indigo}`, display: "inline-block" }} />;
}
function btn(primary) {
  return { background: primary ? C.blue : C.card, color: primary ? "#fff" : "#384A62", border: `1px solid ${primary ? C.blue : C.border}`, borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
}
function pbtn(disabled) { return { ...btn(false), cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1 }; }
function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch (e) { return iso; }
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return iso; }
}
