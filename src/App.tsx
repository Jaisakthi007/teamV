import { useEffect, useMemo, useState } from 'react'
import { BUCKETS, type Bucket } from './buckets'
import {
  askBridge,
  askStudioAgent,
  label,
  list,
  money,
  recordActions,
  type BridgeResult,
  type StudioAskResult,
} from './facilio'
import './App.css'

type Res = { count: number | null; rows: any[]; error?: string; loading?: boolean }

export default function App() {
  const [res, setRes] = useState<Record<string, Res>>({})
  const [open, setOpen] = useState<Bucket | null>(null)
  const [acts, setActs] = useState<Record<number, any>>({})
  const [ranAt, setRanAt] = useState<string>('')
  const [ackFor, setAckFor] = useState<{ id: number; subject?: string } | null>(null)

  async function load() {
    setRes({})
    setRanAt('')
    // One list call per bucket, in parallel — 11 calls, well under the 100/min cap.
    const live = BUCKETS.filter((b) => !b.unavailable)
    setRes(Object.fromEntries(live.map((b) => [b.id, { count: null, rows: [], loading: true }])))
    await Promise.all(
      live.map(async (b) => {
        const r = await list(b.listAction, {
          page_size: 6,
          ...(b.select ? { select: b.select } : {}),
          ...(b.filters?.() ? { filters: b.filters!() } : {}),
        })
        setRes((p) => ({ ...p, [b.id]: r }))
      }),
    )
    setRanAt(new Date().toLocaleTimeString())
  }

  useEffect(() => {
    load()
  }, [])

  async function openBucket(b: Bucket) {
    setOpen(b)
    setActs({})
    const rows = res[b.id]?.rows ?? []
    // buttons come from the server, per record, filtered by its real current state
    for (const r of rows.slice(0, 4)) {
      const a = await recordActions(b.apiModule, r.id)
      setActs((p) => ({ ...p, [r.id]: a }))
    }
  }

  const jobs = BUCKETS.filter((b) => b.kind === 'job')
  const signals = BUCKETS.filter((b) => b.kind === 'signal')

  const totals = useMemo(() => {
    const sum = (bs: Bucket[]) =>
      bs.reduce((n, b) => n + (res[b.id]?.count ?? 0), 0)
    return { jobs: sum(jobs), signals: sum(signals) }
  }, [res])

  return (
    <div className="page">
      <header>
        <div>
          <div className="kicker">FM Copilot · Signal &amp; Job Engine</div>
          <h1>What needs you today</h1>
          <div className="sub">
            Live CBRE portfolio · actions read from each record&rsquo;s real state machine
          </div>
        </div>
        <div className="hdr-right">
          <button className="refresh" onClick={load}>
            Refresh
          </button>
          <div className="stamp">{ranAt ? `updated ${ranAt}` : 'loading…'}</div>
        </div>
      </header>

      <div className="kpis">
        <Kpi kind="job" v={totals.jobs} l="Jobs waiting on you" />
        <Kpi kind="sig" v={totals.signals} l="Signals to look at" />
        <Kpi
          kind="crit"
          v={res['J-07']?.count ?? null}
          l="Work orders past due"
        />
        <Kpi kind="neutral" v={res['J-15']?.count ?? null} l="Permits awaiting approval" />
      </div>

      <Section
        kind="job"
        title="Jobs to be done"
        blurb="Deterministic work already in the queue. Act inline, or open the record."
        bs={jobs}
        res={res}
        onOpen={openBucket}
      />
      <Section
        kind="sig"
        title="Signals"
        blurb="Derived from patterns and dates — not a queued task, but something to look at."
        bs={signals}
        res={res}
        onOpen={openBucket}
      />

      <AgentBridge />

      {ackFor && (
        <AckPane srId={ackFor.id} subject={ackFor.subject} onClose={() => setAckFor(null)} />
      )}

      {open && (
        <div className="drawer-wrap" onClick={() => setOpen(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-hd">
              <div>
                <span className={`tag ${open.kind}`}>{open.id}</span>
                <h2>{open.title}</h2>
                <p>{open.solves}</p>
              </div>
              <button className="x" onClick={() => setOpen(null)}>
                ×
              </button>
            </div>
            <div className="rows">
              {(res[open.id]?.rows ?? []).map((r) => (
                <div className="row" key={r.id}>
                  <div className="row-hd">
                    <strong>{label(r.subject ?? r.name)}</strong>
                    <span className="pill">{label(r.moduleState)}</span>
                  </div>
                  <div className="meta">
                    #{r.id}
                    {r.priority ? ` · ${label(r.priority)}` : ''}
                    {r.dueDate ? ` · due ${String(r.dueDate).slice(0, 10)}` : ''}
                    {r.totalCost ? ` · ${money(r.totalCost)}` : ''}
                  </div>
                  <div className="btns">
                    {acts[r.id] ? (
                      acts[r.id].buttons.length ? (
                        acts[r.id].buttons.map((b: any) => {
                          const isAck =
                            open.apiModule === 'serviceRequest' && /acknowledge/i.test(b.name ?? '')
                          return (
                            <button
                              key={`${b.buttonType}-${b.buttonId}`}
                              className="act"
                              disabled={!isAck}
                              title={isAck ? undefined : 'not wired up yet'}
                              onClick={
                                isAck
                                  ? () => setAckFor({ id: r.id, subject: r.subject ?? r.name })
                                  : undefined
                              }
                            >
                              {b.name}
                            </button>
                          )
                        })
                      ) : (
                        <span className="none">no actions available in this state</span>
                      )
                    ) : (
                      <span className="none">loading actions…</span>
                    )}
                  </div>
                </div>
              ))}
              {!(res[open.id]?.rows ?? []).length && <div className="none">nothing in this bucket</div>}
            </div>
            <div className="drawer-ft">
              Buttons above are whatever the server says this record can run right now —
              including this org&rsquo;s custom ones. Clicking is not wired up yet: executing
              them writes to the live CBRE org.
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

/**
 * Ask the Studio agent team about a service request.
 *
 * Exactly one call leaves the browser (`askBridge`). Context assembly, the Vibe router
 * agent, and the Studio agent all run server-side in the `sr-bridge` function.
 */
function AgentBridge() {
  const [srId, setSrId] = useState('')
  const [q, setQ] = useState('Acknowledge this request — the tenant is paying for it.')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<BridgeResult | null>(null)

  async function send() {
    const id = Number(srId)
    if (!id) return
    setBusy(true)
    setOut(null)
    setOut(await askBridge(id, q))
    setBusy(false)
  }

  const d = out?.router?.decision

  return (
    <section>
      <div className="sech job">
        <h2>Ask the agent team</h2>
      </div>
      <p className="secsub">
        One call from this page. The server assembles the request&rsquo;s full context —
        record, client, tenant, building, site and the buttons its state machine accepts
        right now — routes it through the Vibe agent, and hands the same context to the
        Facilio Studio agent.
      </p>
      <div className="grp">
        <div className="bridge">
          <div className="bridge-in">
            <input
              className="sr-id"
              placeholder="SR id"
              value={srId}
              onChange={(e) => setSrId(e.target.value)}
            />
            <input
              className="sr-q"
              placeholder="What should the agent team do?"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="refresh" disabled={busy || !srId} onClick={send}>
              {busy ? 'asking…' : 'Ask'}
            </button>
          </div>

          {out?.error && <div className="err">{out.error}</div>}

          {out && !out.error && (
            <div className="bridge-out">
              <div className="row">
                <div className="row-hd">
                  <strong>Router chose: {d?.studioAgent ?? '—'}</strong>
                  <span className="pill">{label(out.currentState)}</span>
                </div>
                {d?.rationale && <div className="meta">{d.rationale}</div>}
                {!!d?.missingInfo?.length && (
                  <div className="meta">still needed: {d.missingInfo.join(', ')}</div>
                )}
              </div>
              <div className="row">
                <div className="row-hd">
                  <strong>{out.studio?.agent}</strong>
                  <span className="pill">{out.studio?.status ?? '—'}</span>
                </div>
                <div className="reply">{out.studio?.reply ?? '—'}</div>
              </div>
              <details className="row">
                <summary>Context passed to the agent</summary>
                <pre className="ctx">{out.contextSent}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The Acknowledge action for a Service Request: opens as a pane over the record
 * drawer and immediately runs the `acknowledge_service_request` Studio agent
 * (the Service Request Operations Team) — no router hop, since Acknowledge is
 * already unambiguous. The question stays editable in case a re-ask is needed.
 */
function AckPane({
  srId,
  subject,
  onClose,
}: {
  srId: number
  subject?: string
  onClose: () => void
}) {
  const [q, setQ] = useState('Acknowledge this request.')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<StudioAskResult | null>(null)

  async function run(question: string) {
    setBusy(true)
    setOut(null)
    setOut(await askStudioAgent(srId, question))
    setBusy(false)
  }

  useEffect(() => {
    run(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srId])

  return (
    <div className="drawer-wrap ack-wrap" onClick={onClose}>
      <aside className="drawer ack-pane" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hd">
          <div>
            <span className="tag job">Acknowledge · SR #{srId}</span>
            <h2>{subject ? label(subject) : `Service request #${srId}`}</h2>
            <p>Routed straight to the Service Request Operations Team agent.</p>
          </div>
          <button className="x" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="bridge">
          <div className="bridge-in">
            <input
              className="sr-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              disabled={busy}
            />
            <button className="refresh" disabled={busy} onClick={() => run(q)}>
              {busy ? 'asking…' : 'Re-ask'}
            </button>
          </div>

          {busy && !out && <div className="none">acknowledging…</div>}
          {out?.error && <div className="err">{out.error}</div>}

          {out && !out.error && (
            <div className="bridge-out">
              <div className="row">
                <div className="row-hd">
                  <strong>{out.agent}</strong>
                  <span className="pill">{out.status ?? '—'}</span>
                </div>
                <div className="reply">{out.reply ?? '—'}</div>
              </div>
              <details className="row">
                <summary>Context passed to the agent</summary>
                <pre className="ctx">{out.contextSent}</pre>
              </details>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function Kpi({ v, l, kind }: { v: number | null; l: string; kind: string }) {
  return (
    <div className={`kpi ${kind}`}>
      <div className="v">{v == null ? '—' : v.toLocaleString()}</div>
      <div className="l">{l}</div>
    </div>
  )
}

function Section({
  kind,
  title,
  blurb,
  bs,
  res,
  onOpen,
}: {
  kind: string
  title: string
  blurb: string
  bs: Bucket[]
  res: Record<string, Res>
  onOpen: (b: Bucket) => void
}) {
  const groups = [...new Set(bs.map((b) => b.group))]
  return (
    <section>
      <div className={`sech ${kind}`}>
        <h2>{title}</h2>
        <span className="cnt">{bs.length}</span>
      </div>
      <p className="secsub">{blurb}</p>
      {groups.map((g) => (
        <div className="grp" key={g}>
          <div className="grph">{g}</div>
          <div className="cards">
            {bs
              .filter((b) => b.group === g)
              .map((b) => {
                const r = res[b.id]
                const dead = !!b.unavailable
                return (
                  <button
                    key={b.id}
                    className={`card ${kind} ${dead ? 'dead' : ''}`}
                    disabled={dead}
                    onClick={() => !dead && onOpen(b)}
                    title={b.unavailable || b.solves}
                  >
                    <div className="card-top">
                      <span className="id">{b.id}</span>
                      <span className="mod">{b.module}</span>
                    </div>
                    <div className="n">
                      {dead ? 'n/a' : r?.loading ? '…' : r?.error ? '!' : (r?.count ?? '—')}
                    </div>
                    <div className="t">{b.title}</div>
                    <div className="a">{dead ? 'no data source' : b.action + ' →'}</div>
                    {r?.error && !dead && <div className="err">{r.error}</div>}
                  </button>
                )
              })}
          </div>
        </div>
      ))}
    </section>
  )
}
