/**
 * Admin Knowledge Base (B8) + Assistant & Voice Config (B9) voice tools
 * (Wave 4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_KB_ASSISTANT_TOOL_HANDLERS,
  ADMIN_KB_ASSISTANT_TOOL_DECLARATIONS,
  admin_kb_search,
  admin_kb_create_doc,
  admin_system_kb_update,
  admin_get_assistant_config,
  admin_set_assistant_speech,
  admin_get_awareness_config,
  admin_bulk_set_awareness,
} from '../../src/services/orb-tools/admin-kb-assistant-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
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
  const names = Object.keys(ADMIN_KB_ASSISTANT_TOOL_HANDLERS);

  it('exposes all 15 tools with matching declarations', () => {
    expect(names).toHaveLength(15);
    const declNames = ADMIN_KB_ASSISTANT_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_KB_ASSISTANT_TOOL_HANDLERS[name](
      { query: 'x', document_id: 'd1', title: 't', surface_key: 's1', speech_key: 'k1', text: 'hi', key: 'sig1', enabled: true, changes: [{ key: 'sig1', enabled: true }] },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_KB_ASSISTANT_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('admin_kb_search', () => {
  it('requires a query', async () => {
    const r = await admin_kb_search({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('reports honestly when nothing matches', async () => {
    mockFetch(200, { results: [] });
    const r = await admin_kb_search({ query: 'nonexistent' }, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('No KB docs matched');
  });
});

describe('admin_kb_create_doc', () => {
  it('requires confirmation first', async () => {
    const r = await admin_kb_create_doc({ title: 'New Doc' }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('admin_system_kb_update (exafy_admin only)', () => {
  it('rejects a plain admin session', async () => {
    const r = await admin_system_kb_update({ document_id: 'doc1' }, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('exafy_admin');
  });

  it('requires confirmation for exafy_admin, warning about cross-tenant impact', async () => {
    const r = await admin_system_kb_update({ document_id: 'doc1', title: 'New Title' }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('every tenant');
  });

  it('updates the doc on confirm', async () => {
    mockFetch(200, { ok: true, document: { id: 'doc1' } });
    const r = await admin_system_kb_update({ document_id: 'doc1', title: 'New Title', confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('updated');
  });
});

describe('admin_get_assistant_config', () => {
  it('requires surface_key', async () => {
    const r = await admin_get_assistant_config({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('reports override state', async () => {
    mockFetch(200, { has_tenant_override: true });
    const r = await admin_get_assistant_config({ surface_key: 'orb_voice' }, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('tenant override');
  });
});

describe('admin_set_assistant_speech', () => {
  it('requires speech_key and text', async () => {
    const r = await admin_set_assistant_speech({ speech_key: 'greeting' }, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await admin_set_assistant_speech({ speech_key: 'greeting', text: 'Hi there!' }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('admin_get_awareness_config / admin_bulk_set_awareness', () => {
  it('reports the count of configured signals', async () => {
    mockFetch(200, { resolved: { sig1: {}, sig2: {} } });
    const r = await admin_get_awareness_config({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('2 awareness signals');
  });

  it('bulk update requires a non-empty changes array', async () => {
    const r = await admin_bulk_set_awareness({ changes: [] }, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('bulk update requires confirmation first', async () => {
    const r = await admin_bulk_set_awareness({ changes: [{ key: 'sig1', enabled: true }] }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});
