/**
 * Voice Auto-Rollback (VTID-01961, PR #4)
 *
 * v1: telemetry-only. When the synthetic probe (runVoiceProbe) reports
 * ok=false after a self-healing fix attempt, this module emits
 * `voice.healing.rollback.triggered` with the failure_mode_code, prior
 * Cloud Run revision, and the spec_hash that produced the bad fix. Ops
 * sees the high-priority OASIS event in Voice Lab and Gchat alerts and
 * makes the rollback call manually.
 *
 * The Spec Memory Gate (PR #3) is the actual loop-stopper: a probe_failed
 * row in voice_healing_spec_memory blocks re-dispatch of the same spec
 * for 72h. So even without auto-execute, the loop converges.
 *
 * v2 (post-canary): wire to a dedicated rollback workflow (likely a new
 * `.github/workflows/EXEC-ROLLBACK.yml` or a `target_revision` input to
 * EXEC-DEPLOY) so rollback runs without human in the loop.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import { emitOasisEvent } from './oasis-event-service';
import type { ProbeResult } from './voice-synthetic-probe';

const GATEWAY_REVISION =
  process.env.K_REVISION || process.env.BUILD_INFO || 'unknown';

export interface RollbackContext {
  vtid: string;
  voice_class: string;
  normalized_signature: string;
  spec_hash?: string;
  probe_result: ProbeResult;
  /** Cloud Run revision the failing fix deployed. */
  current_revision?: string;
  /** Cloud Run revision to roll back to (queried out-of-band by ops). */
  prior_revision?: string;
  session_id?: string;
}

export interface RollbackTriggerResult {
  emitted: boolean;
  recommendation: 'manual_rollback' | 'no_op';
  detail: string;
}

/**
 * Emit voice.healing.rollback.triggered. This is telemetry-only in v1 —
 * it does NOT call gcloud or dispatch a workflow. Ops sees the event and
 * makes the rollback decision.
 */
export async function triggerRollbackRecommendation(
  ctx: RollbackContext,
): Promise<RollbackTriggerResult> {
  // If the probe didn't actually fail (defensive), do nothing.
  if (ctx.probe_result.ok) {
    return {
      emitted: false,
      recommendation: 'no_op',
      detail: 'probe_passed_no_rollback_needed',
    };
  }

  try {
    await emitOasisEvent({
      vtid: ctx.vtid,
      type: 'voice.healing.rollback.triggered',
      source: 'voice-auto-rollback',
      status: 'error',
      message: `Voice probe FAILED after fix attempt for ${ctx.voice_class} (${ctx.probe_result.failure_mode_code}). Manual rollback recommended.`,
      payload: {
        voice_class: ctx.voice_class,
        normalized_signature: ctx.normalized_signature,
        spec_hash: ctx.spec_hash,
        failure_mode_code: ctx.probe_result.failure_mode_code,
        probe_duration_ms: ctx.probe_result.duration_ms,
        probe_evidence: ctx.probe_result.evidence,
        current_revision: ctx.current_revision || GATEWAY_REVISION,
        prior_revision: ctx.prior_revision,
        session_id: ctx.session_id,
        recommendation: 'manual_rollback',
        rollback_command: ctx.prior_revision
          ? `gcloud run services update-traffic gateway --to-revisions=${ctx.prior_revision}=100 --region=us-central1 --project=lovable-vitana-vers1`
          : 'gcloud run revisions list --service=gateway --region=us-central1 --project=lovable-vitana-vers1 --limit=5',
      },
    });
    return {
      emitted: true,
      recommendation: 'manual_rollback',
      detail: `failure_mode=${ctx.probe_result.failure_mode_code}`,
    };
  } catch (err: any) {
    return {
      emitted: false,
      recommendation: 'manual_rollback',
      detail: `emit_failed: ${err?.message ?? 'unknown'}`,
    };
  }
}
