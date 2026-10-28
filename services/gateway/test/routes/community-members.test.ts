/**
 * Tests for src/routes/community-members.ts (VTID-DANCE-D4 directory,
 * hardened under VTID-03992):
 *
 *   GET /community/members         — paginated member list
 *   GET /community/members/count   — total count
 *
 * VTID-03992 found this route had no exclusion for registered test/
 * service/automation accounts (service_bot_accounts / notification_test_
 * actors) — confirmed live in production, the two VTID-03990 bot accounts
 * were literally the #1 and #2 results of the default "newest" sort. This
 * suite pins the fix, plus a pre-existing bug caught in the same pass: the
 * `?dance=` filter branch re-filtered from the RAW rows, silently undoing
 * both the hidden-profile filter and the new bot exclusion.
 */

import request from 'supertest';
import express from 'express';
import communityMembersRouter from '../../src/routes/community-members';

const FIXED_IDENTITY = { user_id: 'real-user-1', tenant_id: 'tenant-1' };

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = FIXED_IDENTITY;
    next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
}));

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

function memberRow(userId: string, overrides: Record<string, any> = {}) {
  return {
    user_id: userId,
    vitana_id: `VIT-${userId}`,
    registration_seq: 1,
    display_name: `Member ${userId}`,
    full_name: null,
    avatar_url: null,
    location: null,
    dance_preferences: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Minimal thenable Supabase query-builder fake, keyed by table name. */
function makeFakeSupabase(resultsByTable: Record<string, { data?: any; error?: any; count?: number }>) {
  return {
    from(table: string) {
      const result = resultsByTable[table] || { data: [], error: null };
      const chain: any = {};
      const self = () => chain;
      chain.select = self;
      chain.neq = self;
      chain.eq = self;
      chain.order = self;
      chain.lt = self;
      chain.gt = self;
      chain.limit = self;
      chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
      return chain;
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', communityMembersRouter);
  return app;
}

describe('GET /api/v1/community/members', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes registered service/test accounts (VTID-03992) alongside hidden profiles', async () => {
    mockGetSupabase.mockReturnValue(
      makeFakeSupabase({
        global_community_profiles: { data: [{ user_id: 'hidden-1' }], error: null },
        service_bot_accounts: { data: [{ user_id: 'bot-1' }], error: null },
        notification_test_actors: { data: [{ user_id: 'test-1' }], error: null },
        profiles: {
          data: [
            memberRow('hidden-1', { registration_seq: 4 }),
            memberRow('bot-1', { registration_seq: 3 }),
            memberRow('test-1', { registration_seq: 2 }),
            memberRow('real-2', { registration_seq: 1 }),
          ],
          error: null,
        },
      }),
    );

    const res = await request(buildApp()).get('/api/v1/community/members');

    expect(res.status).toBe(200);
    const ids = res.body.members.map((m: any) => m.vitana_id);
    expect(ids).toEqual(['VIT-real-2']);
  });

  it('the dance filter does not resurrect hidden or excluded members', async () => {
    mockGetSupabase.mockReturnValue(
      makeFakeSupabase({
        global_community_profiles: { data: [{ user_id: 'hidden-1' }], error: null },
        service_bot_accounts: { data: [{ user_id: 'bot-1' }], error: null },
        notification_test_actors: { data: [], error: null },
        profiles: {
          data: [
            memberRow('hidden-1', { dance_preferences: { varieties: ['salsa'] } }),
            memberRow('bot-1', { dance_preferences: { varieties: ['salsa'] } }),
            memberRow('real-2', { dance_preferences: { varieties: ['salsa'] } }),
          ],
          error: null,
        },
      }),
    );

    const res = await request(buildApp()).get('/api/v1/community/members?dance=salsa');

    expect(res.status).toBe(200);
    const ids = res.body.members.map((m: any) => m.vitana_id);
    expect(ids).toEqual(['VIT-real-2']);
  });
});

describe('GET /api/v1/community/members/count', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('subtracts both hidden profiles and registered test/service accounts from the total', async () => {
    mockGetSupabase.mockReturnValue(
      makeFakeSupabase({
        global_community_profiles: { data: [{ user_id: 'hidden-1' }], error: null },
        service_bot_accounts: { data: [{ user_id: 'bot-1' }, { user_id: 'bot-2' }], error: null },
        notification_test_actors: { data: [], error: null },
        profiles: { data: null, error: null, count: 10 },
      }),
    );

    const res = await request(buildApp()).get('/api/v1/community/members/count');

    expect(res.status).toBe(200);
    // 10 total (already excludes self) - 1 hidden - 2 bots = 7
    expect(res.body.total).toBe(7);
  });
});
