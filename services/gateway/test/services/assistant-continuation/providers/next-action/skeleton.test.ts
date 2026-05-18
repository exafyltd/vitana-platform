/**
 * VTID-03056 (B0d-real slice Xa) — Contextual Next Action provider
 * SKELETON tests.
 *
 * Scope: types + composer + provider entry point. NO concrete sources
 * yet — those land in slices Xb-Xe. This suite pins the contract that
 * concrete sources will rely on.
 */

import {
  makeNextActionProvider,
  NEXT_ACTION_EXTRA_KEY,
  NEXT_ACTION_PROVIDER_KEY,
} from '../../../../../src/services/assistant-continuation/providers/next-action';
import {
  rank,
  CROSS_SOURCE_THRESHOLD,
} from '../../../../../src/services/assistant-continuation/providers/next-action/composer';
import type {
  NextActionComposer,
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../../../../../src/services/assistant-continuation/providers/next-action/types';
import {
  NEXT_ACTION_SOURCE_KEYS,
} from '../../../../../src/services/assistant-continuation/providers/next-action/types';
import type { ContinuationDecisionContext } from '../../../../../src/services/assistant-continuation/types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeSupabase(): import('@supabase/supabase-js').SupabaseClient {
  return {
    from: () => ({}) as never,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function makeCtx(
  over: Partial<ContinuationDecisionContext> = {},
): ContinuationDecisionContext {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [NEXT_ACTION_EXTRA_KEY]: {
        supabase: fakeSupabase(),
        decisionContext: null,
      },
    },
    ...over,
  };
}

function makeSource(opts: {
  key: NextActionSource['key'];
  candidate?: ScoredCandidate | null;
  skippedReason?: NextActionSourceResult['skippedReason'];
  surfaces?: ('orb_wake' | 'orb_turn_end')[];
  throws?: boolean;
}): NextActionSource {
  const surfaces = opts.surfaces ?? ['orb_wake', 'orb_turn_end'];
  return {
    key: opts.key,
    serves: (s) => surfaces.includes(s),
    produce: async () => {
      if (opts.throws) {
        throw new Error('boom');
      }
      const result: NextActionSourceResult = {
        source: opts.key,
        candidate: opts.candidate ?? null,
      };
      if (opts.skippedReason !== undefined) {
        result.skippedReason = opts.skippedReason;
      }
      return result;
    },
  };
}

function makeCandidate(
  source: NextActionSource['key'],
  priority: number,
  over: Partial<ScoredCandidate> = {},
): ScoredCandidate {
  return {
    source,
    priority,
    confidence: 'high',
    userFacingLine: `Candidate from ${source}`,
    reasons: [{ kind: `${source}_ready`, detail: 'fake' }],
    dedupeKey: `${source}:1`,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Source-key inventory
// ---------------------------------------------------------------------------

describe('VTID-03056 (Xa) — source key inventory', () => {
  test('NEXT_ACTION_SOURCE_KEYS covers the 10 B0d-real inputs', () => {
    expect(NEXT_ACTION_SOURCE_KEYS.length).toBe(10);
    const expected = new Set([
      'autopilot_recommendation',
      'reminder_due',
      'calendar_upcoming',
      'life_compass_alignment',
      'vitana_index_pillar',
      'diary_missing_relevant',
      'journey_stage_nudge',
      'match_activity_plan',
      'continuity_pending_thread',
      'continuity_promise_owed',
    ]);
    for (const k of NEXT_ACTION_SOURCE_KEYS) expect(expected.has(k)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composer rank() pure function
// ---------------------------------------------------------------------------

describe('VTID-03056 (Xa) — composer rank()', () => {
  test('returns chosen:null + all_sources_skipped when no candidates', () => {
    const r = rank([
      { source: 'reminder_due', candidate: null, skippedReason: 'no_data' },
      { source: 'autopilot_recommendation', candidate: null, skippedReason: 'no_data' },
    ]);
    expect(r.chosen).toBeNull();
    expect(r.suppressReason).toBe('all_sources_skipped');
  });

  test('returns chosen:null + all_sources_errored when EVERY source errored', () => {
    const r = rank([
      { source: 'reminder_due', candidate: null, skippedReason: 'errored' },
      { source: 'autopilot_recommendation', candidate: null, skippedReason: 'errored' },
    ]);
    expect(r.chosen).toBeNull();
    expect(r.suppressReason).toBe('all_sources_errored');
  });

  test('picks highest-priority candidate', () => {
    const reminders = makeCandidate('reminder_due', 80);
    const autopilot = makeCandidate('autopilot_recommendation', 95);
    const r = rank([
      { source: 'reminder_due', candidate: reminders },
      { source: 'autopilot_recommendation', candidate: autopilot },
    ]);
    expect(r.chosen).toBe(autopilot);
    expect(r.suppressReason).toBeUndefined();
  });

  test('breaks ties by registration order (stable sort)', () => {
    const a = makeCandidate('reminder_due', 75);
    const b = makeCandidate('autopilot_recommendation', 75);
    const r = rank([
      { source: 'reminder_due', candidate: a },
      { source: 'autopilot_recommendation', candidate: b },
    ]);
    expect(r.chosen).toBe(a); // first registered wins
  });

  test('suppresses below CROSS_SOURCE_THRESHOLD with tied_below_threshold', () => {
    const c = makeCandidate('vitana_index_pillar', CROSS_SOURCE_THRESHOLD - 1);
    const r = rank([{ source: 'vitana_index_pillar', candidate: c }]);
    expect(r.chosen).toBeNull();
    expect(r.suppressReason).toBe('tied_below_threshold');
  });

  test('returns at threshold (>= boundary fires)', () => {
    const c = makeCandidate('reminder_due', CROSS_SOURCE_THRESHOLD);
    const r = rank([{ source: 'reminder_due', candidate: c }]);
    expect(r.chosen).toBe(c);
  });
});

// ---------------------------------------------------------------------------
// Composer.compose end-to-end
// ---------------------------------------------------------------------------

describe('VTID-03056 (Xa) — composer.compose()', () => {
  function freshComposer(): NextActionComposer {
    // Build a fresh composer per test so registrations don't leak.
    const {
      defaultNextActionComposer,
    } = require('../../../../../src/services/assistant-continuation/providers/next-action/composer');
    defaultNextActionComposer.reset();
    return defaultNextActionComposer;
  }

  test('empty registry → chosen:null + no_sources_registered', async () => {
    const composer = freshComposer();
    const r = await composer.compose('orb_wake', {
      userId: 'u1',
      tenantId: 't1',
      lang: 'en',
      nowIso: '2026-05-18T08:00:00Z',
      decisionContext: null,
      supabase: fakeSupabase(),
    });
    expect(r.chosen).toBeNull();
    expect(r.suppressReason).toBe('no_sources_registered');
    expect(r.candidates).toEqual([]);
    expect(typeof r.composeStartedAt).toBe('string');
    expect(typeof r.composeFinishedAt).toBe('string');
  });

  test('one source returns a candidate → chosen is that candidate', async () => {
    const composer = freshComposer();
    const cand = makeCandidate('reminder_due', 80);
    composer.register(makeSource({ key: 'reminder_due', candidate: cand }));
    const r = await composer.compose('orb_wake', {
      userId: 'u1',
      tenantId: 't1',
      lang: 'en',
      nowIso: '2026-05-18T08:00:00Z',
      decisionContext: null,
      supabase: fakeSupabase(),
    });
    expect(r.chosen).toBe(cand);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].latencyMs).toBeDefined();
  });

  test('source that throws is captured as errored, never propagates', async () => {
    const composer = freshComposer();
    composer.register(makeSource({ key: 'reminder_due', throws: true }));
    const r = await composer.compose('orb_wake', {
      userId: 'u1',
      tenantId: 't1',
      lang: 'en',
      nowIso: '2026-05-18T08:00:00Z',
      decisionContext: null,
      supabase: fakeSupabase(),
    });
    expect(r.chosen).toBeNull();
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].skippedReason).toBe('errored');
    expect(r.suppressReason).toBe('all_sources_errored');
  });

  test('source that BOTH returns a candidate AND a skippedReason is treated as errored', async () => {
    const composer = freshComposer();
    composer.register({
      key: 'reminder_due',
      serves: () => true,
      produce: async () => ({
        source: 'reminder_due',
        candidate: makeCandidate('reminder_due', 80),
        skippedReason: 'no_data', // forbidden mix
      }),
    });
    const r = await composer.compose('orb_wake', {
      userId: 'u1',
      tenantId: 't1',
      lang: 'en',
      nowIso: '2026-05-18T08:00:00Z',
      decisionContext: null,
      supabase: fakeSupabase(),
    });
    expect(r.chosen).toBeNull();
    expect(r.candidates[0].skippedReason).toBe('errored');
  });

  test('source not serving the surface is filtered out before invocation', async () => {
    const composer = freshComposer();
    composer.register(
      makeSource({
        key: 'reminder_due',
        candidate: makeCandidate('reminder_due', 80),
        surfaces: ['orb_turn_end'], // does NOT serve orb_wake
      }),
    );
    const r = await composer.compose('orb_wake', {
      userId: 'u1',
      tenantId: 't1',
      lang: 'en',
      nowIso: '2026-05-18T08:00:00Z',
      decisionContext: null,
      supabase: fakeSupabase(),
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.suppressReason).toBe('all_sources_skipped');
  });
});

// ---------------------------------------------------------------------------
// Provider integration
// ---------------------------------------------------------------------------

describe('VTID-03056 (Xa) — makeNextActionProvider()', () => {
  test('provider serves both orb_wake AND orb_turn_end', () => {
    const provider = makeNextActionProvider();
    expect(provider.surfaces).toContain('orb_wake');
    expect(provider.surfaces).toContain('orb_turn_end');
  });

  test('skipped when no inputs in ctx.extra', async () => {
    const provider = makeNextActionProvider();
    const r = await provider.produce({
      surface: 'orb_wake',
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      // No extra.
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('no_next_action_inputs');
  });

  test('skipped when anonymous (no userId or tenantId)', async () => {
    const provider = makeNextActionProvider();
    const r = await provider.produce(makeCtx({ userId: undefined }));
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('anonymous_caller');
  });

  test('suppressed when composer registry is empty', async () => {
    const {
      defaultNextActionComposer,
    } = require('../../../../../src/services/assistant-continuation/providers/next-action/composer');
    defaultNextActionComposer.reset();
    const provider = makeNextActionProvider();
    const r = await provider.produce(makeCtx());
    expect(r.status).toBe('suppressed');
    if (r.status === 'suppressed') expect(r.reason).toBe('no_sources_registered');
  });

  test('returns a candidate when composer picks one — rendered evidence carries source key', async () => {
    const {
      defaultNextActionComposer,
    } = require('../../../../../src/services/assistant-continuation/providers/next-action/composer');
    defaultNextActionComposer.reset();
    defaultNextActionComposer.register(
      makeSource({
        key: 'reminder_due',
        candidate: makeCandidate('reminder_due', 80, {
          userFacingLine: 'Your magnesium reminder is due in 28 minutes.',
        }),
      }),
    );
    const provider = makeNextActionProvider({
      newId: () => 'fixed-id',
    });
    const r = await provider.produce(makeCtx());
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    const c = r.candidate!;
    expect(c.kind).toBe('next_step');
    expect(c.userFacingLine).toBe('Your magnesium reminder is due in 28 minutes.');
    expect(c.priority).toBe(90); // provider-level default
    expect(c.evidence.some((e) => e.kind === 'source:reminder_due')).toBe(true);
    expect(c.dedupeKey).toBe('reminder_due:1');
  });

  test('provider key + extra key are stable strings (registration contract)', () => {
    expect(NEXT_ACTION_PROVIDER_KEY).toBe('contextual_next_action');
    expect(NEXT_ACTION_EXTRA_KEY).toBe('nextAction');
  });

  // VTID-03073 regression guard: every source's `renderLine` reads
  // `ctx.lang` to pick EN vs DE. Before this fix the provider's
  // composer call hardcoded `'en'` because the extras object never
  // carried `lang` — every wake-brief rendered English to German users
  // for a week. This test fails fast if the wiring breaks again.
  test('VTID-03073: ctx.lang is forwarded from extras.lang into composer ctx', async () => {
    const {
      defaultNextActionComposer,
    } = require('../../../../../src/services/assistant-continuation/providers/next-action/composer');
    defaultNextActionComposer.reset();
    let observedLang: string | null = null;
    defaultNextActionComposer.register({
      key: 'reminder_due',
      serves: () => true,
      produce: async (ctx: { lang: string }) => {
        observedLang = ctx.lang;
        return { source: 'reminder_due', candidate: null, skippedReason: 'no_data' };
      },
    });
    const provider = makeNextActionProvider({ newId: () => 'fixed-id' });
    await provider.produce({
      surface: 'orb_wake',
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      extra: {
        [NEXT_ACTION_EXTRA_KEY]: {
          supabase: fakeSupabase(),
          decisionContext: null,
          lang: 'de',
        },
      },
    });
    expect(observedLang).toBe('de');
  });
});
