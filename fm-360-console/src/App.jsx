import { useEffect, useMemo, useRef, useState } from "react";
import { createVibe } from "@facilio/vibe-sdk";

const vibe = createVibe();
const PAGE_SIZE = 10;
const POLL_MS = 30000; // smart-poll cadence for live counts
const BUILD = "v11 · tenant quote dialog";

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
  const [toast, setToast] = useState(null);
  const [lastTick, setLastTick] = useState(null);
  const [live, setLive] = useState(true);
  const stateRef = useRef({ bucket: null, page: 1, counts: [] });
  stateRef.current = { bucket, page, counts };

  const actor = user?.user?.name || user?.user?.email || "";

  useEffect(() => {
    (async () => {
      try {
        const ok = await vibe.isAuthenticated();
        setAuthed(ok);
        if (ok) {
          setUser(await vibe.getCurrentUser().catch(() => null));
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
        <button style={btn(false)} onClick={() => { refreshCounts(); if (bucket) loadPage(bucket, page); }}>Refresh</button>
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
              <Card key={r.external_id} r={r} acting={actingId === r.external_id} onAction={(a) => takeAction(r, a)} />
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

      {toast && <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", padding: "11px 18px", borderRadius: 10, fontSize: 13.5, boxShadow: "0 6px 24px rgba(0,0,0,.22)", zIndex: 50 }}>{toast}</div>}
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
            <button key={i} disabled={acting && a.kind === "primary"} onClick={() => onAction(a)}
              style={{ ...btn(a.kind === "primary"), padding: "8px 16px", opacity: acting && a.kind === "primary" ? 0.6 : 1, whiteSpace: "nowrap" }}>
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
