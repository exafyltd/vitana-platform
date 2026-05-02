/**
 * VTID-02669: Feedback Completion Reconciler.
 *
 * Closes the loop on feedback tickets that were dispatched through the
 * dev autopilot. Without this, an autopilot execution can complete (PR
 * merged + deployed + verified) but the feedback_ticket sits in
 * status='in_progress' forever — the supervisor never sees a green
 * "Resolved" pill, the customer never gets confirmation.
 *
 * Runs as part of `backgroundExecutorTick` (every ~30s).
 *
 * Logic per tick:
 *   For each dev_autopilot_executions row in status='completed' or
 *   'failed' / 'failed_escalated' whose finding has source_ref starting
 *   with 'feedback_ticket:' and whose linked feedback_ticket is still
 *   in_progress:
 *     - completed → ticket.status='resolved', resolved_at=NOW(),
 *       linked_pr_url=execution.pr_url, auto_resolved=true.
 *     - failed*  → ticket.status='needs_more_info', supervisor_notes
 *       appended with the failure_stage so the supervisor knows what to
 *       investigate.
 *
 * Also stamps `playwright_verified=true` when an oasis_event of type
 * 'playwright.visual.success' or 'deploy.gateway.success' (which gates on
 * Playwright in EXEC-DEPLOY) exists for the deploy that immediately
 * preceded the execution's completion. The drawer renders a green chip.
 *
 * Idempotent. If a ticket has already been transitioned to a terminal
 * status, this loop no-ops on it.
 */

// Match the shape used by dev-autopilot-execute.ts so the reconciler can
// share the SupaConfig the tick already loaded.
interface SupaConfig {
  url: string;
  key: string;
  headers?: Record<string, string>;
}

function headersFor(s: SupaConfig): Record<string, string> {
  return s.headers ?? {
    apikey: s.key,
    Authorization: `Bearer ${s.key}`,
    'Content-Type': 'application/json',
  };
}

interface ExecutionRow {
  id: string;
  finding_id: string;
  status: string;
  pr_url: string | null;
  failure_stage: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface FindingRow {
  id: string;
  source_ref: string | null;
}

interface FeedbackTicketLite {
  id: string;
  ticket_number: string | null;
  status: string;
  supervisor_notes: string | null;
}

const LOG_PREFIX = '[VTID-02669 feedback-completion]';

async function supaGet<T>(
  s: SupaConfig,
  path: string,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${s.url}${path}`, { headers: headersFor(s) });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text().then(t => t.slice(0, 200))}` };
    const data = (await res.json().catch(() => null)) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function supaPatch(
  s: SupaConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${s.url}${path}`, {
      method: 'PATCH',
      headers: { ...headersFor(s), Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text().then(t => t.slice(0, 200))}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Look up the feedback_ticket id from a finding's source_ref like
 * "feedback_ticket:<uuid>". Returns null if the source_ref is malformed
 * or the ticket isn't found.
 */
function ticketIdFromSourceRef(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  const m = /^feedback_ticket:([0-9a-f-]{36})$/i.exec(sourceRef);
  return m ? m[1] : null;
}

/**
 * Check whether a Playwright/visual-verification success event exists for
 * the deploy that closed this execution. We look at oasis_events of type
 * 'deploy.gateway.success' or 'playwright.visual.success' in the 30 min
 * window around the execution's completed_at — that window matches the
 * EXEC-DEPLOY's verification phase.
 */
async function isPlaywrightVerified(s: SupaConfig, execution: ExecutionRow): Promise<boolean> {
  if (!execution.completed_at) return false;
  const completedAt = new Date(execution.completed_at);
  const windowStart = new Date(completedAt.getTime() - 30 * 60 * 1000).toISOString();
  const windowEnd = new Date(completedAt.getTime() + 5 * 60 * 1000).toISOString();
  const path =
    `/rest/v1/oasis_events?type=in.(playwright.visual.success,deploy.gateway.success)`
    + `&created_at=gte.${windowStart}&created_at=lte.${windowEnd}&select=id&limit=1`;
  const r = await supaGet<Array<{ id: string }>>(s, path);
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

export async function reconcileCompletedFeedbackTickets(s: SupaConfig): Promise<{ closed: number; failed: number }> {
  let closed = 0;
  let failed = 0;

  // 1. Find executions whose finding came from a feedback ticket and that
  //    are in a terminal state. Limit to a small batch per tick to keep
  //    the job cheap.
  const execs = await supaGet<Array<ExecutionRow & { finding_id: string }>>(
    s,
    `/rest/v1/dev_autopilot_executions`
    + `?status=in.(completed,failed,failed_escalated)`
    + `&select=id,finding_id,status,pr_url,failure_stage,completed_at,updated_at`
    + `&order=updated_at.desc&limit=20`,
  );
  if (!execs.ok || !execs.data) return { closed, failed };

  for (const exec of execs.data) {
    // 2. Resolve the finding's source_ref. Skip non-feedback findings.
    const findR = await supaGet<FindingRow[]>(
      s,
      `/rest/v1/autopilot_recommendations?id=eq.${exec.finding_id}&select=id,source_ref&limit=1`,
    );
    if (!findR.ok || !findR.data || !findR.data[0]) continue;
    const ticketId = ticketIdFromSourceRef(findR.data[0].source_ref);
    if (!ticketId) continue;

    // 3. Load the ticket. Skip if already terminal — idempotent.
    const tkR = await supaGet<FeedbackTicketLite[]>(
      s,
      `/rest/v1/feedback_tickets?id=eq.${ticketId}&select=id,ticket_number,status,supervisor_notes&limit=1`,
    );
    if (!tkR.ok || !tkR.data || !tkR.data[0]) continue;
    const tk = tkR.data[0];
    const TERMINAL = new Set(['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate', 'needs_more_info']);
    if (TERMINAL.has(tk.status)) continue;

    if (exec.status === 'completed') {
      // Visual verification stamp.
      const verified = await isPlaywrightVerified(s, exec);
      const upd: Record<string, unknown> = {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        linked_pr_url: exec.pr_url,
        auto_resolved: true,
        playwright_verified: verified,
      };
      const upR = await supaPatch(s, `/rest/v1/feedback_tickets?id=eq.${tk.id}`, upd);
      if (upR.ok) {
        closed++;
        console.log(`${LOG_PREFIX} closed ${tk.ticket_number} via execution ${exec.id.slice(0, 8)} (verified=${verified})`);
        // Best-effort OASIS event so dashboards see closure.
        try {
          const { emitOasisEvent } = await import('./oasis-event-service');
          await emitOasisEvent({
            vtid: 'VTID-02669',
            type: 'feedback.ticket.resolved' as any,
            source: 'feedback-completion-reconciler',
            status: 'success',
            message: `Auto-closed feedback ticket ${tk.ticket_number} after dev autopilot execution ${exec.id.slice(0, 8)} completed`,
            payload: {
              ticket_id: tk.id,
              ticket_number: tk.ticket_number,
              execution_id: exec.id,
              pr_url: exec.pr_url,
              playwright_verified: verified,
              via: 'dev_autopilot',
            },
          });
        } catch { /* non-blocking */ }
      } else {
        console.warn(`${LOG_PREFIX} close failed for ${tk.ticket_number}:`, upR.error);
      }
    } else {
      // failed / failed_escalated
      const noteAddition = `\n\n[autopilot ${exec.status} at ${exec.failure_stage ?? 'unknown stage'} — execution ${exec.id.slice(0, 8)}; review and Re-generate]`;
      const merged = (tk.supervisor_notes ?? '').includes(exec.id.slice(0, 8))
        ? tk.supervisor_notes
        : `${tk.supervisor_notes ?? ''}${noteAddition}`;
      const upd: Record<string, unknown> = {
        status: 'needs_more_info',
        supervisor_notes: merged,
      };
      const upR = await supaPatch(s, `/rest/v1/feedback_tickets?id=eq.${tk.id}`, upd);
      if (upR.ok) {
        failed++;
        console.log(`${LOG_PREFIX} reopened ${tk.ticket_number} for review (autopilot ${exec.status} at ${exec.failure_stage ?? 'unknown'})`);
      }
    }
  }

  return { closed, failed };
}
