/**
 * Memory & Diary extras (A13) + Profile & Social depth (A14) voice tools
 * (Wave 6) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  MEMORY_DIARY_SOCIAL_TOOL_HANDLERS,
  MEMORY_DIARY_SOCIAL_TOOL_DECLARATIONS,
  edit_memory,
  reinforce_memory,
  set_memory_permissions,
  get_what_vitana_knows,
  add_diary_photo,
  get_profile_completeness,
  share_my_profile,
  get_my_milestones,
  view_member_profile,
  update_service_offerings,
} from '../../src/services/orb-tools/memory-diary-social-tools';

const USER_ID: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community', user_jwt: 'jwt-abc' };
const NO_JWT_ID: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'community' };

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

function makeSb(rows: unknown[] = [], error: { message: string } | null = null): SupabaseClient {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: rows, error }),
  };
  return { from: jest.fn(() => chain) } as unknown as SupabaseClient;
}

describe('catalogue', () => {
  const names = Object.keys(MEMORY_DIARY_SOCIAL_TOOL_HANDLERS);
  // add_diary_photo delegates straight to tool_navigate_to_screen, which
  // treats a missing user_id as "anonymous" rather than "denied" — it
  // resolves per-screen role gating instead of a blanket auth error.
  const authGatedNames = names.filter((n) => n !== 'add_diary_photo');

  it('exposes all 10 tools with matching declarations', () => {
    expect(names).toHaveLength(10);
    const declNames = MEMORY_DIARY_SOCIAL_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(authGatedNames)('%s denies unauthenticated callers', async (name) => {
    const r = await MEMORY_DIARY_SOCIAL_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('edit_memory', () => {
  it('requires memory_item_id and new_content', async () => {
    const r = await edit_memory({}, USER_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await edit_memory({ memory_item_id: 'm1', new_content: 'corrected' }, USER_ID, makeSb());
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('needs a session JWT', async () => {
    const r = await edit_memory({ memory_item_id: 'm1', new_content: 'x' }, NO_JWT_ID, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });

  it('corrects on confirm', async () => {
    mockFetch(200, {});
    const r = await edit_memory({ memory_item_id: 'm1', new_content: 'corrected', confirm: true }, USER_ID, makeSb());
    expect(r.text).toBe('Memory corrected.');
  });
});

describe('reinforce_memory', () => {
  it('is not confirm-gated', async () => {
    mockFetch(200, {});
    const r = await reinforce_memory({ memory_item_id: 'm1' }, USER_ID, makeSb());
    expect(r.text).toContain('confirmed and trustworthy');
  });
});

describe('set_memory_permissions', () => {
  it('validates domain and visibility', async () => {
    const r = await set_memory_permissions({ domain: 'bogus', visibility: 'private' }, USER_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await set_memory_permissions({ domain: 'diary', visibility: 'private' }, USER_ID, makeSb());
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('get_what_vitana_knows (alias)', () => {
  it('delegates to the memory garden summary route', async () => {
    mockFetch(200, { categories: [] });
    const r = await get_what_vitana_knows({}, USER_ID, makeSb());
    expect(r.ok).toBe(true);
  });
});

describe('add_diary_photo (navigation-only)', () => {
  it('delegates to tool_navigate_to_screen for MEMORY.DIARY (not an unknown-screen error)', async () => {
    const r = await add_diary_photo({}, USER_ID, makeSb());
    if (!r.ok) expect(r.error).not.toContain('Unknown screen_id');
  });
});

describe('get_profile_completeness', () => {
  it('reports the taste-alignment percentage', async () => {
    mockFetch(200, { bundle: { profile_completeness: 62, sparse_data: false } });
    const r = await get_profile_completeness({}, USER_ID, makeSb());
    expect(r.text).toContain('62%');
  });
});

describe('share_my_profile', () => {
  it('builds a shareable link', async () => {
    mockFetch(200, { profile: { handle: 'jane' } });
    const r = await share_my_profile({}, USER_ID, makeSb());
    expect(r.text).toContain('https://vitanaland.com/u/jane');
  });
});

describe('get_my_milestones', () => {
  it('handles no milestones', async () => {
    const r = await get_my_milestones({}, USER_ID, makeSb([]));
    expect(r.text).toBe('No milestones achieved yet.');
  });

  it('lists milestones', async () => {
    const r = await get_my_milestones({}, USER_ID, makeSb([{ title: 'First 10K steps' }]));
    expect(r.text).toContain('First 10K steps');
  });
});

describe('view_member_profile', () => {
  it('requires user_id or handle', async () => {
    const r = await view_member_profile({}, USER_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('reports 404 honestly', async () => {
    mockFetch(404, { error: 'not_found' });
    const r = await view_member_profile({ user_id: 'ghost' }, USER_ID, makeSb());
    expect((r.result as { found: boolean }).found).toBe(false);
  });
});

describe('update_service_offerings', () => {
  it('requires a non-empty offers array', async () => {
    const r = await update_service_offerings({ offers: [] }, USER_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await update_service_offerings({ offers: [{ category: 'coaching', title: 'Life coaching' }] }, USER_ID, makeSb());
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});
