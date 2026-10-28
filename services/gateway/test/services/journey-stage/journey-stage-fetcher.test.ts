/**
 * VTID-02937 (B4) — Supabase-backed JourneyStageFetcher tests.
 *
 * Verifies:
 *   - Read-only interface — three fetch methods, no mutators (B4 wall).
 *   - DB unavailable / error → empty rows + source_health reason.
 *   - app_users.maybeSingle missing row → ok:true + row:null.
 *   - Row mapping defensives for malformed columns.
 *   - History limit clamping (1..365, default 30).
 */

import {
  createSupabaseJourneyStageFetcher,
  mapAppUserRow,
  mapVitanaIndexRow,
} from '../../../src/services/journey-stage/journey-stage-fetcher';

function makeFakeClient(behavior: {
  appUserRow?: unknown | null;
  appUserError?: unknown;
  activeDaysRows?: unknown[];
  activeDaysError?: unknown;
  indexRows?: unknown[];
  indexError?: unknown;
  captureIndexLimit?: (n: number) => void;
}) {
  const client = {
    from(table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        async maybeSingle() {
          // Only app_users uses maybeSingle in B4.
          return {
            data: behavior.appUserError ? null : (behavior.appUserRow ?? null),
            error: behavior.appUserError ?? null,
          };
        },
        limit(n: number) {
          if (table === 'vitana_index_scores' && behavior.captureIndexLimit) {
            behavior.captureIndexLimit(n);
          }
          return builder;
        },
        async then(resolve: (v: unknown) => void) {
          if (table === 'user_active_days') {
            resolve({
              data: behavior.activeDaysError ? null : (behavior.activeDaysRows ?? []),
              error: behavior.activeDaysError ?? null,
            });
          } else if (table === 'vitana_index_scores') {
            resolve({
              data: behavior.indexError ? null : (behavior.indexRows ?? []),
              error: behavior.indexError ?? null,
            });
          } else {
            resolve({ data: null, error: { message: 'unknown table: ' + table } });
          }
        },
      };
      return builder;
    },
  };
  return client;
}

describe('B4 — Supabase-backed JourneyStageFetcher', () => {
  describe('read-only contract (B4 wall)', () => {
    it('JourneyStageFetcher exposes only fetch methods (no writers)', () => {
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => null) as any });
      const keys = Object.keys(fetcher).sort();
      expect(keys).toEqual([
        'fetchAppUser',
        'fetchUserActiveDaysAggregate',
        'fetchVitanaIndexHistory',
      ]);
    });
  });

  describe('DB unavailable', () => {
    it('every fetch returns ok:false + reason when getSupabase returns null', async () => {
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => null) as any });
      const u = await fetcher.fetchAppUser({ userId: 'u' });
      const a = await fetcher.fetchUserActiveDaysAggregate({ userId: 'u' });
      const i = await fetcher.fetchVitanaIndexHistory({ tenantId: 't', userId: 'u' });
      expect(u.ok).toBe(false);
      expect(u.reason).toBe('supabase_unconfigured');
      expect(a.ok).toBe(false);
      expect(a.aggregate.usage_days_count).toBe(0);
      expect(a.aggregate.last_active_date).toBeNull();
      expect(a.reason).toBe('supabase_unconfigured');
      expect(i.ok).toBe(false);
      expect(i.rows).toEqual([]);
      expect(i.reason).toBe('supabase_unconfigured');
    });

    it('every fetch returns ok:false + reason on Supabase error', async () => {
      const client = makeFakeClient({
        appUserError: { message: 'boom-u' },
        activeDaysError: { message: 'boom-a' },
        indexError: { message: 'boom-i' },
      });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      const u = await fetcher.fetchAppUser({ userId: 'u' });
      const a = await fetcher.fetchUserActiveDaysAggregate({ userId: 'u' });
      const i = await fetcher.fetchVitanaIndexHistory({ tenantId: 't', userId: 'u' });
      expect(u.ok).toBe(false);
      expect(u.reason).toBe('boom-u');
      expect(a.ok).toBe(false);
      expect(a.reason).toBe('boom-a');
      expect(i.ok).toBe(false);
      expect(i.reason).toBe('boom-i');
    });
  });

  describe('happy path', () => {
    it('fetchAppUser maps a present row', async () => {
      const client = makeFakeClient({
        appUserRow: { user_id: 'u1', created_at: '2026-04-01T10:00:00Z' },
      });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      const r = await fetcher.fetchAppUser({ userId: 'u1' });
      expect(r.ok).toBe(true);
      expect(r.row).toEqual({ user_id: 'u1', created_at: '2026-04-01T10:00:00Z' });
    });

    it('fetchAppUser returns ok:true + row:null when user is missing', async () => {
      const client = makeFakeClient({ appUserRow: null });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      const r = await fetcher.fetchAppUser({ userId: 'missing' });
      expect(r.ok).toBe(true);
      expect(r.row).toBeNull();
    });

    it('fetchUserActiveDaysAggregate counts rows + picks head as last_active_date', async () => {
      const client = makeFakeClient({
        activeDaysRows: [
          { active_date: '2026-05-11' },
          { active_date: '2026-05-10' },
          { active_date: '2026-05-09' },
        ],
      });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      const r = await fetcher.fetchUserActiveDaysAggregate({ userId: 'u' });
      expect(r.ok).toBe(true);
      expect(r.aggregate.usage_days_count).toBe(3);
      expect(r.aggregate.last_active_date).toBe('2026-05-11');
    });

    it('fetchUserActiveDaysAggregate returns zero count + null when empty', async () => {
      const client = makeFakeClient({ activeDaysRows: [] });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      const r = await fetcher.fetchUserActiveDaysAggregate({ userId: 'u' });
      expect(r.ok).toBe(true);
      expect(r.aggregate.usage_days_count).toBe(0);
      expect(r.aggregate.last_active_date).toBeNull();
    });

    it('fetchVitanaIndexHistory maps rows', async () => {
      const client = makeFakeClient({
        indexRows: [
          { date: '2026-05-11', score_total: 312 },
          { date: '2026-05-10', score_total: 305 },
        ],
      });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      const r = await fetcher.fetchVitanaIndexHistory({ tenantId: 't', userId: 'u' });
      expect(r.ok).toBe(true);
      expect(r.rows).toEqual([
        { date: '2026-05-11', score_total: 312 },
        { date: '2026-05-10', score_total: 305 },
      ]);
    });
  });

  describe('limit clamping (fetchVitanaIndexHistory)', () => {
    it('default 30', async () => {
      let captured = -1;
      const client = makeFakeClient({ indexRows: [], captureIndexLimit: (n) => { captured = n; } });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      await fetcher.fetchVitanaIndexHistory({ tenantId: 't', userId: 'u' });
      expect(captured).toBe(30);
    });

    it('clamps > 365 to 365', async () => {
      let captured = -1;
      const client = makeFakeClient({ indexRows: [], captureIndexLimit: (n) => { captured = n; } });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      await fetcher.fetchVitanaIndexHistory({ tenantId: 't', userId: 'u', limit: 9999 });
      expect(captured).toBe(365);
    });

    it('clamps < 1 to 1', async () => {
      let captured = -1;
      const client = makeFakeClient({ indexRows: [], captureIndexLimit: (n) => { captured = n; } });
      const fetcher = createSupabaseJourneyStageFetcher({ getDb: (() => client) as any });
      await fetcher.fetchVitanaIndexHistory({ tenantId: 't', userId: 'u', limit: 0 });
      expect(captured).toBe(1);
    });
  });

  describe('row mappers', () => {
    it('mapAppUserRow handles a completely empty row', () => {
      expect(mapAppUserRow({})).toEqual({ user_id: '', created_at: '' });
    });

    it('mapVitanaIndexRow coerces negative to 0 and > 999 to 999', () => {
      expect(mapVitanaIndexRow({ date: '2026-05-11', score_total: -5 }).score_total).toBe(0);
      expect(mapVitanaIndexRow({ date: '2026-05-11', score_total: 1500 }).score_total).toBe(999);
    });

    it('mapVitanaIndexRow parses string score_total', () => {
      expect(mapVitanaIndexRow({ date: '2026-05-11', score_total: '425' }).score_total).toBe(425);
    });

    it('mapVitanaIndexRow returns 0 for unparseable score_total', () => {
      expect(mapVitanaIndexRow({ date: '2026-05-11', score_total: 'huh' }).score_total).toBe(0);
      expect(mapVitanaIndexRow({}).score_total).toBe(0);
    });
  });
});
