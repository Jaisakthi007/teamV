import { nowIso } from './facilio'

export type Kind = 'job' | 'signal'

export interface Bucket {
  id: string
  kind: Kind
  group: string
  title: string
  /** what it solves — from the FM Copilot catalogue */
  solves: string
  /** the primary action the catalogue names for this row */
  action: string
  module: string
  /** api module name, for get-record-actions */
  apiModule: string
  listAction: string
  /** verified against the live org before shipping */
  filters?: () => string | undefined
  select?: string
  /** unavailable buckets render greyed with the reason, never faked */
  unavailable?: string
}

/** Anything not in a terminal state. Verified: isn_t accepts a comma list. */
const OPEN = 'moduleState(isn_t)=Closed,Cancelled'

export const BUCKETS: Bucket[] = [
  // ---------------------------------------------------------------- JOBS
  {
    id: 'J-01',
    kind: 'job',
    group: 'Requests intake',
    title: 'Triage & route new requests',
    solves: 'New service requests read, categorised and routed without manual sorting.',
    action: 'Assign / route',
    module: 'Service Request',
    apiModule: 'serviceRequest',
    listAction: 'list-service-requests',
    select: 'id,subject,moduleState,urgency,dueDate,siteId',
    filters: () => 'moduleState=Open',
  },
  {
    id: 'J-03',
    kind: 'job',
    group: 'Work order lifecycle',
    title: 'Approve & sign off completed work',
    solves: 'Orders with work done sit waiting on FM sign-off; approve in place.',
    action: 'Approve',
    module: 'Work Order',
    apiModule: 'workorder',
    listAction: 'list-work-orders',
    select: 'id,subject,moduleState,priority,dueDate,siteId,totalCost',
    filters: () => 'moduleState=Resolved',
  },
  {
    id: 'J-07',
    kind: 'job',
    group: 'Work order lifecycle',
    title: 'Clear overdue / past-SLA orders',
    solves:
      'The past-due backlog. Overdue is dueDate <= now AND still open — the same rule the platform’s own Overdue view uses.',
    action: 'Open queue',
    module: 'Work Order',
    apiModule: 'workorder',
    listAction: 'list-work-orders',
    select: 'id,subject,moduleState,priority,dueDate,siteId,assignedTo',
    filters: () => `${OPEN}&dueDate(is_before)=${nowIso()}`,
  },
  {
    id: 'J-08',
    kind: 'job',
    group: 'Work order lifecycle',
    title: 'Reassign unassigned / stuck orders',
    solves: 'Open orders with no owner at all, to be routed to on-call.',
    action: 'Assign',
    module: 'Work Order',
    apiModule: 'workorder',
    listAction: 'list-work-orders',
    select: 'id,subject,moduleState,priority,dueDate,siteId',
    filters: () => `assignedTo(is_empty)=true&${OPEN}`,
  },
  {
    id: 'J-12',
    kind: 'job',
    group: 'Procurement',
    title: 'Authorise purchase orders',
    solves: 'Open purchase orders carrying committed spend.',
    action: 'Approve',
    module: 'Purchase Order',
    apiModule: 'purchaseorder',
    listAction: 'list-purchase-orders',
    select: 'id,name,moduleState,vendor,totalCost,requiredTime',
    filters: () => OPEN,
  },
  {
    id: 'J-15',
    kind: 'job',
    group: 'Permits & compliance',
    title: 'Approve permits awaiting approval',
    solves:
      'Permits sitting in Requested. Approving moves moduleState to Active; the permit-to-work flow itself runs on permitStatus 1→4.',
    action: 'Approve',
    module: 'Work Permit',
    apiModule: 'workpermit',
    listAction: 'list-work-permits',
    filters: () => 'moduleState=Requested',
  },
  {
    id: 'J-17',
    kind: 'job',
    group: 'Permits & compliance',
    title: 'Own & action audit findings',
    solves: 'Audit findings assigned an owner and a corrective WO raised.',
    action: 'Assign',
    module: 'Findings',
    apiModule: 'finding',
    listAction: '',
    unavailable:
      'No findings read action on this connection. Separately, no corrective-WO path exists in the backend at all — raising a WO from a finding is net-new work, not wiring.',
  },

  // -------------------------------------------------------------- SIGNALS
  {
    id: 'S-04',
    kind: 'signal',
    group: 'Work order',
    title: 'SLA breach signal',
    solves: 'Resolution due date already passed while the order is still open.',
    action: 'Escalate',
    module: 'Work Order',
    apiModule: 'workorder',
    listAction: 'list-work-orders',
    select: 'id,subject,moduleState,priority,dueDate,responseDueDate,siteId',
    filters: () => `${OPEN}&dueDate(is_before)=${nowIso()}`,
  },
  {
    id: 'S-03',
    kind: 'signal',
    group: 'Work order',
    title: 'Assignment signal',
    solves: 'Open orders with no assignee — the upstream cause of most SLA breaches.',
    action: 'Route',
    module: 'Work Order',
    apiModule: 'workorder',
    listAction: 'list-work-orders',
    select: 'id,subject,moduleState,priority,siteId',
    filters: () => `assignedTo(is_empty)=true&${OPEN}`,
  },
  {
    id: 'S-24',
    kind: 'signal',
    group: 'Work permit',
    title: 'Open work-permit signal',
    solves: 'Permits not yet closed out, by linked work order.',
    action: 'Progress permit',
    module: 'Work Permit',
    apiModule: 'workpermit',
    listAction: 'list-work-permits',
    filters: () => OPEN,
  },
  {
    id: 'S-25',
    kind: 'signal',
    group: 'Work permit',
    title: 'Permit past its validity window',
    solves:
      'Validity window elapsed. Computed here on purpose: Facilio seeds an Expired status but has no transition and no job that ever reaches it.',
    action: 'Place on hold',
    module: 'Work Permit',
    apiModule: 'workpermit',
    listAction: 'list-work-permits',
    filters: () => `expectedEndTime(is_before)=${nowIso()}`,
  },
  {
    id: 'S-26',
    kind: 'signal',
    group: 'Financials',
    title: 'Abnormal quotation amount',
    solves: 'A quote that is a statistical outlier against the vendor rate card.',
    action: 'Approve at rate card / send back',
    module: 'RFQ',
    apiModule: 'requestForQuotation',
    listAction: '',
    unavailable:
      'No RFQ or vendor-quote read action on this connection. The rate card itself exists in this org as custom_ratecard, so this lights up as soon as an RFQ read action is exposed.',
  },
]
