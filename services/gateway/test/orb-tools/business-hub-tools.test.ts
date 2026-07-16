/**
 * Business Hub (A6, partial) voice tools (Wave 4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  BUSINESS_HUB_TOOL_HANDLERS,
  BUSINESS_HUB_TOOL_DECLARATIONS,
  create_service,
} from '../../src/services/orb-tools/business-hub-tools';

const USER: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community', user_jwt: 'jwt-abc' };
const USER_NO_JWT: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON: OrbToolIdentity = { user_id: '', tenant_id: null, role: null };

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
  it('exposes exactly 1 tool (13 planned A6 tools intentionally skipped)', () => {
    const names = Object.keys(BUSINESS_HUB_TOOL_HANDLERS);
    expect(names).toEqual(['create_service']);
    const declNames = BUSINESS_HUB_TOOL_DECLARATIONS.map((d) => d.name);
    expect(declNames).toEqual(['create_service']);
  });
});

describe('create_service', () => {
  it('requires an authenticated user', async () => {
    const r = await create_service({ name: 'Coaching', service_type: 'coaching' }, ANON, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('needs a session JWT', async () => {
    const r = await create_service({ name: 'Coaching', service_type: 'coaching' }, USER_NO_JWT, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });

  it('rejects an invalid service_type', async () => {
    const r = await create_service({ name: 'Coaching', service_type: 'bogus' }, USER, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation before creating', async () => {
    const r = await create_service({ name: 'Coaching', service_type: 'coaching' }, USER, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('creates the listing on confirm, with a caveat about no list/edit/archive', async () => {
    mockFetch(200, { ok: true });
    const r = await create_service({ name: 'Coaching', service_type: 'coaching', confirm: true }, USER, {} as SupabaseClient);
    expect(r.text).toContain('Coaching');
    const decl = BUSINESS_HUB_TOOL_DECLARATIONS[0];
    expect(String(decl.description)).toContain('no way to list, edit, or archive');
  });
});
