/**
 * Route tests for POST /api/v1/celebrations/dispatch.
 *
 * Mocks: supabase (in-memory user_notifications for dedupe), auth middleware
 * (injects a fixed identity), notifyUserAsync (captures the dispatch),
 * oasis-event-service (no-op), getUserLocale (fixed 'de').
 *
 * Covers: auth-injected user, invalid kind → 400, missing dedupe_key → 400,
 * happy path → dispatched:1 with localized title/body, dedupe → skipped.
 */

import express from 'express';
import request from 'supertest';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_TENANT_ID = '22222222-2222-2222-2222-222222222222';

// In-memory store for the supabase mock. Each test resets it.
const store: { user_notifications: Array<any> } = { user_notifications: [] };

const notifyUserAsyncMock = jest.fn();
const emitOasisMock = jest.fn().mockResolvedValue({ ok: true });

// Inline supabase mock: just enough surface for the route's dedupe read.
function makeSupaMock() {
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let payloadFilter: { col: string; val: any } | null = null;
    const chain: any = {
      select() { return chain; },
      eq(col: string, val: any) { filters[col] = val; return chain; },
      gte(_col: string, _val: any) { return chain; },
      filter(col: string, _op: string, val: any) {
        // route uses .filter('data->>dedupe_key', 'eq', dedupe_key)
        payloadFilter = { col, val };
        return chain;
      },
      limit() { return chain; },
      async maybeSingle() {
        if (table !== 'user_notifications') return { data: null, error: null };
        const dedupeKey = payloadFilter?.val;
        const hit = store.user_notifications.find(
          (r) =>
            r.user_id === filters.user_id &&
            r.tenant_id === filters.tenant_id &&
            r.type === filters.type &&
            r.data?.dedupe_key === dedupeKey,
        );
        return { data: hit ? { id: hit.id } : null, error: null };
      },
      async insert(row: any) {
        store.user_notifications.push({ id: `row-${store.user_notifications.length}`, ...row });
        return { data: null, error: null };
      },
    };
    return chain;
  }
  return { from: builder };
}

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => makeSupaMock(),
}));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: TEST_USER_ID, tenant_id: TEST_TENANT_ID };
    next();
  },
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: notifyUserAsyncMock,
  TYPE_META: {
    daily_goal_celebration: { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
    phase_milestone_celebration: { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
    progress_milestone_celebration: { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  },
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: emitOasisMock,
}));

jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
}));

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-key';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const celebrationsRouter = require('../src/routes/celebrations').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/celebrations', celebrationsRouter);
  return app;
}

describe('POST /api/v1/celebrations/dispatch', () => {
  beforeEach(() => {
    store.user_notifications = [];
    notifyUserAsyncMock.mockClear();
    emitOasisMock.mockClear();
  });

  it('rejects unknown kind with 400', async () => {
    const res = await request(makeApp())
      .post('/api/v1/celebrations/dispatch')
      .send({ kind: 'nope', dedupe_key: '2026-06-05' });
    expect(res.status).toBe(400);
    expect(res.body.skipped).toBe('unknown_kind');
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });

  it('rejects missing dedupe_key with 400', async () => {
    const res = await request(makeApp())
      .post('/api/v1/celebrations/dispatch')
      .send({ kind: 'daily_goal' });
    expect(res.status).toBe(400);
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });

  it('happy path: daily_goal dispatches a localized push and emits OASIS', async () => {
    const res = await request(makeApp())
      .post('/api/v1/celebrations/dispatch')
      .send({ kind: 'daily_goal', dedupe_key: '2026-06-05' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, dispatched: 1 });
    expect(notifyUserAsyncMock).toHaveBeenCalledTimes(1);
    const [userId, tenantId, type, payload] = notifyUserAsyncMock.mock.calls[0];
    expect(userId).toBe(TEST_USER_ID);
    expect(tenantId).toBe(TEST_TENANT_ID);
    expect(type).toBe('daily_goal_celebration');
    expect(payload.title).toMatch(/Heutiges Ziel geschafft/);
    expect(payload.data.kind).toBe('daily_goal');
    expect(payload.data.dedupe_key).toBe('2026-06-05');
    expect(payload.data.url).toBe('/autopilot');
    expect(emitOasisMock).toHaveBeenCalledTimes(1);
  });

  it('phase_milestone interpolates the phase param into the body', async () => {
    const res = await request(makeApp())
      .post('/api/v1/celebrations/dispatch')
      .send({ kind: 'phase_milestone', dedupe_key: 'phase:3', extra: { phase: 'Rhythmus' } });
    expect(res.status).toBe(200);
    const payload = notifyUserAsyncMock.mock.calls[0][3];
    expect(payload.body).toContain('Rhythmus');
    expect(payload.data.phase).toBe('Rhythmus');
  });

  it('dedupes a second call with the same dedupe_key', async () => {
    const app = makeApp();
    // 1st call lands the row (the dedupe lookup found nothing).
    await request(app)
      .post('/api/v1/celebrations/dispatch')
      .send({ kind: 'progress_50', dedupe_key: 'progress:50' });
    // Simulate that notifyUserAsync wrote the canonical user_notifications
    // row (in production that's done inside notifyUser). The dedupe path
    // doesn't care who wrote the row, only that it exists.
    store.user_notifications.push({
      id: 'fake',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      type: 'progress_milestone_celebration',
      data: { dedupe_key: 'progress:50' },
    });
    notifyUserAsyncMock.mockClear();

    const res = await request(app)
      .post('/api/v1/celebrations/dispatch')
      .send({ kind: 'progress_50', dedupe_key: 'progress:50' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, dispatched: 0, skipped: 'already_sent' });
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });
});
