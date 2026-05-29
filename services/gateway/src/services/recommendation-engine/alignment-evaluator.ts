/**
 * Pure evaluator for "does this recommendation declare a mission dimension?"
 *
 * Phase 5 of the Ultimate Goal hardening (docs/GOVERNANCE/ULTIMATE-GOAL.md):
 * extracted so the activation-time alignment-warning logic is unit-testable
 * without standing up HTTP mocks for the Supabase REST call.
 *
 * A rec is "served" if it advances any mission dimension:
 *   - has a primary pillar (derived from contribution_vector), OR
 *   - has a non-'none' economic_axis.
 *
 * "Unclear" recs are the ones we want to flag — the queue is shipping work
 * that doesn't connect to the contract. NOT a hard block; just visibility.
 */

import { derivePillarImpact, type PillarImpact } from './pillar-impact';

export interface AlignmentEvaluationInput {
  contribution_vector?: Record<string, unknown> | null;
  economic_axis?: string | null;
  autonomy_level?: string | null;
}

export interface AlignmentEvaluation {
  pillar_impact: PillarImpact;
  economic_axis: string;
  autonomy_level: string;
  has_pillar: boolean;
  has_economy: boolean;
  aligned: boolean;
  topic: 'autopilot.alignment.served' | 'autopilot.alignment.unclear';
  status: 'info' | 'warning';
  message: string;
}

export function evaluateRecAlignment(rec: AlignmentEvaluationInput): AlignmentEvaluation {
  const pillarImpact = derivePillarImpact(rec.contribution_vector);
  const economicAxis = rec.economic_axis || 'none';
  const autonomyLevel = rec.autonomy_level || 'manual';

  const hasPillar = pillarImpact.primary_pillar !== null;
  const hasEconomy = economicAxis !== 'none';
  const aligned = hasPillar || hasEconomy;

  let message: string;
  if (aligned) {
    const parts: string[] = [];
    if (hasPillar && pillarImpact.primary_pillar) parts.push(pillarImpact.primary_pillar);
    if (hasEconomy) parts.push(economicAxis);
    message = `Activated VTID advances ${parts.join(' + ')}`;
  } else {
    message = 'Activated VTID has no declared mission dimension (pillar_impact=none, economic_axis=none). See docs/GOVERNANCE/ULTIMATE-GOAL.md.';
  }

  return {
    pillar_impact: pillarImpact,
    economic_axis: economicAxis,
    autonomy_level: autonomyLevel,
    has_pillar: hasPillar,
    has_economy: hasEconomy,
    aligned,
    topic: aligned ? 'autopilot.alignment.served' : 'autopilot.alignment.unclear',
    status: aligned ? 'info' : 'warning',
    message,
  };
}
