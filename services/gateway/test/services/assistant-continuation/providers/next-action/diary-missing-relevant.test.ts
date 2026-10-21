/**
 * VTID-03059 (B0d-real slice Xd) — diary-missing-relevant source tests.
 */

import {
  produceDiaryMissingRelevant,
  classifyDiaryState,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/diary-missing-relevant';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';

function fakeSupabase(opts: {
  row: unknown | null;
  err?: { message: string };
  shouldThrow?: boolean;
}): import('@supabase/supabase-js').SupabaseClient {
  // Chain: .from('user_diary_streak').select(...).eq().maybeSingle()
  const finalResult = opts.err
    ? { data: null, error: opts.err }
    : { data: opts.row, error: null };
  const chain = {
    eq: () => chain,
    maybeSingle: () =>
      opts.shouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve(finalResult),
  };
  return {
    from: () => ({ select: () => chain }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function ctxWith(
  sb: import('@supabase/supabase-js').SupabaseClient,
  lang = 'en',
  nowIso = '2026-05-18T08:00:00Z',
): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang,
    nowIso,
    decisionContext: null,
    supabase: sb,
  };
}

describe('classifyDiaryState — pure', () => {
  test('no last_day → none:no_data', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 0, last_day: null, longest_streak_days: 0 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'none', reason: 'no_data' });
  });

  test('garbage last_day → none:no_data', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 5, last_day: 'not-a-date', longest_streak_days: 5 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'none', reason: 'no_data' });
  });

  test('entry already today → none:no_eligible_record', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 7, last_day: '2026-05-18', longest_streak_days: 7 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'none', reason: 'no_eligible_record' });
  });

  test('yesterday + streak>=2 → streak_at_risk', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 5, last_day: '2026-05-17', longest_streak_days: 5 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'streak_at_risk', currentStreak: 5, daysSinceLast: 1 });
  });

  test('yesterday + streak=1 → none (no momentum to lose)', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 1, last_day: '2026-05-17', longest_streak_days: 1 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'none', reason: 'no_eligible_record' });
  });

  test('5 days ago + longest 7 → streak_broken_restart', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 0, last_day: '2026-05-13', longest_streak_days: 7 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'streak_broken_restart', daysSinceLast: 5, longestStreak: 7 });
  });

  test('3 days ago + longest 2 → none (no significant history)', () => {
    expect(
      classifyDiaryState(
        { current_streak_days: 0, last_day: '2026-05-15', longest_streak_days: 2 },
        '2026-05-18T08:00:00Z',
      ),
    ).toEqual({ kind: 'none', reason: 'no_eligible_record' });
  });
});

describe('renderLine — pure', () => {
  test('EN streak_at_risk', () => {
    expect(
      renderLine({ kind: 'streak_at_risk', currentStreak: 5, daysSinceLast: 1 }, 'en'),
    ).toMatch(/5 days in a row.*streak stays alive/);
  });
  test('DE streak_at_risk', () => {
    expect(
      renderLine({ kind: 'streak_at_risk', currentStreak: 5, daysSinceLast: 1 }, 'de'),
    ).toMatch(/5 Tage in Folge/);
  });
  test('EN streak_broken_restart', () => {
    expect(
      renderLine({ kind: 'streak_broken_restart', daysSinceLast: 4, longestStreak: 7 }, 'en'),
    ).toMatch(/4 days ago.*longest streak was 7/);
  });
});

describe('produceDiaryMissingRelevant', () => {
  test('missing view → feature_disabled', async () => {
    const r = await produceDiaryMissingRelevant(
      ctxWith(
        fakeSupabase({
          row: null,
          err: { message: 'relation "user_diary_streak" does not exist' },
        }),
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('feature_disabled');
  });

  test('supabase error → source_unavailable', async () => {
    const r = await produceDiaryMissingRelevant(
      ctxWith(fakeSupabase({ row: null, err: { message: 'rls denied' } })),
    );
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('throw → errored', async () => {
    const r = await produceDiaryMissingRelevant(
      ctxWith(fakeSupabase({ row: null, shouldThrow: true })),
    );
    expect(r.skippedReason).toBe('errored');
  });

  test('no row → no_eligible_record', async () => {
    const r = await produceDiaryMissingRelevant(ctxWith(fakeSupabase({ row: null })));
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('streak_at_risk → priority 78, confidence high, dedupe by kind', async () => {
    const r = await produceDiaryMissingRelevant(
      ctxWith(
        fakeSupabase({
          row: {
            current_streak_days: 6,
            last_day: '2026-05-17',
            longest_streak_days: 6,
          },
        }),
      ),
    );
    expect(r.candidate?.priority).toBe(78);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.dedupeKey).toBe('diary_missing_relevant:streak_at_risk');
    expect(r.candidate?.userFacingLine).toContain('6 days');
    expect(r.candidate?.cta?.type).toBe('navigate');
  });

  test('streak_broken_restart → priority 58, confidence medium', async () => {
    const r = await produceDiaryMissingRelevant(
      ctxWith(
        fakeSupabase({
          row: {
            current_streak_days: 0,
            last_day: '2026-05-14',
            longest_streak_days: 8,
          },
        }),
      ),
    );
    expect(r.candidate?.priority).toBe(58);
    expect(r.candidate?.confidence).toBe('medium');
    expect(r.candidate?.dedupeKey).toBe('diary_missing_relevant:streak_broken_restart');
  });
});
