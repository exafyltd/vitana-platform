/**
 * Admin Marketplace voice tools (Wave 3, plan section B6) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_MARKETPLACE_TOOL_HANDLERS,
  ADMIN_MARKETPLACE_TOOL_DECLARATIONS,
  admin_update_merchant,
  admin_bulk_product_action,
  admin_trigger_source_sync,
  admin_get_ingestion_coverage,
} from '../../src/services/orb-tools/admin-marketplace-tools';

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

describe('admin marketplace role gate', () => {
  const names = Object.keys(ADMIN_MARKETPLACE_TOOL_HANDLERS);

  it('exposes all 12 tools with matching declarations', () => {
    expect(names).toHaveLength(12);
    const declNames = ADMIN_MARKETPLACE_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = { merchant_id: 'm1', product_id: 'p1', product_ids: ['p1'], action: 'hide', config_id: 'c1', policy_id: 'g1', network: 'shopify' };
    const r = await ADMIN_MARKETPLACE_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_MARKETPLACE_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('admin_update_merchant', () => {
  it('requires at least one field to change', async () => {
    const r = await admin_update_merchant({ merchant_id: 'm1' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_update_merchant({ merchant_id: 'm1', is_active: false }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('admin_bulk_product_action', () => {
  it('validates action and product_ids', async () => {
    const r = await admin_bulk_product_action({ product_ids: [], action: 'hide' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('rejects more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `p${i}`);
    const r = await admin_bulk_product_action({ product_ids: ids, action: 'hide' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_bulk_product_action({ product_ids: ['p1'], action: 'hide' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('admin_trigger_source_sync', () => {
  it('validates network', async () => {
    const r = await admin_trigger_source_sync({ network: 'bogus' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_trigger_source_sync({ network: 'shopify' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('admin_get_ingestion_coverage', () => {
  it('fetches both runs and coverage by default', async () => {
    const fn = mockFetch(200, { ok: true });
    await admin_get_ingestion_coverage({}, ADMIN_ID, makeSb());
    expect(fn.mock.calls.length).toBe(2);
  });
});
