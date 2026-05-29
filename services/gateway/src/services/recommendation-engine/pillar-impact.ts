/**
 * Pillar impact derivation.
 *
 * Reads the autopilot_recommendations.contribution_vector JSONB (a per-pillar
 * weighting populated by the SQL trigger from source_ref — see
 * supabase/migrations/20260423150000_vitana_index_contribution_vector.sql) and
 * collapses it into a single (primary_pillar, magnitude) pair for surfacing
 * on the wire.
 *
 * This is part of the Ultimate Goal hardening (docs/GOVERNANCE/ULTIMATE-GOAL.md):
 * pillar_impact is the "which of the 5 longevity pillars does this rec improve,
 * and how much" field. It is NOT a new database column — it is derived at read
 * time so the data stays in one place (the JSONB).
 *
 * Magnitude bands (max pillar weight in the vector):
 *   - high   ≥ 0.5
 *   - medium ≥ 0.2
 *   - low    ≥ 0.05
 *   - none   < 0.05 or empty vector
 *
 * Tie-breaking on primary_pillar: PILLAR_KEYS iteration order (stable).
 */

import { PILLAR_KEYS, type PillarKey } from '../../lib/vitana-pillars';

export type PillarMagnitude = 'high' | 'medium' | 'low' | 'none';

export interface PillarImpact {
  primary_pillar: PillarKey | null;
  magnitude: PillarMagnitude;
}

const NONE_IMPACT: PillarImpact = { primary_pillar: null, magnitude: 'none' };

export function derivePillarImpact(
  contribution_vector: Record<string, unknown> | null | undefined,
): PillarImpact {
  if (!contribution_vector || typeof contribution_vector !== 'object') {
    return NONE_IMPACT;
  }

  let best: { pillar: PillarKey; value: number } | null = null;
  for (const pillar of PILLAR_KEYS) {
    const raw = (contribution_vector as Record<string, unknown>)[pillar];
    const value = typeof raw === 'number' ? raw : Number(raw ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!best || value > best.value) {
      best = { pillar, value };
    }
  }

  if (!best) return NONE_IMPACT;

  let magnitude: PillarMagnitude;
  if (best.value >= 0.5) magnitude = 'high';
  else if (best.value >= 0.2) magnitude = 'medium';
  else if (best.value >= 0.05) magnitude = 'low';
  else magnitude = 'none';

  if (magnitude === 'none') {
    return NONE_IMPACT;
  }

  return { primary_pillar: best.pillar, magnitude };
}
