/**
 * VTID-03058 (B0d-real slice Xc) — Life-compass-alignment NextActionSource.
 *
 * Reads the user's active `life_compass` row (primary_goal + category)
 * AND the compiled pillar_momentum from decisionContext. When the user
 * has BOTH (a) an active Life Compass goal and (b) at least one
 * slipping pillar that's coachable, this source produces a
 * goal-anchored next-action.
 *
 * The line is structured as: "Anchor on <goal>. <pillar> is slipping —
 * one small step today?" The Life Compass becomes the WHY; the pillar
 * becomes the WHAT. This is the alignment the user explicitly asked
 * for in B0d-real acceptance #4 ("Life Compass + weak pillar suggest
 * a next action, it can win").
 *
 * Priority bands (Life Compass present + slipping pillar):
 *   - high confidence on pillar      → 80
 *   - medium confidence on pillar    → 70
 *   - life compass present, no slip  → skipped (no_eligible_record)
 *   - no life compass                → skipped (no_eligible_record)
 *
 * Below reminders/calendar/autopilot bands so an imminent reminder
 * wins, but above CROSS_SOURCE_THRESHOLD=50 so the alignment fires
 * when nothing more urgent is on deck.
 *
 * Reads decisionContext.pillar_momentum (already compiled in the
 * gateway's bootstrap path); does NOT re-query pillar data.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';
import type {
  DecisionPillarMomentum,
  PillarKey,
} from '../../../../../orb/context/types';

const KEY = 'life_compass_alignment' as const;

export function makeLifeCompassAlignmentSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceLifeCompassAlignment,
  };
}

export async function produceLifeCompassAlignment(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  // Step 1: read the active Life Compass row.
  let compass: LifeCompassLike | null = null;
  try {
    const { data, error } = await ctx.supabase
      .from('life_compass')
      .select('id, primary_goal, category, is_active, created_at')
      .eq('user_id', ctx.userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // Missing-table is a separate skip; everything else is unavailable.
      if (/relation .* does not exist/i.test(error.message)) {
        return {
          source: KEY,
          candidate: null,
          skippedReason: 'feature_disabled',
        };
      }
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    compass = (data as LifeCompassLike | null) ?? null;
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (!compass || !compass.primary_goal || !compass.primary_goal.trim()) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  // Step 2: read pillar_momentum from the decision context. No re-query.
  const pm = extractPillarMomentum(ctx.decisionContext);
  if (!pm) {
    return { source: KEY, candidate: null, skippedReason: 'no_data' };
  }
  if (pm.confidence === 'low') {
    return { source: KEY, candidate: null, skippedReason: 'low_confidence' };
  }
  if (!pm.suggested_focus) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }
  const slipRow = pm.per_pillar.find((p) => p.pillar === pm.suggested_focus);
  if (!slipRow || (slipRow.momentum !== 'slipping' && slipRow.momentum !== 'unknown')) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const priority = pm.confidence === 'high' ? 80 : 70;
  const focus = pm.suggested_focus;
  const goal = compass.primary_goal.trim();
  const userFacingLine = renderLine(goal, focus, ctx.lang);

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence: pm.confidence,
    userFacingLine,
    reasons: [
      {
        kind: 'life_compass_anchor',
        detail: `goal="${goal}" category=${compass.category ?? 'unset'}`,
      },
      {
        kind: 'pillar_slipping_aligned',
        detail: `${focus} (${slipRow.momentum})`,
      },
    ],
    dedupeKey: `life_compass_alignment:${compass.id}:${focus}`,
    cta: {
      type: 'navigate',
      route: '/health',
      payload: { focus_pillar: focus, life_compass_id: compass.id },
    },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

interface LifeCompassLike {
  id: string;
  primary_goal: string | null;
  category: string | null;
  is_active: boolean;
  created_at: string;
}

/**
 * Defensive extraction. The decision context flows in as `unknown`
 * because the framework's ContinuationDecisionContext.extra is opaque.
 * Returns null on any shape mismatch — never throws.
 */
export function extractPillarMomentum(
  decisionContext: unknown,
): DecisionPillarMomentum | null {
  if (!decisionContext || typeof decisionContext !== 'object') return null;
  const pm = (decisionContext as Record<string, unknown>).pillar_momentum;
  if (!pm || typeof pm !== 'object') return null;
  return pm as DecisionPillarMomentum;
}

export function renderLine(
  goal: string,
  focus: PillarKey,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  // Goal text varies per user — quote it verbatim so the user hears
  // THEIR words, not a paraphrase.
  if (isDe) {
    const pillarDe: Record<PillarKey, string> = {
      sleep: 'Schlaf',
      nutrition: 'Ernährung',
      exercise: 'Bewegung',
      hydration: 'Hydration',
      mental: 'Mental',
    };
    return (
      `Dein aktueller Anker ist "${goal}". ` +
      `${pillarDe[focus]} bleibt zurzeit zurück — sollen wir heute einen kleinen Schritt darauf einplanen?`
    );
  }
  return (
    `Your current anchor is "${goal}". ` +
    `${focus} is slipping — want one small step on it today?`
  );
}
