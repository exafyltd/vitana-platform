/**
 * VTID-04883 (D2) — the Jev shadow of the next-action slate never changes what the composer decides.
 *
 * The composer fires `shadowNextAction(...)` after `rank()` and returns without waiting for it. This
 * suite runs the real composer with the shadow resolving, hanging forever, and rejecting, and pins that
 * the compose result (chosen candidate, suppress reason, candidates) is identical in every case, and
 * that the shadow sees the slate and the chosen source.
 */

const shadowNextAction = jest.fn();
jest.mock('../../../../../src/services/jev/gates/community-ranking-gates', () => ({
  shadowNextAction: (...a: unknown[]) => shadowNextAction(...a),
}));

import type {
  NextActionComposer,
  NextActionSource,
  NextActionSourceContext,
  ScoredCandidate,
} from '../../../../../src/services/assistant-continuation/providers/next-action/types';

function fakeSupabase(): import('@supabase/supabase-js').SupabaseClient {
  return {
    from: () => ({}) as never,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

const ctx = (): NextActionSourceContext => ({
  userId: 'u1',
  tenantId: 't1',
  lang: 'en',
  nowIso: '2026-10-07T08:00:00Z',
  decisionContext: null,
  supabase: fakeSupabase(),
});

const cand = (source: NextActionSource['key'], priority: number): ScoredCandidate => ({
  source,
  priority,
  confidence: 'high',
  userFacingLine: `from ${source}`,
  reasons: [{ kind: `${source}_ready`, detail: 'fake' }],
  dedupeKey: `${source}:1`,
});

const source = (key: NextActionSource['key'], candidate: ScoredCandidate | null): NextActionSource => ({
  key,
  serves: () => true,
  produce: async () => ({ source: key, candidate }),
});

function freshComposer(): NextActionComposer {
  const { defaultNextActionComposer } = require('../../../../../src/services/assistant-continuation/providers/next-action/composer');
  defaultNextActionComposer.reset();
  defaultNextActionComposer.register(source('reminder_due', cand('reminder_due', 70)));
  defaultNextActionComposer.register(source('journey_stage_nudge', cand('journey_stage_nudge', 90)));
  defaultNextActionComposer.register(source('diary_missing_relevant', null));
  return defaultNextActionComposer;
}

const decision = (r: Awaited<ReturnType<NextActionComposer['compose']>>) => ({
  chosen: r.chosen?.source ?? null,
  suppressReason: r.suppressReason ?? null,
  candidates: r.candidates.map((c) => [c.source, c.candidate?.priority ?? null, c.skippedReason ?? null]),
});

describe('VTID-04883 D2: the next-action decision is unchanged by the Jev shadow', () => {
  beforeEach(() => shadowNextAction.mockReset());

  test('resolving, hanging and rejecting shadows give the same compose result', async () => {
    shadowNextAction.mockResolvedValue('row-1');
    const resolved = decision(await freshComposer().compose('orb_wake', ctx()));

    shadowNextAction.mockReturnValue(new Promise(() => undefined)); // never settles
    const hanging = decision(await freshComposer().compose('orb_wake', ctx()));

    shadowNextAction.mockRejectedValue(new Error('jev down'));
    const rejected = decision(await freshComposer().compose('orb_wake', ctx()));

    expect(resolved.chosen).toBe('journey_stage_nudge');
    expect(hanging).toEqual(resolved);
    expect(rejected).toEqual(resolved);
  });

  test('the shadow sees the slate (sources with a candidate) and the chosen source', async () => {
    shadowNextAction.mockResolvedValue(null);
    await freshComposer().compose('orb_wake', ctx());
    expect(shadowNextAction).toHaveBeenCalledTimes(1);
    const arg = shadowNextAction.mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: 't1', userId: 'u1', surface: 'orb_wake', chosenSource: 'journey_stage_nudge' });
    expect(arg.slate.map((s: any) => s.source).sort()).toEqual(['journey_stage_nudge', 'reminder_due']);
  });

  test('a shadow that throws synchronously-rejected does not leak an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      shadowNextAction.mockRejectedValue(new Error('boom'));
      await freshComposer().compose('orb_wake', ctx());
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
