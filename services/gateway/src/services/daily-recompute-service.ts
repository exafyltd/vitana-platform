/**
 * VTID-01095: Daily Recompute Service
 *
 * Orchestrates the daily recompute pipeline for each user:
 *   Stage A: Longevity compute
 *   Stage B: Topics recompute
 *   Stage C: Community recommendations
 *   Stage D: Matches recompute
 *
 * Key features:
 *   - Idempotent: Uses daily_recompute_runs table to track progress
 *   - Retriable: Can resume from failed stage
 *   - Logged: Emits OASIS events at each stage
 *   - Terminal-complete: Only marks done when OASIS completion event is written
 */

import { randomUUID } from 'crypto';
import { CicdEventType } from '../types/cicd';
import { emitOasisEvent } from './oasis-event-service';

const VTID = 'VTID-01095';

// Pipeline stages in execution order
export const PIPELINE_STAGES = ['longevity', 'topics', 'community_recs', 'matches'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface StageStatus {
  status: 'pending' | 'in_progress' | 'success' | 'failed';
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  error?: string;
  result?: Record<string, unknown>;
}

export interface DailyRecomputeRun {
  id: string;
  tenant_id: string;
  user_id: string;
  run_date: string;
  status: 'in_progress' | 'completed' | 'failed';
  stage_status: Record<PipelineStage, StageStatus>;
  current_stage?: PipelineStage;
  error_message?: string;
  error_stage?: string;
  started_at: string;
  finished_at?: string;
  metadata?: Record<string, unknown>;
}

export interface RecomputeBatchRequest {
  tenant_id: string;
  date: string;
  limit_users?: number;
  cursor?: string | null;
}

export interface RecomputeBatchResponse {
  ok: boolean;
  processed: number;
  skipped: number;
  failed: number;
  next_cursor: string | null;
  run_ids: string[];
  errors?: Array<{ user_id: string; error: string }>;
}

export interface RecomputeStatusResponse {
  ok: boolean;
  date: string;
  tenant_id: string;
  total_users: number;
  completed: number;
  in_progress: number;
  failed: number;
  last_cursor?: string;
}

/**
 * Emit OASIS event for daily recompute pipeline
 */
async function emitSchedulerEvent(
  eventType: CicdEventType,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; event_id?: string }> {
  return emitOasisEvent({
    vtid: VTID,
    type: eventType,
    source: 'scheduler-daily-recompute',
    status,
    message,
    payload: {
      ...payload,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Get or create a run record for the user+date
 */
async function getOrCreateRun(
  supabaseUrl: string,
  supabaseKey: string,
  tenantId: string,
  userId: string,
  runDate: string
): Promise<{ run: DailyRecomputeRun | null; isNew: boolean; error?: string }> {
  // Check for existing run
  const checkResponse = await fetch(
    `${supabaseUrl}/rest/v1/daily_recompute_runs?tenant_id=eq.${tenantId}&user_id=eq.${userId}&run_date=eq.${runDate}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    }
  );

  if (!checkResponse.ok) {
    const errorText = await checkResponse.text();
    return { run: null, isNew: false, error: `Failed to check existing run: ${errorText}` };
  }

  const existingRuns = (await checkResponse.json()) as DailyRecomputeRun[];

  if (existingRuns.length > 0) {
    const existing = existingRuns[0];
    // If already completed, skip
    if (existing.status === 'completed') {
      return { run: existing, isNew: false };
    }
    // If in_progress or failed, we can retry
    return { run: existing, isNew: false };
  }

  // Create new run
  const runId = randomUUID();
  const now = new Date().toISOString();

  const initialStageStatus: Record<PipelineStage, StageStatus> = {
    longevity: { status: 'pending' },
    topics: { status: 'pending' },
    community_recs: { status: 'pending' },
    matches: { status: 'pending' },
  };

  const createResponse = await fetch(`${supabaseUrl}/rest/v1/daily_recompute_runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      id: runId,
      tenant_id: tenantId,
      user_id: userId,
      run_date: runDate,
      status: 'in_progress',
      stage_status: initialStageStatus,
      current_stage: 'longevity',
      started_at: now,
    }),
  });

  if (!createResponse.ok) {
    // Might be a conflict - try to get again
    const errorText = await createResponse.text();
    if (createResponse.status === 409) {
      // Conflict - run was created by another process
      return getOrCreateRun(supabaseUrl, supabaseKey, tenantId, userId, runDate);
    }
    return { run: null, isNew: false, error: `Failed to create run: ${errorText}` };
  }

  const created = (await createResponse.json()) as DailyRecomputeRun[];
  return { run: created[0], isNew: true };
}

/**
 * Update run record with stage status
 */
async function updateRunStatus(
  supabaseUrl: string,
  supabaseKey: string,
  runId: string,
  updates: Partial<DailyRecomputeRun>
): Promise<boolean> {
  const response = await fetch(`${supabaseUrl}/rest/v1/daily_recompute_runs?id=eq.${runId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({
      ...updates,
      updated_at: new Date().toISOString(),
    }),
  });

  return response.ok;
}

/**
 * Execute a single stage via RPC
 */
async function executeStage(
  supabaseUrl: string,
  supabaseKey: string,
  stage: PipelineStage,
  userId: string,
  runDate: string
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; duration_ms: number }> {
  const startTime = Date.now();

  const rpcNames: Record<PipelineStage, string> = {
    longevity: 'scheduler_longevity_compute_daily',
    topics: 'scheduler_topics_recompute_user_profile',
    community_recs: 'scheduler_community_recompute_recommendations',
    matches: 'scheduler_match_recompute_daily',
  };

  const rpcName = rpcNames[stage];

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_date: runDate,
      }),
    });

    const duration_ms = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `RPC ${rpcName} failed: ${errorText}`, duration_ms };
    }

    const result = (await response.json()) as Record<string, unknown>;

    if (!result.ok) {
      return { ok: false, error: (result.error as string) || 'Stage returned failure', result, duration_ms };
    }

    return { ok: true, result, duration_ms };
  } catch (err) {
    const duration_ms = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: errorMessage, duration_ms };
  }
}

/**
 * Execute the full pipeline for a single user
 */
async function executePipelineForUser(
  supabaseUrl: string,
  supabaseKey: string,
  tenantId: string,
  userId: string,
  runDate: string
): Promise<{ ok: boolean; run_id: string; error?: string }> {
  // Get or create run record
  const { run, isNew, error: runError } = await getOrCreateRun(supabaseUrl, supabaseKey, tenantId, userId, runDate);

  if (runError || !run) {
    return { ok: false, run_id: '', error: runError || 'Failed to get/create run' };
  }

  // If already completed, skip
  if (run.status === 'completed') {
    console.log(`[${VTID}] Run ${run.id} already completed for user ${userId}, date ${runDate}`);
    return { ok: true, run_id: run.id };
  }

  // Emit started event
  if (isNew) {
    await emitSchedulerEvent('vtid.daily_recompute.started', 'info', `Daily recompute started for user`, {
      run_id: run.id,
      tenant_id: tenantId,
      user_id: userId,
      date: runDate,
    });
  }

  // Execute stages in order
  const stageStatus = { ...run.stage_status };

  for (const stage of PIPELINE_STAGES) {
    // Skip already completed stages
    if (stageStatus[stage]?.status === 'success') {
      console.log(`[${VTID}] Stage ${stage} already completed for run ${run.id}`);
      continue;
    }

    // Update current stage
    await updateRunStatus(supabaseUrl, supabaseKey, run.id, {
      current_stage: stage,
    });

    const stageStartTime = new Date().toISOString();

    // Mark stage as in_progress
    stageStatus[stage] = {
      status: 'in_progress',
      started_at: stageStartTime,
    };

    await updateRunStatus(supabaseUrl, supabaseKey, run.id, {
      stage_status: stageStatus,
    });

    // Execute the stage
    const { ok: stageOk, result, error: stageError, duration_ms } = await executeStage(
      supabaseUrl,
      supabaseKey,
      stage,
      userId,
      runDate
    );

    const stageFinishTime = new Date().toISOString();

    if (stageOk) {
      // Stage succeeded
      stageStatus[stage] = {
        status: 'success',
        started_at: stageStartTime,
        finished_at: stageFinishTime,
        duration_ms,
        result,
      };

      await updateRunStatus(supabaseUrl, supabaseKey, run.id, {
        stage_status: stageStatus,
      });

      // Emit stage success event
      const eventType = `vtid.stage.${stage}.success` as CicdEventType;
      await emitSchedulerEvent(eventType, 'success', `Stage ${stage} completed successfully`, {
        run_id: run.id,
        tenant_id: tenantId,
        user_id: userId,
        date: runDate,
        stage,
        duration_ms,
        result,
      });

      console.log(`[${VTID}] Stage ${stage} succeeded for run ${run.id} (${duration_ms}ms)`);
    } else {
      // Stage failed - stop pipeline
      stageStatus[stage] = {
        status: 'failed',
        started_at: stageStartTime,
        finished_at: stageFinishTime,
        duration_ms,
        error: stageError,
      };

      await updateRunStatus(supabaseUrl, supabaseKey, run.id, {
        status: 'failed',
        stage_status: stageStatus,
        error_stage: stage,
        error_message: stageError,
        finished_at: stageFinishTime,
      });

      // Emit stage failed event
      const stageEventType = `vtid.stage.${stage}.failed` as CicdEventType;
      await emitSchedulerEvent(stageEventType, 'error', `Stage ${stage} failed: ${stageError}`, {
        run_id: run.id,
        tenant_id: tenantId,
        user_id: userId,
        date: runDate,
        stage,
        duration_ms,
        error: stageError,
      });

      // Emit terminal failure event
      await emitSchedulerEvent('vtid.daily_recompute.failed', 'error', `Daily recompute failed at stage ${stage}`, {
        run_id: run.id,
        tenant_id: tenantId,
        user_id: userId,
        date: runDate,
        failed_stage: stage,
        error: stageError,
        is_terminal: true,
      });

      console.error(`[${VTID}] Stage ${stage} failed for run ${run.id}: ${stageError}`);
      return { ok: false, run_id: run.id, error: `Stage ${stage} failed: ${stageError}` };
    }
  }

  // All stages completed - mark run as completed
  const finishTime = new Date().toISOString();

  await updateRunStatus(supabaseUrl, supabaseKey, run.id, {
    status: 'completed',
    finished_at: finishTime,
  });

  // Emit terminal completion event (NON-NEGOTIABLE)
  await emitSchedulerEvent('vtid.daily_recompute.completed', 'success', `Daily recompute completed successfully`, {
    run_id: run.id,
    tenant_id: tenantId,
    user_id: userId,
    date: runDate,
    is_terminal: true,
    total_duration_ms: Date.now() - new Date(run.started_at).getTime(),
    stage_durations: Object.fromEntries(
      PIPELINE_STAGES.map((s) => [s, stageStatus[s]?.duration_ms || 0])
    ),
  });

  console.log(`[${VTID}] Pipeline completed for run ${run.id}`);
  return { ok: true, run_id: run.id };
}

/**
 * Process a batch of users for daily recompute
 */
export async function processDailyRecomputeBatch(
  request: RecomputeBatchRequest
): Promise<RecomputeBatchResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error(`[${VTID}] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE`);
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      failed: 0,
      next_cursor: null,
      run_ids: [],
      errors: [{ user_id: '', error: 'Gateway misconfigured: missing Supabase credentials' }],
    };
  }

  const { tenant_id, date, limit_users = 200, cursor } = request;
  const limit = Math.min(limit_users, 200); // Cap at 200

  console.log(`[${VTID}] Processing batch: tenant=${tenant_id}, date=${date}, limit=${limit}, cursor=${cursor || 'null'}`);

  // Get batch of users
  const usersResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/scheduler_get_users_batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({
      p_tenant_id: tenant_id,
      p_date: date,
      p_limit: limit,
      p_cursor: cursor || null,
    }),
  });

  if (!usersResponse.ok) {
    const errorText = await usersResponse.text();
    console.error(`[${VTID}] Failed to get users batch: ${errorText}`);
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      failed: 0,
      next_cursor: null,
      run_ids: [],
      errors: [{ user_id: '', error: `Failed to get users batch: ${errorText}` }],
    };
  }

  const users = (await usersResponse.json()) as Array<{ user_id: string; needs_processing: boolean }>;

  if (users.length === 0) {
    console.log(`[${VTID}] No more users to process`);
    return {
      ok: true,
      processed: 0,
      skipped: 0,
      failed: 0,
      next_cursor: null,
      run_ids: [],
    };
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const runIds: string[] = [];
  const errors: Array<{ user_id: string; error: string }> = [];

  // Process each user
  for (const user of users) {
    if (!user.needs_processing) {
      skipped++;
      continue;
    }

    const result = await executePipelineForUser(supabaseUrl, supabaseKey, tenant_id, user.user_id, date);

    if (result.ok) {
      processed++;
      if (result.run_id) {
        runIds.push(result.run_id);
      }
    } else {
      failed++;
      errors.push({ user_id: user.user_id, error: result.error || 'Unknown error' });
      if (result.run_id) {
        runIds.push(result.run_id);
      }
    }
  }

  // Determine next cursor
  const nextCursor = users.length === limit ? users[users.length - 1].user_id : null;

  console.log(
    `[${VTID}] Batch complete: processed=${processed}, skipped=${skipped}, failed=${failed}, next_cursor=${nextCursor || 'null'}`
  );

  return {
    ok: failed === 0,
    processed,
    skipped,
    failed,
    next_cursor: nextCursor,
    run_ids: runIds,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Get status of daily recompute for a tenant+date
 */
export async function getDailyRecomputeStatus(
  tenantId: string,
  date: string
): Promise<RecomputeStatusResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      date,
      tenant_id: tenantId,
      total_users: 0,
      completed: 0,
      in_progress: 0,
      failed: 0,
    };
  }

  // Get counts by status
  const response = await fetch(
    `${supabaseUrl}/rest/v1/daily_recompute_runs?tenant_id=eq.${tenantId}&run_date=eq.${date}&select=status`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      date,
      tenant_id: tenantId,
      total_users: 0,
      completed: 0,
      in_progress: 0,
      failed: 0,
    };
  }

  const runs = (await response.json()) as Array<{ status: string }>;

  const completed = runs.filter((r) => r.status === 'completed').length;
  const in_progress = runs.filter((r) => r.status === 'in_progress').length;
  const failed = runs.filter((r) => r.status === 'failed').length;

  // Get last cursor (most recent user_id that was processed)
  const lastRunResponse = await fetch(
    `${supabaseUrl}/rest/v1/daily_recompute_runs?tenant_id=eq.${tenantId}&run_date=eq.${date}&order=user_id.desc&limit=1&select=user_id`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    }
  );

  let lastCursor: string | undefined;
  if (lastRunResponse.ok) {
    const lastRuns = (await lastRunResponse.json()) as Array<{ user_id: string }>;
    if (lastRuns.length > 0) {
      lastCursor = lastRuns[0].user_id;
    }
  }

  return {
    ok: true,
    date,
    tenant_id: tenantId,
    total_users: runs.length,
    completed,
    in_progress,
    failed,
    last_cursor: lastCursor,
  };
}
