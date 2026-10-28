/**
 * VTID-04333 — the member ticket number travels with its VTID.
 *
 * A member reports a problem and is told a ticket number (`FB-YYYY-MM-NNNNNN`).
 * The supervisor works in VTIDs, findings, executions and PRs. Before this
 * module the only link from the Dev Autopilot side back to the ticket was the
 * `[FB-…]` prefix the bridge puts on the finding title — the PR title, the
 * OASIS events and every list API dropped it.
 *
 * One small, pure resolver used everywhere the chain is rendered:
 *   - `ticketIdFromSourceRef`   — `feedback_ticket:<uuid>` → uuid
 *   - `feedbackTicketRefFor`    — a recommendation row → `{ ticket_id,
 *                                  ticket_number, linked_vtid }` or null
 *   - `resolveFeedbackTicketRef`— same, but falls back to one
 *                                  `feedback_tickets` read when the
 *                                  recommendation predates the snapshot
 *                                  fields (best-effort, never throws)
 *
 * API shape (consumed by the Command Hub, VTID-04334):
 *   feedback_ticket: { ticket_id: string, ticket_number: string | null,
 *                      linked_vtid: string | null }
 */

export const TICKET_NUMBER_RE = /^FB-\d{4}-\d{2}-\d{4,}$/;
const VTID_RE = /^VTID-\d{4,5}$/;

export interface FeedbackTicketRef {
  ticket_id: string;
  ticket_number: string | null;
  linked_vtid: string | null;
}

export interface RecommendationLike {
  source_ref?: string | null;
  spec_snapshot?: Record<string, unknown> | null;
  activated_vtid?: string | null;
}

export function ticketIdFromSourceRef(sourceRef: string | null | undefined): string | null {
  if (!sourceRef) return null;
  const m = /^feedback_ticket:([0-9a-f-]{36})$/i.exec(sourceRef);
  return m ? m[1] : null;
}

export function isTicketNumber(v: unknown): v is string {
  return typeof v === 'string' && TICKET_NUMBER_RE.test(v.trim());
}

function feedbackBlock(rec: RecommendationLike): Record<string, unknown> | null {
  const snap = rec.spec_snapshot;
  if (!snap || typeof snap !== 'object') return null;
  const fb = (snap as { feedback?: unknown }).feedback;
  return fb && typeof fb === 'object' ? (fb as Record<string, unknown>) : null;
}

/**
 * Pure: derive the ticket reference from a recommendation row. Returns null
 * when the recommendation did not come from a feedback ticket.
 * `linked_vtid` prefers the snapshot's own value (stamped by the bridge once
 * the ticket VTID exists) and falls back to the finding's `activated_vtid` —
 * the bridge allocates the ticket VTID AS the finding's activated_vtid, so
 * the two are the same id.
 */
export function feedbackTicketRefFor(rec: RecommendationLike | null | undefined): FeedbackTicketRef | null {
  if (!rec) return null;
  const fb = feedbackBlock(rec);
  const ticketId = ticketIdFromSourceRef(rec.source_ref ?? null)
    ?? (fb && typeof fb.ticket_id === 'string' ? fb.ticket_id : null);
  if (!ticketId) return null;
  const tn = fb && isTicketNumber(fb.ticket_number) ? String(fb.ticket_number).trim() : null;
  const snapVtid = fb && typeof fb.linked_vtid === 'string' && VTID_RE.test(fb.linked_vtid) ? fb.linked_vtid : null;
  const actVtid = typeof rec.activated_vtid === 'string' && VTID_RE.test(rec.activated_vtid) ? rec.activated_vtid : null;
  return { ticket_id: ticketId, ticket_number: tn, linked_vtid: snapVtid ?? actVtid };
}

interface SupaLike { url: string; key: string }

/**
 * `feedbackTicketRefFor` plus one read of `feedback_tickets` when the
 * snapshot does not carry the ticket number (recommendations created before
 * VTID-02665 stamped it). Never throws; on any failure returns what the pure
 * resolver had.
 */
export async function resolveFeedbackTicketRef(
  s: SupaLike,
  rec: RecommendationLike | null | undefined,
): Promise<FeedbackTicketRef | null> {
  const ref = feedbackTicketRefFor(rec);
  if (!ref || (ref.ticket_number && ref.linked_vtid)) return ref;
  try {
    const r = await fetch(
      `${s.url}/rest/v1/feedback_tickets?id=eq.${ref.ticket_id}&select=ticket_number,linked_vtid&limit=1`,
      { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } },
    );
    if (!r.ok) return ref;
    const rows = (await r.json().catch(() => [])) as Array<{ ticket_number?: string | null; linked_vtid?: string | null }>;
    const row = rows[0];
    if (!row) return ref;
    return {
      ticket_id: ref.ticket_id,
      ticket_number: ref.ticket_number ?? (isTicketNumber(row.ticket_number) ? String(row.ticket_number).trim() : null),
      linked_vtid: ref.linked_vtid ?? (typeof row.linked_vtid === 'string' && VTID_RE.test(row.linked_vtid) ? row.linked_vtid : null),
    };
  } catch {
    return ref;
  }
}

// ---------------------------------------------------------------------------
// Latest Dev Autopilot execution per ticket (admin ticket APIs)
// ---------------------------------------------------------------------------

/**
 * API shape (VTID-04333), on every admin ticket row/detail:
 *   latest_execution: {
 *     id, status, stage, failure_stage, pr_url, pr_number,
 *     created_at, updated_at, completed_at
 *   } | null
 * `stage` is where the pipeline is (the execution status: cooling, running,
 * awaiting_approval, ci, merging, deploying, verifying, completed) or, for a
 * failed execution, the stage it failed at.
 */
export interface LatestExecutionSummary {
  id: string;
  status: string;
  stage: string;
  failure_stage: string | null;
  pr_url: string | null;
  pr_number: number | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

const FAILED_STATUSES = new Set(['failed', 'failed_escalated', 'reverted', 'cancelled', 'auto_archived']);

export function summarizeExecution(row: Record<string, unknown> | null | undefined): LatestExecutionSummary | null {
  if (!row || typeof row.id !== 'string' || typeof row.status !== 'string') return null;
  const failureStage = typeof row.failure_stage === 'string' ? row.failure_stage : null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id: row.id,
    status: row.status,
    stage: FAILED_STATUSES.has(row.status) && failureStage ? failureStage : row.status,
    failure_stage: failureStage,
    pr_url: str(row.pr_url),
    pr_number: typeof row.pr_number === 'number' ? row.pr_number : null,
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    completed_at: str(row.completed_at),
  };
}

/**
 * Attach `latest_execution` to each ticket from a flat list of execution rows
 * (any order). The newest row per `finding_id` (by created_at) wins; a ticket
 * with no `linked_finding_id` or no execution gets null.
 */
export function attachLatestExecutions<T extends { linked_finding_id?: string | null }>(
  tickets: T[],
  executions: Array<Record<string, unknown>>,
): Array<T & { latest_execution: LatestExecutionSummary | null }> {
  const newest = new Map<string, Record<string, unknown>>();
  for (const e of executions) {
    const fid = typeof e.finding_id === 'string' ? e.finding_id : null;
    if (!fid) continue;
    const cur = newest.get(fid);
    if (!cur || String(e.created_at ?? '') > String(cur.created_at ?? '')) newest.set(fid, e);
  }
  return tickets.map((t) => ({
    ...t,
    latest_execution: t.linked_finding_id ? summarizeExecution(newest.get(t.linked_finding_id)) : null,
  }));
}
