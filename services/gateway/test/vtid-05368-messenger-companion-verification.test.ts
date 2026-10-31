/**
 * VTID-05368 (plan messenger-vitana-cards-v2, lane messenger-companion-verification)
 * — the Messenger companion DM carries the personalized enrichment card, end to end,
 * in a sending mode. `npx jest test/vtid-05368-messenger-companion-verification.test.ts`
 *
 * Proves offline (the engine never runs on staging — rule 48):
 *  - in `live` mode a member who set nothing up gets ONE Vitana DM whose card is the
 *    enrichment card (metadata.card = { kind: 'vitana_card', card_type: 'E1', params: {} });
 *  - a fully set-up member gets no enrichment card (the morning greeting, F4);
 *  - the default pacer is the presence pacer on the `messenger_companion` surface, once
 *    per member; a paused member gets nothing;
 *  - one card per member per local day: a second tick the same day sends nothing;
 *  - `staff` mode sends the enrichment card to staff only; everyone else stays shadow.
 */
const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
const mockPacer = jest.fn();
jest.mock('../src/services/guide/presence-pacer', () => ({
  canSurfaceProactively: (...a: unknown[]) => mockPacer(...a),
}));

import { runCompanionTick } from '../src/services/companion/companion-service';
import { buildCompanionMetadata, type DeliveryInput } from '../src/services/companion/delivery';
import type { CompanionConfig } from '../src/services/companion/config';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = '66666666-6666-4666-8666-666666666666'; // set nothing up
const DONE = '77777777-7777-4777-8777-777777777777'; // set everything up
const NOW = new Date('2026-10-20T06:15:00Z'); // 08:15 Berlin, inside the window
const TODAY = '2026-10-20';

const config = (mode: CompanionConfig['mode']): CompanionConfig => ({
  mode, reason: mode, windowStartMin: 450, windowEndMin: 570,
  shadowComposeLimit: 20, model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
});

function fakeDb(tables: Record<string, any[]>) {
  const ledger = (tables.companion_messages_ledger ??= []);
  let nextId = 1;
  const rpc = jest.fn(async (fn: string, a: any) => {
    if (fn === 'claim_companion_message') {
      const taken = ledger.some((r) => r.user_id === a.p_user_id && r.local_date === a.p_local_date
        && (r.mode === a.p_mode || (a.p_mode !== 'shadow' && r.mode !== 'shadow')));
      if (taken) return { data: { ok: true, claimed: false, reason: 'already_sent_today' }, error: null };
      const row = { id: nextId++, user_id: a.p_user_id, local_date: a.p_local_date, mode: a.p_mode,
        moment_key: a.p_moment_key, card_type: a.p_card_type, facts: a.p_facts, status: 'pending' };
      ledger.push(row);
      return { data: { ok: true, claimed: true, id: row.id }, error: null };
    }
    if (fn === 'finish_companion_message') return { data: { ok: true }, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let head = false;
    const q: any = {
      select: (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return q; },
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: (c: string) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      then: (ok: any, ko: any) => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { client: { from, rpc } as any, ledger, tables };
}

function seed(): Record<string, any[]> {
  return {
    user_tenants: [NEW, DONE].map((id) => ({ user_id: id, tenant_id: T, is_primary: true })),
    profiles: [
      { user_id: NEW, first_name: 'Nina', timezone: 'Europe/Berlin' },
      {
        user_id: DONE, first_name: 'Dora', timezone: 'Europe/Berlin',
        avatar_url: 'a', bio: 'A bio that is clearly longer than fifty characters so it counts as done.', location: 'Berlin',
        cover_url: 'c', universal_intent_cover_url: null, interests: ['sleep'],
      },
    ],
    profile_posts: [{ user_id: DONE }],
    social_connections: [
      { user_id: DONE, provider: 'instagram', is_active: true, disconnected_at: null },
      { user_id: DONE, provider: 'facebook', is_active: true, disconnected_at: null },
    ],
    connected_app_settings: [{ user_id: DONE, app_id: 'google-calendar', enabled: true }],
    contacts: [{ user_id: DONE }],
    user_device_tokens: [{ user_id: DONE, revoked_at: null, fcm_token: 'tok' }],
  };
}

function deps(db: ReturnType<typeof fakeDb>, mode: CompanionConfig['mode'], over: Record<string, unknown> = {}) {
  const delivered: DeliveryInput[] = [];
  return {
    delivered,
    d: {
      sb: db.client, now: NOW, config: config(mode),
      emit: jest.fn(async () => ({ ok: true })),
      // No `pacer` here: the tick's default is the presence pacer on messenger_companion.
      fetchIndex: jest.fn(async () => null),
      compose: jest.fn(async () => ({ ok: true as const, text: 'Guten Morgen!', model: 'eu.anthropic.claude-sonnet-4-6' })),
      locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
      deliver: jest.fn(async (input: DeliveryInput) => { delivered.push(input); return { ok: true as const, chatMessageId: 'msg', pushed: true }; }),
      staffIds: jest.fn(async () => new Set<string>()),
      ...over,
    },
  };
}

const META_ENV = ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'FACEBOOK_CLIENT_ID', 'FACEBOOK_CLIENT_SECRET'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of META_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockStrict.mockResolvedValue({ ok: true, ids: new Set<string>() });
  mockPacer.mockReset();
  mockPacer.mockResolvedValue({ allow: true, reason: 'ok' });
});
afterEach(() => {
  for (const k of META_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('VTID-05368: the Messenger companion DM carries the personalized enrichment card', () => {
  it('live mode: the new member\'s one DM carries the E1 card; the set-up member gets no enrichment card', async () => {
    const db = fakeDb(seed());
    const { d, delivered } = deps(db, 'live');
    const r = await runCompanionTick(d as any);
    expect(r).toMatchObject({ ok: true, mode: 'live', decided: 2, sent: 2 });

    const toNew = delivered.filter((x) => x.userId === NEW);
    expect(toNew).toHaveLength(1);
    expect(toNew[0]).toMatchObject({ mode: 'live', momentKey: 'enrichment_e1', cardType: 'E1' });
    const meta = buildCompanionMetadata(toNew[0]) as any;
    expect(meta).toMatchObject({ source: 'companion', moment_key: 'enrichment_e1' });
    expect(meta.card).toEqual({ kind: 'vitana_card', v: 1, card_type: 'E1', params: {} });

    const toDone = delivered.filter((x) => x.userId === DONE);
    expect(toDone).toHaveLength(1);
    expect(toDone[0].cardType).not.toMatch(/^E/);
    expect(toDone[0]).toMatchObject({ momentKey: 'morning_greeting', cardType: 'F4' });
  });

  it('uses the presence pacer on the messenger_companion surface, once per member', async () => {
    const db = fakeDb(seed());
    await runCompanionTick(deps(db, 'live').d as any);
    expect(mockPacer).toHaveBeenCalledWith(NEW, 'messenger_companion');
    expect(mockPacer).toHaveBeenCalledWith(DONE, 'messenger_companion');
    expect(mockPacer).toHaveBeenCalledTimes(2);
  });

  it('a paused member (pacer says no) gets no DM at all', async () => {
    mockPacer.mockImplementation(async (id: string) => (id === NEW ? { allow: false, reason: 'paused' } : { allow: true, reason: 'ok' }));
    const db = fakeDb(seed());
    const { d, delivered } = deps(db, 'live');
    const r = await runCompanionTick(d as any);
    expect(delivered.some((x) => x.userId === NEW)).toBe(false);
    expect(r.skipped).toMatchObject({ pacer_paused: 1 });
  });

  it('one card per member per local day: a second tick the same day sends nothing', async () => {
    const db = fakeDb(seed());
    const first = deps(db, 'live');
    await runCompanionTick(first.d as any);
    const second = deps(db, 'live', { now: new Date(NOW.getTime() + 15 * 60_000) });
    const r = await runCompanionTick(second.d as any);
    expect(second.delivered).toHaveLength(0);
    expect(r).toMatchObject({ decided: 0, sent: 0 });
    expect(r.skipped).toMatchObject({ already_today: 2 });
    expect(db.ledger.filter((x) => x.user_id === NEW && x.local_date === TODAY)).toHaveLength(1);
  });

  it('staff mode: the enrichment card goes to a staff member only; the other member stays shadow', async () => {
    const db = fakeDb(seed());
    const { d, delivered } = deps(db, 'staff', { staffIds: jest.fn(async () => new Set([NEW])) });
    const r = await runCompanionTick(d as any);
    expect(r).toMatchObject({ mode: 'staff', decided: 2, sent: 1 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ userId: NEW, mode: 'staff', cardType: 'E1' });
    expect(db.ledger.find((x) => x.user_id === DONE)?.mode).toBe('shadow');
  });

  it('never offers Connect Instagram/Facebook while the Meta OAuth client is unset', async () => {
    const t = seed();
    // NEW has done everything except the two social connects.
    t.profiles[0] = { ...t.profiles[1], user_id: NEW, first_name: 'Nina' };
    t.profile_posts.push({ user_id: NEW });
    t.connected_app_settings.push({ user_id: NEW, app_id: 'google-calendar', enabled: true });
    t.contacts.push({ user_id: NEW });
    t.user_device_tokens.push({ user_id: NEW, revoked_at: null, fcm_token: 'tok2' });
    const db = fakeDb(t);
    const { d, delivered } = deps(db, 'live');
    await runCompanionTick(d as any);
    const toNew = delivered.find((x) => x.userId === NEW)!;
    expect(['E6', 'E7']).not.toContain(toNew.cardType);
  });
});
