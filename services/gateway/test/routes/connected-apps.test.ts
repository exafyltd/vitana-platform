/**
 * VTID-04402 — /api/v1/connected-apps route handlers: auth, caller scoping,
 * unknown ids, happy paths, hub refusals and thrown errors. The hub itself is
 * pinned in test/vtid-04402-connected-apps.test.ts.
 */
import express from 'express';
import request from 'supertest';

describe('connected-apps routes', () => {
  function app(identity: any, hubMock: Record<string, jest.Mock>) {
    jest.resetModules();
    jest.doMock('../../src/middleware/auth-supabase-jwt', () => ({
      requireAuth: (req: any, res: any, next: any) => {
        if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
        req.identity = identity;
        next();
      },
    }));
    jest.doMock('../../src/services/connected-apps/hub', () => hubMock);
    const router = require('../../src/routes/connected-apps').default;
    const a = express();
    a.use(express.json());
    a.use('/x', router);
    return a;
  }
  afterEach(() => {
    jest.dontMock('../../src/middleware/auth-supabase-jwt');
    jest.dontMock('../../src/services/connected-apps/hub');
  });

  it('needs a verified member', async () => {
    const r = await request(app(null, {})).get('/x');
    expect(r.status).toBe(401);
  });

  it('acts only for the caller, rejects unknown apps, passes Apple credentials through', async () => {
    const connectApp = jest.fn(async () => ({ ok: true, status: 'on' }));
    const listApps = jest.fn(async () => [{ id: 'gmail', status: 'on' }]);
    const a = app({ user_id: 'me', tenant_id: 't1' }, { connectApp, listApps, disconnectApp: jest.fn(), syncApp: jest.fn(), importDeviceContacts: jest.fn() });
    expect((await request(a).post('/x/nope/connect')).status).toBe(404);
    const r = await request(a).post('/x/apple-mail/connect').send({ apple_id: 'me@icloud.com', app_password: 'p', user_id: 'victim' });
    expect(r.status).toBe(200);
    expect(connectApp).toHaveBeenCalledWith('me', 't1', 'apple-mail', expect.objectContaining({ appleId: 'me@icloud.com', appPassword: 'p' }));
    expect((await request(a).get('/x')).body).toEqual({ ok: true, apps: [{ id: 'gmail', status: 'on' }] });
  });

  it('sync refuses an app that is off', async () => {
    const syncApp = jest.fn();
    const a = app({ user_id: 'me' }, { listApps: jest.fn(async () => [{ id: 'google-contacts', status: 'off' }]), syncApp, connectApp: jest.fn(), disconnectApp: jest.fn(), importDeviceContacts: jest.fn() });
    const r = await request(a).post('/x/google-contacts/sync');
    expect(r.status).toBe(409);
    expect(syncApp).not.toHaveBeenCalled();
  });

  it('disconnect forwards remove_data only when it is exactly true', async () => {
    const disconnectApp = jest.fn(async () => ({ ok: true }));
    const a = app({ user_id: 'me' }, { disconnectApp, listApps: jest.fn(), syncApp: jest.fn(), connectApp: jest.fn(), importDeviceContacts: jest.fn() });
    expect((await request(a).post('/x/iphone-contacts/disconnect').send({ remove_data: true })).status).toBe(200);
    await request(a).post('/x/iphone-contacts/disconnect').send({ remove_data: 'yes' });
    expect(disconnectApp).toHaveBeenNthCalledWith(1, 'me', 'iphone-contacts', { removeData: true });
    expect(disconnectApp).toHaveBeenNthCalledWith(2, 'me', 'iphone-contacts', { removeData: false });
    expect((await request(a).post('/x/nope/disconnect')).status).toBe(404);
  });

  it('android import is not read as an app id, and hub refusals keep their status', async () => {
    const importDeviceContacts = jest.fn(async (_u: string, c: any[]) => (c.length ? { ok: true, result: { imported: c.length } } : { ok: false, error: 'no_contacts', status: 400 }));
    const a = app({ user_id: 'me' }, { importDeviceContacts, listApps: jest.fn(), syncApp: jest.fn(), connectApp: jest.fn(), disconnectApp: jest.fn() });
    const ok = await request(a).post('/x/android-contacts/import').send({ contacts: [{ name: ['Ana'] }] });
    expect(ok.body).toEqual({ ok: true, result: { imported: 1 } });
    expect(importDeviceContacts).toHaveBeenCalledWith('me', [{ name: ['Ana'] }]);
    expect((await request(a).post('/x/android-contacts/import').send({})).status).toBe(400);
  });

  it('a thrown hub error is a 500 JSON body, never a leaked message', async () => {
    const connectApp = jest.fn(async () => { throw new Error('db down: secret detail'); });
    const a = app({ user_id: 'me', tenant_id: 't1' }, { connectApp, listApps: jest.fn(), syncApp: jest.fn(), disconnectApp: jest.fn(), importDeviceContacts: jest.fn() });
    const r = await request(a).post('/x/gmail/connect');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'internal_error' });
  });

  it('a failed sync is a 502 with the hub result', async () => {
    const syncApp = jest.fn(async () => ({ ok: false, error: 'upstream' }));
    const a = app({ user_id: 'me' }, { listApps: jest.fn(async () => [{ id: 'outlook-calendar', status: 'on' }]), syncApp, connectApp: jest.fn(), disconnectApp: jest.fn(), importDeviceContacts: jest.fn() });
    const r = await request(a).post('/x/outlook-calendar/sync');
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ ok: false, error: 'upstream' });
  });
});
