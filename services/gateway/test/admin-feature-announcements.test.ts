// BOOTSTRAP-FEATURE-ANNOUNCEMENTS — HTTP tests for the admin endpoint that
// publishes News Feed "Brand New Feature" / "Did You Know" cards and fans
// out the accompanying in-app + push notification.
//
// Contract under test (POST /api/v1/admin/feature-announcements):
//   - auth: 401 without an identity, 403 for a non-exafy-admin identity
//   - validation: 400 when required fields are missing
//   - happy path (tenant-wide): writes the row with target_user_ids=null,
//     resolves every tenant member, notifies all of them
//   - happy path (staged test send): recipient_ids scopes both the row's
//     target_user_ids and the notification fan-out to just those users,
//     without querying user_tenants
//   - error path: 500 when the insert fails

import express from 'express';
import request from 'supertest';

let mockSupabase: any;
const notifyUsersAsyncMock = jest.fn();
const bulkGetUserLocalesMock = jest.fn();

// Mirrors the real two-stage contract: requireAuth verifies the token and
// sets req.identity; requireExafyAdmin only checks it (must run after).
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (h === 'Bearer admin') {
      req.identity = { user_id: 'admin-1', email: 'admin@exafy.io', exafy_admin: true };
      return next();
    }
    if (h === 'Bearer user') {
      req.identity = { user_id: 'user-1', email: 'user@example.com', exafy_admin: false };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  },
  requireExafyAdmin: (req: any, res: any, next: any) => {
    if (!req.identity) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (!req.identity.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    return next();
  },
}));

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

jest.mock('../src/services/notification-service', () => ({
  notifyUsersAsync: (...args: any[]) => notifyUsersAsyncMock(...args),
}));

jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: (...args: any[]) => bulkGetUserLocalesMock(...args),
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/admin-feature-announcements').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/feature-announcements', router);
  return app;
}

/** Chainable fake covering feature_announcements insert+update and user_tenants select. */
function makeFakeSupabase(opts: {
  insertResult: { data: { id: string } | null; error: { message: string } | null };
  membersResult?: { data: { user_id: string }[] | null; error: { message: string } | null };
}) {
  return {
    from: (table: string) => {
      if (table === 'feature_announcements') {
        const chain: any = {};
        chain.insert = () => chain;
        chain.select = () => chain;
        chain.single = () => Promise.resolve(opts.insertResult);
        chain.update = () => chain;
        chain.eq = () => Promise.resolve({ data: null, error: null });
        return chain;
      }
      if (table === 'user_tenants') {
        const chain: any = {};
        chain.select = () => chain;
        chain.eq = () => Promise.resolve(opts.membersResult ?? { data: [], error: null });
        return chain;
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  };
}

const VALID_BODY = {
  tenant_id: 'tenant-1',
  variant: 'brand-new-feature',
  feature_title: { en: 'Tag Members in Posts', de: 'Mitglieder in Beiträgen markieren' },
  description: { en: 'You can now tag members.', de: 'Du kannst jetzt Mitglieder markieren.' },
  deep_link: '/home?compose=1',
};

beforeEach(() => {
  notifyUsersAsyncMock.mockClear();
  bulkGetUserLocalesMock.mockReset();
  bulkGetUserLocalesMock.mockResolvedValue(new Map());
  mockSupabase = makeFakeSupabase({ insertResult: { data: { id: 'ann-1' }, error: null } });
});

describe('POST /api/v1/admin/feature-announcements — auth', () => {
  it('401 without token', async () => {
    const r = await request(makeApp()).post('/api/v1/admin/feature-announcements').send(VALID_BODY);
    expect(r.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/feature-announcements')
      .set('Authorization', 'Bearer user')
      .send(VALID_BODY);
    expect(r.status).toBe(403);
  });
});

describe('POST /api/v1/admin/feature-announcements — validation', () => {
  it('400 when required fields are missing', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/feature-announcements')
      .set('Authorization', 'Bearer admin')
      .send({ tenant_id: 'tenant-1' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('400 for an unknown variant', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/feature-announcements')
      .set('Authorization', 'Bearer admin')
      .send({ ...VALID_BODY, variant: 'not-a-real-variant' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/v1/admin/feature-announcements — happy paths', () => {
  it('publishes tenant-wide and notifies every member', async () => {
    mockSupabase = makeFakeSupabase({
      insertResult: { data: { id: 'ann-1' }, error: null },
      membersResult: { data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null },
    });
    bulkGetUserLocalesMock.mockResolvedValue(new Map([['u1', 'de'], ['u2', 'en']]));

    const r = await request(makeApp())
      .post('/api/v1/admin/feature-announcements')
      .set('Authorization', 'Bearer admin')
      .send(VALID_BODY);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, announcement_id: 'ann-1', test_send: false, sent_to: 2 });
    // One notifyUsersAsync call per locale group (de: [u1], en: [u2]).
    expect(notifyUsersAsyncMock).toHaveBeenCalledTimes(2);
    const calledUserIdGroups = notifyUsersAsyncMock.mock.calls.map((c: any[]) => c[0]);
    expect(calledUserIdGroups.flat().sort()).toEqual(['u1', 'u2']);
  });

  it('staged test send scopes to recipient_ids and skips the tenant-wide lookup', async () => {
    bulkGetUserLocalesMock.mockResolvedValue(new Map([['me-1', 'de']]));

    const r = await request(makeApp())
      .post('/api/v1/admin/feature-announcements')
      .set('Authorization', 'Bearer admin')
      .send({ ...VALID_BODY, recipient_ids: ['me-1'] });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, test_send: true, sent_to: 1 });
    expect(notifyUsersAsyncMock).toHaveBeenCalledTimes(1);
    expect(notifyUsersAsyncMock.mock.calls[0][0]).toEqual(['me-1']);
  });
});

describe('POST /api/v1/admin/feature-announcements — error path', () => {
  it('500 when the insert fails', async () => {
    mockSupabase = makeFakeSupabase({ insertResult: { data: null, error: { message: 'boom' } } });

    const r = await request(makeApp())
      .post('/api/v1/admin/feature-announcements')
      .set('Authorization', 'Bearer admin')
      .send(VALID_BODY);

    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });
});
