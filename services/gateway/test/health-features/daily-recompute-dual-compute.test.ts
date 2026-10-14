/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the dual-compute as the FINAL step of
 * the existing daily recompute batch (plan Change 11), through the real
 * processDailyRecomputeBatch over a fake PostgREST (fetch):
 *   - it runs after every user's stages, only for users whose `index` stage
 *     ended `success` for the run date (executePipelineForUser now reports the
 *     per-stage status map);
 *   - it never changes ok / processed / failed / next_cursor — not when it
 *     fails, throws or runs out of budget;
 *   - it is a no-op (no `dual_compute` field, never called) with the flag unset
 *     or on staging.
 */
const mockRun = jest.fn();
jest.mock('../../src/services/health-features/index-dual-compute', () => {
  const actual = jest.requireActual('../../src/services/health-features/index-dual-compute');
  return { ...actual, defaultDualComputeDeps: () => ({}), runIndexDualComputeForBatch: (...a: unknown[]) => mockRun(...a) };
});
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../src/services/notification-service', () => ({ notifyUserAsync: jest.fn() }));
jest.mock('../../src/services/proactive-match-messenger', () => ({ sendProactiveMatchMessages: jest.fn(async () => undefined) }));

import { processDailyRecomputeBatch } from '../../src/services/daily-recompute-service';

const T = '10000000-0000-0000-0000-000000000001';
const DATE = '2026-10-13';
const order: string[] = [];
let users: Array<{ user_id: string; needs_processing: boolean }>;
/** user -> stage that fails (or none); 'done' = run already completed. */
let failAt: Record<string, string | 'done' | undefined>;

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const SAVED = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  process.env = { ...SAVED, SUPABASE_URL: 'http://pg', SUPABASE_SERVICE_ROLE: 'k' };
  users = [
    { user_id: 'u-ok', needs_processing: true },
    { user_id: 'u-index-failed', needs_processing: true },
    { user_id: 'u-matches-failed', needs_processing: true },
    { user_id: 'u-done', needs_processing: true },
    { user_id: 'u-skip', needs_processing: false },
  ];
  failAt = { 'u-index-failed': 'index', 'u-matches-failed': 'matches', 'u-done': 'done' };
  mockRun.mockImplementation(async () => {
    order.push('dual_compute');
    return { compared: 1, failed: 0, skipped_budget: 0, skipped_index: 0 };
  });
  global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.endsWith('/rpc/scheduler_get_users_batch')) return json(users);
    if (u.includes('/daily_recompute_runs?') && (!init?.method || init.method === 'GET')) {
      const userId = /user_id=eq\.([^&]+)/.exec(u)![1];
      if (failAt[userId] === 'done') {
        return json([{ id: `run-${userId}`, status: 'completed', started_at: new Date().toISOString(), stage_status: { index: { status: 'success' } } }]);
      }
      return json([]);
    }
    if (u.endsWith('/daily_recompute_runs') && init?.method === 'POST') {
      const body = JSON.parse(init.body!);
      return json([{ ...body }], 201);
    }
    if (u.includes('/daily_recompute_runs?id=eq.')) return json({});
    const m = /\/rpc\/(scheduler_\w+)$/.exec(u);
    if (m) {
      const userId = JSON.parse(init!.body!).p_user_id as string;
      const stage = { scheduler_vitana_index_compute_daily: 'index', scheduler_longevity_compute_daily: 'longevity', scheduler_topics_recompute_user_profile: 'topics', scheduler_community_recompute_recommendations: 'community_recs', scheduler_match_recompute_daily: 'matches' }[m[1]]!;
      order.push(`${userId}:${stage}`);
      return json(failAt[userId] === stage ? { ok: false, error: 'boom' } : { ok: true });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
});
afterAll(() => {
  process.env = SAVED;
});

const BASE = { tenant_id: T, date: DATE, limit_users: 5 };

describe('the final step of the daily recompute (Change 11)', () => {
  it('runs last, after every user\'s stages, with each user\'s index outcome', async () => {
    process.env.VITANA_INDEX_DUAL_COMPUTE_ENABLED = 'true';
    const res = await processDailyRecomputeBatch({ ...BASE, cursor: null });
    expect(order[order.length - 1]).toBe('dual_compute');
    expect(order.filter((x) => x === 'dual_compute')).toHaveLength(1);
    const arg = mockRun.mock.calls[0][1];
    expect(arg).toEqual({
      tenant_id: T,
      run_date: DATE,
      first_batch: true,
      users: [
        { user_id: 'u-ok', index_ok: true },
        { user_id: 'u-index-failed', index_ok: false },
        { user_id: 'u-matches-failed', index_ok: true },
        { user_id: 'u-done', index_ok: true },
      ],
    });
    expect(res).toMatchObject({ ok: false, processed: 2, skipped: 1, failed: 2, next_cursor: 'u-skip', dual_compute: { compared: 1, failed: 0 } });
    // a later batch is not the first one
    await processDailyRecomputeBatch({ ...BASE, cursor: 'u-skip' });
    expect(mockRun.mock.calls[1][1].first_batch).toBe(false);
  });

  it('never changes ok / processed / failed / next_cursor — failed, throwing or over budget', async () => {
    const reference = await processDailyRecomputeBatch({ ...BASE, cursor: null }); // flag off
    const pick = (r: Record<string, unknown>) => ({ ok: r.ok, processed: r.processed, skipped: r.skipped, failed: r.failed, next_cursor: r.next_cursor, run_ids: (r.run_ids as string[]).length, errors: r.errors });
    process.env.VITANA_INDEX_DUAL_COMPUTE_ENABLED = 'true';
    for (const impl of [
      async () => ({ compared: 0, failed: 4, skipped_budget: 0, skipped_index: 0 }),
      async () => ({ compared: 1, failed: 0, skipped_budget: 3, skipped_index: 0 }),
      async () => {
        throw new Error('boom');
      },
    ]) {
      mockRun.mockImplementationOnce(impl);
      const r = await processDailyRecomputeBatch({ ...BASE, cursor: null });
      expect(pick(r as never)).toEqual(pick(reference as never));
    }
  });

  it('flag unset or staging: never called, no dual_compute field', async () => {
    for (const env of [{}, { VITANA_INDEX_DUAL_COMPUTE_ENABLED: 'TRUE' }, { VITANA_INDEX_DUAL_COMPUTE_ENABLED: 'true', VITANA_ENV: 'staging' }]) {
      Object.assign(process.env, env);
      const r = await processDailyRecomputeBatch({ ...BASE, cursor: null });
      expect(r).not.toHaveProperty('dual_compute');
      delete process.env.VITANA_INDEX_DUAL_COMPUTE_ENABLED;
      delete process.env.VITANA_ENV;
    }
    expect(mockRun).not.toHaveBeenCalled();
  });
});
