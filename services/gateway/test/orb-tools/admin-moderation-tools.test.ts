/**
 * Admin Content Moderation voice tools (Wave 3, plan section B4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_MODERATION_TOOL_HANDLERS,
  ADMIN_MODERATION_TOOL_DECLARATIONS,
  admin_list_moderation_queue,
  admin_approve_content,
  admin_list_reports,
  admin_get_report,
} from '../../src/services/orb-tools/admin-moderation-tools';

const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

function makeSb(): SupabaseClient {
  return {} as unknown as SupabaseClient;
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

describe('admin moderation role gate', () => {
  const names = Object.keys(ADMIN_MODERATION_TOOL_HANDLERS);

  it('exposes all 8 tools with matching declarations', () => {
    expect(names).toHaveLength(8);
    const declNames = ADMIN_MODERATION_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_MODERATION_TOOL_HANDLERS[name]({ item_id: 'i1' }, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_MODERATION_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('admin_list_moderation_queue', () => {
  it('reports empty queue honestly', async () => {
    mockFetch(200, { ok: true, items: [] });
    const r = await admin_list_moderation_queue({}, ADMIN_ID, makeSb());
    expect(r.text).toContain('empty');
  });
});

describe('admin_approve_content', () => {
  it('requires item_id', async () => {
    const r = await admin_approve_content({}, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_approve_content({ item_id: 'i1' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('approves after confirm=true', async () => {
    mockFetch(200, { ok: true });
    const r = await admin_approve_content({ item_id: 'i1', confirm: true }, ADMIN_ID, makeSb());
    expect(r.text).toContain('approved');
  });
});

describe('admin_list_reports / admin_get_report gaps', () => {
  it('admin_list_reports flags the missing report table', async () => {
    mockFetch(200, { ok: true, items: [] });
    const r = await admin_list_reports({}, ADMIN_ID, makeSb());
    expect(r.text).toContain('no dedicated user-report table');
  });

  it('admin_get_report reports not-implemented honestly', async () => {
    const r = await admin_get_report({}, ADMIN_ID, makeSb());
    expect((r.result as { available: boolean }).available).toBe(false);
  });
});
