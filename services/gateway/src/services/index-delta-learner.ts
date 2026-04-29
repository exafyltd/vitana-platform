/**
 * VTID-02632 — Phase 8 — Loop 4 — Index-Delta-Learner.
 *
 * Single-purpose: when an autopilot recommendation completes, capture the
 * Vitana Index pillar delta caused by that completion. The nightly
 * consolidator (loop_4) rolls these observations up into the trajectory
 * snapshots used by the journey overlay and the agent-profile digest.
 *
 * The ranker priors update happens off this table — we do not couple the
 * write here to any ranker config write. That keeps the hot path fast and
 * makes the calibration job restartable.
 *
 * Plan reference: .claude/plans/the-vitana-system-has-wild-puffin.md
 *   Loop 4 (Part 3) + index_delta_observations (Phase 8 schema)
 */

import { getSupabase } from '../lib/supabase';
import { getSystemControl } from './system-controls-service';

const VTID = 'VTID-02632';

export interface IndexDeltaInput {
  tenant_id: string;
  user_id: string;
  recommendation_id?: string | null;
  action_kind: 'autopilot_completion' | 'diary_entry' | 'manual_log' | 'biometric_log';
  pillar: 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';
  pillar_score_before?: number | null;
  pillar_score_after?: number | null;
  total_score_before?: number | null;
  total_score_after?: number | null;
  ranker_config_version?: string | null;
  source_engine?: string | null;
  notes?: string | null;
}

/**
 * Fire-and-forget write of an Index delta observation. Never throws —
 * a write failure here must not block the autopilot completion path.
 *
 * Returns `{ ok, written }` so callers can include it in their response
 * envelope without a try/catch wrapper at the call site.
 */
export async function recordIndexDelta(input: IndexDeltaInput): Promise<{ ok: boolean; written: boolean; reason?: string }> {
  // Flag-gated. Default ON, but operators can disable for an emergency.
  try {
    const flag = await getSystemControl('index_delta_learner_enabled');
    if (flag && !flag.enabled) {
      return { ok: true, written: false, reason: 'flag_disabled' };
    }
  } catch {
    // Flag read error -> proceed; the learner is the safer default.
  }

  const supabase = getSupabase();
  if (!supabase) return { ok: true, written: false, reason: 'no_supabase' };

  const before = numOrNull(input.pillar_score_before);
  const after = numOrNull(input.pillar_score_after);
  const totalBefore = numOrNull(input.total_score_before);
  const totalAfter = numOrNull(input.total_score_after);
  const pillarDelta = (before !== null && after !== null) ? (after - before) : null;
  const totalDelta = (totalBefore !== null && totalAfter !== null) ? (totalAfter - totalBefore) : null;

  const { error } = await supabase.from('index_delta_observations').insert({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    recommendation_id: input.recommendation_id ?? null,
    action_kind: input.action_kind,
    pillar: input.pillar,
    pillar_score_before: before,
    pillar_score_after: after,
    pillar_delta: pillarDelta,
    total_score_before: totalBefore,
    total_score_after: totalAfter,
    total_delta: totalDelta,
    ranker_config_version: input.ranker_config_version ?? null,
    source_engine: input.source_engine ?? `${VTID}.index_delta_learner`,
    notes: input.notes ?? null,
  });

  if (error) {
    return { ok: false, written: false, reason: error.message };
  }
  return { ok: true, written: true };
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
