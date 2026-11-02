/**
 * VTID-05099 — Vitana Companion Messages, Phase 1 (shadow only).
 * `npm run test:companion`
 *
 * Sparred plan (docs/validation/VTID-05099/plan-sparring.md, owner approved
 * 2026-10-12). Pins: the moment → card choice (topics, anti-repeat, fallback);
 * the mode rules (never on staging, feature flag, no sending mode in Phase 1);
 * the shadow tick (local window, exclusions, opt-out, one decision per member
 * per local day, onboarding touch, pacer, compose cap, sends nothing); the
 * composer (Bedrock only, English intent, localized prompt, validation, no
 * template fallback); the endpoints; and the proactive match message claiming
 * the shared one-a-day slot.
 */
import express from 'express';
import request from 'supertest';

const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import { resolveCompanionConfig, type CompanionConfig } from '../src/services/companion/config';
import { pickMoment, MOMENTS, MORNING_GREETING_INTENT, type MemberContext } from '../src/services/companion/moments';
import {
  composeCompanionMessage, validateComposition, buildComposePrompt, COMPANION_BASE_PROMPT,
} from '../src/services/companion/composer';
import { localTime } from '../src/services/companion/local-time';
import { runCompanionTick } from '../src/services/companion/companion-service';
import { VITANA_BOT_USER_ID } from '../src/lib/vitana-bot';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '11111111-1111-4111-8111-111111111111'; // Berlin, inside the window at NOW
const B = '22222222-2222-4222-8222-222222222222'; // New York, outside the window at NOW
const C = '33333333-3333-4333-8333-333333333333'; // test account (excluded)
const D = '44444444-4444-4444-8444-444444444444'; // Berlin, opted out
// 2026-10-20 06:15 UTC = 08:15 Berlin (CEST), 02:15 New York.
const NOW = new Date('2026-10-20T06:15:00Z');

const INDEX = {
  total: 512, tier: 'Early', trend_7d: 14, points_to_really_good: 88,
  weakest_pillar: { name: 'sleep', score: 60 }, strongest_pillar: { name: 'nutrition', score: 140 },
} as any;

function ctx(over: Partial<MemberContext> = {}): MemberContext {
  return {
    userId: A, tenantId: T, firstName: 'Dragan', locale: 'de', localDate: '2026-10-20',
    topics: { health: true, community: true, business: false },
    vitanaIndex: INDEX, lastUsed: {}, ...over,
  };
}

const shadowConfig: CompanionConfig = {
  mode: 'shadow', reason: 'shadow', windowStartMin: 450, windowEndMin: 570,
  shadowComposeLimit: 20, model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
};

// ── moments ─────────────────────────────────────────────────────────────────
describe('VTID-05099: which moment and which Vitana card', () => {
  it('brings the Vitana Index (card F2) when there is a score', () => {
    const m = pickMoment(ctx());
    expect(m.momentKey).toBe('vitana_index');
    expect(m.cardType).toBe('F2');
    expect(m.facts).toMatchObject({ score: 512, tier: 'Early', weakest_pillar: 'sleep', trend_7d: 14 });
  });

  it('falls back to the morning greeting (card F4 Talk to Vitana) with no score', () => {
    const m = pickMoment(ctx({ vitanaIndex: null }));
    expect(m).toMatchObject({ momentKey: 'morning_greeting', cardType: 'F4', topic: null });
  });

  it('respects the health topic switch', () => {
    expect(pickMoment(ctx({ topics: { health: false, community: true, business: false } })).momentKey).toBe('morning_greeting');
  });

  it('does not repeat the Index within 3 days, and does again after', () => {
    expect(pickMoment(ctx({ lastUsed: { vitana_index: '2026-10-18' } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ lastUsed: { vitana_index: '2026-10-17' } })).momentKey).toBe('vitana_index');
  });

  it('every moment names a card and carries an English intent, never a finished sentence (rule 41)', () => {
    for (const m of MOMENTS) {
      const c = m.build(ctx());
      expect(c).not.toBeNull();
      expect(c!.cardType).toMatch(/^[EFG]\d+$/);
      expect(c!.intent).toMatch(/^(Warmly greet|Greet) the member/);
      expect(c!.intent).not.toMatch(/["“„]/); // no quoted line to say
    }
    expect(MORNING_GREETING_INTENT).toContain('press the ORB');
  });
});

// ── mode ────────────────────────────────────────────────────────────────────
describe('VTID-05099: mode', () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
  it('never runs on staging', () => {
    expect(resolveCompanionConfig(env({ COMPANION_MODE: 'shadow' }), { isStaging: true, featureLive: true }).mode).toBe('disabled-on-staging');
  });
  it('is off without the feature flag or COMPANION_MODE', () => {
    expect(resolveCompanionConfig(env({ COMPANION_MODE: 'shadow' }), { isStaging: false, featureLive: false }).mode).toBe('off');
    expect(resolveCompanionConfig(env({}), { isStaging: false, featureLive: true }).mode).toBe('off');
  });
  it('shadow when asked; staff/live have no sending mode in Phase 1 and still run in shadow', () => {
    expect(resolveCompanionConfig(env({ COMPANION_MODE: 'shadow' }), { isStaging: false, featureLive: true }).mode).toBe('shadow');
    for (const m of ['staff', 'live']) {
      const c = resolveCompanionConfig(env({ COMPANION_MODE: m }), { isStaging: false, featureLive: true });
      expect(c).toMatchObject({ mode: 'shadow', reason: 'send_not_available' });
    }
  });
  it('defaults: 07:30–09:30 window, 20 composed samples a day, Bedrock models', () => {
    const c = resolveCompanionConfig(env({ COMPANION_MODE: 'shadow' }), { isStaging: false, featureLive: true });
    expect(c).toMatchObject({ windowStartMin: 450, windowEndMin: 570, shadowComposeLimit: 20 });
    expect(c.model).toMatch(/^eu\.anthropic\./);
    expect(c.fallbackModel).toMatch(/^eu\.anthropic\./);
  });
  it('COMPANION_SHADOW_COMPOSE_LIMIT: 0 means no samples; junk means the default', () => {
    const at = (v: string) => resolveCompanionConfig(env({ COMPANION_MODE: 'shadow', COMPANION_SHADOW_COMPOSE_LIMIT: v }), { isStaging: false, featureLive: true }).shadowComposeLimit;
    expect([at('0'), at('5'), at('abc'), at('-3'), at('')]).toEqual([0, 5, 20, 20, 20]);
  });
  it('an inverted window falls back to the default', () => {
    const c = resolveCompanionConfig(env({ COMPANION_MODE: 'shadow', COMPANION_WINDOW_START: '10:00', COMPANION_WINDOW_END: '09:00' }), { isStaging: false, featureLive: true });
    expect([c.windowStartMin, c.windowEndMin]).toEqual([450, 570]);
  });
});

describe('VTID-05099: local time', () => {
  it("uses the member's zone and falls back to Europe/Berlin", () => {
    expect(localTime(NOW, 'Europe/Berlin')).toEqual({ date: '2026-10-20', minuteOfDay: 8 * 60 + 15 });
    expect(localTime(NOW, 'America/New_York')).toEqual({ date: '2026-10-20', minuteOfDay: 2 * 60 + 15 });
    expect(localTime(NOW, 'Not/AZone')).toEqual(localTime(NOW, 'Europe/Berlin'));
    expect(localTime(new Date('2026-10-20T23:30:00Z'), 'Europe/Berlin').date).toBe('2026-10-21');
  });
});

// ── composer ────────────────────────────────────────────────────────────────
describe('VTID-05099: composer', () => {
  const okCall = jest.fn(async () => ({ ok: true, text: 'Guten Morgen Dragan! Dein Vitana Index liegt heute bei 512.', provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' }));

  it('calls Bedrock for primary AND fallback, with the localized prompt and the English intent', async () => {
    const moment = pickMoment(ctx());
    const r = await composeCompanionMessage(ctx(), moment, shadowConfig, okCall as any);
    expect(r).toEqual({ ok: true, text: 'Guten Morgen Dragan! Dein Vitana Index liegt heute bei 512.', model: 'eu.anthropic.claude-sonnet-4-6' });
    const [, prompt, opts] = (okCall.mock.calls[0] as any);
    expect(opts.providerOverride).toBe('bedrock');
    expect(opts.modelOverride).toBe(shadowConfig.model);
    expect(opts.fallbackOverride).toEqual({ provider: 'bedrock', model: shadowConfig.fallbackModel });
    expect(opts.systemPrompt).toMatch(/^LANGUAGE: Respond ONLY in German/);
    expect(opts.systemPrompt).toContain(COMPANION_BASE_PROMPT);
    expect(prompt).toContain(`Intent: ${moment.intent}`);
    expect(prompt).toContain('"score":512');
  });

  it('never uses an answer from a non-Bedrock provider', async () => {
    const call = jest.fn(async () => ({ ok: true, text: 'Hallo', provider: 'vertex', model: 'gemini' }));
    expect(await composeCompanionMessage(ctx(), pickMoment(ctx()), shadowConfig, call as any)).toEqual({ ok: false, error: 'non_bedrock_provider:vertex' });
  });

  it('a failed or truncated call is a skip, never a template', async () => {
    const fail = jest.fn(async () => ({ ok: false, error: 'both providers failed' }));
    expect(await composeCompanionMessage(ctx(), pickMoment(ctx()), shadowConfig, fail as any)).toEqual({ ok: false, error: 'both providers failed' });
    const cut = jest.fn(async () => ({ ok: true, text: 'Guten', truncated: true, provider: 'bedrock' }));
    expect(await composeCompanionMessage(ctx(), pickMoment(ctx()), shadowConfig, cut as any)).toEqual({ ok: false, error: 'truncated' });
    const threw = jest.fn(async () => { throw new Error('boom'); });
    expect((await composeCompanionMessage(ctx(), pickMoment(ctx()), shadowConfig, threw as any)).ok).toBe(false);
  });

  it('validates the text', () => {
    expect(validateComposition('', 'de')).toEqual({ ok: false, error: 'empty' });
    expect(validateComposition('x'.repeat(701), 'de')).toEqual({ ok: false, error: 'too_long' });
    expect(validateComposition('Schau hier https://x.y', 'de')).toEqual({ ok: false, error: 'contains_link' });
    expect(validateComposition('- Punkt eins', 'de')).toEqual({ ok: false, error: 'contains_markdown' });
    expect(validateComposition('Good morning!', 'ru')).toEqual({ ok: false, error: 'wrong_script' });
    expect(validateComposition('Доброе утро!', 'ru')).toEqual({ ok: true, text: 'Доброе утро!' });
    expect(validateComposition('"Guten Morgen!"', 'de')).toEqual({ ok: true, text: 'Guten Morgen!' });
  });

  it('a missing first name is said to the model, not invented', () => {
    expect(buildComposePrompt(ctx({ firstName: null }), pickMoment(ctx()))).toContain('(unknown — greet warmly without a name)');
  });
});

// ── the shadow tick ─────────────────────────────────────────────────────────
function fakeDb(tables: Record<string, any[]>) {
  const writes: Array<{ table: string; op: string }> = [];
  const ledger = (tables.companion_messages_ledger ??= []);
  let nextId = 1;
  const rpc = jest.fn(async (fn: string, a: any) => {
    if (fn === 'claim_companion_message') {
      const taken = ledger.some((r) => r.user_id === a.p_user_id && r.local_date === a.p_local_date
        && (r.mode === a.p_mode || (a.p_mode !== 'shadow' && r.mode !== 'shadow')));
      if (taken) return { data: { ok: true, claimed: false, reason: a.p_mode === 'shadow' ? 'already_decided_today' : 'already_sent_today' }, error: null };
      const row = { id: nextId++, user_id: a.p_user_id, tenant_id: a.p_tenant_id, local_date: a.p_local_date, mode: a.p_mode,
        sender: a.p_sender, moment_key: a.p_moment_key, card_type: a.p_card_type, facts: a.p_facts, status: 'pending',
        composed_text: null, created_at: NOW.toISOString() };
      ledger.push(row);
      return { data: { ok: true, claimed: true, id: row.id }, error: null };
    }
    if (fn === 'finish_companion_message') {
      const row = ledger.find((r) => r.id === a.p_id && r.status === 'pending');
      if (!row) return { data: { ok: false, error: 'NOT_PENDING' }, error: null };
      Object.assign(row, { status: a.p_status, composed_text: a.p_composed_text, composed_by_model: a.p_composed_by_model, chat_message_id: a.p_chat_message_id });
      return { data: { ok: true }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let head = false;
    const q: any = {
      select: (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return q; },
      order: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      not: (c: string, _op: string, _v: null) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      insert: async () => { writes.push({ table, op: 'insert' }); return { error: null }; },
      upsert: async () => { writes.push({ table, op: 'upsert' }); return { error: null }; },
      update: () => { writes.push({ table, op: 'update' }); return q; },
      delete: () => { writes.push({ table, op: 'delete' }); return q; },
      then: (ok: any, ko: any) => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { client: { from, rpc } as any, writes, rpc, tables, ledger };
}

function seed() {
  return {
    user_tenants: [A, B, C, D, VITANA_BOT_USER_ID].map((id) => ({ user_id: id, tenant_id: T, is_primary: true })),
    profiles: [
      { user_id: A, first_name: 'Dragan', timezone: 'Europe/Berlin' },
      { user_id: B, first_name: 'Ana', timezone: 'America/New_York' },
      { user_id: C, first_name: 'Test', timezone: 'Europe/Berlin' },
      { user_id: D, first_name: 'Mila', timezone: 'Europe/Berlin' },
      { user_id: VITANA_BOT_USER_ID, first_name: 'Vitana', timezone: 'Europe/Berlin' },
    ],
    companion_preferences: [{ user_id: D, enabled: false, topic_health: true, topic_community: true, topic_business: false }],
    onboarding_touch_ledger: [] as any[],
  } as Record<string, any[]>;
}

function deps(db: ReturnType<typeof fakeDb>, over: Record<string, unknown> = {}) {
  return {
    sb: db.client, now: NOW, config: shadowConfig,
    emit: jest.fn(async () => ({ ok: true })),
    pacer: jest.fn(async () => ({ allow: true, reason: 'ok' as const })),
    fetchIndex: jest.fn(async () => INDEX),
    compose: jest.fn(async () => ({ ok: true as const, text: 'Guten Morgen Dragan!', model: 'eu.anthropic.claude-sonnet-4-6' })),
    locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
    // VTID-05366: these tests are about the Phase 1 moments; members are fully set
    // up so the enrichment moments (pinned in vtid-05366-companion-enrichment-moments)
    // stay out of the way.
    enrichment: jest.fn(async (_sb: unknown, ids: string[]) => ({
      completions: new Map(ids.map((id) => [id, new Map(ENRICHMENT_ALL.map((t) => [t, true]))])),
      dismissals: new Map(ids.map((id) => [id, []])),
      unavailable: [],
    })),
    ...over,
  };
}

const ENRICHMENT_ALL = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11'] as const;

describe('VTID-05099: the shadow tick', () => {
  beforeEach(() => mockStrict.mockResolvedValue({ ok: true, ids: new Set([C]) }));

  it('decides one moment for the member inside their local window and sends nothing', async () => {
    const db = fakeDb(seed());
    const d = deps(db);
    const r = await runCompanionTick(d as any);
    expect(r).toMatchObject({ ok: true, mode: 'shadow', members: 3, in_window: 2, decided: 1, composed: 1, moments: { vitana_index: 1 } });
    expect(r.skipped).toEqual({ opted_out: 1 });
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ user_id: A, mode: 'shadow', sender: 'companion', moment_key: 'vitana_index', card_type: 'F2',
      status: 'shadow', composed_text: 'Guten Morgen Dragan!', local_date: '2026-10-20' });
    // Sends nothing: no table writes at all (no chat_messages, no notifications, no pacer touch) — only the two ledger RPCs.
    expect(db.writes).toEqual([]);
    expect(db.rpc.mock.calls.map((c) => c[0])).toEqual(['claim_companion_message', 'finish_companion_message']);
    // One aggregate OASIS event, no per-member events.
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect((d.emit.mock.calls[0] as any)[0].type).toBe('companion.tick.completed');
  });

  it('never decides for the Vitana bot or an excluded test/service account', async () => {
    const db = fakeDb(seed());
    await runCompanionTick(deps(db) as any);
    expect(db.ledger.map((r) => r.user_id)).not.toContain(C);
    expect(db.ledger.map((r) => r.user_id)).not.toContain(VITANA_BOT_USER_ID);
  });

  it('a failed exclusion lookup skips the whole tick', async () => {
    mockStrict.mockResolvedValueOnce({ ok: false, error: 'down' });
    const db = fakeDb(seed());
    expect(await runCompanionTick(deps(db) as any)).toMatchObject({ ok: false, reason: 'exclusion_unavailable' });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('once per member per local day: later ticks the same day decide nothing', async () => {
    const db = fakeDb(seed());
    await runCompanionTick(deps(db) as any);
    const second = await runCompanionTick(deps(db, { now: new Date(NOW.getTime() + 15 * 60_000) }) as any);
    expect(second.decided).toBe(0);
    expect(second.skipped).toMatchObject({ already_today: 1 });
    expect(db.ledger).toHaveLength(1);
  });

  it('a real proactive DM already sent today (e.g. the match message) means no decision', async () => {
    const tables = seed();
    tables.companion_messages_ledger = [{ id: 99, user_id: A, local_date: '2026-10-20', mode: 'live', moment_key: 'new_match', status: 'sent' }];
    const db = fakeDb(tables);
    const r = await runCompanionTick(deps(db) as any);
    expect(r.decided).toBe(0);
    expect(r.skipped).toMatchObject({ already_today: 1 });
  });

  it('an onboarding touch sent today means no decision (one Vitana touch a day)', async () => {
    const tables = seed();
    tables.onboarding_touch_ledger = [{ user_id: A, local_day: '2026-10-20', status: 'sent' }];
    const r = await runCompanionTick(deps(fakeDb(tables)) as any);
    expect(r.decided).toBe(0);
    expect(r.skipped).toMatchObject({ onboarding_touched_today: 1 });
  });

  it('respects the presence pacer (pause, daily cap)', async () => {
    const db = fakeDb(seed());
    const r = await runCompanionTick(deps(db, { pacer: jest.fn(async () => ({ allow: false, reason: 'paused' })) }) as any);
    expect(r.decided).toBe(0);
    expect(r.skipped).toMatchObject({ pacer_paused: 1 });
  });

  it('respects anti-repeat from the ledger history', async () => {
    const tables = seed();
    tables.companion_messages_ledger = [{ id: 98, user_id: A, local_date: '2026-10-19', mode: 'shadow', moment_key: 'vitana_index', status: 'shadow' }];
    const db = fakeDb(tables);
    await runCompanionTick(deps(db) as any);
    expect(db.ledger.find((r) => r.local_date === '2026-10-20')?.moment_key).toBe('morning_greeting');
  });

  it('caps full compositions per day; beyond the cap it still decides, without text', async () => {
    const tables = seed();
    tables.companion_messages_ledger = Array.from({ length: 20 }, (_, i) => ({
      id: 1000 + i, user_id: `x${i}`, local_date: '2026-10-20', mode: 'shadow', moment_key: 'vitana_index',
      status: 'shadow', composed_text: 'sample', created_at: NOW.toISOString(),
    }));
    const db = fakeDb(tables);
    const d = deps(db);
    const r = await runCompanionTick(d as any);
    expect(r).toMatchObject({ decided: 1, composed: 0 });
    expect(d.compose).not.toHaveBeenCalled();
    expect(db.ledger.find((x) => x.user_id === A)?.composed_text).toBeNull();
  });

  it('a failed composition is recorded without text and counted', async () => {
    const db = fakeDb(seed());
    const r = await runCompanionTick(deps(db, { compose: jest.fn(async () => ({ ok: false, error: 'router_failed: x' })) }) as any);
    expect(r).toMatchObject({ decided: 1, composed: 0, compose_failed: 1 });
    expect(r.skipped).toMatchObject({ compose_router_failed: 1 });
    expect(db.ledger[0]).toMatchObject({ status: 'shadow', composed_text: null });
  });

  it('a tick with nobody in the window emits nothing', async () => {
    const db = fakeDb(seed());
    const d = deps(db, { now: new Date('2026-10-20T18:00:00Z') }); // 20:00 Berlin, 14:00 New York
    const r = await runCompanionTick(d as any);
    expect(r).toMatchObject({ in_window: 0, decided: 0 });
    expect(d.emit).not.toHaveBeenCalled();
  });

  it('off / disabled-on-staging: does nothing at all', async () => {
    for (const mode of ['off', 'disabled-on-staging'] as const) {
      const db = fakeDb(seed());
      const r = await runCompanionTick(deps(db, { config: { ...shadowConfig, mode, reason: mode } }) as any);
      expect(r).toEqual({ ok: true, mode, reason: mode });
      expect(db.rpc).not.toHaveBeenCalled();
    }
  });
});

// ── endpoints ───────────────────────────────────────────────────────────────
describe('VTID-05099: the endpoints', () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; jest.resetModules(); });

  function appWith(env: Record<string, string | undefined>) {
    process.env = { ...prev, ...env } as NodeJS.ProcessEnv;
    jest.resetModules();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/scheduled-notifications', require('../src/routes/scheduled-notifications').default);
    app.use('/api/v1/companion', require('../src/routes/companion').default);
    return app;
  }

  it('the tick needs the internal token whatever the global auth mode is', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', SCHEDULED_NOTIFICATIONS_AUTH_MODE: 'off' });
    expect((await request(app).post('/api/v1/scheduled-notifications/companion-tick')).status).toBe(401);
    expect((await request(app).post('/api/v1/scheduled-notifications/companion-tick').set('X-Gateway-Internal', 'nope')).status).toBe(403);
  });

  it('the staging gateway refuses the tick even with a valid token', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', VITANA_ENV: 'staging', FEATURE_COMPANION_MESSAGES_ENV: 'staging+prod', COMPANION_MODE: 'shadow' });
    const r = await request(app).post('/api/v1/scheduled-notifications/companion-tick').set('X-Gateway-Internal', 'secret');
    expect(r.status).toBe(409);
    expect(r.body.mode).toBe('disabled-on-staging');
  });

  it('off by default in production: the tick answers mode off and touches nothing', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', VITANA_ENV: 'production', FEATURE_COMPANION_MESSAGES_ENV: undefined, COMPANION_MODE: undefined });
    const r = await request(app).post('/api/v1/scheduled-notifications/companion-tick').set('X-Gateway-Internal', 'secret');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'off' });
  });

  it('status is a read-only GET with the mode and nothing about members', async () => {
    const app = appWith({ VITANA_ENV: 'staging' });
    const r = await request(app).get('/api/v1/companion/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: 'disabled-on-staging', reason: 'staging_shares_production_database', env: 'staging' });
  });
});
