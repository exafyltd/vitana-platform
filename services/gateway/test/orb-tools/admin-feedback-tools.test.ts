/**
 * Admin Feedback & Support voice tools (Wave 3, plan section B15) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_FEEDBACK_TOOL_HANDLERS,
  ADMIN_FEEDBACK_TOOL_DECLARATIONS,
  admin_act_on_ticket,
} from '../../src/services/orb-tools/admin-feedback-tools';

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

describe('admin feedback role gate', () => {
  const names = Object.keys(ADMIN_FEEDBACK_TOOL_HANDLERS);

  it('exposes all 5 tools with matching declarations', () => {
    expect(names).toHaveLength(5);
    const declNames = ADMIN_FEEDBACK_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = { ticket_id: 't1', action: 'resolve' };
    const r = await ADMIN_FEEDBACK_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_FEEDBACK_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('admin_act_on_ticket', () => {
  it('rejects the unsupported "assign" action honestly', async () => {
    const r = await admin_act_on_ticket({ ticket_id: 't1', action: 'assign' }, ADMIN_ID, makeSb());
    expect((r.result as { supported: boolean }).supported).toBe(false);
  });

  it('rejects an unknown action', async () => {
    const r = await admin_act_on_ticket({ ticket_id: 't1', action: 'bogus' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('mark_duplicate requires duplicate_of', async () => {
    const r = await admin_act_on_ticket({ ticket_id: 't1', action: 'mark_duplicate' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_act_on_ticket({ ticket_id: 't1', action: 'resolve' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('resolves after confirm=true', async () => {
    mockFetch(200, { ok: true });
    const r = await admin_act_on_ticket({ ticket_id: 't1', action: 'resolve', confirm: true }, ADMIN_ID, makeSb());
    expect(r.text).toContain('resolve');
  });
});
