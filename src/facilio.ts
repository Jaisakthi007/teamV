import { createVibe } from '@facilio/vibe-sdk'

export const vibe = createVibe()

const CMMS = 'facilio-cmms'
const PLATFORM = 'notifictication-rule-connection'

/** One list call. Returns {count, rows}. Never throws — a dead bucket must not kill the board. */
export async function list(
  action: string,
  args: Record<string, unknown> = {},
): Promise<{ count: number | null; rows: any[]; error?: string }> {
  try {
    const res: any = await vibe.executeAction(CMMS, action, {
      page: 1,
      include_count: true,
      ...args,
    })
    if (res?.success === false) {
      return { count: null, rows: [], error: res?.error?.message || 'action failed' }
    }
    return { count: res?.count ?? null, rows: res?.data ?? [] }
  } catch (e: any) {
    return { count: null, rows: [], error: e?.message || String(e) }
  }
}

/**
 * Module metadata — the only reliable source of this org's status labels.
 * Status names are per-org, so nothing here is hardcoded.
 */
export async function metadata(action: string): Promise<any | null> {
  try {
    const res: any = await vibe.executeAction(CMMS, action, {})
    return res?.data ?? res ?? null
  } catch {
    return null
  }
}

/** Pull the allowedValues for a field out of a metadata payload, whatever shape it came in. */
export function allowedValues(meta: any, field: string): { label: string; value: any }[] {
  if (!meta) return []
  const fields: any[] = meta.fields || meta.meta?.fields || []
  const f = fields.find((x) => x?.name === field)
  const vals = f?.allowedValues || f?.picklistValues || []
  return vals
    .map((v: any) =>
      typeof v === 'string'
        ? { label: v, value: v }
        : { label: v?.label ?? v?.displayName ?? String(v?.value), value: v?.value ?? v?.id },
    )
    .filter((v: any) => v.label)
}

/**
 * The buttons a record can actually run right now, straight from the server's
 * state machine. Never hardcode a state->button map: this org has custom buttons
 * (Create PO, Cancel Work Order, Associate TSRs) that differ from stock Facilio.
 */
export async function recordActions(moduleName: string, recordId: number) {
  try {
    const res: any = await vibe.executeAction(PLATFORM, 'get-record-actions', {
      moduleName,
      recordId,
    })
    const d = res?.data ?? res ?? {}
    return {
      currentState: d.currentState ?? null,
      buttons: [
        ...(d.stateTransitions ?? []),
        ...(d.approvalTransitions ?? []),
        ...(d.systemButtons ?? []),
        ...(d.customButtons ?? []),
      ],
    }
  } catch (e: any) {
    return { currentState: null, buttons: [], error: e?.message }
  }
}

/** The Vibe router agent that sits between this app and the Studio agent team. */
export const ROUTER_AGENT = 'sr-router_02b195e38764434a911a8a93dff124fa'

export type BridgeResult = {
  srId: number
  currentState: any
  availableButtons: any[]
  router: { agent: string; threadId: number; decision: any; raw: string | null }
  studio: { agent: string; threadId: number; status: string | null; reply: string | null }
  contextSent: string
  error?: string
}

/**
 * The whole bridge in ONE browser call.
 *
 * Everything else happens server-side inside the `sr-bridge` function: it assembles the
 * full SR context (record + site/client/tenant/building/space + the buttons the record's
 * state machine accepts right now), hands it to the Vibe router agent to pick the right
 * Studio agent, then calls that Studio agent with the same full context. Keeping it to a
 * single executeFunction is what keeps us under the ~100 calls/min cap.
 */
export async function askBridge(srId: number, question: string): Promise<BridgeResult> {
  try {
    const res: any = await vibe.executeFunction('sr-bridge', 'route-and-run', {
      srId,
      question,
      routerAgent: ROUTER_AGENT,
    })
    const out = res?.output ?? res
    if (out?.error || res?.ok === false) {
      return { ...(out ?? {}), error: out?.error ?? res?.error ?? 'bridge failed' } as BridgeResult
    }
    return out as BridgeResult
  } catch (e: any) {
    return { error: e?.message || String(e) } as BridgeResult
  }
}

export type StudioAskResult = {
  srId: number
  agent: string
  threadId: number
  createdThread?: boolean
  status: string | null
  reply: string | null
  contextSent: string
  currentState: any
  availableButtons: any[]
  error?: string
}

/**
 * Ask a specific Studio agent directly — no router hop. Used where the action is
 * already unambiguous (e.g. the Acknowledge button), so there's nothing to route.
 */
export async function askStudioAgent(
  srId: number,
  question: string,
  agent = 'acknowledge_service_request',
): Promise<StudioAskResult> {
  try {
    const res: any = await vibe.executeFunction('sr-bridge', 'ask-studio-agent', {
      srId,
      question,
      agent,
    })
    const out = res?.output ?? res
    if (out?.error || res?.ok === false) {
      return { ...(out ?? {}), error: out?.error ?? res?.error ?? 'bridge failed' } as StudioAskResult
    }
    return out as StudioAskResult
  } catch (e: any) {
    return { error: e?.message || String(e) } as StudioAskResult
  }
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

export function label(v: any): string {
  if (v == null) return '—'
  if (typeof v === 'object') return v.displayName ?? v.name ?? v.subject ?? `#${v.id ?? ''}`
  return String(v)
}

export function money(n: any): string {
  const v = Number(n)
  if (!isFinite(v) || v === 0) return '—'
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 })
}
