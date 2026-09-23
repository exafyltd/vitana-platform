/**
 * VTID-04357 — calendar step 6: the developer and admin work lenses.
 *
 * Work items are computed live from the tables that already own them and are
 * never written into calendar_events:
 *   - a deploy or a ticket is not one person's appointment, so writing it
 *     would mean one row per staff member per event, kept in sync forever;
 *   - the source table stays the only truth, so there is nothing to drift.
 *
 * Developer lens: gateway deploys (staging + production) and Dev Autopilot
 * executions held for review. Admin lens: member-ticket SLA deadlines and
 * pending BackOffice approvals.
 *
 * All of it is platform-wide operations data, so it is shown only to Exafy
 * staff (the verified `exafy_admin` JWT claim). The active role is only a
 * client header and never grants access on its own — it only picks which
 * lens a staff member is looking at.
 *
 * Text: the gateway ships a `work.kind` + params and an identifier as title
 * (a commit sha, a ticket number), never a sentence; the app translates.
 */

import type { CalendarEvent, CalendarRoleContext } from '../types/calendar';
import type { CalendarWindowItem } from './calendar-service';
import { getSupabaseConfig, headers } from './calendar-service';

const LOG_PREFIX = '[CalendarWorkLens]';

export type WorkLens = 'developer' | 'admin';

export type WorkKind =
  | 'deploy_staging'
  | 'deploy_prod'
  | 'autopilot_review'
  | 'ticket_due'
  | 'erp_approval';

export interface WorkDescriptor {
  kind: WorkKind;
  source_id: string;
  params: Record<string, string>;
}

export type WorkWindowItem = CalendarWindowItem & { work: WorkDescriptor };

/** Per-source cap, so one noisy source cannot flood a month view. */
export const WORK_SOURCE_LIMIT = 200;

const DEPLOY_MINUTES = 10;
const REVIEW_MINUTES = 30;
const TICKET_MINUTES = 30;
const ERP_MINUTES = 30;

const EMOJI: Record<WorkKind, string> = {
  deploy_staging: '🧪',
  deploy_prod: '🚀',
  autopilot_review: '🔍',
  ticket_due: '⏰',
  erp_approval: '✅',
};

/** feedback_tickets_status_check values that mean the ticket needs nobody. */
const CLOSED_TICKET_STATUSES = new Set(['resolved', 'user_confirmed', 'duplicate', 'rejected', 'wont_fix']);

/**
 * Which work lenses a request gets. Nothing unless the caller is Exafy staff;
 * then the active role picks the lens (super_admin sees both).
 */
export function workLensesFor(role: string | null, isExafyAdmin: boolean): WorkLens[] {
  if (!isExafyAdmin) return [];
  switch (role) {
    case 'developer':
    case 'infra':
    case 'dev':
    case 'DEV':
      return ['developer'];
    case 'admin':
    case 'staff':
    case 'backoffice':
      return ['admin'];
    case 'super_admin':
      return ['developer', 'admin'];
    default:
      return [];
  }
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** A synthetic, read-only entry. `id` is prefixed so it can never match a row. */
export function toWorkItem(
  userId: string,
  lens: WorkLens,
  work: WorkDescriptor,
  title: string,
  start: string,
  minutes: number,
): WorkWindowItem {
  const id = `work:${work.kind}:${work.source_id}`;
  const end = plusMinutes(start, minutes);
  const roleContext: CalendarRoleContext = lens;
  const eventType = work.kind.startsWith('deploy_') ? 'deployment' : lens === 'developer' ? 'dev_task' : 'admin_task';
  const event = {
    id,
    user_id: userId,
    title,
    description: null,
    start_time: start,
    end_time: end,
    location: null,
    event_type: eventType,
    status: 'confirmed',
    priority: work.kind === 'deploy_prod' || work.kind === 'ticket_due' ? 'high' : 'medium',
    is_recurring: false,
    recurring_pattern: null,
    attendees_count: 0,
    has_rewards: false,
    metadata: { work_item: true },
    source_message_id: null,
    source_type: work.kind.startsWith('deploy_') ? 'ci_cd' : 'vtid',
    created_at: start,
    updated_at: start,
    role_context: roleContext,
    source_ref_id: work.source_id,
    source_ref_type: `work_${work.kind}`,
    activated_at: null,
    completed_at: null,
    completion_status: null,
    completion_notes: null,
    original_start_time: null,
    reschedule_count: 0,
    priority_score: 0,
    wellness_tags: [],
    pillar: null,
    contribution_vector: null,
    rrule: null,
    timezone: null,
    reminder_offsets: [],
    emoji: EMOJI[work.kind],
  } as unknown as CalendarEvent;
  return { id, event_id: id, start_time: start, end_time: end, busy: false, occurrence_index: null, event, work };
}

// -----------------------------------------------------------------------------
// Row → item mappers (pure, exported for tests)
// -----------------------------------------------------------------------------

export function deployItems(
  userId: string,
  rows: Array<{ id: string; topic: string; service?: string | null; created_at: string; metadata?: any }>,
): WorkWindowItem[] {
  return rows.map((r) => {
    const prod = r.topic === 'prod.deploy.completed';
    const commit = String(r.metadata?.git_commit ?? '').slice(0, 7);
    const service = String(r.service ?? '').replace(/-aws(dr)?$/, '');
    return toWorkItem(
      userId,
      'developer',
      { kind: prod ? 'deploy_prod' : 'deploy_staging', source_id: r.id, params: { commit, service } },
      commit || service || r.topic,
      r.created_at,
      DEPLOY_MINUTES,
    );
  });
}

export function reviewItems(
  userId: string,
  rows: Array<{ id: string; pr_number?: number | null; updated_at: string; metadata?: any }>,
): WorkWindowItem[] {
  return rows.map((r) => {
    const pending = r.metadata?.pending_approval ?? {};
    const start = typeof pending.staged_at === 'string' ? pending.staged_at : r.updated_at;
    const title = typeof pending.pr_title === 'string' && pending.pr_title ? pending.pr_title : r.id.slice(0, 8);
    return toWorkItem(
      userId,
      'developer',
      { kind: 'autopilot_review', source_id: r.id, params: { execution: r.id.slice(0, 8), branch: String(pending.branch ?? '') } },
      title,
      start,
      REVIEW_MINUTES,
    );
  });
}

export function ticketItems(
  userId: string,
  rows: Array<{ id: string; ticket_number?: string | null; status?: string | null; priority?: string | null; kind?: string | null; sla_due_at: string }>,
): WorkWindowItem[] {
  return rows
    .filter((r) => !CLOSED_TICKET_STATUSES.has(String(r.status ?? '')))
    .map((r) =>
      toWorkItem(
        userId,
        'admin',
        {
          kind: 'ticket_due',
          source_id: r.id,
          params: { ticket: String(r.ticket_number ?? ''), priority: String(r.priority ?? ''), ticket_kind: String(r.kind ?? '') },
        },
        r.ticket_number || r.id.slice(0, 8),
        // The deadline is the moment; the block ends on it.
        plusMinutes(r.sla_due_at, -TICKET_MINUTES),
        TICKET_MINUTES,
      ),
    );
}

export function erpApprovalItems(
  userId: string,
  rows: Array<{ id: string; approve_capability?: string | null; created_at: string }>,
): WorkWindowItem[] {
  return rows.map((r) =>
    toWorkItem(
      userId,
      'admin',
      { kind: 'erp_approval', source_id: r.id, params: { capability: String(r.approve_capability ?? '') } },
      r.approve_capability || r.id.slice(0, 8),
      r.created_at,
      ERP_MINUTES,
    ),
  );
}

// -----------------------------------------------------------------------------
// Fetch
// -----------------------------------------------------------------------------

async function read<T>(url: string, key: string, label: string): Promise<T[]> {
  try {
    const res = await fetch(url, { headers: headers(key) });
    if (!res.ok) {
      console.error(`${LOG_PREFIX} ${label} read failed: ${res.status} ${await res.text()}`);
      return [];
    }
    return (await res.json()) as T[];
  } catch (err: any) {
    console.error(`${LOG_PREFIX} ${label} read failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Work items for the window. Every source fails open to [] and logs: a
 * broken ops table must never take the calendar down with it.
 */
export async function listWorkItems(
  userId: string,
  lenses: WorkLens[],
  window: { from: string; to: string },
): Promise<WorkWindowItem[]> {
  if (lenses.length === 0) return [];
  const config = getSupabaseConfig();
  if (!config) return [];
  const from = encodeURIComponent(window.from);
  const to = encodeURIComponent(window.to);
  const rest = `${config.url}/rest/v1`;
  const lim = `limit=${WORK_SOURCE_LIMIT}`;

  const jobs: Array<Promise<WorkWindowItem[]>> = [];

  if (lenses.includes('developer')) {
    jobs.push(
      read<any>(
        `${rest}/oasis_events?select=id,topic,service,created_at,metadata` +
          `&topic=in.(staging.deploy.completed,prod.deploy.completed)` +
          `&created_at=gte.${from}&created_at=lt.${to}&order=created_at.asc&${lim}`,
        config.key,
        'deploys',
      ).then((rows) => deployItems(userId, rows)),
    );
    // A held execution needs someone now, whatever the window: it shows on
    // the day it was staged when that day is in view.
    jobs.push(
      read<any>(
        `${rest}/dev_autopilot_executions?select=id,pr_number,updated_at,metadata` +
          `&status=eq.awaiting_approval&order=updated_at.desc&${lim}`,
        config.key,
        'autopilot reviews',
      ).then((rows) => inWindow(reviewItems(userId, rows), window)),
    );
  }

  if (lenses.includes('admin')) {
    jobs.push(
      read<any>(
        `${rest}/feedback_tickets?select=id,ticket_number,status,priority,kind,sla_due_at` +
          `&sla_due_at=gte.${from}&sla_due_at=lt.${to}&resolved_at=is.null&order=sla_due_at.asc&${lim}`,
        config.key,
        'ticket SLAs',
      ).then((rows) => ticketItems(userId, rows)),
    );
    jobs.push(
      read<any>(
        `${rest}/erp_approvals?select=id,approve_capability,created_at` +
          `&status=eq.pending&created_at=gte.${from}&created_at=lt.${to}&order=created_at.asc&${lim}`,
        config.key,
        'ERP approvals',
      ).then((rows) => erpApprovalItems(userId, rows)),
    );
  }

  const all = (await Promise.all(jobs)).flat();
  return all.sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

export function inWindow<T extends { start_time: string; end_time: string | null }>(
  items: T[],
  window: { from: string; to: string },
): T[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return items.filter((i) => {
    const s = Date.parse(i.start_time);
    const e = Date.parse(i.end_time ?? i.start_time);
    return s < to && Math.max(e, s + 1) > from;
  });
}

/** Merge work items into the window list, keeping start order. */
export function mergeWorkItems<T extends { start_time: string }>(items: T[], work: T[]): T[] {
  return [...items, ...work].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}
