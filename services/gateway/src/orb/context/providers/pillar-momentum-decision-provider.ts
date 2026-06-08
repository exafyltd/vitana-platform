/**
 * VTID-02955 (B5) — PillarMomentum → AssistantDecisionContext adapter.
 *
 * The B5 read-only compile slice produced `PillarMomentumContext`,
 * a richer shape designed for the Command Hub operator. The assistant
 * decision layer reads a NARROWER shape (`DecisionPillarMomentum`)
 * that strips:
 *   - raw pillar scores (0..200 per pillar)
 *   - raw history dates / timestamps
 *   - raw trend arrays
 *   - raw window-coverage integers
 *
 * Kept: stable pillar enums, per-pillar momentum band (already
 * decision-grade), coarse confidence, and enum-only warnings.
 *
 * NEVER carries medical interpretation, diagnoses, or treatment
 * advice. Pillars are coaching axes, not clinical categories.
 *
 * Pure function. No IO. The caller is responsible for invoking the
 * pillar-momentum compiler + passing its output here.
 */

import type { PillarMomentumContext } from '../../../services/pillar-momentum/types';
import type {
  DecisionPillarMomentum,
  PillarMomentumWarning,
} from '../types';

export interface DistillPillarMomentumInputs {
  /**
   * Output of `compilePillarMomentumContext` from B5. Read-only.
   */
  pillarMomentum: PillarMomentumContext;
}

/**
 * Distills `PillarMomentumContext` into the decision-grade
 * `DecisionPillarMomentum`.
 *
 * Always returns a typed shape (never undefined). The caller decides
 * whether to attach it to `AssistantDecisionContext.pillar_momentum`
 * or set the field to `null` based on source health.
 */
export function distillPillarMomentumForDecision(
  input: DistillPillarMomentumInputs,
): DecisionPillarMomentum {
  const { pillarMomentum } = input;

  // Per-pillar: keep only the pillar enum + momentum band.
  // DROP latest_score and recent_window_days — those are raw
  // operator-view fields and have no place in the prompt.
  const per_pillar = pillarMomentum.per_pillar.map((entry) => ({
    pillar: entry.pillar,
    momentum: entry.momentum,
  }));

  const warnings = computeDecisionWarnings(pillarMomentum);

  return {
    per_pillar,
    weakest_pillar: pillarMomentum.weakest_pillar,
    strongest_pillar: pillarMomentum.strongest_pillar,
    suggested_focus: pillarMomentum.suggested_focus,
    confidence: pillarMomentum.confidence,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Computes the enum-only warning list. NEVER free-text strings,
 * NEVER medical interpretation, NEVER diagnoses.
 */
export function computeDecisionWarnings(
  ctx: PillarMomentumContext,
): ReadonlyArray<PillarMomentumWarning> {
  const out: PillarMomentumWarning[] = [];

  if (ctx.confidence === 'low') {
    out.push('low_pillar_confidence');
  }

  // 'no_recent_pillar_data' when EVERY pillar resolved to 'unknown'
  // momentum — i.e., insufficient observations in the windows.
  const allUnknown = ctx.per_pillar.length > 0
    ? ctx.per_pillar.every((p) => p.momentum === 'unknown')
    : true;
  if (allUnknown) {
    out.push('no_recent_pillar_data');
  }

  return out;
}
