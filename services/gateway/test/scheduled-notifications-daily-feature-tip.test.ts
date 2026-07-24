// BOOTSTRAP-DAILY-FEATURE-TIP — HTTP tests for the automatic once-a-day
// "Did You Know" News Feed card cron endpoint.
//
// Contract under test (POST /api/v1/scheduled-notifications/daily-feature-tip):
//   - 400 without tenant_id
//   - happy path: advances did_you_know_state.last_index by 1, publishes a
//     tenant-wide feature_announcements row (variant='did-you-know-feature',
//     target_user_ids=null), fans out to every active tenant member
//   - rotation wraps around to index 0 once the tip list is exhausted
//   - 500 when the announcement insert fails

import express from 'express';
import request from 'supertest';

let mockSupabase: any;
const notifyUserAsyncMock = jest.fn();
const bulkGetUserLocalesMock = jest.fn();
let upsertedState: any = null;

jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: (...args: any[]) => notifyUserAsyncMock(...args),
  sendPushToUser: jest.fn(),
  sendAppilixPush: jest.fn(),
  TYPE_META: {},
}));

jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
  bulkGetUserLocales: (...args: any[]) => bulkGetUserLocalesMock(...args),
}));

jest.mock('../src/data/feature-tips', () => ({
  FEATURE_TIPS: [
    { key: 'tip-a', title: { en: 'Tip A', de: 'Tipp A' }, description: { en: 'Desc A', de: 'Beschr A' }, deepLink: '/a' },
    { key: 'tip-b', title: { en: 'Tip B', de: 'Tipp B' }, description: { en: 'Desc B', de: 'Beschr B' }, deepLink: '/b' },
  ],
}));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockSupabase,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/scheduled-notifications').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scheduled-notifications', router);
  return app;
}

function makeFakeSupabase(opts: {
  lastIndex: number | null;
  insertResult: { data: { id: string } | null; error: { message: string } | null };
  members: Array<{ user_id: string }>;
}) {
  upsertedState = null;
  return {
    from: (table: string) => {
      if (table === 'did_you_know_state') {
        const chain: any = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = () =>
          Promise.resolve({ data: opts.lastIndex === null ? null : { last_index: opts.lastIndex }, error: null });
        chain.upsert = (row: any) => {
          upsertedState = row;
          return Promise.resolve({ data: null, error: null });
        };
        return chain;
      }
      if (table === 'feature_announcements') {
        const chain: any = {};
        chain.insert = () => chain;
        chain.select = () => chain;
        chain.single = () => Promise.resolve(opts.insertResult);
        return chain;
      }
      if (table === 'user_tenants') {
        const chain: any = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        return Object.assign(chain, {
          then: (resolve: any) => resolve({ data: opts.members, error: null }),
        });
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  };
}

beforeEach(() => {
  notifyUserAsyncMock.mockClear();
  bulkGetUserLocalesMock.mockReset();
  bulkGetUserLocalesMock.mockResolvedValue(new Map([['u1', 'de'], ['u2', 'en']]));
});

describe('POST /daily-feature-tip', () => {
  it('400 without tenant_id', async () => {
    delete process.env.DEFAULT_TENANT_ID;
    mockSupabase = makeFakeSupabase({
      lastIndex: -1,
      insertResult: { data: { id: 'ann-1' }, error: null },
      members: [],
    });
    const r = await request(makeApp()).post('/api/v1/scheduled-notifications/daily-feature-tip').send({});
    expect(r.status).toBe(400);
  });

  it('advances rotation, publishes tenant-wide, and notifies every member', async () => {
    mockSupabase = makeFakeSupabase({
      lastIndex: 0, // tip-a already ran → next should be tip-b (index 1)
      insertResult: { data: { id: 'ann-1' }, error: null },
      members: [{ user_id: 'u1' }, { user_id: 'u2' }],
    });

    const r = await request(makeApp())
      .post('/api/v1/scheduled-notifications/daily-feature-tip')
      .send({ tenant_id: 'tenant-1' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, tip: 'tip-b', announcement_id: 'ann-1', dispatched: 2 });
    expect(upsertedState).toMatchObject({ tenant_id: 'tenant-1', last_index: 1 });
    expect(notifyUserAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('wraps around to index 0 once the tip list is exhausted', async () => {
    mockSupabase = makeFakeSupabase({
      lastIndex: 1, // tip-b (last in the 2-item mocked list) already ran
      insertResult: { data: { id: 'ann-2' }, error: null },
      members: [{ user_id: 'u1' }],
    });

    const r = await request(makeApp())
      .post('/api/v1/scheduled-notifications/daily-feature-tip')
      .send({ tenant_id: 'tenant-1' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, tip: 'tip-a' });
    expect(upsertedState).toMatchObject({ tenant_id: 'tenant-1', last_index: 0 });
  });

  it('500 when the announcement insert fails', async () => {
    mockSupabase = makeFakeSupabase({
      lastIndex: -1,
      insertResult: { data: null, error: { message: 'boom' } },
      members: [],
    });

    const r = await request(makeApp())
      .post('/api/v1/scheduled-notifications/daily-feature-tip')
      .send({ tenant_id: 'tenant-1' });

    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });
});
