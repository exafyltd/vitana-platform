/**
 * Admin Specialists / Personas voice tools (Wave 6, plan section B10) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_SPECIALISTS_TOOL_HANDLERS,
  ADMIN_SPECIALISTS_TOOL_DECLARATIONS,
  admin_list_specialists,
  admin_get_specialist,
  admin_create_specialist,
  admin_set_specialist_status,
  admin_test_specialist_connection,
} from '../../src/services/orb-tools/admin-specialists-tools';

const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

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

describe('catalogue', () => {
  const names = Object.keys(ADMIN_SPECIALISTS_TOOL_HANDLERS);

  it('exposes all 9 tools with matching declarations', () => {
    expect(names).toHaveLength(9);
    const declNames = ADMIN_SPECIALISTS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_SPECIALISTS_TOOL_HANDLERS[name](
      { key: 'nutrition', display_name: 'Nutrition', role: 'coach', system_prompt: 'x', version: 1, tool_keys: ['a'], kb_keys: ['b'], enabled: true, connection_id: 'c1' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_SPECIALISTS_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('admin_list_specialists / admin_get_specialist', () => {
  it('lists personas', async () => {
    mockFetch(200, { personas: [{ key: 'nutrition' }, { key: 'fitness' }] });
    const r = await admin_list_specialists({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('2 specialist personas');
  });

  it('reports honestly on 404', async () => {
    mockFetch(404, { error: 'not_found' });
    const r = await admin_get_specialist({ key: 'ghost' }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { found: boolean }).found).toBe(false);
  });
});

describe('admin_create_specialist', () => {
  it('validates the key pattern', async () => {
    const r = await admin_create_specialist(
      { key: 'Bad-Key', display_name: 'X', role: 'coach', system_prompt: 'y' },
      ADMIN_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await admin_create_specialist(
      { key: 'nutrition2', display_name: 'Nutrition 2', role: 'coach', system_prompt: 'y' },
      ADMIN_ID,
      {} as SupabaseClient,
    );
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('reports a taken key on 409', async () => {
    mockFetch(409, { error: 'conflict' });
    const r = await admin_create_specialist(
      { key: 'nutrition', display_name: 'Nutrition', role: 'coach', system_prompt: 'y', confirm: true },
      ADMIN_ID,
      {} as SupabaseClient,
    );
    expect((r.result as { reason: string }).reason).toBe('key_taken');
  });
});

describe('admin_set_specialist_status', () => {
  it('special-cases the vitana persona', async () => {
    mockFetch(400, { error: 'VITANA_ALWAYS_ON' });
    const r = await admin_set_specialist_status({ key: 'vitana', enabled: false, confirm: true }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('vitana_always_on');
  });
});

describe('admin_test_specialist_connection', () => {
  it('requires connection_id', async () => {
    const r = await admin_test_specialist_connection({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('reports health honestly', async () => {
    mockFetch(200, { provider: 'stub', healthy: false, note: 'timeout' });
    const r = await admin_test_specialist_connection({ connection_id: 'c1' }, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('unhealthy');
  });
});
