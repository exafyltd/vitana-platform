/**
 * Feed extras (A9 partial) + Goals & Journey (A12) voice tools
 * (Wave 4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  FEED_GOALS_TOOL_HANDLERS,
  FEED_GOALS_TOOL_DECLARATIONS,
  list_open_asks,
  edit_my_post,
  delete_my_post,
  set_goal,
  list_my_goals,
  get_goal_progress,
  get_journey_checkpoints,
} from '../../src/services/orb-tools/feed-goals-tools';

const USER: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community', user_jwt: 'jwt-abc' };
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

function makeSb(chain: Record<string, unknown>): SupabaseClient {
  return { from: jest.fn(() => chain) } as unknown as SupabaseClient;
}

describe('catalogue', () => {
  it('exposes all 8 tools with matching declarations', () => {
    const names = Object.keys(FEED_GOALS_TOOL_HANDLERS);
    expect(names).toHaveLength(8);
    const declNames = FEED_GOALS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });
});

describe('list_open_asks', () => {
  it('requires an authenticated user', async () => {
    const r = await list_open_asks({}, ANON, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('reports open asks', async () => {
    mockFetch(200, { items: [{ title: 'Need a plumber' }] });
    const r = await list_open_asks({}, USER, {} as SupabaseClient);
    expect(r.text).toContain('Need a plumber');
  });
});

describe('edit_my_post / delete_my_post', () => {
  it('edit_my_post requires confirmation first', async () => {
    const r = await edit_my_post({ post_id: 'p1', content: 'new text' }, USER, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('edit_my_post updates ownership-scoped rows', async () => {
    const chain: any = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }),
    };
    const r = await edit_my_post({ post_id: 'p1', content: 'new text', confirm: true }, USER, makeSb(chain));
    expect(r.text).toBe('Post updated.');
  });

  it('delete_my_post reports honestly when the post is not the caller\'s', async () => {
    const chain: any = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const r = await delete_my_post({ post_id: 'p1', confirm: true }, USER, makeSb(chain));
    expect((r.result as { deleted: boolean }).deleted).toBe(false);
  });
});

describe('set_goal / list_my_goals / get_goal_progress', () => {
  it('set_goal requires a non-empty goal statement', async () => {
    const r = await set_goal({}, USER, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('set_goal saves the goal', async () => {
    mockFetch(200, { ok: true });
    const r = await set_goal({ goal: 'Run a marathon' }, USER, {} as SupabaseClient);
    expect(r.text).toContain('Run a marathon');
  });

  it('list_my_goals reports no active goal honestly', async () => {
    mockFetch(200, { life_compass: {} });
    const r = await list_my_goals({}, USER, {} as SupabaseClient);
    expect((r.result as { goal: unknown }).goal).toBeNull();
  });

  it('get_goal_progress reports day/total when a goal exists', async () => {
    mockFetch(200, { life_compass: { primary_goal: 'Run a marathon', goal_day: 3, goal_total_days: 90 } });
    const r = await get_goal_progress({}, USER, {} as SupabaseClient);
    expect(r.text).toContain('Day 3 of 90');
  });
});

describe('get_journey_checkpoints', () => {
  it('reports checkpoints', async () => {
    mockFetch(200, { plan: { checkpoints: [{ title: 'Week 1', status: 'done' }] } });
    const r = await get_journey_checkpoints({}, USER, {} as SupabaseClient);
    expect(r.text).toContain('Week 1');
  });
});
