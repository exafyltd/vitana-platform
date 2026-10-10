/**
 * VTID-05023 part 4, layer (c) and the gateway helper: the 5-minute
 * reconciliation between GoTrue (Supabase auth.users) and Aurora, and
 * ensureProvisioned(userId) awaited before the gateway's own writes.
 */

import {
  ensureProvisioned,
  goTrueAdmin,
  setAuthBridgeDepsForTests,
  supabaseStore,
} from '../src/services/auth-bridge/auth-bridge';
import {
  isAuthBridgeReconcileEnabled,
  reconcileAuthBridge,
  reconcileOptionsFromEnv,
  startAuthBridgeReconcileLoop,
} from '../src/services/auth-bridge/auth-bridge-reconciler';
import { FakeAuthBridge, TENANT, authUser } from './auth-bridge/fake-auth-bridge';

const SINCE = new Date('2026-10-20T00:00:00Z');

describe('VTID-05023 auth-bridge reconciler', () => {
  let fake: FakeAuthBridge;
  beforeEach(() => {
    fake = new FakeAuthBridge();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('provisions an auth user created since the flip that has no app_users row (lost webhook)', async () => {
    const missing = authUser(1);
    const ok = authUser(2);
    fake.authUsers = [missing, ok];
    fake.seedProvisioned(ok.id);

    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE });

    expect(s.ok).toBe(true);
    expect(s.provisioned).toEqual([missing.id]);
    expect(fake.appUsers.has(missing.id)).toBe(true);
    expect(fake.ensureCalls.map((u) => u.id)).toEqual([missing.id]);
    expect(fake.appMetadataWrites).toEqual([{ id: missing.id, tenant: TENANT }]);
  });

  it('never touches users created before AUTH_BRIDGE_RECONCILE_SINCE', async () => {
    const old = authUser(3, { created_at: '2025-01-01T00:00:00Z' });
    fake.authUsers = [old];
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE });
    expect(s.provisioned).toEqual([]);
    expect(fake.ensureCalls).toHaveLength(0);
  });

  it('provisions nobody when AUTH_BRIDGE_RECONCILE_SINCE is unset, and says so', async () => {
    fake.authUsers = [authUser(1)];
    const s = await reconcileAuthBridge(fake.deps(), { since: null });
    expect(s.provisioned).toEqual([]);
    expect(fake.ensureCalls).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/AUTH_BRIDGE_RECONCILE_SINCE/));
  });

  it('pages through GoTrue until a short page and sees every user', async () => {
    fake.authUsers = [1, 2, 3, 4, 5].map((n) => authUser(n));
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE, perPage: 2 });
    expect(fake.listCalls).toEqual([
      { page: 1, perPage: 2 },
      { page: 2, perPage: 2 },
      { page: 3, perPage: 2 },
    ]);
    expect(s.pages).toBe(3);
    expect(s.auth_users_seen).toBe(5);
    expect(s.provisioned).toHaveLength(5);
  });

  it('asks for one more page when the last full page ends exactly at the total', async () => {
    fake.authUsers = [1, 2, 3, 4].map((n) => authUser(n));
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE, perPage: 2 });
    expect(fake.listCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(s.auth_users_seen).toBe(4);
  });

  it('is idempotent: a second run provisions nothing', async () => {
    fake.authUsers = [authUser(1), authUser(2)];
    await reconcileAuthBridge(fake.deps(), { since: SINCE });
    const second = await reconcileAuthBridge(fake.deps(), { since: SINCE });
    expect(second.provisioned).toEqual([]);
    expect(fake.ensureCalls).toHaveLength(2);
  });

  it('cleans up a user deleted on Supabase (profile left, GoTrue 404)', async () => {
    const gone = authUser(9);
    const stays = authUser(2);
    fake.authUsers = [stays];
    fake.seedProvisioned(stays.id);
    fake.seedProvisioned(gone.id);

    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE });

    expect(s.deleted).toEqual([gone.id]);
    expect(fake.deleted.get(gone.id)).toBe('reconciler');
    expect(fake.profiles.has(stays.id)).toBe(true);
    // second run: nothing left to do
    const again = await reconcileAuthBridge(fake.deps(), { since: SINCE });
    expect(again.deleted).toEqual([]);
  });

  it('does not delete a user GoTrue still knows (created after the listing)', async () => {
    const late = authUser(7);
    fake.seedProvisioned(late.id);
    const deps = fake.deps();
    // the listing misses the user, the direct lookup finds it
    deps.gotrue.listUsers = async () => [];
    deps.gotrue.getUser = async (id) => (id === late.id ? late : null);
    const s = await reconcileAuthBridge(deps, { since: SINCE });
    expect(s.deleted).toEqual([]);
    expect(fake.deleted.size).toBe(0);
  });

  it('skips users whose deletion was already processed', async () => {
    const gone = authUser(9);
    fake.seedProvisioned(gone.id);
    fake.deleted.set(gone.id, 'webhook');
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE });
    expect(s.deletion_candidates).toBe(0);
    expect(s.deleted).toEqual([]);
  });

  it('a failed GoTrue page aborts the run before any deletion', async () => {
    fake.authUsers = [1, 2, 3].map((n) => authUser(n));
    fake.seedProvisioned(authUser(9).id); // would look deleted
    fake.failListOnPage = 2;
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE, perPage: 2 });
    expect(s.ok).toBe(false);
    expect(s.deletion_skipped_reason).toBe('incomplete_listing');
    expect(s.deleted).toEqual([]);
    expect(fake.deleted.size).toBe(0);
  });

  it('deletes nothing when more profiles than the limit lack an auth user', async () => {
    for (let n = 100; n < 105; n++) fake.seedProvisioned(authUser(n).id);
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE, maxDeletes: 3 });
    expect(s.deletion_skipped_reason).toMatch(/too_many_candidates \(5 > 3\)/);
    expect(fake.deleted.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('reports a provisioning failure without stopping the others', async () => {
    const bad = authUser(1);
    const good = authUser(2);
    fake.authUsers = [bad, good];
    fake.failEnsureFor.add(bad.id);
    const s = await reconcileAuthBridge(fake.deps(), { since: SINCE });
    expect(s.ok).toBe(false);
    expect(Object.keys(s.provision_errors)).toEqual([bad.id]);
    expect(s.provisioned).toEqual([good.id]);
  });

  it('env: off by default, SINCE and MAX_DELETES parsed, never on staging', () => {
    expect(isAuthBridgeReconcileEnabled({})).toBe(false);
    expect(isAuthBridgeReconcileEnabled({ AUTH_BRIDGE_RECONCILE_ENABLED: 'true' })).toBe(true);
    expect(reconcileOptionsFromEnv({}).since).toBeNull();
    expect(reconcileOptionsFromEnv({ AUTH_BRIDGE_RECONCILE_SINCE: 'garbage' }).since).toBeNull();
    expect(reconcileOptionsFromEnv({ AUTH_BRIDGE_RECONCILE_SINCE: '2026-10-20T00:00:00Z' }).since?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(reconcileOptionsFromEnv({}).maxDeletes).toBe(20);
    expect(reconcileOptionsFromEnv({ AUTH_BRIDGE_RECONCILE_MAX_DELETES: '5' }).maxDeletes).toBe(5);
    expect(startAuthBridgeReconcileLoop({})).toBe(false);
    expect(startAuthBridgeReconcileLoop({ AUTH_BRIDGE_RECONCILE_ENABLED: 'true', VITANA_ENV: 'staging' })).toBe(false);
  });
});

describe('VTID-05023 ensureProvisioned(userId)', () => {
  let fake: FakeAuthBridge;
  const saved = process.env.AUTH_BRIDGE_ENABLED;
  beforeEach(() => {
    fake = new FakeAuthBridge();
    setAuthBridgeDepsForTests(fake.deps());
    process.env.AUTH_BRIDGE_ENABLED = 'true';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    setAuthBridgeDepsForTests(null);
    process.env.AUTH_BRIDGE_ENABLED = saved;
    jest.restoreAllMocks();
  });

  it('is inert unless AUTH_BRIDGE_ENABLED=true', async () => {
    process.env.AUTH_BRIDGE_ENABLED = '';
    expect(await ensureProvisioned(authUser(1).id)).toBe('disabled');
    expect(fake.ensureCalls).toHaveLength(0);
  });

  it('one lookup for a provisioned member, then served from cache', async () => {
    const u = authUser(1);
    fake.seedProvisioned(u.id);
    expect(await ensureProvisioned(u.id)).toBe('exists');
    expect(await ensureProvisioned(u.id)).toBe('cached');
    expect(fake.ensureCalls).toHaveLength(0);
  });

  it('provisions a brand-new member from GoTrue before the gateway writes', async () => {
    const u = authUser(2, { user_metadata: { tenant_slug: 'maxina' } });
    fake.authUsers = [u];
    expect(await ensureProvisioned(u.id)).toBe('provisioned');
    expect(fake.ensureCalls[0]).toMatchObject({ id: u.id, user_metadata: { tenant_slug: 'maxina' } });
    expect(fake.appUsers.has(u.id)).toBe(true);
    expect(fake.appMetadataWrites).toEqual([{ id: u.id, tenant: TENANT }]);
  });

  it('concurrent calls for one member share one provisioning', async () => {
    const u = authUser(3);
    fake.authUsers = [u];
    const results = await Promise.all([ensureProvisioned(u.id), ensureProvisioned(u.id), ensureProvisioned(u.id)]);
    expect(results).toEqual(['provisioned', 'provisioned', 'provisioned']);
    expect(fake.ensureCalls).toHaveLength(1);
  });

  it('never throws: unknown auth user, bad id and failures are reported', async () => {
    expect(await ensureProvisioned(authUser(4).id)).toBe('no_auth_user');
    expect(await ensureProvisioned('nope')).toBe('invalid_user_id');
    expect(await ensureProvisioned(undefined)).toBe('invalid_user_id');
    const u = authUser(5);
    fake.authUsers = [u];
    fake.failEnsureFor.add(u.id);
    expect(await ensureProvisioned(u.id)).toBe('error');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('VTID-05023 PostgREST store and GoTrue admin client', () => {
  it('calls ensure_provisioned with the auth user fields', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { user_id: 'u', created: ['profiles'], provisioned: true, active_tenant_id: TENANT }, error: null });
    const store = supabaseStore({ rpc, from: jest.fn() } as any);
    const r = await store.ensureProvisioned(authUser(1, { user_metadata: { full_name: 'A' }, created_at: '2026-10-20T10:00:00Z' }));
    expect(rpc).toHaveBeenCalledWith('ensure_provisioned', {
      p_user_id: authUser(1).id,
      p_email: 'user1@example.com',
      p_raw_user_meta: { full_name: 'A' },
      p_created_at: '2026-10-20T10:00:00Z',
    });
    expect(r).toEqual({ user_id: 'u', created: ['profiles'], provisioned: true, active_tenant_id: TENANT });
  });

  it('surfaces RPC errors', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const store = supabaseStore({ rpc, from: jest.fn() } as any);
    await expect(store.handleDeletedUser('u', 'webhook')).rejects.toThrow(/auth_bridge_handle_deleted_user failed: boom/);
    await expect(store.unprovisioned(['u'])).rejects.toThrow(/boom/);
  });

  it('pages /auth/v1/admin/users, maps 404 to null and merges app_metadata', async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    const fetchImpl = jest.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (url.includes('?page=')) {
        return { ok: true, status: 200, json: async () => ({ users: [{ id: 'a', email: 'a@x', user_metadata: { k: 1 }, app_metadata: {} }] }), text: async () => '' };
      }
      if (url.endsWith('/missing')) return { ok: false, status: 404, json: async () => ({}), text: async () => 'User not found' };
      if (url.endsWith('/broken')) return { ok: false, status: 500, json: async () => ({}), text: async () => 'oops' };
      return { ok: true, status: 200, json: async () => ({ id: 'b', email: 'b@x' }), text: async () => '' };
    });
    const g = goTrueAdmin('http://internal-proxy:8080/', 'svc-key', fetchImpl as any);

    const users = await g.listUsers(2, 500);
    expect(calls[0].url).toBe('http://internal-proxy:8080/auth/v1/admin/users?page=2&per_page=500');
    expect(calls[0].init.headers).toMatchObject({ apikey: 'svc-key', Authorization: 'Bearer svc-key' });
    expect(users).toEqual([{ id: 'a', email: 'a@x', user_metadata: { k: 1 }, app_metadata: {}, created_at: null, email_confirmed_at: null }]);

    expect(await g.getUser('missing')).toBeNull();
    await expect(g.getUser('broken')).rejects.toThrow(/HTTP 500/);

    await g.setActiveTenant('b', TENANT);
    const put = calls[calls.length - 1];
    expect(put.url).toBe('http://internal-proxy:8080/auth/v1/admin/users/b');
    expect(put.init.method).toBe('PUT');
    expect(JSON.parse(put.init.body)).toEqual({ app_metadata: { active_tenant_id: TENANT } });
  });
});
