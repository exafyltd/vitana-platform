import request from 'supertest';
import express, { Express } from 'express';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-1', tenant_id: 'tenant-1' };
    next();
  }),
  requireTenant: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: jest.fn() })),
}));

import { isFeatureLive } from '../../src/services/feature-flags';
import realtimeRelayRouter from '../../src/routes/realtime-relay';

describe.each([
  { path: '/realtime/user-notifications/stream', flag: 'REALTIME_RELAY_USER_NOTIFICATIONS' },
  { path: '/realtime/user-activity-log/stream', flag: 'REALTIME_RELAY_USER_ACTIVITY_LOG' },
  { path: '/realtime/chat-messages/stream', flag: 'REALTIME_RELAY_CHAT_MESSAGES' },
])('GET $path', ({ path, flag }) => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/realtime', realtimeRelayRouter);
  });

  it('returns 404 not_enabled when the feature flag is off, without opening an SSE stream', async () => {
    (isFeatureLive as jest.Mock).mockReturnValue(false);

    const res = await request(app).get(path);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not_enabled' });
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);
  });

  it('checks the correct per-table flag before doing anything auth-scoped', async () => {
    (isFeatureLive as jest.Mock).mockReturnValue(false);
    await request(app).get(path);
    expect(isFeatureLive).toHaveBeenCalledWith(flag);
  });
});
