/**
 * Autonomous Self-Improvement Engine - VTID-01185
 *
 * Closes the full autonomous loop:
 * 1. Listens for OASIS events (deploy failures, errors, completions)
 * 2. Generates real-time recommendations from live system signals
 * 3. Auto-activates high-confidence recommendations (creates VTIDs)
 * 4. Feeds completion/failure outcomes back to improve future recommendations
 * 5. Cleans up expired/stale recommendations
 *
 * This is the "brain" that makes the platform self-improving.
 */

import { emitOasisEvent } from '../oasis-event-service';
import { generateRecommendations, SourceType } from './recommendation-generator';

const LOG_PREFIX = '[VTID-01185:Autonomous]';

// =============================================================================
// Types
// =============================================================================

interface AutonomousEngineState {
  initialized: boolean;
  lastCleanupAt?: Date;
  lastFeedbackSyncAt?: Date;
  eventListenerInterval?: NodeJS.Timeout;
  cleanupInterval?: NodeJS.Timeout;
  feedbackInterval?: NodeJS.Timeout;
}

// =============================================================================
// State
// =============================================================================

const state: AutonomousEngineState = {
  initialized: false,
};

// =============================================================================
// Supabase Helper
// =============================================================================

async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function querySupabase<T>(
  table: string,
  query: string
): Promise<{ ok: boolean; data?: T[]; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      return { ok: false, error: `${response.status}` };
    }

    const data = (await response.json()) as T[];
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function patchSupabase(
  table: string,
  filter: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${filter}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });

    return { ok: response.ok, error: response.ok ? undefined : `${response.status}` };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// 1. Real-Time Event Listener
// =============================================================================

/**
 * Poll for recent OASIS events that should trigger immediate recommendations.
 * Runs every 5 minutes — looks for deploy failures, error spikes, stuck tasks.
 */
async function pollForRealtimeSignals(): Promise<void> {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Check for deploy failures in last 5 minutes
    const deployFailures = await querySupabase<{ id: string; vtid: string; message: string }>(
      'oasis_events',
      `topic=in.(deploy.gateway.failed,cicd.deploy.service.failed,deploy.service.failed)&created_at=gte.${fiveMinAgo}&select=id,vtid,message&limit=5`
    );

    if (deployFailures.ok && deployFailures.data && deployFailures.data.length > 0) {
      console.log(`${LOG_PREFIX} Detected ${deployFailures.data.length} deploy failure(s) — triggering OASIS analysis`);

      await generateRecommendations(
        process.env.VITANA_BASE_PATH || '/workspace/vitana-platform',
        {
          sources: ['oasis'],
          limit: 5,
          force: true,
          triggered_by: 'autonomous-engine',
          trigger_type: 'webhook',
        }
      );
    }

    // Check for error spikes (>20 errors in 5 minutes)
    const errorEvents = await querySupabase<{ id: string }>(
      'oasis_events',
      `status=eq.error&created_at=gte.${fiveMinAgo}&select=id&limit=25`
    );

    if (errorEvents.ok && errorEvents.data && errorEvents.data.length >= 20) {
      console.log(`${LOG_PREFIX} Error spike detected (${errorEvents.data.length} errors in 5min) — triggering analysis`);

      await generateRecommendations(
        process.env.VITANA_BASE_PATH || '/workspace/vitana-platform',
        {
          sources: ['oasis', 'health'],
          limit: 5,
          force: true,
          triggered_by: 'autonomous-engine-error-spike',
          trigger_type: 'webhook',
        }
      );
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Real-time signal polling error:`, error);
  }
}

// =============================================================================
// 2. Auto-Activation of High-Confidence Recommendations
// =============================================================================

/**
 * Automatically activate recommendations that meet auto-activation criteria:
 * - impact_score >= 8
 * - effort_score <= 4 (low effort)
 * - risk_level = 'low'
 * - status = 'new' and older than 24 hours (give humans time to review first)
 */
async function autoActivateHighConfidence(): Promise<void> {
  try {
    const autoActivateEnabled = process.env.AUTO_ACTIVATE_RECOMMENDATIONS === 'true';
    if (!autoActivateEnabled) return;

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Find recommendations eligible for auto-activation
    const candidates = await querySupabase<{ id: string; title: string; impact_score: number }>(
      'autopilot_recommendations',
      `status=eq.new&impact_score=gte.8&effort_score=lte.4&risk_level=eq.low&created_at=lte.${oneDayAgo}&select=id,title,impact_score&limit=3`
    );

    if (!candidates.ok || !candidates.data || candidates.data.length === 0) return;

    console.log(`${LOG_PREFIX} Found ${candidates.data.length} recommendation(s) eligible for auto-activation`);

    for (const candidate of candidates.data) {
      const result = await callRpc<{ ok: boolean; vtid?: string }>('activate_autopilot_recommendation', {
        p_recommendation_id: candidate.id,
        p_user_id: null,
      });

      if (result.ok && result.data?.ok) {
        console.log(`${LOG_PREFIX} Auto-activated: "${candidate.title}" -> ${result.data.vtid}`);

        await emitOasisEvent({
          vtid: result.data.vtid || 'SYSTEM',
          type: 'autopilot.recommendation.auto_activated' as any,
          source: 'autonomous-engine',
          status: 'info',
          message: `Auto-activated recommendation: ${candidate.title}`,
          payload: {
            recommendation_id: candidate.id,
            vtid: result.data.vtid,
            impact_score: candidate.impact_score,
            reason: 'high_impact_low_effort_low_risk',
          },
        });
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Auto-activation error:`, error);
  }
}

// =============================================================================
// 3. Feedback Loop: Completed/Failed VTIDs Update Recommendations
// =============================================================================

/**
 * Sync VTID terminal outcomes back to their source recommendations.
 * When a VTID created from a recommendation completes or fails,
 * update the recommendation status accordingly.
 */
async function syncFeedbackLoop(): Promise<void> {
  try {
    // Find activated recommendations whose VTIDs have reached terminal state
    const activatedRecs = await querySupabase<{
      id: string;
      activated_vtid: string;
      title: string;
    }>(
      'autopilot_recommendations',
      'status=eq.activated&activated_vtid=not.is.null&select=id,activated_vtid,title&limit=50'
    );

    if (!activatedRecs.ok || !activatedRecs.data || activatedRecs.data.length === 0) return;

    for (const rec of activatedRecs.data) {
      // Check if the VTID has reached terminal state
      const vtidStatus = await querySupabase<{
        vtid: string;
        status: string;
        is_terminal: boolean;
        terminal_outcome: string;
      }>(
        'vtid_ledger',
        `vtid=eq.${encodeURIComponent(rec.activated_vtid)}&select=vtid,status,is_terminal,terminal_outcome&limit=1`
      );

      if (!vtidStatus.ok || !vtidStatus.data || vtidStatus.data.length === 0) continue;

      const vtid = vtidStatus.data[0];
      if (!vtid.is_terminal) continue;

      const outcome = vtid.terminal_outcome || vtid.status;

      if (outcome === 'completed' || outcome === 'success') {
        // Success: mark recommendation as completed (new status we'll add)
        await patchSupabase(
          'autopilot_recommendations',
          `id=eq.${rec.id}`,
          { status: 'rejected', updated_at: new Date().toISOString() } // reuse 'rejected' as 'resolved'
        );

        console.log(`${LOG_PREFIX} Feedback: "${rec.title}" completed via ${rec.activated_vtid}`);

        await emitOasisEvent({
          vtid: rec.activated_vtid,
          type: 'autopilot.recommendation.completed' as any,
          source: 'autonomous-engine',
          status: 'success',
          message: `Recommendation completed: ${rec.title}`,
          payload: { recommendation_id: rec.id, vtid: rec.activated_vtid, outcome },
        });
      } else if (outcome === 'failed' || outcome === 'cancelled') {
        // Failure: create a follow-up "investigate failure" recommendation
        console.log(`${LOG_PREFIX} Feedback: "${rec.title}" failed via ${rec.activated_vtid} — generating follow-up`);

        await emitOasisEvent({
          vtid: rec.activated_vtid,
          type: 'autopilot.recommendation.failed' as any,
          source: 'autonomous-engine',
          status: 'warning',
          message: `Recommendation failed: ${rec.title} — follow-up needed`,
          payload: { recommendation_id: rec.id, vtid: rec.activated_vtid, outcome },
        });

        // Generate a follow-up recommendation for the failure
        await callRpc('insert_autopilot_recommendation', {
          p_title: `Investigate failure: ${rec.title}`,
          p_summary: `VTID ${rec.activated_vtid} failed with outcome "${outcome}". Original recommendation: ${rec.title}. Investigate root cause and retry or adjust approach.`,
          p_domain: 'dev',
          p_risk_level: 'medium',
          p_impact_score: 7,
          p_effort_score: 4,
          p_source_type: 'oasis',
          p_source_ref: `vtid:${rec.activated_vtid}:failure`,
          p_fingerprint: `feedback:failure:${rec.activated_vtid}`,
          p_run_id: `feedback-${Date.now()}`,
          p_suggested_files: [],
          p_suggested_endpoints: [],
          p_suggested_tests: [],
          p_expires_days: 14,
        });

        // Mark original as rejected (resolved via feedback)
        await patchSupabase(
          'autopilot_recommendations',
          `id=eq.${rec.id}`,
          { status: 'rejected', updated_at: new Date().toISOString() }
        );
      }
    }

    state.lastFeedbackSyncAt = new Date();
  } catch (error) {
    console.error(`${LOG_PREFIX} Feedback loop error:`, error);
  }
}

// =============================================================================
// 4. Expired Recommendation Cleanup
// =============================================================================

/**
 * Clean up stale and expired recommendations:
 * - Expire recommendations older than their expires_at date
 * - Unsnoze recommendations past their snoozed_until date
 * - Mark seed recommendations without fingerprints as rejected (stale seeds)
 */
async function cleanupExpiredRecommendations(): Promise<void> {
  try {
    const now = new Date().toISOString();

    // 1. Mark expired recommendations
    await patchSupabase(
      'autopilot_recommendations',
      `status=eq.new&expires_at=lt.${now}&expires_at=not.is.null`,
      { status: 'rejected', updated_at: now }
    );

    // 2. Unsnoze past-due snoozed recommendations
    await patchSupabase(
      'autopilot_recommendations',
      `status=eq.snoozed&snoozed_until=lt.${now}`,
      { status: 'new', snoozed_until: null, updated_at: now }
    );

    // 3. Purge stale seed data: recommendations without a fingerprint or source_type
    //    that have been sitting in 'new' for >30 days (the original 10 seeds)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await patchSupabase(
      'autopilot_recommendations',
      `status=eq.new&fingerprint=is.null&created_at=lt.${thirtyDaysAgo}`,
      { status: 'rejected', updated_at: now }
    );

    // Also try the RPC cleanup if it exists
    try {
      await callRpc('cleanup_expired_autopilot_recommendations', {});
    } catch {
      // RPC may not exist yet, that's fine
    }

    state.lastCleanupAt = new Date();
    console.log(`${LOG_PREFIX} Cleanup completed at ${now}`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Cleanup error:`, error);
  }
}

// =============================================================================
// 5. Event-Driven Recommendation on VTID Completion
// =============================================================================

/**
 * After any VTID completes, analyze what changed and suggest follow-ups.
 * This creates a self-reinforcing improvement cycle.
 */
async function checkRecentCompletions(): Promise<void> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Find recently completed VTIDs
    const completions = await querySupabase<{ vtid: string; title: string }>(
      'oasis_events',
      `topic=in.(vtid.terminalize.success,vtid.lifecycle.completed)&created_at=gte.${oneHourAgo}&select=vtid,message&limit=10`
    );

    if (!completions.ok || !completions.data || completions.data.length === 0) return;

    // Trigger an OASIS analysis to find new issues that may have been introduced
    // or follow-up improvements from the completed work
    if (completions.data.length >= 2) {
      console.log(`${LOG_PREFIX} ${completions.data.length} recent completions — triggering follow-up analysis`);

      await generateRecommendations(
        process.env.VITANA_BASE_PATH || '/workspace/vitana-platform',
        {
          sources: ['oasis', 'roadmap'],
          limit: 5,
          force: false,
          triggered_by: 'autonomous-engine-completion',
          trigger_type: 'webhook',
        }
      );
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Completion check error:`, error);
  }
}

// =============================================================================
// Engine Lifecycle
// =============================================================================

/**
 * Initialize the autonomous self-improvement engine.
 * Sets up periodic tasks for:
 * - Real-time signal polling (every 5 minutes)
 * - Feedback loop sync (every 10 minutes)
 * - Cleanup (every 6 hours)
 * - Auto-activation check (every 30 minutes)
 * - Completion follow-up (every 15 minutes)
 */
export async function initializeAutonomousEngine(): Promise<void> {
  if (state.initialized) {
    console.log(`${LOG_PREFIX} Already initialized`);
    return;
  }

  console.log(`${LOG_PREFIX} Initializing autonomous self-improvement engine...`);

  // Run initial cleanup on startup
  await cleanupExpiredRecommendations();

  // Real-time signal polling: every 5 minutes
  state.eventListenerInterval = setInterval(async () => {
    await pollForRealtimeSignals();
    await checkRecentCompletions();
    await autoActivateHighConfidence();
  }, 5 * 60 * 1000);

  // Feedback loop: every 10 minutes
  state.feedbackInterval = setInterval(async () => {
    await syncFeedbackLoop();
  }, 10 * 60 * 1000);

  // Cleanup: every 6 hours
  state.cleanupInterval = setInterval(async () => {
    await cleanupExpiredRecommendations();
  }, 6 * 60 * 60 * 1000);

  state.initialized = true;

  await emitOasisEvent({
    vtid: 'VTID-01185',
    type: 'autopilot.autonomous.engine.started' as any,
    source: 'autonomous-engine',
    status: 'info',
    message: 'Autonomous self-improvement engine started',
    payload: {
      intervals: {
        realtime_polling_ms: 5 * 60 * 1000,
        feedback_sync_ms: 10 * 60 * 1000,
        cleanup_ms: 6 * 60 * 60 * 1000,
      },
      auto_activate_enabled: process.env.AUTO_ACTIVATE_RECOMMENDATIONS === 'true',
    },
  });

  console.log(`${LOG_PREFIX} Engine started successfully`);
}

/**
 * Stop the autonomous engine (graceful shutdown)
 */
export function stopAutonomousEngine(): void {
  if (state.eventListenerInterval) {
    clearInterval(state.eventListenerInterval);
    state.eventListenerInterval = undefined;
  }
  if (state.cleanupInterval) {
    clearInterval(state.cleanupInterval);
    state.cleanupInterval = undefined;
  }
  if (state.feedbackInterval) {
    clearInterval(state.feedbackInterval);
    state.feedbackInterval = undefined;
  }
  state.initialized = false;
  console.log(`${LOG_PREFIX} Engine stopped`);
}

/**
 * Get engine status for health checks
 */
export function getAutonomousEngineStatus(): {
  initialized: boolean;
  lastCleanupAt?: string;
  lastFeedbackSyncAt?: string;
  autoActivateEnabled: boolean;
} {
  return {
    initialized: state.initialized,
    lastCleanupAt: state.lastCleanupAt?.toISOString(),
    lastFeedbackSyncAt: state.lastFeedbackSyncAt?.toISOString(),
    autoActivateEnabled: process.env.AUTO_ACTIVATE_RECOMMENDATIONS === 'true',
  };
}
