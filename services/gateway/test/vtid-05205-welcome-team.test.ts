/**
 * VTID-05205 — team welcome DMs (Mariia day 0, Jovana day 1, Alex Blue day 2).
 * `npm run test:welcome-team`
 *
 * Plan: .kiro/specs/new-member-welcome/plan-sparring.md, Part A (sparred,
 * owner approved 2026-10-15). Everything here runs over an in-memory database
 * and a fake clock — no test touches staging or production (rules 31–32, 46–48).
 * The SQL of the claim RPCs is proven separately on PGlite
 * (docs/validation/VTID-05205/pglite-welcome-team-check.mjs).
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import {
  resolveWelcomeTeamConfig, publicStatus, DEFAULT_SENDER_IDS, type WelcomeTeamConfig,
} from '../src/services/welcome-team/config';
import {
  decideWelcome, firstName, welcomeLocale, composeWelcome, runWelcomeTeamTick, welcomeTextKey,
} from '../src/services/welcome-team/welcome-team-service';
import { tt, GATEWAY_LOCALES } from '../src/i18n/catalog';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ROLLOUT = new Date('2026-10-20T08:00:00Z');
const TENANT = '2e7528b8-472a-4356-88da-0280d4639cce';
const MARIIA = DEFAULT_SENDER_IDS.mariia;
const JOVANA = DEFAULT_SENDER_IDS.jovana;
const ALEX = DEFAULT_SENDER_IDS.alex;
const NEW = '11111111-1111-4111-8111-111111111111';
const NEW2 = '44444444-4444-4444-8444-444444444444';
const VETERAN = '33333333-3333-4333-8333-333333333333';
const BOT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  mockStrict.mockReset();
  mockStrict.mockResolvedValue({ ok: true, ids: new Set<string>([BOT]) });
});

// ── config ────────────────────────────────────────────────────────────────────
describe('VTID-05205: mode and settings', () => {
  const live = {
    WELCOME_ROLLOUT_AT: ROLLOUT.toISOString(), WELCOME_TEAM_MODE: 'live',
    WELCOME_TEAM_SEND_ENABLED: 'true', WELCOME_SENDER_NAMES_CONFIRMED: 'true',
  };

  test('never runs on staging, whatever the switches say', () => {
    const c = resolveWelcomeTeamConfig(live, { isStaging: true, featureLive: true });
    expect(c.mode).toBe('disabled-on-staging');
    expect(c.reason).toBe('staging_shares_production_database');
  });
  test('off without the feature flag, without a rollout time, or without a mode', () => {
    expect(resolveWelcomeTeamConfig(live, { isStaging: false, featureLive: false }).mode).toBe('off');
    expect(resolveWelcomeTeamConfig({ ...live, WELCOME_ROLLOUT_AT: '' }, { isStaging: false, featureLive: true }))
      .toMatchObject({ mode: 'off', reason: 'rollout_at_missing' });
    expect(resolveWelcomeTeamConfig({ ...live, WELCOME_ROLLOUT_AT: 'not-a-date' }, { isStaging: false, featureLive: true }).mode).toBe('off');
    expect(resolveWelcomeTeamConfig({ WELCOME_ROLLOUT_AT: ROLLOUT.toISOString() }, { isStaging: false, featureLive: true }))
      .toMatchObject({ mode: 'off', reason: 'mode_off' });
  });
  test('live needs the send switch AND the sender-names pre-flight; otherwise it stays shadow', () => {
    const o = { isStaging: false, featureLive: true };
    expect(resolveWelcomeTeamConfig({ ...live, WELCOME_TEAM_SEND_ENABLED: '' }, o)).toMatchObject({ mode: 'shadow', reason: 'send_not_available' });
    expect(resolveWelcomeTeamConfig({ ...live, WELCOME_SENDER_NAMES_CONFIRMED: '' }, o)).toMatchObject({ mode: 'shadow', reason: 'sender_names_not_confirmed' });
    expect(resolveWelcomeTeamConfig(live, o)).toMatchObject({ mode: 'live', reason: 'live' });
    expect(resolveWelcomeTeamConfig({ ...live, WELCOME_TEAM_MODE: 'shadow' }, o).mode).toBe('shadow');
  });
  test('defaults: the three verified sender ids, 0/1/2 days, MAXINA, closed pilot, de+en ready', () => {
    const c = resolveWelcomeTeamConfig(live, { isStaging: false, featureLive: true });
    expect(c.senders).toEqual([
      { slug: 'mariia', userId: MARIIA, staggerDays: 0 },
      { slug: 'jovana', userId: JOVANA, staggerDays: 1 },
      { slug: 'alex', userId: ALEX, staggerDays: 2 },
    ]);
    expect(c.tenantId).toBe(TENANT);
    expect(c.audience).toBe('pilot');
    expect(c.pilotUserIds.size).toBe(0);
    expect([...c.readyLocales].sort()).toEqual(['de', 'en']);
  });
  test('account ids, timing and locales are configurable; bad values fall back', () => {
    const c = resolveWelcomeTeamConfig({
      ...live,
      WELCOME_SENDER_JOVANA_ID: NEW2, WELCOME_SENDER_ALEX_ID: 'not-a-uuid',
      WELCOME_STAGGER_DAYS_JOVANA: '3', WELCOME_STAGGER_DAYS_ALEX: '-1',
      WELCOME_TEAM_AUDIENCE: 'all', WELCOME_TEAM_PILOT_USER_IDS: `${NEW}, junk ,${NEW2}`,
      WELCOME_TEAM_READY_LOCALES: 'de,en,sr', WELCOME_TEAM_MIN_GAP_HOURS: '12', WELCOME_TEAM_MAX_SENDS_PER_TICK: '5',
    }, { isStaging: false, featureLive: true });
    expect(c.senders.find((s) => s.slug === 'jovana')).toEqual({ slug: 'jovana', userId: NEW2, staggerDays: 3 });
    expect(c.senders.find((s) => s.slug === 'alex')).toEqual({ slug: 'alex', userId: ALEX, staggerDays: 2 });
    expect(c.audience).toBe('all');
    expect([...c.pilotUserIds].sort()).toEqual([NEW, NEW2].sort());
    expect([...c.readyLocales].sort()).toEqual(['de', 'en', 'sr']);
    expect(c.minGapHours).toBe(12);
    expect(c.maxSendsPerTick).toBe(5);
  });
  test('the public status never carries an account id', () => {
    const c = resolveWelcomeTeamConfig({ ...live, WELCOME_TEAM_PILOT_USER_IDS: NEW }, { isStaging: false, featureLive: true });
    const s = JSON.stringify(publicStatus(c));
    for (const id of [MARIIA, JOVANA, ALEX, NEW]) expect(s).not.toContain(id);
  });
});

// ── pure decision ─────────────────────────────────────────────────────────────
describe('VTID-05205: which welcome is due', () => {
  const senders = resolveWelcomeTeamConfig({}, { isStaging: false, featureLive: false }).senders;
  const base = { baseline: ROLLOUT, memberId: NEW, senders, minGapHours: 20, unavailableSenders: new Set<never>() };
  const at = (h: number) => new Date(ROLLOUT.getTime() + h * HOUR);
  const sent = (h: number) => ({ status: 'sent' as const, attempts: 1, sent_at: at(h).toISOString(), updated_at: at(h).toISOString() });

  test('Mariia right after registration; Jovana only from day 1; Alex only from day 2', () => {
    expect(decideWelcome({ ...base, now: at(0.1), claims: { bySender: {} } })).toMatchObject({ send: true, sender: { slug: 'mariia' } });
    expect(decideWelcome({ ...base, now: at(23), claims: { bySender: { mariia: sent(0.1) } } })).toEqual({ send: false, reason: 'not_due' });
    expect(decideWelcome({ ...base, now: at(24.2), claims: { bySender: { mariia: sent(0.1) } } })).toMatchObject({ send: true, sender: { slug: 'jovana' } });
    expect(decideWelcome({ ...base, now: at(47), claims: { bySender: { mariia: sent(0.1), jovana: sent(24.2) } } })).toEqual({ send: false, reason: 'not_due' });
    // Alex is due at 48 h, but Jovana went out late (at 40 h): Alex waits the 20 h gap.
    expect(decideWelcome({ ...base, now: at(48.1), claims: { bySender: { mariia: sent(0.1), jovana: sent(40) } } })).toEqual({ send: false, reason: 'min_gap' });
    expect(decideWelcome({ ...base, now: at(60.1), claims: { bySender: { mariia: sent(0.1), jovana: sent(40) } } })).toMatchObject({ send: true, sender: { slug: 'alex' } });
    expect(decideWelcome({ ...base, now: at(48.3), claims: { bySender: { mariia: sent(0.1), jovana: sent(24.2) } } })).toMatchObject({ send: true, sender: { slug: 'alex' } });
    expect(decideWelcome({ ...base, now: at(99), claims: { bySender: { mariia: sent(0.1), jovana: sent(24.2), alex: sent(48.3) } } })).toEqual({ send: false, reason: 'all_sent' });
  });
  test('a late tick never sends two welcomes close together (min gap)', () => {
    // The tick was down for 3 days: Mariia goes first, Jovana must wait the gap.
    const d = decideWelcome({ ...base, now: at(80), claims: { bySender: { mariia: sent(79) } } });
    expect(d).toEqual({ send: false, reason: 'min_gap' });
  });
  test('a failed first attempt is retried once; a spent retry and an in-flight claim are never re-sent', () => {
    const failed1 = { status: 'failed' as const, attempts: 1, sent_at: null, updated_at: at(0).toISOString() };
    const failed2 = { ...failed1, attempts: 2 };
    const pending = { status: 'pending' as const, attempts: 1, sent_at: null, updated_at: at(20).toISOString() };
    expect(decideWelcome({ ...base, now: at(1), claims: { bySender: { mariia: failed1 } } })).toMatchObject({ send: true, sender: { slug: 'mariia' } });
    // Spent retry: Mariia is skipped, Jovana is next once due.
    expect(decideWelcome({ ...base, now: at(25), claims: { bySender: { mariia: failed2 } } })).toMatchObject({ send: true, sender: { slug: 'jovana' } });
    // In flight: never re-sent, and it counts for the gap.
    expect(decideWelcome({ ...base, now: at(1), claims: { bySender: { mariia: pending } } })).toEqual({ send: false, reason: 'not_due' });
    expect(decideWelcome({ ...base, now: at(24.15), claims: { bySender: { mariia: pending } } })).toEqual({ send: false, reason: 'min_gap' });
  });
  test('a sender never welcomes themselves; an unavailable sender is skipped', () => {
    expect(decideWelcome({ ...base, memberId: MARIIA, now: at(0.1), claims: { bySender: {} } })).toEqual({ send: false, reason: 'not_due' });
    expect(decideWelcome({ ...base, memberId: MARIIA, now: at(25), claims: { bySender: {} } })).toMatchObject({ send: true, sender: { slug: 'jovana' } });
    expect(decideWelcome({ ...base, now: at(0.1), claims: { bySender: {} }, unavailableSenders: new Set(['mariia'] as const) }))
      .toEqual({ send: false, reason: 'not_due' });
  });
});

// ── texts ─────────────────────────────────────────────────────────────────────
describe('VTID-05205: the welcome texts', () => {
  test('first name only; no name ⇒ the no-name text', () => {
    expect(firstName('Anna Müller')).toBe('Anna');
    expect(firstName('  @anna ')).toBe('anna');
    expect(firstName('')).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(welcomeTextKey('jovana', false)).toBe('welcome_team.jovana.body_noname');
    expect(composeWelcome('mariia', 'en', 'Anna Müller')).toMatch(/^Hi Anna, /);
    expect(composeWelcome('mariia', 'en', null)).toMatch(/^Hi there, /);
  });
  test('locale gate: a reviewed locale is used, any other gets English', () => {
    const ready = new Set(['de', 'en']);
    expect(welcomeLocale('de', ready)).toBe('de');
    expect(welcomeLocale('en-US', ready)).toBe('en');
    expect(welcomeLocale('fr', ready)).toBe('en');
    expect(welcomeLocale('', ready)).toBe('en');
    expect(composeWelcome('alex', welcomeLocale('fr', ready), 'Anna')).toBe(tt('welcome_team.alex.body', 'en', { name: 'Anna' }));
  });
  test('every locale has all six texts with the {name} placeholder where expected and at most one emoji', () => {
    const emoji = /\p{Extended_Pictographic}/gu;
    for (const lc of GATEWAY_LOCALES.filter((l) => l !== 'ar')) {
      for (const slug of ['mariia', 'jovana', 'alex'] as const) {
        const withName = tt(`welcome_team.${slug}.body` as any, lc, { name: 'Ana' });
        const noName = tt(`welcome_team.${slug}.body_noname` as any, lc);
        expect(withName).toContain('Ana');
        expect(withName).not.toContain('{name}');
        expect(noName).not.toContain('{name}');
        expect((withName.match(emoji) ?? []).length).toBeLessThanOrEqual(1);
        expect((noName.match(emoji) ?? []).length).toBeLessThanOrEqual(1);
      }
    }
  });
  test('Alex is a real person: no AI claim and no promise of an immediate reply, in any locale', () => {
    const banned = /\b(AI|KI|IA|bot|robot|assistant)\b|immediately|right away|instantly|sofort|umgehend|de inmediato|tout de suite|imediatamente|немедленно|сразу|natychmiast|hemen|odmah|立即|马上/i;
    for (const lc of GATEWAY_LOCALES.filter((l) => l !== 'ar')) {
      for (const k of ['welcome_team.alex.body', 'welcome_team.alex.body_noname'] as const) {
        expect(tt(k, lc, { name: 'Ana' })).not.toMatch(banned);
      }
    }
  });
});

// ── in-memory database ────────────────────────────────────────────────────────
interface Claim { user_id: string; sender_slug: string; tenant_id: string; status: string; attempts: number; chat_message_id: string | null; sent_at: string | null; updated_at: string }

function fakeDb(seed: { user_tenants: any[]; app_users: any[] }, clock: { now: Date }, opts: { failInsertTimes?: number } = {}) {
  const tables: Record<string, any[]> = {
    user_tenants: seed.user_tenants, app_users: seed.app_users, welcome_team_claims: [] as Claim[], chat_messages: [],
  };
  let failInserts = opts.failInsertTimes ?? 0;
  const writes: Array<{ table: string; op: string }> = [];
  let seq = 0;

  const rpc = jest.fn(async (fn: string, a: any) => {
    const claims = tables.welcome_team_claims as Claim[];
    const now = clock.now.toISOString();
    if (fn === 'claim_welcome_message') {
      writes.push({ table: 'welcome_team_claims', op: 'claim' });
      const c = claims.find((x) => x.user_id === a.p_user_id && x.sender_slug === a.p_sender_slug);
      if (!c) {
        claims.push({ user_id: a.p_user_id, sender_slug: a.p_sender_slug, tenant_id: a.p_tenant_id, status: 'pending', attempts: 1, chat_message_id: null, sent_at: null, updated_at: now });
        return { data: { ok: true, claimed: true, attempt: 1 }, error: null };
      }
      if (c.status === 'failed' && c.attempts === 1) { c.status = 'pending'; c.attempts = 2; c.updated_at = now; return { data: { ok: true, claimed: true, attempt: 2 }, error: null }; }
      return { data: { ok: true, claimed: false, reason: c.status === 'sent' ? 'already_sent' : c.status === 'pending' ? 'in_flight' : 'retry_spent' }, error: null };
    }
    if (fn === 'finish_welcome_message') {
      writes.push({ table: 'welcome_team_claims', op: 'finish' });
      const c = claims.find((x) => x.user_id === a.p_user_id && x.sender_slug === a.p_sender_slug && x.status === 'pending');
      if (!c) return { data: { ok: false, error: 'NOT_PENDING' }, error: null };
      c.status = a.p_status; c.updated_at = now;
      if (a.p_status === 'sent') { c.sent_at = now; c.chat_message_id = a.p_chat_message_id; }
      return { data: { ok: true }, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  });

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let pendingInsert: any = null;
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      insert: (row: any) => { pendingInsert = row; return q; },
      single: async () => {
        writes.push({ table, op: 'insert' });
        if (table === 'chat_messages' && failInserts > 0) { failInserts--; return { data: null, error: { message: 'boom' } }; }
        const row = { id: `msg-${++seq}`, created_at: clock.now.toISOString(), ...pendingInsert };
        (tables[table] ??= []).push(row);
        return { data: { id: row.id }, error: null };
      },
      update: () => { writes.push({ table, op: 'update' }); return q; },
      upsert: async () => { writes.push({ table, op: 'upsert' }); return { error: null }; },
      delete: () => { writes.push({ table, op: 'delete' }); return q; },
      then: (ok: any, ko: any) => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve({ data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { client: { from, rpc } as any, tables, writes, rpc };
}

const senderUsers = [
  { user_id: MARIIA, display_name: 'Mariia Maksina', vitana_id: 'mariia11' },
  { user_id: JOVANA, display_name: 'Jovana Tadić', vitana_id: 'jovana4' },
  { user_id: ALEX, display_name: 'Alex Blue', vitana_id: 'dragan1' },
];
const membership = (user_id: string, created: Date) => ({ user_id, tenant_id: TENANT, is_primary: true, created_at: created.toISOString() });

function liveConfig(over: Partial<WelcomeTeamConfig> = {}): WelcomeTeamConfig {
  return {
    ...resolveWelcomeTeamConfig({}, { isStaging: false, featureLive: false }),
    mode: 'live', reason: 'live', rolloutAt: ROLLOUT, audience: 'all', ...over,
  };
}

async function simulate(db: ReturnType<typeof fakeDb>, clock: { now: Date }, config: WelcomeTeamConfig, hours: number, extra: { notify?: any; locale?: any; emit?: any } = {}) {
  const notify = extra.notify ?? jest.fn(async () => ({ pushed: 1, inapp: true }));
  const results = [];
  const start = clock.now.getTime();
  for (let h = 0; h <= hours; h += 0.25) { // a tick every 15 minutes
    clock.now = new Date(start + h * HOUR);
    results.push(await runWelcomeTeamTick({ sb: db.client, now: clock.now, config, notify, locale: extra.locale ?? (async () => 'en'), emit: extra.emit }));
  }
  return { notify, results };
}

// ── the tick ─────────────────────────────────────────────────────────────────
describe('VTID-05205: the tick (in-memory, fake clock)', () => {
  test('a new member gets Mariia, then Jovana, then Alex — once each, on three different days', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + 2 * HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna Müller', vitana_id: 'anna1' }] }, clock);
    const { notify } = await simulate(db, clock, liveConfig(), 24 * 5);

    const dms = db.tables.chat_messages;
    expect(dms.map((m) => m.sender_id)).toEqual([MARIIA, JOVANA, ALEX]);
    expect(new Set(dms.map((m) => m.created_at.slice(0, 10))).size).toBe(3);
    for (let i = 1; i < dms.length; i++) {
      expect(new Date(dms[i].created_at).getTime() - new Date(dms[i - 1].created_at).getTime()).toBeGreaterThanOrEqual(20 * HOUR);
    }
    // Mariia arrives on the first tick after registration.
    expect(new Date(dms[0].created_at).getTime() - (ROLLOUT.getTime() + 2 * HOUR)).toBeLessThanOrEqual(15 * 60_000);
    for (const m of dms) {
      expect(m).toMatchObject({ receiver_id: NEW, tenant_id: TENANT, message_type: 'text', receiver_vitana_id: 'anna1' });
      expect(m.metadata).toMatchObject({ source: 'welcome_team', automated: true, done_by_vitana: false, vtid: 'VTID-05205', locale: 'en' });
      expect(m.content).toMatch(/^(Hi|Hey) Anna, /);
    }
    expect(dms[0].sender_vitana_id).toBe('mariia11');
    expect(db.tables.welcome_team_claims.every((c: Claim) => c.status === 'sent' && c.chat_message_id)).toBe(true);

    // One push per DM, shaped like a DM from that person: a reply opens their thread.
    expect(notify).toHaveBeenCalledTimes(3);
    const [, , type, payload] = notify.mock.calls[2];
    expect(type).toBe('new_chat_message');
    expect(payload).toMatchObject({ title: 'Alex Blue', data: { sender_id: ALEX, thread_id: ALEX, url: `/inbox/u/${ALEX}` } });
  });

  test('retries, repeat ticks and a second run never send a welcome twice', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna', vitana_id: null }] }, clock);
    await simulate(db, clock, liveConfig(), 24 * 4);
    // The same hour ticked again (an EventBridge retry), and a whole extra week.
    await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: liveConfig(), notify: jest.fn(async () => ({ pushed: 1, inapp: true })), locale: async () => 'en' });
    await simulate(db, clock, liveConfig(), 24 * 7);
    expect(db.tables.chat_messages).toHaveLength(3);
    // A sign-in creates no membership row and calls nothing here: there is no other send path.
  });

  test('members who joined before the rollout never get a welcome (no retroactive sends)', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({
      user_tenants: [membership(VETERAN, new Date(ROLLOUT.getTime() - 10 * DAY)), membership(NEW, new Date(ROLLOUT.getTime() - 60_000))],
      app_users: [...senderUsers, { user_id: VETERAN, display_name: 'Vera' }, { user_id: NEW, display_name: 'Anna' }],
    }, clock);
    await simulate(db, clock, liveConfig(), 24 * 4);
    expect(db.tables.chat_messages).toHaveLength(0);
  });

  test('test/service accounts get nothing; a failed exclusion lookup skips the whole tick before any write', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(BOT, clock.now)], app_users: [...senderUsers, { user_id: BOT, display_name: 'Bot' }] }, clock);
    await simulate(db, clock, liveConfig(), 24 * 3);
    expect(db.tables.chat_messages).toHaveLength(0);

    mockStrict.mockResolvedValue({ ok: false, error: 'service_bot_accounts: timeout' });
    const db2 = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }] }, clock);
    const r = await runWelcomeTeamTick({ sb: db2.client, now: clock.now, config: liveConfig(), notify: jest.fn(), locale: async () => 'en' });
    expect(r).toMatchObject({ ok: false, reason: 'exclusion_unavailable' });
    expect(db2.writes).toEqual([]);
  });

  test('a sender who is excluded or has no account sends nothing; the others still do', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set([JOVANA]) });
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [senderUsers[0], senderUsers[1], { user_id: NEW, display_name: 'Anna' }] }, clock);
    await simulate(db, clock, liveConfig(), 24 * 4);
    expect(db.tables.chat_messages.map((m) => m.sender_id)).toEqual([MARIIA]); // Jovana excluded, Alex has no app_users row
  });

  test('a sender who joins as a member gets the other two welcomes, never their own', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(JOVANA, clock.now)], app_users: senderUsers }, clock);
    await simulate(db, clock, liveConfig(), 24 * 4);
    expect(db.tables.chat_messages.map((m) => m.sender_id)).toEqual([MARIIA, ALEX]);
    expect(db.tables.chat_messages.every((m) => m.sender_id !== m.receiver_id)).toBe(true);
  });

  test('closed pilot: only allowlisted members, counted from the rollout; an empty allowlist reaches nobody', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const seed = () => ({
      user_tenants: [membership(NEW, clock.now), membership(VETERAN, new Date(ROLLOUT.getTime() - 30 * DAY))],
      app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }, { user_id: VETERAN, display_name: 'Vera' }],
    });
    const db = fakeDb(seed(), clock);
    await simulate(db, clock, liveConfig({ audience: 'pilot', pilotUserIds: new Set([VETERAN]) }), 24 * 4);
    expect(new Set(db.tables.chat_messages.map((m) => m.receiver_id))).toEqual(new Set([VETERAN]));
    expect(db.tables.chat_messages).toHaveLength(3);

    clock.now = new Date(ROLLOUT.getTime() + HOUR);
    const db2 = fakeDb(seed(), clock);
    await simulate(db2, clock, liveConfig({ audience: 'pilot', pilotUserIds: new Set() }), 24 * 3);
    expect(db2.tables.chat_messages).toHaveLength(0);
  });

  test('shadow decides but writes nothing at all', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }] }, clock);
    const notify = jest.fn();
    const r = await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: liveConfig({ mode: 'shadow', reason: 'shadow' }), notify, locale: async () => 'en' });
    expect(r.would_send).toEqual({ mariia: 1, jovana: 0, alex: 0 });
    expect(r.sent).toEqual({ mariia: 0, jovana: 0, alex: 0 });
    expect(db.writes).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  test('off / staging configs do nothing at all', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: senderUsers }, clock);
    for (const mode of ['off', 'disabled-on-staging'] as const) {
      const r = await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: liveConfig({ mode, reason: mode }) });
      expect(r).toEqual({ ok: true, mode, reason: mode });
    }
    expect(db.writes).toEqual([]);
    expect(mockStrict).not.toHaveBeenCalled();
  });

  test('a failed DM write is retried once on a later tick, and never a third time', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const ok = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }] }, clock, { failInsertTimes: 1 });
    const { notify } = await simulate(ok, clock, liveConfig(), 24 * 4);
    expect(ok.tables.chat_messages.map((m) => m.sender_id)).toEqual([MARIIA, JOVANA, ALEX]);
    expect(ok.tables.welcome_team_claims.find((c: Claim) => c.sender_slug === 'mariia')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(notify).toHaveBeenCalledTimes(3); // no push for the failed write

    clock.now = new Date(ROLLOUT.getTime() + HOUR);
    const bad = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }] }, clock, { failInsertTimes: 2 });
    await simulate(bad, clock, liveConfig(), 24 * 4);
    expect(bad.tables.welcome_team_claims.find((c: Claim) => c.sender_slug === 'mariia')).toMatchObject({ status: 'failed', attempts: 2 });
    expect(bad.tables.chat_messages.map((m) => m.sender_id)).toEqual([JOVANA, ALEX]);
  });

  test('a failed push never undoes the DM', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }] }, clock);
    const notify = jest.fn(async () => { throw new Error('fcm down'); });
    await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: liveConfig(), notify, locale: async () => 'en' });
    expect(db.tables.chat_messages).toHaveLength(1);
    expect(db.tables.welcome_team_claims[0]).toMatchObject({ status: 'sent' });
  });

  test("the recipient's language: reviewed locales as-is, others in English, missing name ⇒ no-name text", async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({
      user_tenants: [membership(NEW, clock.now), membership(NEW2, clock.now)],
      app_users: [...senderUsers, { user_id: NEW, display_name: 'Anna' }, { user_id: NEW2, display_name: '' }],
    }, clock);
    const locale = async (_sb: unknown, id: string) => (id === NEW ? 'de' : 'fr');
    await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: liveConfig(), notify: jest.fn(async () => ({ pushed: 1, inapp: true })), locale });
    const byReceiver = Object.fromEntries(db.tables.chat_messages.map((m) => [m.receiver_id, m]));
    expect(byReceiver[NEW].content).toBe(tt('welcome_team.mariia.body', 'de', { name: 'Anna' }));
    expect(byReceiver[NEW].metadata.locale).toBe('de');
    expect(byReceiver[NEW2].content).toBe(tt('welcome_team.mariia.body_noname', 'en'));
    expect(byReceiver[NEW2].metadata.locale).toBe('en');
  });

  test('a member whose registration is not complete (no app_users row) waits', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const db = fakeDb({ user_tenants: [membership(NEW, clock.now)], app_users: senderUsers }, clock);
    const r = await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: liveConfig(), notify: jest.fn(), locale: async () => 'en' });
    expect(r.skipped).toEqual({ registration_incomplete: 1 });
    expect(db.tables.chat_messages).toHaveLength(0);
  });

  test('at most maxSendsPerTick DMs per invocation; the rest follow on the next tick', async () => {
    const clock = { now: new Date(ROLLOUT.getTime() + HOUR) };
    const ids = Array.from({ length: 5 }, (_, i) => `5555555${i}-5555-4555-8555-555555555555`);
    const db = fakeDb({
      user_tenants: ids.map((id) => membership(id, clock.now)),
      app_users: [...senderUsers, ...ids.map((id) => ({ user_id: id, display_name: 'M' }))],
    }, clock);
    const cfg = liveConfig({ maxSendsPerTick: 2 });
    const r = await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: cfg, notify: jest.fn(async () => ({ pushed: 1, inapp: true })), locale: async () => 'en' });
    expect(r.capped).toBe(true);
    expect(db.tables.chat_messages).toHaveLength(2);
    await runWelcomeTeamTick({ sb: db.client, now: clock.now, config: cfg, notify: jest.fn(async () => ({ pushed: 1, inapp: true })), locale: async () => 'en' });
    expect(db.tables.chat_messages).toHaveLength(4);
  });
});

// ── endpoints ─────────────────────────────────────────────────────────────────
describe('VTID-05205: the endpoints', () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; });

  function appWith(env: Record<string, string | undefined>) {
    process.env = { ...prev, ...env };
    jest.resetModules();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/scheduled-notifications', require('../src/routes/scheduled-notifications').default);
    app.use('/api/v1/welcome-team', require('../src/routes/community-welcome-team').default);
    return app;
  }

  test('the tick needs the internal token whatever the global auth mode is', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', SCHEDULED_NOTIFICATIONS_AUTH_MODE: 'off' });
    expect((await request(app).post('/api/v1/scheduled-notifications/welcome-team-tick')).status).toBe(401);
    expect((await request(app).post('/api/v1/scheduled-notifications/welcome-team-tick').set('X-Gateway-Internal', 'wrong')).status).toBe(403);
  });
  test('503 when no internal token is configured', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: '', SCHEDULED_NOTIFICATIONS_AUTH_MODE: 'off' });
    expect((await request(app).post('/api/v1/scheduled-notifications/welcome-team-tick').set('X-Gateway-Internal', 'x')).status).toBe(503);
  });
  test('the staging gateway refuses the tick even with a valid token and every switch on', async () => {
    const app = appWith({
      GATEWAY_INTERNAL_TOKEN: 'secret', VITANA_ENV: 'staging', FEATURE_WELCOME_TEAM_ENV: 'staging+prod',
      WELCOME_ROLLOUT_AT: ROLLOUT.toISOString(), WELCOME_TEAM_MODE: 'live', WELCOME_TEAM_SEND_ENABLED: 'true', WELCOME_SENDER_NAMES_CONFIRMED: 'true',
    });
    const r = await request(app).post('/api/v1/scheduled-notifications/welcome-team-tick').set('X-Gateway-Internal', 'secret');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, mode: 'disabled-on-staging' });
  });
  test('with the feature off the tick answers without touching the database', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', VITANA_ENV: 'production', FEATURE_WELCOME_TEAM_ENV: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE: '' });
    const r = await request(app).post('/api/v1/scheduled-notifications/welcome-team-tick').set('X-Gateway-Internal', 'secret');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: 'off', reason: 'feature_off' });
  });
  test('status is a read-only GET with the mode and no member or account data', async () => {
    const app = appWith({ VITANA_ENV: 'staging', WELCOME_TEAM_PILOT_USER_IDS: NEW });
    const r = await request(app).get('/api/v1/welcome-team/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'disabled-on-staging', reason: 'staging_shares_production_database', env: 'staging', audience: 'pilot' });
    const s = JSON.stringify(r.body);
    for (const id of [MARIIA, JOVANA, ALEX, NEW]) expect(s).not.toContain(id);
  });
});

// ── the migration ─────────────────────────────────────────────────────────────
describe('VTID-05205: migration', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20261015150000_vtid_05205_welcome_team_claims.sql'), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');

  test('one transaction, idempotent DDL', () => {
    expect(code.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.welcome_team_claims/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(code).not.toMatch(/CREATE FUNCTION/);
  });
  test('send-once key, RLS on with no policies, functions for service_role only', () => {
    expect(code).toMatch(/PRIMARY KEY \(user_id, sender_slug\)/);
    expect(code).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(code).not.toMatch(/CREATE POLICY/);
    expect(code).toMatch(/REVOKE ALL ON public\.welcome_team_claims FROM anon, authenticated/);
    for (const fn of ['claim_welcome_message\\(uuid, uuid, text\\)', 'finish_welcome_message\\(uuid, text, text, uuid\\)']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC`));
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM anon, authenticated`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO service_role`));
    }
    expect(code.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(code.match(/SET search_path = public/g)).toHaveLength(2);
  });
  test('adds no trigger and touches no existing table', () => {
    expect(code).not.toMatch(/CREATE (OR REPLACE )?TRIGGER/i);
    expect(code).not.toMatch(/ALTER TABLE (?!public\.welcome_team_claims)/);
    expect(code).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM) public\.(chat_messages|user_tenants|app_users)/);
  });
});
