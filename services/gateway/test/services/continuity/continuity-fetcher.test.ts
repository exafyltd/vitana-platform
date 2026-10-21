/**
 * VTID-02932 (B2) — Supabase-backed ContinuityFetcher tests.
 *
 * Verifies:
 *   - Read-only interface — no mutator methods exposed (B2 wall).
 *   - DB unavailable / error → empty arrays + source_health flag.
 *   - Row mapping handles missing / wrong-type columns defensively.
 *   - Limit clamping (1..50).
 *   - Status filter passes through when provided.
 */

import {
  createSupabaseContinuityFetcher,
  mapThreadRow,
  mapPromiseRow,
} from '../../../src/services/continuity/continuity-fetcher';

function makeFakeClient(behavior: {
  threadsRows?: unknown[];
  promisesRows?: unknown[];
  threadsError?: unknown;
  promisesError?: unknown;
  captureStatusEq?: (table: string, status: string) => void;
  captureLimit?: (table: string, limit: number) => void;
}) {
  const client = {
    from(table: string) {
      const isThreads = table === 'user_open_threads';
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: string) {
          if (col === 'status' && behavior.captureStatusEq) {
            behavior.captureStatusEq(table, val);
          }
          return builder;
        },
        order() { return builder; },
        limit(n: number) {
          if (behavior.captureLimit) behavior.captureLimit(table, n);
          return builder;
        },
        async then(resolve: (v: unknown) => void) {
          if (isThreads) {
            resolve({
              data: behavior.threadsError ? null : (behavior.threadsRows ?? []),
              error: behavior.threadsError ?? null,
            });
          } else {
            resolve({
              data: behavior.promisesError ? null : (behavior.promisesRows ?? []),
              error: behavior.promisesError ?? null,
            });
          }
        },
      };
      return builder;
    },
  };
  return client;
}

describe('B2 — Supabase-backed ContinuityFetcher', () => {
  describe('read-only contract (B2 wall)', () => {
    it('ContinuityFetcher interface exposes ONLY listOpenThreads + listPromises', () => {
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => null) as any });
      const keys = Object.keys(fetcher).sort();
      expect(keys).toEqual(['listOpenThreads', 'listPromises']);
    });
  });

  describe('DB unavailable', () => {
    it('returns ok:false + empty rows + reason when getSupabase returns null', async () => {
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => null) as any });
      const t = await fetcher.listOpenThreads({ tenantId: 't', userId: 'u' });
      const p = await fetcher.listPromises({ tenantId: 't', userId: 'u' });
      expect(t.ok).toBe(false);
      expect(t.rows).toEqual([]);
      expect(t.reason).toBe('supabase_unconfigured');
      expect(p.ok).toBe(false);
      expect(p.rows).toEqual([]);
      expect(p.reason).toBe('supabase_unconfigured');
    });

    it('returns ok:false + empty rows + reason on Supabase error', async () => {
      const client = makeFakeClient({
        threadsError: { message: 'boom-threads' },
        promisesError: { message: 'boom-promises' },
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      const t = await fetcher.listOpenThreads({ tenantId: 't', userId: 'u' });
      const p = await fetcher.listPromises({ tenantId: 't', userId: 'u' });
      expect(t.ok).toBe(false);
      expect(t.rows).toEqual([]);
      expect(t.reason).toBe('boom-threads');
      expect(p.ok).toBe(false);
      expect(p.rows).toEqual([]);
      expect(p.reason).toBe('boom-promises');
    });
  });

  describe('happy path', () => {
    it('maps thread rows', async () => {
      const client = makeFakeClient({
        threadsRows: [{
          thread_id: 't1',
          topic: 'magnesium',
          summary: 'follow up on dosage',
          status: 'open',
          session_id_first: 's1',
          session_id_last: 's2',
          last_mentioned_at: '2026-05-10T12:00:00Z',
          resolved_at: null,
          created_at: '2026-05-01T12:00:00Z',
          updated_at: '2026-05-10T12:00:00Z',
        }],
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      const t = await fetcher.listOpenThreads({ tenantId: 't', userId: 'u' });
      expect(t.ok).toBe(true);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0].thread_id).toBe('t1');
      expect(t.rows[0].topic).toBe('magnesium');
      expect(t.rows[0].status).toBe('open');
    });

    it('maps promise rows', async () => {
      const client = makeFakeClient({
        promisesRows: [{
          promise_id: 'p1',
          thread_id: 't1',
          session_id: 's2',
          promise_text: 'remind me at 8pm',
          due_at: '2026-05-11T20:00:00Z',
          status: 'owed',
          decision_id: 'd1',
          kept_at: null,
          created_at: '2026-05-10T12:00:00Z',
          updated_at: '2026-05-10T12:00:00Z',
        }],
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      const p = await fetcher.listPromises({ tenantId: 't', userId: 'u' });
      expect(p.ok).toBe(true);
      expect(p.rows).toHaveLength(1);
      expect(p.rows[0].promise_id).toBe('p1');
      expect(p.rows[0].status).toBe('owed');
    });
  });

  describe('limit clamping', () => {
    it('clamps undefined → 20', async () => {
      let captured = -1;
      const client = makeFakeClient({
        threadsRows: [],
        captureLimit: (_table, n) => { captured = n; },
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      await fetcher.listOpenThreads({ tenantId: 't', userId: 'u' });
      expect(captured).toBe(20);
    });

    it('clamps > 50 to 50', async () => {
      let captured = -1;
      const client = makeFakeClient({
        threadsRows: [],
        captureLimit: (_table, n) => { captured = n; },
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      await fetcher.listOpenThreads({ tenantId: 't', userId: 'u', limit: 999 });
      expect(captured).toBe(50);
    });

    it('clamps < 1 to 1', async () => {
      let captured = -1;
      const client = makeFakeClient({
        promisesRows: [],
        captureLimit: (_table, n) => { captured = n; },
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      await fetcher.listPromises({ tenantId: 't', userId: 'u', limit: 0 });
      expect(captured).toBe(1);
    });
  });

  describe('status filter on listPromises', () => {
    it('passes status through to supabase when provided', async () => {
      let captured = '';
      const client = makeFakeClient({
        promisesRows: [],
        captureStatusEq: (_table, s) => { captured = s; },
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      await fetcher.listPromises({ tenantId: 't', userId: 'u', status: 'owed' });
      expect(captured).toBe('owed');
    });

    it('omits status filter when status is absent', async () => {
      const captured: string[] = [];
      const client = makeFakeClient({
        promisesRows: [],
        captureStatusEq: (_table, s) => { captured.push(s); },
      });
      const fetcher = createSupabaseContinuityFetcher({ getDb: (() => client) as any });
      await fetcher.listPromises({ tenantId: 't', userId: 'u' });
      expect(captured).toEqual([]);
    });
  });

  describe('mapThreadRow defensives', () => {
    it('handles a completely empty row', () => {
      const r = mapThreadRow({});
      expect(r.thread_id).toBe('');
      expect(r.topic).toBe('');
      expect(r.summary).toBeNull();
      expect(r.status).toBe('open');
      expect(r.session_id_first).toBeNull();
      expect(r.session_id_last).toBeNull();
      expect(r.last_mentioned_at).toBe('');
      expect(r.resolved_at).toBeNull();
    });

    it('coerces unknown status to "open"', () => {
      const r = mapThreadRow({ status: 'gibberish' });
      expect(r.status).toBe('open');
    });

    it('keeps known status values', () => {
      expect(mapThreadRow({ status: 'open' }).status).toBe('open');
      expect(mapThreadRow({ status: 'resolved' }).status).toBe('resolved');
      expect(mapThreadRow({ status: 'abandoned' }).status).toBe('abandoned');
    });
  });

  describe('mapPromiseRow defensives', () => {
    it('handles a completely empty row', () => {
      const r = mapPromiseRow({});
      expect(r.promise_id).toBe('');
      expect(r.thread_id).toBeNull();
      expect(r.session_id).toBeNull();
      expect(r.promise_text).toBe('');
      expect(r.due_at).toBeNull();
      expect(r.status).toBe('owed');
      expect(r.decision_id).toBeNull();
      expect(r.kept_at).toBeNull();
    });

    it('coerces unknown status to "owed"', () => {
      const r = mapPromiseRow({ status: 'pending' });
      expect(r.status).toBe('owed');
    });

    it('keeps known status values', () => {
      expect(mapPromiseRow({ status: 'owed' }).status).toBe('owed');
      expect(mapPromiseRow({ status: 'kept' }).status).toBe('kept');
      expect(mapPromiseRow({ status: 'broken' }).status).toBe('broken');
      expect(mapPromiseRow({ status: 'cancelled' }).status).toBe('cancelled');
    });
  });
});
