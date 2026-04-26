/**
 * VTID-01973: Life Compass alignment helper (P2-A).
 *
 * Reads the existing life_compass table (G3 of vitana_autopilot_index_compass_loop)
 * and the new intent_compass_boost mapping. Used by:
 *   - The matcher: to flip compass_aligned=true on intent_matches rows.
 *   - The notifier: to prioritise surfacing of aligned matches.
 *   - The proactive prompt branch in orb-live.ts (P2-B): to phrase the
 *     prompt in a compass-aware way ("This fits your longevity focus...").
 */

import { createClient } from '@supabase/supabase-js';
import type { IntentKind } from './intent-classifier';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

export interface CompassGoal {
  user_id: string;
  category: string | null;       // e.g. 'longevity', 'earn_money', 'life_partner'
  primary_goal: string | null;   // user-friendly text
  alignment_score: number;
  confidence_score: number;
}

// In-process cache: 5-min TTL, keyed by user_id. Goals don't change often.
const COMPASS_TTL_MS = 5 * 60 * 1000;
const compassCache = new Map<string, { goal: CompassGoal | null; expires_at: number }>();

export async function getActiveCompassGoal(userId: string): Promise<CompassGoal | null> {
  if (!userId) return null;

  const cached = compassCache.get(userId);
  if (cached && cached.expires_at > Date.now()) return cached.goal;

  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('life_compass')
      .select('user_id, category, primary_goal, alignment_score, confidence_score')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    const goal = (data as CompassGoal | null) ?? null;
    compassCache.set(userId, { goal, expires_at: Date.now() + COMPASS_TTL_MS });
    return goal;
  } catch (err: any) {
    console.warn(`[VTID-01973] getActiveCompassGoal failed: ${err.message}`);
    return null;
  }
}

/**
 * Given a kind_pairing and both parties' active compass categories, return
 * the boost weight for this match. Null/0 means no alignment boost.
 *
 * Reads intent_compass_boost (seeded in migration 7/9). Both sides must
 * have an aligned compass for the bonus to apply.
 */
export async function compassAlignmentBonus(
  kindPairing: string,
  dictatorCategory: string | null,
  counterpartyCategory: string | null,
): Promise<number> {
  if (!dictatorCategory || !counterpartyCategory) return 0;
  // The boost is per (compass_category, intent_kind). For pairings, we
  // check whether EITHER party's compass aligns with the OTHER party's
  // intent_kind. Conservative: require both sides aligned.
  const [kindA, kindB] = kindPairing.split('::') as [IntentKind, IntentKind];
  if (!kindA || !kindB) return 0;

  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('intent_compass_boost')
      .select('compass_category, intent_kind, boost_weight')
      .in('compass_category', [dictatorCategory, counterpartyCategory])
      .in('intent_kind', [kindA, kindB]);

    if (!data || (data as any[]).length === 0) return 0;

    // Both sides must have at least one boost row covering them.
    const aBoost = (data as any[]).find(
      (r) => r.compass_category === dictatorCategory && r.intent_kind === kindA,
    );
    const bBoost = (data as any[]).find(
      (r) => r.compass_category === counterpartyCategory && r.intent_kind === kindB,
    );
    if (!aBoost || !bBoost) return 0;

    // Use the smaller of the two boosts so neither side dominates.
    return Math.min(Number(aBoost.boost_weight) || 0, Number(bBoost.boost_weight) || 0);
  } catch (err: any) {
    console.warn(`[VTID-01973] compassAlignmentBonus failed: ${err.message}`);
    return 0;
  }
}

export function invalidateCompassCache(userId: string): void {
  compassCache.delete(userId);
}
