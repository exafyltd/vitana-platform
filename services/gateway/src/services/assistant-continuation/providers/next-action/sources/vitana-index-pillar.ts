/**
 * VTID-03059 (B0d-real slice Xd) — Vitana-Index-Pillar NextActionSource.
 *
 * The "Pillar momentum is ONE candidate, not the whole system" source.
 * B0d-mini (voice-wake-brief renderer) hardcoded a per-pillar line as
 * the only proactive surface. This file lifts the same signal — pillar
 * momentum from decisionContext — into a proper NextActionSource so it
 * competes with reminders, calendar, autopilot, and Life Compass on
 * equal footing.
 *
 * Trigger: pillar_momentum present + confidence medium/high +
 * suggested_focus has 'slipping' or 'unknown' momentum.
 *
 * Priority bands (intentionally lower than life-compass-alignment so
 * the goal-anchored variant wins when both qualify):
 *   high confidence    → 68
 *   medium confidence  → 58
 *
 * Both are above CROSS_SOURCE_THRESHOLD=50; below reminders/calendar/
 * autopilot urgency bands so any time-sensitive item wins.
 *
 * Hard scope: this source produces a candidate ABOVE the threshold but
 * BELOW most other sources. It only wins when nothing else has a real
 * signal. That's the central correction from B0d-mini — pillar momentum
 * alone is the WEAKEST proactive lever; the user's spec was explicit.
 *
 * Reads decisionContext.pillar_momentum only — no DB queries (the
 * compiler already ran).
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

const KEY = 'vitana_index_pillar' as const;

export function makeVitanaIndexPillarSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceVitanaIndexPillar,
  };
}

export async function produceVitanaIndexPillar(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
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

  const focus = pm.suggested_focus;
  const priority = pm.confidence === 'high' ? 68 : 58;
  const userFacingLine = renderLine(focus, ctx.lang);

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence: pm.confidence,
    userFacingLine,
    reasons: [
      {
        kind: 'pillar_momentum_slipping',
        detail: `${focus} (${slipRow.momentum}, confidence=${pm.confidence})`,
      },
    ],
    dedupeKey: `vitana_index_pillar:${focus}`,
    cta: {
      type: 'navigate',
      route: '/health',
      payload: { focus_pillar: focus },
    },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export function extractPillarMomentum(
  decisionContext: unknown,
): DecisionPillarMomentum | null {
  if (!decisionContext || typeof decisionContext !== 'object') return null;
  const pm = (decisionContext as Record<string, unknown>).pillar_momentum;
  if (!pm || typeof pm !== 'object') return null;
  return pm as DecisionPillarMomentum;
}

const LINES: Record<PillarKey, Record<string, string>> = {
  sleep: {
    en: 'Your sleep pillar has been slipping lately. Want to look at what is getting in the way?',
    de: 'Deine Schlaf-Säule sackt in letzter Zeit etwas ab. Wollen wir uns anschauen, was da hineinspielt?',
  },
  nutrition: {
    en: 'Your nutrition pillar has been slipping lately. Want help getting it back on track?',
    de: 'Deine Ernährungs-Säule sackt in letzter Zeit etwas ab. Sollen wir das gemeinsam wieder aufbauen?',
  },
  exercise: {
    en: 'Your exercise pillar has been slipping lately. Want to set up something light for today?',
    de: 'Deine Bewegungs-Säule sackt in letzter Zeit etwas ab. Sollen wir heute etwas Leichtes einplanen?',
  },
  hydration: {
    en: 'Your hydration pillar has been slipping lately. Want a small step to lift it back up?',
    de: 'Deine Hydrations-Säule sackt in letzter Zeit etwas ab. Wollen wir einen kleinen Schritt einbauen?',
  },
  mental: {
    en: 'Your mental pillar has been slipping lately. What is weighing on you right now?',
    de: 'Deine Mental-Säule sackt in letzter Zeit etwas ab. Was beschäftigt dich gerade?',
  },
};

export function renderLine(focus: PillarKey, lang: string): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const row = LINES[focus];
  return row[isDe ? 'de' : 'en'] ?? row.en;
}
