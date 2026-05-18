/**
 * VTID-03081 (B1 wiring) — wake-cadence-signals tests.
 *
 * Covers:
 *   - Pure helpers (pickIso, pickGreetingStyle, pickSessionsTodayCount,
 *     secondsBetween, msBetween, sameUtcDay)
 *   - fetchWakeCadenceSignals: error path, empty rows, mixed rows,
 *     stale-day session count
 *   - recordWakeBriefEmitted: skip not recorded, real style upserts,
 *     error path
 */

import {
  fetchWakeCadenceSignals,
  recordWakeBriefEmitted,
  pickIso,
  pickGreetingStyle,
  pickSessionsTodayCount,
  secondsBetween,
  msBetween,
  sameUtcDay,
} from '../../src/services/wake-cadence-signals';

function fakeSb(rows: Array<{ signal_name: string; value: unknown; last_seen_at: string }>) {
  const chain: any = {
    eq: () => chain,
    in: () => Promise.resolve({ data: rows, error: null }),
  };
  let captured: unknown = null;
  return {
    sb: {
      from: () => ({
        select: () => chain,
        upsert: (row: unknown, _opts: unknown) => {
          captured = row;
          return Promise.resolve({ error: null });
        },
      }),
      rpc: async () => ({ data: null, error: null }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient,
    getCapturedUpsert: () => captured,
  };
}

function fakeSbErr(message: string) {
  const chain: any = {
    eq: () => chain,
    in: () => Promise.resolve({ data: null, error: { message } }),
  };
  return {
    from: () => ({
      select: () => chain,
      upsert: () => Promise.resolve({ error: { message } }),
    }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('VTID-03081 — pure helpers', () => {
  test('pickIso prefers value.iso, falls back to last_seen_at', () => {
    expect(pickIso({ iso: '2026-05-18T08:00:00Z' }, '2026-05-18T07:00:00Z')).toBe(
      '2026-05-18T08:00:00Z',
    );
    expect(pickIso({ other: 'x' }, '2026-05-18T07:00:00Z')).toBe('2026-05-18T07:00:00Z');
    expect(pickIso(null, '2026-05-18T07:00:00Z')).toBe('2026-05-18T07:00:00Z');
    expect(pickIso(null, null)).toBeNull();
  });

  test('pickGreetingStyle accepts only the 4 known policies', () => {
    expect(pickGreetingStyle({ style: 'skip' })).toBe('skip');
    expect(pickGreetingStyle({ style: 'brief_resume' })).toBe('brief_resume');
    expect(pickGreetingStyle({ style: 'warm_return' })).toBe('warm_return');
    expect(pickGreetingStyle({ style: 'fresh_intro' })).toBe('fresh_intro');
    expect(pickGreetingStyle({ style: 'something_else' })).toBeNull();
    expect(pickGreetingStyle(null)).toBeNull();
    expect(pickGreetingStyle({})).toBeNull();
  });

  test('pickSessionsTodayCount returns null on day mismatch', () => {
    expect(pickSessionsTodayCount({ date: '2026-05-18', count: 4 }, '2026-05-18')).toBe(4);
    // Yesterday's count is stale → null (next session resets to 1).
    expect(pickSessionsTodayCount({ date: '2026-05-17', count: 9 }, '2026-05-18')).toBeNull();
    expect(pickSessionsTodayCount(null, '2026-05-18')).toBeNull();
    expect(pickSessionsTodayCount({ date: '2026-05-18', count: -1 }, '2026-05-18')).toBeNull();
  });

  test('secondsBetween clamps negative and rejects bad input', () => {
    const now = Date.parse('2026-05-18T08:00:00Z');
    expect(secondsBetween('2026-05-18T07:59:00Z', now)).toBe(60);
    expect(secondsBetween('2026-05-18T08:01:00Z', now)).toBe(0); // future → clamp
    expect(secondsBetween(null, now)).toBeNull();
    expect(secondsBetween('not-a-date', now)).toBeNull();
  });

  test('msBetween clamps + sameUtcDay matches YYYY-MM-DD prefix', () => {
    const now = Date.parse('2026-05-18T08:00:00Z');
    expect(msBetween('2026-05-18T07:50:00Z', now)).toBe(10 * 60 * 1000);
    expect(sameUtcDay('2026-05-18T07:00:00Z', '2026-05-18T23:00:00Z')).toBe(true);
    expect(sameUtcDay('2026-05-17T23:00:00Z', '2026-05-18T01:00:00Z')).toBe(false);
  });
});

describe('VTID-03081 — fetchWakeCadenceSignals', () => {
  const nowIso = '2026-05-18T08:00:00Z';

  test('missing identity returns empty', async () => {
    const { sb } = fakeSb([]);
    expect(await fetchWakeCadenceSignals({ supabase: sb, tenantId: '', userId: 'u1', nowIso })).toEqual({});
    expect(await fetchWakeCadenceSignals({ supabase: sb, tenantId: 't1', userId: '', nowIso })).toEqual({});
  });

  test('supabase error returns empty (fail-open)', async () => {
    const sb = fakeSbErr('rls denied');
    const out = await fetchWakeCadenceSignals({ supabase: sb, tenantId: 't1', userId: 'u1', nowIso });
    expect(out).toEqual({});
  });

  test('no rows returns empty', async () => {
    const { sb } = fakeSb([]);
    const out = await fetchWakeCadenceSignals({ supabase: sb, tenantId: 't1', userId: 'u1', nowIso });
    expect(out).toEqual({});
  });

  test('full signal set is parsed and converted', async () => {
    const { sb } = fakeSb([
      {
        signal_name: 'wake_cadence:last_turn_at',
        value: { iso: '2026-05-18T07:55:00Z' },
        last_seen_at: '2026-05-18T07:55:00Z',
      },
      {
        signal_name: 'wake_cadence:last_greeting_at',
        value: { iso: '2026-05-18T07:50:00Z' },
        last_seen_at: '2026-05-18T07:50:00Z',
      },
      {
        signal_name: 'wake_cadence:last_greeting_style',
        value: { style: 'warm_return' },
        last_seen_at: '2026-05-18T07:50:00Z',
      },
      {
        signal_name: 'wake_cadence:sessions_today',
        value: { date: '2026-05-18', count: 3 },
        last_seen_at: '2026-05-18T07:50:00Z',
      },
    ]);
    const out = await fetchWakeCadenceSignals({ supabase: sb, tenantId: 't1', userId: 'u1', nowIso });
    expect(out.seconds_since_last_turn_anywhere).toBe(5 * 60);
    expect(out.time_since_last_greeting_today_ms).toBe(10 * 60 * 1000);
    expect(out.greeting_style_last_used).toBe('warm_return');
    expect(out.sessions_today_count).toBe(3);
  });

  test('yesterday greeting row does NOT populate time_since_last_greeting_today_ms', async () => {
    const { sb } = fakeSb([
      {
        signal_name: 'wake_cadence:last_greeting_at',
        value: { iso: '2026-05-17T23:30:00Z' },
        last_seen_at: '2026-05-17T23:30:00Z',
      },
    ]);
    const out = await fetchWakeCadenceSignals({ supabase: sb, tenantId: 't1', userId: 'u1', nowIso });
    expect(out.time_since_last_greeting_today_ms).toBeUndefined();
  });

  test('stale sessions_today (yesterday) returns no count', async () => {
    const { sb } = fakeSb([
      {
        signal_name: 'wake_cadence:sessions_today',
        value: { date: '2026-05-17', count: 9 },
        last_seen_at: '2026-05-17T23:00:00Z',
      },
    ]);
    const out = await fetchWakeCadenceSignals({ supabase: sb, tenantId: 't1', userId: 'u1', nowIso });
    expect(out.sessions_today_count).toBeUndefined();
  });
});

describe('VTID-03081 — recordWakeBriefEmitted', () => {
  test('skip is not recorded', async () => {
    const { sb } = fakeSb([]);
    const out = await recordWakeBriefEmitted({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      style: 'skip',
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('skip_not_recorded');
  });

  test('non-skip style upserts both rows', async () => {
    const { sb, getCapturedUpsert } = fakeSb([]);
    const out = await recordWakeBriefEmitted({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      style: 'warm_return',
      nowIso: '2026-05-18T08:00:00Z',
    });
    expect(out.ok).toBe(true);
    const upserted = getCapturedUpsert();
    expect(Array.isArray(upserted)).toBe(true);
    const rows = upserted as Array<{ signal_name: string; value: { iso?: string; style?: string } }>;
    expect(rows.length).toBe(2);
    const greetingAtRow = rows.find((r) => r.signal_name === 'wake_cadence:last_greeting_at');
    const styleRow = rows.find((r) => r.signal_name === 'wake_cadence:last_greeting_style');
    expect(greetingAtRow?.value.iso).toBe('2026-05-18T08:00:00Z');
    expect(styleRow?.value.style).toBe('warm_return');
  });

  test('error returns {ok:false, reason}', async () => {
    const sb = fakeSbErr('rls denied');
    const out = await recordWakeBriefEmitted({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      style: 'warm_return',
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('rls denied');
  });

  test('missing identity returns missing_identity', async () => {
    const { sb } = fakeSb([]);
    const out = await recordWakeBriefEmitted({
      supabase: sb,
      tenantId: '',
      userId: 'u1',
      style: 'warm_return',
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('missing_identity');
  });
});
