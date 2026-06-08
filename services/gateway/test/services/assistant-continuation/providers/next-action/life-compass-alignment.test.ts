/**
 * VTID-03058 (B0d-real slice Xc) — life-compass-alignment source tests.
 */

import {
  produceLifeCompassAlignment,
  extractPillarMomentum,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/life-compass-alignment';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';
import type {
  DecisionPillarMomentum,
  PillarKey,
  PillarMomentumBand,
  PillarMomentumConfidence,
} from '../../../../../src/orb/context/types';

function fakeSupabase(opts: {
  compass: unknown | null;
  err?: { message: string };
  shouldThrow?: boolean;
}): import('@supabase/supabase-js').SupabaseClient {
  // Chain: .from('life_compass').select(...).eq().eq().order().limit().maybeSingle()
  const finalResult = opts.err
    ? { data: null, error: opts.err }
    : { data: opts.compass, error: null };
  const chain = {
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () =>
      opts.shouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve(finalResult),
  };
  return {
    from: () => ({ select: () => chain }),
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

function ctxWith(
  sb: import('@supabase/supabase-js').SupabaseClient,
  decisionContext: unknown,
  lang = 'en',
): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang,
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext,
    supabase: sb,
  };
}

describe('life-compass-alignment pure helpers', () => {
  test('extractPillarMomentum — defensive on bad shapes', () => {
    expect(extractPillarMomentum(null)).toBeNull();
    expect(extractPillarMomentum(undefined)).toBeNull();
    expect(extractPillarMomentum({})).toBeNull();
    expect(extractPillarMomentum({ pillar_momentum: null })).toBeNull();
    expect(extractPillarMomentum({ pillar_momentum: 'oops' })).toBeNull();
    const pm = makePm();
    expect(extractPillarMomentum({ pillar_momentum: pm })).toEqual(pm);
  });

  test('renderLine — quotes the user goal verbatim', () => {
    const enLine = renderLine('Live longer with my kids', 'nutrition', 'en');
    expect(enLine).toContain('"Live longer with my kids"');
    expect(enLine.toLowerCase()).toContain('nutrition');
    const deLine = renderLine('Mit Kindern älter werden', 'sleep', 'de');
    expect(deLine).toContain('"Mit Kindern älter werden"');
    expect(deLine).toContain('Schlaf');
  });
});

describe('produceLifeCompassAlignment source', () => {
  test('missing Life Compass table → feature_disabled', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({
          compass: null,
          err: { message: 'relation "life_compass" does not exist' },
        }),
        { pillar_momentum: makePm() },
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('feature_disabled');
  });

  test('supabase error (other) → source_unavailable', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({ compass: null, err: { message: 'rls denied' } }),
        { pillar_momentum: makePm() },
      ),
    );
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('thrown exception → errored', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(fakeSupabase({ compass: null, shouldThrow: true }), {
        pillar_momentum: makePm(),
      }),
    );
    expect(r.skippedReason).toBe('errored');
  });

  test('no compass row → no_eligible_record', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(fakeSupabase({ compass: null }), { pillar_momentum: makePm() }),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('empty primary_goal → no_eligible_record', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({
          compass: {
            id: 'lc-1',
            primary_goal: '   ',
            category: 'longevity',
            is_active: true,
            created_at: '2026-05-01T00:00:00Z',
          },
        }),
        { pillar_momentum: makePm() },
      ),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('low-confidence pillar_momentum → low_confidence', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({
          compass: {
            id: 'lc-1',
            primary_goal: 'Live longer',
            category: 'longevity',
            is_active: true,
            created_at: '2026-05-01T00:00:00Z',
          },
        }),
        { pillar_momentum: makePm({ confidence: 'low' }) },
      ),
    );
    expect(r.skippedReason).toBe('low_confidence');
  });

  test('no slipping pillar → no_eligible_record', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({
          compass: {
            id: 'lc-1',
            primary_goal: 'Live longer',
            category: 'longevity',
            is_active: true,
            created_at: '2026-05-01T00:00:00Z',
          },
        }),
        {
          pillar_momentum: makePm({
            per_pillar: [
              { pillar: 'sleep', momentum: 'steady' },
              { pillar: 'nutrition', momentum: 'improving' },
              { pillar: 'exercise', momentum: 'steady' },
              { pillar: 'hydration', momentum: 'steady' },
              { pillar: 'mental', momentum: 'steady' },
            ],
          }),
        },
      ),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('compass + slipping pillar + high confidence → priority 80', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({
          compass: {
            id: 'lc-1',
            primary_goal: 'Live longer with my kids',
            category: 'longevity',
            is_active: true,
            created_at: '2026-05-01T00:00:00Z',
          },
        }),
        { pillar_momentum: makePm({ confidence: 'high' }) },
      ),
    );
    expect(r.candidate?.priority).toBe(80);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.userFacingLine).toContain('"Live longer with my kids"');
    expect(r.candidate?.userFacingLine.toLowerCase()).toContain('nutrition');
    expect(r.candidate?.dedupeKey).toBe('life_compass_alignment:lc-1:nutrition');
    expect(r.candidate?.cta?.type).toBe('navigate');
    expect(r.candidate?.reasons.length).toBe(2);
  });

  test('compass + slipping pillar + medium confidence → priority 70', async () => {
    const r = await produceLifeCompassAlignment(
      ctxWith(
        fakeSupabase({
          compass: {
            id: 'lc-1',
            primary_goal: 'Lift my mood',
            category: 'wellbeing',
            is_active: true,
            created_at: '2026-05-01T00:00:00Z',
          },
        }),
        {
          pillar_momentum: makePm({
            confidence: 'medium',
            suggested_focus: 'mental',
            per_pillar: [
              { pillar: 'sleep', momentum: 'steady' },
              { pillar: 'nutrition', momentum: 'steady' },
              { pillar: 'exercise', momentum: 'steady' },
              { pillar: 'hydration', momentum: 'steady' },
              { pillar: 'mental', momentum: 'slipping' },
            ],
          }),
        },
        'de',
      ),
    );
    expect(r.candidate?.priority).toBe(70);
    expect(r.candidate?.userFacingLine).toContain('"Lift my mood"');
    expect(r.candidate?.userFacingLine).toContain('Mental');
  });
});
