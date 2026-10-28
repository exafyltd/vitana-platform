/**
 * VTID-04875 — Overview Phase 1a: the GET /api/v1/autopilot/pipeline/summary
 * builder, extracted verbatim from the inline handler in routes/autopilot.ts
 * so the Command Hub Overview's /ops/attention adapters (plan A, REVISION 2
 * F3) can call it in-process instead of making an HTTP self-call.
 *
 * Contract: returns `{ status, body }` — exactly the status code and JSON body
 * the route used to send. It never throws: an unexpected error becomes
 * `{ status: 500, body: { ok: false, error } }` and is logged with the same
 * `[pipeline/summary] Error:` tag as before. The route is a thin wrapper
 * (`res.status(status).json(body)`), pinned byte-for-byte by
 * test/vtid-04875-pipeline-summary-builder.test.ts.
 *
 * Data access is unchanged: raw PostgREST fetches against SUPABASE_URL with
 * the service-role key, the same 14 queries in the same order. `deps` only
 * lets a caller inject fetch / env / loop status (tests, adapters); every
 * default is what the handler used. Date.now() is read at the same points as
 * before, so time-derived fields are unchanged too.
 */

import { getEventLoopStatus } from './autopilot-event-loop';

export interface PipelineSummaryDeps {
  /** Defaults to the global fetch, resolved at call time. */
  fetchImpl?: typeof fetch;
  /** Defaults to autopilot-event-loop's getEventLoopStatus. */
  getEventLoopStatus?: () => Promise<{ is_running: boolean; execution_armed: boolean } & Record<string, any>>;
  /** Defaults to process.env.SUPABASE_URL (read at call time). */
  supabaseUrl?: string;
  /** Defaults to process.env.SUPABASE_SERVICE_ROLE (read at call time). */
  serviceRoleKey?: string;
}

export interface PipelineSummaryBody {
  ok: true;
  timestamp: string;
  funnel: {
    scheduled: number;
    in_progress: number;
    completed: number;
    rejected: number;
    stuck: number;
    broken: number;
  };
  entry_points: Record<string, number>;
  success_rate: number;
  attention_queue: any[];
  recommendations: any[];
  loop_running: boolean;
  execution_armed: boolean;
  workers_active: boolean;
}

export type PipelineSummaryErrorBody = { ok: false; error: string };

export type PipelineSummaryResult =
  | { status: 200; body: PipelineSummaryBody }
  | { status: 500; body: PipelineSummaryErrorBody };

/**
 * Full pipeline dashboard data: funnel, entry points, attention queue,
 * recommendations, success rate.
 */
export async function buildPipelineSummary(deps: PipelineSummaryDeps = {}): Promise<PipelineSummaryResult> {
  const doFetch: typeof fetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const loopStatusFn = deps.getEventLoopStatus ?? getEventLoopStatus;
  try {
    const supabaseUrl = deps.supabaseUrl !== undefined ? deps.supabaseUrl : process.env.SUPABASE_URL;
    const svcKey = deps.serviceRoleKey !== undefined ? deps.serviceRoleKey : process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !svcKey) {
      return { status: 500, body: { ok: false, error: 'Supabase not configured' } };
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
    };

    // --- Parallel fetches ---
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const [
      loopStatus,
      taskCountsResp,
      stuckResp,
      brokenResp,
      blockedResp,
      newReadyResp,
      entryPointResp,
      recsResp,
      workersResp,
      completedWeekResp,
      failedWeekResp,
    ] = await Promise.all([
      loopStatusFn(),

      // VTID Unification: ALL queries filter by vtid=like.VTID-% to match board (VTID-XXXXX only)
      // Task counts by status — direct queries
      Promise.all([
        doFetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        doFetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        doFetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.completed&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        doFetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.rejected&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
      ]).catch(() => null),

      // Stuck: in_progress > 1 hour
      doFetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&updated_at=lt.${encodeURIComponent(oneHourAgo)}&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // Broken: in_progress with last event being error/failure
      doFetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&updated_at=lt.${encodeURIComponent(oneHourAgo)}&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // Blocked: scheduled/pending with no spec
      doFetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&or=(spec_status.is.null,spec_status.eq.missing)&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // New/ready: scheduled/pending with spec validated (awaiting human approval)
      doFetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&spec_status=eq.validated&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // Entry points: count oasis_events by source for task creation events (last 7 days)
      doFetch(
        `${supabaseUrl}/rest/v1/oasis_events?vtid=like.VTID-%25&topic=in.(email.intake.task_created,vtid.task.scheduled,vtid.lifecycle.execution_approved)&created_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=source,vtid&limit=500`,
        { headers }
      ).catch(() => null),

      // Recommendations: pending, limit 5
      doFetch(
        `${supabaseUrl}/rest/v1/autopilot_recommendations?status=eq.pending&order=impact_score.desc&limit=5&select=id,title,summary,domain,risk_level,impact_score,status,created_at,source_type`, // VTID-04667: source_type drives "Create task" vs "Activate"
        { headers }
      ).catch(() => null),

      // Workers active (recent heartbeat)
      doFetch(
        `${supabaseUrl}/rest/v1/oasis_events?topic=eq.vtid.stage.worker_orchestrator.heartbeat&created_at=gt.${encodeURIComponent(new Date(Date.now() - 300000).toISOString())}&select=id&limit=1`,
        { headers }
      ).catch(() => null),

      // Completed in last 7 days (for success rate)
      doFetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.completed&updated_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=vtid&limit=500`,
        { headers }
      ).catch(() => null),

      // Failed/rejected in last 7 days (for success rate)
      doFetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(rejected,voided)&updated_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=vtid&limit=500`,
        { headers }
      ).catch(() => null),
    ]);

    // --- Parse task counts (from direct queries) ---
    let taskCounts: Record<string, number> = { scheduled: 0, in_progress: 0, completed: 0, rejected: 0 };
    if (Array.isArray(taskCountsResp)) {
      const [scheduledArr, inProgressArr, completedArr, rejectedArr] = taskCountsResp as any[][];
      taskCounts.scheduled = Array.isArray(scheduledArr) ? scheduledArr.length : 0;
      taskCounts.in_progress = Array.isArray(inProgressArr) ? inProgressArr.length : 0;
      taskCounts.completed = Array.isArray(completedArr) ? completedArr.length : 0;
      taskCounts.rejected = Array.isArray(rejectedArr) ? rejectedArr.length : 0;
    }

    // --- Parse stuck tasks ---
    let stuckTasks: any[] = [];
    if (stuckResp && stuckResp.ok) {
      const data = await stuckResp.json() as any[];
      stuckTasks = data.map(t => ({
        vtid: t.vtid,
        title: t.title || t.vtid,
        severity: 'STUCK',
        reason: `In progress for ${Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000)} minutes with no progress`,
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
        status: 'in_progress',
        spec_status: t.spec_status,
      }));
    }

    // --- Parse broken (reuse stuck data — broken = stuck with error events) ---
    // For now, stuck and broken overlap; we differentiate by duration
    const brokenTasks = stuckTasks
      .filter(t => t.stuck_minutes > 120) // > 2 hours = likely broken
      .map(t => ({ ...t, severity: 'BROKEN', reason: `Execution stalled for ${t.stuck_minutes} minutes — likely broken` }));
    const justStuck = stuckTasks.filter(t => t.stuck_minutes <= 120);

    // --- Parse blocked tasks ---
    let blockedTasks: any[] = [];
    if (blockedResp && blockedResp.ok) {
      const data = await blockedResp.json() as any[];
      blockedTasks = data.map(t => ({
        vtid: t.vtid,
        title: t.title || t.vtid,
        severity: 'BLOCKED',
        reason: 'No spec generated — cannot activate',
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
        status: 'scheduled',
        spec_status: t.spec_status || 'missing',
      }));
    }

    // --- Parse new/ready tasks ---
    let newReadyTasks: any[] = [];
    if (newReadyResp && newReadyResp.ok) {
      const data = await newReadyResp.json() as any[];
      newReadyTasks = data.map(t => ({
        vtid: t.vtid,
        title: t.title || t.vtid,
        severity: 'NEW',
        reason: 'Spec validated — waiting for human approval',
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
        status: 'scheduled',
        spec_status: 'validated',
      }));
    }

    // --- Build attention queue (sorted by severity priority) ---
    const severityOrder: Record<string, number> = { BROKEN: 0, STUCK: 1, BLOCKED: 2, NEW: 3 };
    const attentionQueue = [...brokenTasks, ...justStuck, ...blockedTasks, ...newReadyTasks]
      .sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

    // --- Parse entry points ---
    const entryPoints: Record<string, number> = {
      'command-hub': 0,
      'orb': 0,
      'operator': 0,
      'email-intake': 0,
      'system': 0,
    };
    if (entryPointResp && entryPointResp.ok) {
      const events = await entryPointResp.json() as any[];
      events.forEach((ev: any) => {
        const src = (ev.source || '').toLowerCase();
        if (src.includes('email')) entryPoints['email-intake']++;
        else if (src.includes('orb')) entryPoints['orb']++;
        else if (src.includes('operator')) entryPoints['operator']++;
        else if (src.includes('command-hub') || src.includes('commandhub')) entryPoints['command-hub']++;
        else if (src.includes('task-intake')) entryPoints['orb']++; // task-intake = ORB/Operator
        else entryPoints['system']++;
      });
    }

    // --- Parse recommendations ---
    let recommendations: any[] = [];
    if (recsResp && recsResp.ok) {
      recommendations = await recsResp.json() as any[];
    }

    // --- Workers active ---
    let workersActive = false;
    if (workersResp && workersResp.ok) {
      const workerData = await workersResp.json() as any[];
      workersActive = workerData.length > 0;
    }

    // --- Success rate (last 7 days) ---
    let completedCount = 0;
    let failedCount = 0;
    if (completedWeekResp && completedWeekResp.ok) {
      const data = await completedWeekResp.json() as any[];
      completedCount = data.length;
    }
    if (failedWeekResp && failedWeekResp.ok) {
      const data = await failedWeekResp.json() as any[];
      failedCount = data.length;
    }
    const totalResolved = completedCount + failedCount + brokenTasks.length;
    const successRate = totalResolved > 0 ? Math.round((completedCount / totalResolved) * 100) : 0;

    const body: PipelineSummaryBody = {
      ok: true,
      timestamp: new Date().toISOString(),
      funnel: {
        scheduled: taskCounts.scheduled || taskCounts.pending || 0,
        in_progress: taskCounts.in_progress || 0,
        completed: taskCounts.completed || 0,
        rejected: taskCounts.rejected || 0,
        stuck: justStuck.length,
        broken: brokenTasks.length,
      },
      entry_points: entryPoints,
      success_rate: successRate,
      attention_queue: attentionQueue,
      recommendations,
      loop_running: loopStatus.is_running,
      execution_armed: loopStatus.execution_armed,
      workers_active: workersActive,
    };
    return { status: 200, body };
  } catch (error: any) {
    console.error('[pipeline/summary] Error:', error);
    return { status: 500, body: { ok: false, error: error.message } };
  }
}
