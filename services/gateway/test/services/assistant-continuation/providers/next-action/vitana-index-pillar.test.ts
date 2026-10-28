/**
 * VTID-03059 (B0d-real slice Xd) — vitana-index-pillar source tests.
 */

import {
  produceVitanaIndexPillar,
  extractPillarMomentum,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/vitana-index-pillar';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';
import type {
  DecisionPillarMomentum,
  PillarKey,
  PillarMomentumBand,
  PillarMomentumConfidence,
} from '../../../../../src/orb/context/types';

function fakeSupabase(): import('@supabase/supabase-js').SupabaseClient {
  return {
    from: () => ({}) as never,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function makePm(over: Partial<DecisionPillarMomentum> = {}): DecisionPillarMomentum {
  const focus: PillarKey = (over.suggested_focus ?? 'nutrition') as PillarKey;
  const focusMomentum: PillarMomentumBand =
    over.per_pillar?.find((p) => p.pillar === focus)?.momentum ?? 'slipping';
  return {
    per_pillar: over.per_pillar ?? [
      { pillar: 'sleep', momentum: 'steady' },
      { pillar: 'nutrition', momentum: focusMomentum },
      { pillar: 'exercise', momentum: 'steady' },
      { pillar: 'hydration', momentum: 'steady' },
      { pillar: 'mental', momentum: 'steady' },
    ],
    weakest_pillar: focus,
    strongest_pillar: 'sleep',
    suggested_focus: focus,
    confidence: (over.confidence ?? 'high') as PillarMomentumConfidence,
    warnings: [],
  };
}

function ctxWith(decisionContext: unknown, lang = 'en'): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang,
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext,
    supabase: fakeSupabase(),
  };
}

describe('vitana-index-pillar pure helpers', () => {
  test('extractPillarMomentum is defensive', () => {
    expect(extractPillarMomentum(null)).toBeNull();
    expect(extractPillarMomentum({})).toBeNull();
    expect(extractPillarMomentum({ pillar_momentum: null })).toBeNull();
    expect(extractPillarMomentum({ pillar_momentum: 'oops' })).toBeNull();
    const pm = makePm();
    expect(extractPillarMomentum({ pillar_momentum: pm })).toEqual(pm);
  });

  test('renderLine — EN+DE per pillar', () => {
    expect(renderLine('sleep', 'en')).toContain('sleep pillar');
    expect(renderLine('sleep', 'de')).toContain('Schlaf');
    expect(renderLine('mental', 'en')).toMatch(/mental.*weighing on you/);
    expect(renderLine('mental', 'de')).toContain('Mental');
  });
});

describe('produceVitanaIndexPillar source', () => {
  test('no decision context → no_data', async () => {
    const r = await produceVitanaIndexPillar(ctxWith(null));
    expect(r.skippedReason).toBe('no_data');
  });

  test('decision context missing pillar_momentum → no_data', async () => {
    const r = await produceVitanaIndexPillar(ctxWith({ some_other_field: true }));
    expect(r.skippedReason).toBe('no_data');
  });

  test('low confidence → low_confidence', async () => {
    const r = await produceVitanaIndexPillar(
      ctxWith({ pillar_momentum: makePm({ confidence: 'low' }) }),
    );
    expect(r.skippedReason).toBe('low_confidence');
  });

  test('suggested_focus null → no_eligible_record', async () => {
    const pm = makePm();
    (pm as { suggested_focus: PillarKey | null }).suggested_focus = null;
    const r = await produceVitanaIndexPillar(ctxWith({ pillar_momentum: pm }));
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('focus pillar steady/improving → no_eligible_record', async () => {
    const r = await produceVitanaIndexPillar(
      ctxWith({
        pillar_momentum: makePm({
          per_pillar: [
            { pillar: 'sleep', momentum: 'steady' },
            { pillar: 'nutrition', momentum: 'improving' },
            { pillar: 'exercise', momentum: 'steady' },
            { pillar: 'hydration', momentum: 'steady' },
            { pillar: 'mental', momentum: 'steady' },
          ],
        }),
      }),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('slipping focus + high confidence → priority 68, dedupe by pillar', async () => {
    const r = await produceVitanaIndexPillar(
      ctxWith({ pillar_momentum: makePm({ confidence: 'high' }) }),
    );
    expect(r.candidate?.priority).toBe(68);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.userFacingLine.toLowerCase()).toContain('nutrition');
    expect(r.candidate?.dedupeKey).toBe('vitana_index_pillar:nutrition');
    expect(r.candidate?.cta?.type).toBe('navigate');
  });

  test('slipping focus + medium confidence → priority 58', async () => {
    const r = await produceVitanaIndexPillar(
      ctxWith({ pillar_momentum: makePm({ confidence: 'medium' }) }),
    );
    expect(r.candidate?.priority).toBe(58);
  });

  test('unknown momentum on suggested focus counts as eligible (gap-filling)', async () => {
    const r = await produceVitanaIndexPillar(
      ctxWith({
        pillar_momentum: makePm({
          per_pillar: [
            { pillar: 'sleep', momentum: 'steady' },
            { pillar: 'nutrition', momentum: 'unknown' },
            { pillar: 'exercise', momentum: 'steady' },
            { pillar: 'hydration', momentum: 'steady' },
            { pillar: 'mental', momentum: 'steady' },
          ],
        }),
      }),
    );
    expect(r.candidate).not.toBeNull();
  });
});
