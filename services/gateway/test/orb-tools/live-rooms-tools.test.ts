/**
 * Live Rooms / Go Live (A7) voice tools (Wave 4, plan section A7) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  LIVE_ROOMS_TOOL_HANDLERS,
  LIVE_ROOMS_TOOL_DECLARATIONS,
  list_live_rooms_now,
  get_live_room_details,
  go_live,
  create_live_room,
  schedule_live_session,
  purchase_room_access,
  end_live_session,
} from '../../src/services/orb-tools/live-rooms-tools';

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
  it('exposes all 7 tools with matching declarations', () => {
    const names = Object.keys(LIVE_ROOMS_TOOL_HANDLERS);
    expect(names).toHaveLength(7);
    const declNames = LIVE_ROOMS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });
});

describe('list_live_rooms_now', () => {
  it('requires an authenticated user with a tenant', async () => {
    const sb = {} as unknown as SupabaseClient;
    const r = await list_live_rooms_now({}, ANON, sb);
    expect(r.ok).toBe(false);
  });

  it('reports live + scheduled rooms', async () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          { id: 'r1', title: 'Morning Yoga', status: 'live', starts_at: new Date().toISOString() },
          { id: 'r2', title: 'Q&A', status: 'scheduled', starts_at: new Date(Date.now() + 3600_000).toISOString() },
        ],
        error: null,
      }),
    };
    const sb = { from: jest.fn(() => chain) } as unknown as SupabaseClient;
    const r = await list_live_rooms_now({}, USER, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('1 live now');
  });
});

describe('get_live_room_details', () => {
  it('needs a session JWT', async () => {
    const r = await get_live_room_details({ room_id: 'r1' }, USER_NO_JWT, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });

  it('summarizes room + session state', async () => {
    mockFetch(200, { ok: true, room: { status: 'live' }, session: { access_level: 'public' } });
    const r = await get_live_room_details({ room_id: 'r1' }, USER, {} as SupabaseClient);
    expect(r.text).toContain('live');
  });
});

describe('go_live / schedule_live_session', () => {
  it('go_live requires room_id', async () => {
    const r = await go_live({}, USER, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('go_live starts a session now', async () => {
    mockFetch(200, { ok: true });
    const r = await go_live({ room_id: 'r1' }, USER, {} as SupabaseClient);
    expect(r.text).toContain('live now');
  });

  it('schedule_live_session requires starts_at', async () => {
    const r = await schedule_live_session({ room_id: 'r1' }, USER, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('schedule_live_session schedules for the future', async () => {
    mockFetch(200, { ok: true });
    const r = await schedule_live_session({ room_id: 'r1', starts_at: '2027-01-01T00:00:00Z' }, USER, {} as SupabaseClient);
    expect(r.text).toContain('Session scheduled');
  });
});

describe('create_live_room', () => {
  it('requires confirmation first', async () => {
    const r = await create_live_room({ title: 'My Room' }, USER, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('surfaces creator-not-onboarded honestly', async () => {
    mockFetch(400, { ok: false, error: 'CREATOR_NOT_ONBOARDED' });
    const r = await create_live_room({ title: 'My Room', confirm: true }, USER, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('creator_not_onboarded');
  });
});

describe('purchase_room_access', () => {
  it('returns a confirm_payment directive', async () => {
    mockFetch(200, { ok: true, client_secret: 'pi_123_secret', amount: 500, currency: 'eur' });
    const r = await purchase_room_access({ room_id: 'r1' }, USER, {} as SupabaseClient);
    const result = r.result as { directive: { directive: string; client_secret: string } };
    expect(result.directive.directive).toBe('confirm_payment');
    expect(result.directive.client_secret).toBe('pi_123_secret');
  });
});

describe('end_live_session', () => {
  it('requires confirmation first', async () => {
    const r = await end_live_session({ room_id: 'r1' }, USER, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('ends the session on confirm', async () => {
    mockFetch(200, { ok: true });
    const r = await end_live_session({ room_id: 'r1', confirm: true }, USER, {} as SupabaseClient);
    expect(r.text).toBe('Session ended.');
  });
});
