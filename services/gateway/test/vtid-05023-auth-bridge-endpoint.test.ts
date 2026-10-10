/**
 * VTID-05023 part 4, layer (b): POST /api/v1/internal/auth-bridge/user-event —
 * the auth.users webhook that replaces Supabase's six sign-up triggers.
 * Pins: service-token auth (fail closed), INSERT / confirm-UPDATE provisioning
 * with active_tenant_id written back only when missing, other UPDATEs ignored,
 * DELETE cleanup, idempotency, and loud failures.
 */

import express from 'express';
import request from 'supertest';
import authBridgeRouter from '../src/routes/auth-bridge';
import { setAuthBridgeDepsForTests } from '../src/services/auth-bridge/auth-bridge';
import { FakeAuthBridge, TENANT } from './auth-bridge/fake-auth-bridge';

const TOKEN = 'svc-token-for-tests';
const UID = '10000000-0000-0000-0000-000000000001';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/internal/auth-bridge', authBridgeRouter);
  return a;
}

function insertEvent(extra: Record<string, unknown> = {}) {
  return {
    type: 'INSERT',
    schema: 'auth',
    table: 'users',
    record: {
      id: UID,
      email: 'alice@example.com',
      raw_user_meta_data: { tenant_slug: 'maxina', full_name: 'Alice Example' },
      raw_app_meta_data: { provider: 'email' },
      created_at: '2026-10-20T10:00:00Z',
      email_confirmed_at: null,
      ...extra,
    },
    old_record: null,
  };
}

const post = (body: unknown, token: string | null = TOKEN) => {
  const r = request(app()).post('/api/v1/internal/auth-bridge/user-event');
  return (token === null ? r : r.set('Authorization', `Bearer ${token}`)).send(body as object);
};

describe('VTID-05023 auth-bridge webhook endpoint', () => {
  let fake: FakeAuthBridge;
  const savedToken = process.env.GATEWAY_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = TOKEN;
    fake = new FakeAuthBridge();
    setAuthBridgeDepsForTests(fake.deps());
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    setAuthBridgeDepsForTests(null);
    process.env.GATEWAY_SERVICE_TOKEN = savedToken;
    jest.restoreAllMocks();
  });

  describe('auth', () => {
    it('401 without a bearer token', async () => {
      const res = await post(insertEvent(), null);
      expect(res.status).toBe(401);
      expect(fake.ensureCalls).toHaveLength(0);
    });

    it('401 with a wrong token', async () => {
      const res = await post(insertEvent(), 'not-the-token');
      expect(res.status).toBe(401);
      expect(fake.ensureCalls).toHaveLength(0);
    });

    it('401 for every call when GATEWAY_SERVICE_TOKEN is unset (fail closed, even for an empty bearer)', async () => {
      delete process.env.GATEWAY_SERVICE_TOKEN;
      expect((await post(insertEvent(), TOKEN)).status).toBe(401);
      expect((await post(insertEvent(), '')).status).toBe(401);
      expect(fake.ensureCalls).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('400 on an unknown event type or a non-uuid id', async () => {
      expect((await post({ type: 'TRUNCATE', record: null })).status).toBe(400);
      expect((await post(insertEvent({ id: 'not-a-uuid' }))).status).toBe(400);
      expect((await post({ type: 'DELETE', record: null, old_record: null })).status).toBe(400);
      expect(fake.ensureCalls).toHaveLength(0);
    });

    it('503 when the gateway has no Supabase service credentials', async () => {
      setAuthBridgeDepsForTests(null);
      const savedUrl = process.env.SUPABASE_URL;
      delete process.env.SUPABASE_URL;
      try {
        const res = await post(insertEvent());
        expect(res.status).toBe(503);
      } finally {
        process.env.SUPABASE_URL = savedUrl;
      }
    });
  });

  describe('INSERT', () => {
    it('provisions the new member from the webhook record and writes active_tenant_id back', async () => {
      const res = await post(insertEvent());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, action: 'provisioned', user_id: UID });
      expect(fake.ensureCalls).toHaveLength(1);
      expect(fake.ensureCalls[0]).toEqual({
        id: UID,
        email: 'alice@example.com',
        user_metadata: { tenant_slug: 'maxina', full_name: 'Alice Example' },
        app_metadata: { provider: 'email' },
        created_at: '2026-10-20T10:00:00Z',
        email_confirmed_at: null,
      });
      expect(fake.appUsers.has(UID)).toBe(true);
      expect(fake.appMetadataWrites).toEqual([{ id: UID, tenant: TENANT }]);
    });

    it('never overwrites an active_tenant_id the user already has', async () => {
      const res = await post(insertEvent({ raw_app_meta_data: { active_tenant_id: '00000000-0000-0000-0000-0000000000a9' } }));
      expect(res.status).toBe(200);
      expect(fake.appMetadataWrites).toHaveLength(0);
    });

    it('is idempotent: a repeated INSERT (or a lazy-hook race) creates nothing more', async () => {
      await post(insertEvent());
      const again = await post(insertEvent());
      expect(again.status).toBe(200);
      expect(again.body.action).toBe('already_provisioned');
      expect(again.body.result.created).toEqual([]);
      expect([...fake.appUsers]).toEqual([UID]);
    });

    it('a member the lazy db-pre-request hook already provisioned is reported as such', async () => {
      fake.seedProvisioned(UID);
      const res = await post(insertEvent());
      expect(res.body.action).toBe('already_provisioned');
    });

    it('500 and a logged error when provisioning fails (the reconciler retries)', async () => {
      fake.failEnsureFor.add(UID);
      const res = await post(insertEvent());
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/ensure_provisioned failed/);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('UPDATE', () => {
    it('provisions on email confirmation (covers a lost INSERT webhook)', async () => {
      const res = await post({
        type: 'UPDATE',
        record: { id: UID, email: 'alice@example.com', raw_user_meta_data: {}, email_confirmed_at: '2026-10-20T10:05:00Z' },
        old_record: { id: UID, email_confirmed_at: null },
      });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('provisioned');
      expect(fake.appUsers.has(UID)).toBe(true);
    });

    it('ignores any other UPDATE (no trigger reacted to it before)', async () => {
      const res = await post({
        type: 'UPDATE',
        record: { id: UID, email: 'alice@example.com', email_confirmed_at: '2026-10-20T10:05:00Z' },
        old_record: { id: UID, email_confirmed_at: '2026-10-20T10:05:00Z' },
      });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('ignored');
      expect(fake.ensureCalls).toHaveLength(0);
    });
  });

  describe('DELETE', () => {
    it('runs the Aurora-side cleanup for the deleted user', async () => {
      fake.seedProvisioned(UID);
      const res = await post({ type: 'DELETE', schema: 'auth', table: 'users', record: null, old_record: { id: UID, email: 'alice@example.com' } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, action: 'deleted', user_id: UID });
      expect(fake.deleted.get(UID)).toBe('webhook');
      expect(fake.profiles.has(UID)).toBe(false);
      expect(fake.ensureCalls).toHaveLength(0);
    });

    it('is idempotent on a repeated DELETE', async () => {
      fake.seedProvisioned(UID);
      const body = { type: 'DELETE', record: null, old_record: { id: UID } };
      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);
      expect(fake.deleted.size).toBe(1);
    });
  });
});
