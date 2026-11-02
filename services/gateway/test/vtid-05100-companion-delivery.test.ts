/**
 * VTID-05100 — Vitana Companion Messages, Phase 2 backend.
 * `npm run test:companion`
 *
 * Sparred plan (docs/validation/VTID-05099/plan-sparring.md §A.5, §A.7, §B;
 * owner approved 2026-10-12). Pins: the member's preferences API (defaults,
 * validation, own row only, 401); delivery (one Vitana DM with the card in
 * metadata and no strings in its params, the pacer touch, exactly one push of
 * the new type with catalog text, the slot finished as sent; a failed insert
 * finishes it failed with no push); sending stays OFF without
 * COMPANION_SEND_ENABLED; staff mode sends only to staff; a failed composition
 * in a send mode is no DM; the reply hook marks the ledger and never breaks
 * the Vitana reply.
 */
import express from 'express';
import request from 'supertest';

// ── module mocks ────────────────────────────────────────────────────────────
const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
const mockEmit = jest.fn(async (_e: any) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (e: any) => mockEmit(e) }));

let mockPrefsDb: any = null;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockPrefsDb }));

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    // A known test token signs in as member M; no token goes through the REAL middleware (→ 401).
    requireAuth: (req: any, res: any, next: any) => {
      if (req.headers.authorization === 'Bearer member-m') {
        req.identity = { user_id: '55555555-5555-4555-8555-555555555555', tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', exafy_admin: false };
        return next();
      }
      return actual.requireAuth(req, res, next);
    },
    requireTenant: (_req: any, _res: any, next: any) => next(),
    resolveVitanaId: jest.fn().mockResolvedValue(null),
  };
});

// chat route (reply hook) dependencies — same mocks as test/chat-vitana-reply.test.ts
let mockChatDb: any;
jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return { ...actual, createClient: jest.fn(() => mockChatDb) };
});
jest.mock('../src/services/system-controls-service', () => ({ isVitanaBrainEnabled: jest.fn().mockResolvedValue(false) }));
const mockProcessConversationTurn = jest.fn();
jest.mock('../src/services/conversation-client', () => ({
  processConversationTurn: (...args: any[]) => mockProcessConversationTurn(...args),
}));

import { resolveCompanionConfig, isSendMode, type CompanionConfig } from '../src/services/companion/config';
import {
  deliverCompanionMessage, cardParams, buildCompanionMetadata,
  COMPANION_NOTIFICATION_TYPE, COMPANION_DM_URL, COMPANION_PACER_SURFACE,
} from '../src/services/companion/delivery';
import { runCompanionTick } from '../src/services/companion/companion-service';
import { markCompanionRepliedInBackground, DEFAULT_PREFERENCES } from '../src/services/companion/companion-repository';
import { TYPE_META } from '../src/services/notification-service';
import { NOTIFICATION_CATALOG } from '../src/services/notification-controls/notification-catalog';
import { tt } from '../src/i18n/catalog';
import { VITANA_BOT_USER_ID } from '../src/lib/vitana-bot';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '11111111-1111-4111-8111-111111111111'; // Berlin, staff
const E = '66666666-6666-4666-8666-666666666666'; // Berlin, not staff
const M = '55555555-5555-4555-8555-555555555555'; // the signed-in member (preferences)
// 2026-10-20 06:15 UTC = 08:15 Berlin (inside the 07:30–09:30 window).
const NOW = new Date('2026-10-20T06:15:00Z');

const INDEX = {
  total: 512, tier: 'Early', trend_7d: 14, points_to_really_good: 88,
  weakest_pillar: { name: 'sleep', score: 60 }, strongest_pillar: { name: 'nutrition', score: 140 },
} as any;

const baseConfig: CompanionConfig = {
  mode: 'shadow', reason: 'shadow', windowStartMin: 450, windowEndMin: 570,
  shadowComposeLimit: 20, model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
};

beforeEach(() => {
  mockEmit.mockClear();
  mockStrict.mockResolvedValue({ ok: true, ids: new Set<string>() });
});

// ── preferences API ─────────────────────────────────────────────────────────
function prefsDb(rows: any[] = []) {
  const upserts: any[] = [];
  const from = jest.fn((table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      maybeSingle: async () => {
        if (table !== 'companion_preferences') return { data: null, error: { message: `unexpected table ${table}` } };
        return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null };
      },
      upsert: async (row: any, opts: any) => {
        upserts.push({ table, row, opts });
        const i = rows.findIndex((r) => r.user_id === row.user_id);
        if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
        return { error: null };
      },
    };
    return q;
  });
  return { client: { from } as any, rows, upserts, from };
}

function companionApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/companion', require('../src/routes/companion').default);
  return app;
}

describe('VTID-05100: preferences API', () => {
  it('GET without a token → 401 JSON from the real auth middleware', async () => {
    mockPrefsDb = prefsDb().client;
    const r = await request(companionApp()).get('/api/v1/companion/preferences');
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toMatch(/json/);
    expect(r.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('PATCH without a token → 401 and nothing written', async () => {
    const db = prefsDb();
    mockPrefsDb = db.client;
    const r = await request(companionApp()).patch('/api/v1/companion/preferences').send({ enabled: false });
    expect(r.status).toBe(401);
    expect(db.upserts).toEqual([]);
  });

  it('GET with no saved row → the defaults (enabled, health + community on, business off)', async () => {
    mockPrefsDb = prefsDb().client;
    const r = await request(companionApp()).get('/api/v1/companion/preferences').set('Authorization', 'Bearer member-m');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, preferences: { enabled: true, topic_health: true, topic_community: true, topic_business: false } });
    expect(DEFAULT_PREFERENCES).toEqual({ enabled: true, topic_health: true, topic_community: true, topic_business: false });
  });

  it('GET returns only the signed-in member\'s own row', async () => {
    mockPrefsDb = prefsDb([
      { user_id: A, enabled: false, topic_health: false, topic_community: false, topic_business: true },
      { user_id: M, enabled: true, topic_health: false, topic_community: true, topic_business: true },
    ]).client;
    const r = await request(companionApp()).get('/api/v1/companion/preferences').set('Authorization', 'Bearer member-m');
    expect(r.body.preferences).toEqual({ enabled: true, topic_health: false, topic_community: true, topic_business: true });
  });

  it('PATCH merges onto the current settings, keyed by the verified user id (a body user_id is refused)', async () => {
    const db = prefsDb();
    mockPrefsDb = db.client;
    const ok = await request(companionApp()).patch('/api/v1/companion/preferences')
      .set('Authorization', 'Bearer member-m').send({ topic_business: true });
    expect(ok.status).toBe(200);
    expect(ok.body.preferences).toEqual({ enabled: true, topic_health: true, topic_community: true, topic_business: true });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].row).toMatchObject({ user_id: M, tenant_id: T, topic_business: true, enabled: true });
    expect(db.upserts[0].opts).toEqual({ onConflict: 'user_id' });
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.preferences.updated', vtid: 'VTID-05100' }));

    const spoof = await request(companionApp()).patch('/api/v1/companion/preferences')
      .set('Authorization', 'Bearer member-m').send({ user_id: A, enabled: false });
    expect(spoof.status).toBe(400);
    expect(db.upserts).toHaveLength(1);
  });

  it('PATCH validation: booleans only, known fields only, at least one field', async () => {
    const db = prefsDb();
    mockPrefsDb = db.client;
    for (const body of [{ enabled: 'false' }, { topic_health: 1 }, { window: 'evening' }, {}, { enabled: null }]) {
      const r = await request(companionApp()).patch('/api/v1/companion/preferences')
        .set('Authorization', 'Bearer member-m').send(body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ ok: false, error: 'invalid_preferences' });
    }
    expect(db.upserts).toEqual([]);
  });
});

// ── delivery ────────────────────────────────────────────────────────────────
function deliveryDb(opts: { insertError?: string } = {}) {
  const inserts: any[] = [];
  const rpc = jest.fn(async (fn: string, a: any) => ({ data: { ok: true }, error: null, fn, a }));
  const from = jest.fn((table: string) => ({
    insert: (row: any) => {
      inserts.push({ table, row });
      return {
        select: () => ({
          single: async () => (opts.insertError
            ? { data: null, error: { message: opts.insertError } }
            : { data: { id: 'msg-uuid-1' }, error: null }),
        }),
      };
    },
  }));
  return { client: { from, rpc } as any, inserts, rpc, from };
}

const VITANA_INDEX_FACTS = { score: 512, tier: 'Early', weakest_pillar: 'sleep', strongest_pillar: 'nutrition', trend_7d: 14, points_to_really_good: 88 };

function deliveryInput(over: Record<string, unknown> = {}) {
  return {
    ledgerId: 7, mode: 'staff' as const, userId: A, tenantId: T, momentKey: 'vitana_index', cardType: 'F2',
    facts: VITANA_INDEX_FACTS, text: 'Guten Morgen Dragan! Dein Vitana Index liegt heute bei 512.', model: 'eu.anthropic.claude-sonnet-4-6',
    ...over,
  };
}

function deliveryDeps(db: ReturnType<typeof deliveryDb>) {
  return {
    sb: db.client,
    notify: jest.fn(async () => ({ pushed: 1, inapp: true })),
    touch: jest.fn(async () => ({ success: true })),
    locale: jest.fn(async () => 'de'),
    emit: jest.fn(async () => ({ ok: true })),
  };
}

describe('VTID-05100: delivery', () => {
  it('inserts ONE Vitana DM with the card in metadata, touches the pacer, sends ONE push, finishes sent', async () => {
    const db = deliveryDb();
    const d = deliveryDeps(db);
    const r = await deliverCompanionMessage(deliveryInput(), d as any);
    expect(r).toEqual({ ok: true, chatMessageId: 'msg-uuid-1', pushed: true });

    // One DM, from the Vitana bot to the member, text type, the composed text as the body.
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0].row;
    expect(db.inserts[0].table).toBe('chat_messages');
    expect(row).toMatchObject({ tenant_id: T, sender_id: VITANA_BOT_USER_ID, receiver_id: A, message_type: 'text', content: deliveryInput().text });
    expect(row.metadata).toEqual({
      source: 'companion', moment_key: 'vitana_index', vtid: 'VTID-05100',
      card: { kind: 'vitana_card', v: 1, card_type: 'F2', params: { score: 512, trend_7d: 14, points_to_really_good: 88 } },
    });
    // The card carries no strings at all — labels come from the client catalog (sparring F12).
    expect(Object.values(row.metadata.card.params).every((v) => typeof v === 'number')).toBe(true);

    // Pacer touch on the companion surface.
    expect(d.touch).toHaveBeenCalledTimes(1);
    expect((d.touch.mock.calls[0] as any)[0]).toMatchObject({ user_id: A, surface: 'messenger_companion', reason_tag: 'vitana_index' });
    expect(COMPANION_PACER_SURFACE).toBe('messenger_companion');

    // Exactly one push, the new type, catalog text in the member's language, deep link to the Vitana DM.
    expect(d.notify).toHaveBeenCalledTimes(1);
    const [uid, tid, type, payload] = (d.notify.mock.calls[0] as any);
    expect([uid, tid, type]).toEqual([A, T, 'vitana_companion_message']);
    expect(payload.title).toBe(tt('notif.vitana_companion_message.title', 'de'));
    expect(payload.body).toBe(tt('notif.vitana_companion_message.body', 'de'));
    expect(payload.title).toBe('Nachricht von Vitana');
    expect(payload.data).toMatchObject({ type: 'vitana_companion_message', url: `/inbox/u/${VITANA_BOT_USER_ID}`, sender_id: VITANA_BOT_USER_ID });
    expect(COMPANION_DM_URL).toBe(`/inbox/u/${VITANA_BOT_USER_ID}`);
    expect(Object.values(payload.data).every((v) => typeof v === 'string')).toBe(true); // FCM data contract

    // Slot finished as sent, with the text, model and chat message id.
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('finish_companion_message', {
      p_id: 7, p_status: 'sent', p_composed_text: deliveryInput().text,
      p_composed_by_model: 'eu.anthropic.claude-sonnet-4-6', p_chat_message_id: 'msg-uuid-1',
    });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.message.sent' }));
  });

  it('a failed DM insert finishes the slot as failed: no push, no pacer touch', async () => {
    const db = deliveryDb({ insertError: 'permission denied' });
    const d = deliveryDeps(db);
    const r = await deliverCompanionMessage(deliveryInput(), d as any);
    expect(r).toEqual({ ok: false, error: 'insert_failed: permission denied' });
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.touch).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect((db.rpc.mock.calls[0] as any)[1]).toMatchObject({ p_id: 7, p_status: 'failed', p_chat_message_id: null });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.message.failed' }));
  });

  it('a held or failing push never undoes the DM; a failing pacer touch never blocks it', async () => {
    const db = deliveryDb();
    const d = deliveryDeps(db);
    d.notify.mockRejectedValueOnce(new Error('fcm down') as never);
    d.touch.mockRejectedValueOnce(new Error('pacer down') as never);
    const r = await deliverCompanionMessage(deliveryInput(), d as any);
    expect(r).toMatchObject({ ok: true, chatMessageId: 'msg-uuid-1', pushed: false });
    expect((db.rpc.mock.calls[0] as any)[1]).toMatchObject({ p_status: 'sent' });
  });

  it('card params keep only finite numbers', () => {
    expect(cardParams({ a: 1, b: 'x', c: null, d: NaN, e: Infinity, f: true, g: { h: 1 }, i: 0 })).toEqual({ a: 1, i: 0 });
    expect(buildCompanionMetadata({ momentKey: 'morning_greeting', cardType: 'F4', facts: {} }))
      .toEqual({ source: 'companion', moment_key: 'morning_greeting', vtid: 'VTID-05100', card: { kind: 'vitana_card', v: 1, card_type: 'F4', params: {} } });
  });

  it('the new notification type: push_and_inapp, p2 (quiet hours apply), chat category, in the admin catalog with both languages', () => {
    expect(COMPANION_NOTIFICATION_TYPE).toBe('vitana_companion_message');
    expect(TYPE_META.vitana_companion_message).toEqual({ channel: 'push_and_inapp', priority: 'p2', category: 'chat' });
    const entry = NOTIFICATION_CATALOG.get('vitana_companion_message')!;
    expect(entry).toMatchObject({ audience: 'member', text: 'ready' });
    expect(entry.label.de && entry.label.en).toBeTruthy();
    expect(tt('notif.vitana_companion_message.title', 'en')).toBe('Message from Vitana');
  });
});

// ── mode / config ───────────────────────────────────────────────────────────
describe('VTID-05100: sending stays off without COMPANION_SEND_ENABLED', () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
  const at = (e: Record<string, string>) => resolveCompanionConfig(env(e), { isStaging: false, featureLive: true });

  it('staff/live without the switch (or with anything but exact "true") run in shadow', () => {
    for (const m of ['staff', 'live']) {
      for (const flag of [undefined, 'false', 'TRUE', '1', 'yes', '']) {
        const e: Record<string, string> = { COMPANION_MODE: m };
        if (flag !== undefined) e.COMPANION_SEND_ENABLED = flag;
        expect(at(e)).toMatchObject({ mode: 'shadow', reason: 'send_not_available' });
      }
    }
  });

  it('with COMPANION_SEND_ENABLED=true: staff and live become sending modes', () => {
    expect(at({ COMPANION_MODE: 'staff', COMPANION_SEND_ENABLED: 'true' })).toMatchObject({ mode: 'staff', reason: 'staff' });
    expect(at({ COMPANION_MODE: 'live', COMPANION_SEND_ENABLED: 'true' })).toMatchObject({ mode: 'live', reason: 'live' });
    expect(isSendMode('staff') && isSendMode('live')).toBe(true);
    expect(isSendMode('shadow') || isSendMode('off') || isSendMode('disabled-on-staging')).toBe(false);
  });

  it('the switch never overrides staging, the feature flag or an off mode', () => {
    const e = env({ COMPANION_MODE: 'live', COMPANION_SEND_ENABLED: 'true' });
    expect(resolveCompanionConfig(e, { isStaging: true, featureLive: true }).mode).toBe('disabled-on-staging');
    expect(resolveCompanionConfig(e, { isStaging: false, featureLive: false }).mode).toBe('off');
    expect(at({ COMPANION_SEND_ENABLED: 'true' }).mode).toBe('off');
    expect(at({ COMPANION_MODE: 'shadow', COMPANION_SEND_ENABLED: 'true' }).mode).toBe('shadow');
  });
});

// ── the tick in a sending mode ──────────────────────────────────────────────
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
      not: (c: string) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      insert: async () => { writes.push({ table, op: 'insert' }); return { error: null }; },
      upsert: async () => { writes.push({ table, op: 'upsert' }); return { error: null }; },
      update: () => { writes.push({ table, op: 'update' }); return q; },
      then: (ok: any, ko: any) => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { client: { from, rpc } as any, writes, rpc, ledger };
}

function seed() {
  return {
    user_tenants: [A, E].map((id) => ({ user_id: id, tenant_id: T, is_primary: true })),
    profiles: [
      { user_id: A, first_name: 'Dragan', timezone: 'Europe/Berlin' },
      { user_id: E, first_name: 'Eva', timezone: 'Europe/Berlin' },
    ],
    user_permitted_roles: [
      { user_id: A, tenant_id: T, role: 'staff' },
      { user_id: E, tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'admin' }, // admin elsewhere ≠ staff here
      { user_id: E, tenant_id: T, role: 'professional' },
    ],
    companion_preferences: [] as any[],
    onboarding_touch_ledger: [] as any[],
  } as Record<string, any[]>;
}

function tickDeps(db: ReturnType<typeof fakeDb>, mode: CompanionConfig['mode'], over: Record<string, unknown> = {}) {
  return {
    sb: db.client, now: NOW, config: { ...baseConfig, mode, reason: mode },
    emit: jest.fn(async () => ({ ok: true })),
    pacer: jest.fn(async () => ({ allow: true, reason: 'ok' as const })),
    fetchIndex: jest.fn(async () => INDEX),
    compose: jest.fn(async () => ({ ok: true as const, text: 'Guten Morgen!', model: 'eu.anthropic.claude-sonnet-4-6' })),
    locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
    deliver: jest.fn(async () => ({ ok: true as const, chatMessageId: 'msg-1', pushed: true })),
    // VTID-05366: these tests are about sending; members are fully set up so the
    // enrichment moments (pinned in vtid-05366-companion-enrichment-moments) stay out of the way.
    enrichment: jest.fn(async (_sb: unknown, ids: string[]) => ({
      completions: new Map(ids.map((id) => [id, new Map(ENRICHMENT_ALL.map((t) => [t, true]))])),
      dismissals: new Map(ids.map((id) => [id, []])),
      unavailable: [],
    })),
    ...over,
  };
}

const ENRICHMENT_ALL = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11'] as const;

describe('VTID-05100: the tick in a sending mode', () => {
  it('staff mode: only the staff member gets a real DM; everyone else keeps the shadow behaviour', async () => {
    const db = fakeDb(seed());
    const d = tickDeps(db, 'staff');
    const r = await runCompanionTick(d as any);
    expect(r).toMatchObject({ ok: true, mode: 'staff', decided: 2, sent: 1, send_failed: 0 });
    expect(d.deliver).toHaveBeenCalledTimes(1);
    expect((d.deliver.mock.calls[0] as any)[0]).toMatchObject({
      userId: A, tenantId: T, mode: 'staff', momentKey: 'vitana_index', cardType: 'F2', text: 'Guten Morgen!',
      ledgerId: db.ledger.find((x) => x.user_id === A)!.id,
    });
    expect(db.ledger.find((x) => x.user_id === A)).toMatchObject({ mode: 'staff', status: 'pending' }); // finished by delivery
    expect(db.ledger.find((x) => x.user_id === E)).toMatchObject({ mode: 'shadow', status: 'shadow' });
    expect(db.writes).toEqual([]); // the tick itself writes no table; delivery is the only writer
  });

  it('staff mode: a failed staff lookup sends to nobody (fail closed)', async () => {
    const db = fakeDb(seed());
    const d = tickDeps(db, 'staff', { staffIds: jest.fn(async () => { throw new Error('roles down'); }) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await runCompanionTick(d as any);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('staff lookup failed'));
    warn.mockRestore();
    expect(r).toMatchObject({ sent: 0 });
    expect(d.deliver).not.toHaveBeenCalled();
    expect(db.ledger.every((x) => x.mode === 'shadow')).toBe(true);
  });

  it('live mode: every eligible member gets a real DM, once per local day', async () => {
    const db = fakeDb(seed());
    const d = tickDeps(db, 'live');
    expect(await runCompanionTick(d as any)).toMatchObject({ mode: 'live', decided: 2, sent: 2 });
    expect(db.ledger.map((x) => x.mode)).toEqual(['live', 'live']);
    const again = await runCompanionTick(tickDeps(db, 'live', { now: new Date(NOW.getTime() + 15 * 60_000) }) as any);
    expect(again).toMatchObject({ decided: 0, sent: 0 });
    expect(again.skipped).toMatchObject({ already_today: 2 });
  });

  it('a send composes even when the shadow sample cap is used up', async () => {
    const tables = seed();
    tables.companion_messages_ledger = Array.from({ length: 20 }, (_, i) => ({
      id: 1000 + i, user_id: `x${i}`, local_date: '2026-10-20', mode: 'shadow', moment_key: 'vitana_index',
      status: 'shadow', composed_text: 'sample', created_at: NOW.toISOString(),
    }));
    const db = fakeDb(tables);
    const d = tickDeps(db, 'staff');
    const r = await runCompanionTick(d as any);
    expect(d.compose).toHaveBeenCalledTimes(1); // the staff member only; E's shadow row is over the cap
    expect(r).toMatchObject({ sent: 1, composed: 1 });
  });

  it('a failed composition in a send mode: no DM, the slot finishes failed', async () => {
    const db = fakeDb(seed());
    const d = tickDeps(db, 'live', { compose: jest.fn(async () => ({ ok: false as const, error: 'router_failed: both' })) });
    const r = await runCompanionTick(d as any);
    expect(d.deliver).not.toHaveBeenCalled();
    expect(r).toMatchObject({ sent: 0, compose_failed: 2 });
    expect(db.ledger.every((x) => x.status === 'failed' && x.composed_text === null)).toBe(true);
  });

  it('opted-out members and the pacer are respected in a send mode too', async () => {
    const tables = seed();
    tables.companion_preferences = [{ user_id: E, enabled: false, topic_health: true, topic_community: true, topic_business: false }];
    const db = fakeDb(tables);
    const d = tickDeps(db, 'live', { pacer: jest.fn(async (id: string) => (id === A ? { allow: false, reason: 'paused' } : { allow: true, reason: 'ok' })) });
    const r = await runCompanionTick(d as any);
    expect(d.deliver).not.toHaveBeenCalled();
    expect(r.skipped).toMatchObject({ opted_out: 1, pacer_paused: 1 });
  });

  it('shadow mode never delivers', async () => {
    const db = fakeDb(seed());
    const d = tickDeps(db, 'shadow');
    const r = await runCompanionTick(d as any);
    expect(d.deliver).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('sent');
    expect(db.ledger.every((x) => x.mode === 'shadow')).toBe(true);
  });
});

// ── reply hook ──────────────────────────────────────────────────────────────
function chatChain(rpcImpl: (...a: any[]) => any) {
  const chain: any = {
    from: jest.fn(() => chain), select: jest.fn(() => chain), insert: jest.fn(() => chain), update: jest.fn(() => chain),
    eq: jest.fn(() => chain), or: jest.fn(() => chain), order: jest.fn(() => chain), limit: jest.fn(() => chain),
    lt: jest.fn(() => chain), is: jest.fn(() => chain), single: jest.fn(() => chain), maybeSingle: jest.fn(() => chain),
    in: jest.fn(() => chain),
    rpc: jest.fn(rpcImpl),
    then: (ok: any, ko: any) => Promise.resolve({ data: [], error: null }).then(ok, ko),
  };
  return chain;
}

describe('VTID-05100: the reply hook', () => {
  function chatApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/chat', require('../src/routes/chat').default);
    return app;
  }
  beforeEach(() => {
    mockProcessConversationTurn.mockResolvedValue({
      ok: true, reply: 'Gern!', thread_id: 't', turn_number: 1, meta: { model_used: 'm', latency_ms: 1 },
    });
  });

  it('a member text to Vitana calls mark_companion_replied for that member', async () => {
    mockChatDb = chatChain(async () => ({ data: { ok: true, marked: true }, error: null }));
    const r = await request(chatApp()).post('/api/v1/chat/vitana-reply').set('Authorization', 'Bearer member-m').send({ content: 'Danke Vitana' });
    expect(r.status).toBe(200);
    expect(mockChatDb.rpc).toHaveBeenCalledWith('mark_companion_replied', { p_user_id: M });
  });

  it('a failing ledger never breaks the reply (rejected, error result, or thrown synchronously)', async () => {
    const impls = [
      async () => { throw new Error('db down'); },
      async () => ({ data: null, error: { message: 'boom' } }),
      () => { throw new Error('sync boom'); },
    ];
    for (const impl of impls) {
      mockChatDb = chatChain(impl);
      const r = await request(chatApp()).post('/api/v1/chat/vitana-reply').set('Authorization', 'Bearer member-m').send({ content: 'Hallo' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, reply: 'Gern!' });
      expect(mockChatDb.rpc).toHaveBeenCalledTimes(1);
    }
  });

  it('the background helper never throws or rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => markCompanionRepliedInBackground({ rpc: () => { throw new Error('x'); } } as any, A)).not.toThrow();
    expect(() => markCompanionRepliedInBackground({} as any, A)).not.toThrow();
    await new Promise((res) => setImmediate(res));
    warn.mockRestore();
  });
});
