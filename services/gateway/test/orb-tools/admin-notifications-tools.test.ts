/**
 * Admin Notifications & Broadcast voice tools (Wave 3, plan section B11) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_NOTIFICATIONS_TOOL_HANDLERS,
  ADMIN_NOTIFICATIONS_TOOL_DECLARATIONS,
  admin_compose_broadcast,
  admin_send_broadcast,
  admin_create_notification_category,
  admin_update_notification_category,
} from '../../src/services/orb-tools/admin-notifications-tools';

const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

interface StubResp {
  data: unknown;
  error: { message: string } | null;
}

function makeSb(count = 0): SupabaseClient {
  const sb = {
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.then = (onOk: (v: StubResp & { count: number }) => unknown) =>
        Promise.resolve({ data: null, error: null, count }).then(onOk);
      return chain;
    },
  };
  return sb as unknown as SupabaseClient;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('admin notifications role gate', () => {
  const names = Object.keys(ADMIN_NOTIFICATIONS_TOOL_HANDLERS);

  it('exposes all 7 tools with matching declarations', () => {
    expect(names).toHaveLength(7);
    const declNames = ADMIN_NOTIFICATIONS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = { title: 't', body: 'b', send_to_all: true, tenant_id: 't-1', category_id: 'c1', type: 'chat', display_name: 'D' };
    const r = await ADMIN_NOTIFICATIONS_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_NOTIFICATIONS_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('admin_compose_broadcast', () => {
  it('requires title and body', async () => {
    const r = await admin_compose_broadcast({}, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('never calls the network — preview only', async () => {
    const fn = mockFetch(200, {});
    await admin_compose_broadcast({ title: 't', body: 'b', send_to_all: true, tenant_id: 't-1' }, ADMIN_ID, makeSb(42));
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports the resolved audience size', async () => {
    const r = await admin_compose_broadcast({ title: 't', body: 'b', send_to_all: true, tenant_id: 't-1' }, ADMIN_ID, makeSb(42));
    expect(r.text).toContain('42');
  });
});

describe('admin_send_broadcast', () => {
  it('requires an audience', async () => {
    const r = await admin_send_broadcast({ title: 't', body: 'b' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_send_broadcast({ title: 't', body: 'b', send_to_all: true, tenant_id: 't-1' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('sends after confirm=true', async () => {
    mockFetch(200, { ok: true, sent_to: 5 });
    const r = await admin_send_broadcast({ title: 't', body: 'b', send_to_all: true, tenant_id: 't-1', confirm: true }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(true);
  });
});

describe('admin_create_notification_category', () => {
  it('validates type', async () => {
    const r = await admin_create_notification_category({ type: 'bogus', display_name: 'X' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_create_notification_category({ type: 'chat', display_name: 'X' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('admin_update_notification_category', () => {
  it('refuses to change type', async () => {
    const r = await admin_update_notification_category({ category_id: 'c1', type: 'community' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});
