/**
 * VTID-03068 (B0d-real Xk) — Cross-session dedupe store tests.
 *
 * Covers:
 *   - buildDedupeSignalName format
 *   - isSeenRecently: hit, miss, error fail-open, default window
 *   - recordDedupeSighting: upsert payload shape, error path
 */

import {
  buildDedupeSignalName,
  isSeenRecently,
  recordDedupeSighting,
  DEFAULT_DEDUPE_WINDOW_MS,
  DEDUPE_SIGNAL_PREFIX,
} from '../../../../../src/services/assistant-continuation/providers/next-action/dedupe-store';

function fakeSb(opts: {
  selectRows?: unknown[] | null;
  selectError?: { message: string } | null;
  selectThrows?: boolean;
  upsertError?: { message: string } | null;
  upsertThrows?: boolean;
  captureUpsert?: (row: unknown) => void;
}): { sb: import('@supabase/supabase-js').SupabaseClient; selectFilters: Record<string, unknown>[] } {
  const selectFilters: Record<string, unknown>[] = [];
  // The store calls:
  //   sb.from('user_assistant_state').select('last_seen_at').eq().eq().eq().gte().limit()
  // and
  //   sb.from('user_assistant_state').upsert(row, { onConflict })
  // Two different paths off `from`.
  const fakeChain: any = {
    eq: function (col: string, val: unknown) {
      selectFilters.push({ [col]: val });
      return fakeChain;
    },
    gte: function (col: string, val: unknown) {
      selectFilters.push({ [col + '_gte']: val });
      return fakeChain;
    },
    limit: function () {
      if (opts.selectThrows) return Promise.reject(new Error('boom'));
      return Promise.resolve(
        opts.selectError
          ? { data: null, error: opts.selectError }
          : { data: opts.selectRows ?? null, error: null },
      );
    },
  };
  const from = () => ({
    select: () => fakeChain,
    upsert: function (row: unknown, _opts: unknown) {
      if (opts.captureUpsert) opts.captureUpsert(row);
      if (opts.upsertThrows) return Promise.reject(new Error('boom'));
      return Promise.resolve(
        opts.upsertError ? { error: opts.upsertError } : { error: null },
      );
    },
  });
  return {
    sb: { from } as unknown as import('@supabase/supabase-js').SupabaseClient,
    selectFilters,
  };
}

const baseInputs = {
  tenantId: 't1',
  userId: 'u1',
  dedupeKey: 'reminder_due:r-1',
};

describe('VTID-03068 — buildDedupeSignalName', () => {
  test('prepends prefix', () => {
    expect(buildDedupeSignalName('reminder_due:r-1')).toBe(
      DEDUPE_SIGNAL_PREFIX + 'reminder_due:r-1',
    );
  });
});

describe('VTID-03068 — isSeenRecently', () => {
  test('returns true when supabase returns a row within window', async () => {
    const { sb } = fakeSb({
      selectRows: [{ last_seen_at: '2026-05-18T07:00:00Z' }],
    });
    expect(
      await isSeenRecently({ ...baseInputs, supabase: sb, nowIso: '2026-05-18T08:00:00Z' }),
    ).toBe(true);
  });

  test('returns false when supabase returns empty', async () => {
    const { sb } = fakeSb({ selectRows: [] });
    expect(await isSeenRecently({ ...baseInputs, supabase: sb })).toBe(false);
  });

  test('returns false on supabase error (fail-open)', async () => {
    const { sb } = fakeSb({ selectError: { message: 'rls denied' } });
    expect(await isSeenRecently({ ...baseInputs, supabase: sb })).toBe(false);
  });

  test('returns false on exception (fail-open)', async () => {
    const { sb } = fakeSb({ selectThrows: true });
    expect(await isSeenRecently({ ...baseInputs, supabase: sb })).toBe(false);
  });

  test('passes the right filters to supabase', async () => {
    const { sb, selectFilters } = fakeSb({ selectRows: [] });
    await isSeenRecently({
      ...baseInputs,
      supabase: sb,
      nowIso: '2026-05-18T08:00:00Z',
    });
    // Expect 3 .eq filters (tenant + user + signal_name) and 1 .gte
    // (last_seen_at >= cutoff).
    expect(selectFilters.some((f) => f.tenant_id === 't1')).toBe(true);
    expect(selectFilters.some((f) => f.user_id === 'u1')).toBe(true);
    expect(
      selectFilters.some((f) => f.signal_name === buildDedupeSignalName(baseInputs.dedupeKey)),
    ).toBe(true);
    expect(selectFilters.some((f) => f.last_seen_at_gte != null)).toBe(true);
  });

  test('uses DEFAULT_DEDUPE_WINDOW_MS when windowMs is not supplied', async () => {
    const { sb, selectFilters } = fakeSb({ selectRows: [] });
    const nowIso = '2026-05-18T08:00:00Z';
    await isSeenRecently({ ...baseInputs, supabase: sb, nowIso });
    const gteFilter = selectFilters.find((f) => f.last_seen_at_gte != null);
    expect(gteFilter).toBeDefined();
    const cutoffMs = Date.parse(String(gteFilter!.last_seen_at_gte));
    const expected = Date.parse(nowIso) - DEFAULT_DEDUPE_WINDOW_MS;
    expect(cutoffMs).toBe(expected);
  });
});

describe('VTID-03068 — recordDedupeSighting', () => {
  test('upserts a well-formed row', async () => {
    let captured: unknown = null;
    const { sb } = fakeSb({ captureUpsert: (r) => (captured = r) });
    const out = await recordDedupeSighting({
      ...baseInputs,
      supabase: sb,
      source: 'reminder_due',
      surface: 'orb_wake',
    });
    expect(out.ok).toBe(true);
    expect(captured).not.toBeNull();
    const row = captured as Record<string, unknown>;
    expect(row.tenant_id).toBe('t1');
    expect(row.user_id).toBe('u1');
    expect(row.signal_name).toBe(buildDedupeSignalName('reminder_due:r-1'));
    expect(row.value).toEqual({
      source: 'reminder_due',
      surface: 'orb_wake',
      shown_at: expect.any(String),
    });
    expect(typeof row.last_seen_at).toBe('string');
  });

  test('returns {ok:false, reason} on supabase error', async () => {
    const { sb } = fakeSb({ upsertError: { message: 'rls denied' } });
    const out = await recordDedupeSighting({
      ...baseInputs,
      supabase: sb,
      source: 'reminder_due',
      surface: 'orb_wake',
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('rls denied');
  });

  test('returns {ok:false, reason} on exception', async () => {
    const { sb } = fakeSb({ upsertThrows: true });
    const out = await recordDedupeSighting({
      ...baseInputs,
      supabase: sb,
      source: 'reminder_due',
      surface: 'orb_wake',
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('boom');
  });
});
