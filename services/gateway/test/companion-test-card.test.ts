/**
 * VTID-05588 (companion-test-card/gateway-test-card) — an exafy admin sends one
 * Vitana companion card (the Vitana Index moment, F2) to themselves, now.
 *
 * Plan: .kiro/specs/companion-test-card/plan.md (sparred, converged-auto-v1).
 * Pins: 401 / 403 / 400 (strict body, no user id) / 409 staging / 409 sending
 * off / 422 no Index (nothing written) / 502 compose failure (nothing written) /
 * success writes exactly one Vitana-bot DM to the CALLER with the same card
 * metadata a tick message carries plus `test: true` — no ledger claim, no pacer
 * touch, no push, no companion.message.sent — one companion.test_card.sent
 * event, and a second press inside 60 s is 429.
 */
import express from 'express';
import request from 'supertest';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mockEmit = jest.fn(async (_e: any) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (e: any) => mockEmit(e) }));

let mockDb: any = null;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockDb }));

const mockNotify = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  ...jest.requireActual('../src/services/notification-service'),
  notifyUser: (...a: unknown[]) => mockNotify(...a),
}));
const mockTouch = jest.fn();
jest.mock('../src/services/guide/presence-pacer', () => ({
  ...jest.requireActual('../src/services/guide/presence-pacer'),
  recordTouch: (...a: unknown[]) => mockTouch(...a),
}));

const mockFetchIndex = jest.fn();
jest.mock('../src/services/user-context-profiler', () => ({
  ...jest.requireActual('../src/services/user-context-profiler'),
  fetchVitanaIndexForProfiler: (...a: unknown[]) => mockFetchIndex(...a),
}));
const mockCompose = jest.fn();
jest.mock('../src/services/companion/composer', () => ({
  ...jest.requireActual('../src/services/companion/composer'),
  composeCompanionMessage: (...a: unknown[]) => mockCompose(...a),
}));
jest.mock('../src/i18n/server-locale', () => ({
  ...jest.requireActual('../src/i18n/server-locale'),
  getUserLocale: jest.fn(async () => 'de'),
}));

let mockConfig: any;
jest.mock('../src/services/companion/config', () => ({
  ...jest.requireActual('../src/services/companion/config'),
  resolveCompanionConfig: () => mockConfig,
}));

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    requireAuth: (req: any, res: any, next: any) => {
      if (req.headers.authorization === 'Bearer admin') {
        req.identity = { user_id: ADMIN, tenant_id: T, exafy_admin: true };
        return next();
      }
      if (req.headers.authorization === 'Bearer member') {
        req.identity = { user_id: MEMBER, tenant_id: T, exafy_admin: false };
        return next();
      }
      return actual.requireAuth(req, res, next);
    },
    resolveVitanaId: jest.fn().mockResolvedValue(null),
  };
});

import { VITANA_BOT_USER_ID } from '../src/lib/vitana-bot';
import { buildCompanionMetadata } from '../src/services/companion/delivery';

const INDEX = {
  total: 512, tier: 'Early', trend_7d: 14, points_to_really_good: 88,
  weakest_pillar: { name: 'sleep', score: 60 }, strongest_pillar: { name: 'nutrition', score: 140 },
} as any;

const sendConfig = (mode: string) => ({
  mode, reason: mode, windowStartMin: 450, windowEndMin: 570, shadowComposeLimit: 0,
  model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
});

/** A tiny Supabase double: records inserts, answers the reads the route makes. */
function db() {
  const inserts: Array<{ table: string; row: any }> = [];
  const touched = new Set<string>();
  const api: any = {
    inserts, touched,
    from(table: string) {
      touched.add(table);
      const q: any = {
        _table: table,
        select() { return q; }, eq() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
        range() { return q; },
        maybeSingle: async () => {
          if (table === 'user_tenants') return { data: { user_id: ADMIN, tenant_id: T }, error: null };
          if (table === 'profiles') return { data: { user_id: ADMIN, first_name: 'Dragan', timezone: 'Europe/Berlin' }, error: null };
          return { data: null, error: null };
        },
        insert(row: any) {
          inserts.push({ table, row });
          return { select: () => ({ single: async () => ({ data: { id: 'msg-1' }, error: null }) }) };
        },
        upsert() { throw new Error(`unexpected upsert on ${table}`); },
        update() { throw new Error(`unexpected update on ${table}`); },
      };
      return q;
    },
    rpc() { throw new Error('unexpected rpc'); },
  };
  return api;
}

let app: express.Express;
let resetRateLimit: () => void;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../src/routes/companion');
  app = express();
  app.use(express.json());
  app.use('/api/v1/companion', mod.default);
  resetRateLimit = mod.__resetTestCardRateLimit;
});

beforeEach(() => {
  mockEmit.mockClear(); mockNotify.mockClear(); mockTouch.mockClear();
  mockFetchIndex.mockReset().mockResolvedValue(INDEX);
  mockCompose.mockReset().mockResolvedValue({ ok: true, text: 'Guten Morgen Dragan! Dein Vitana Index ist 512.', model: 'm' });
  mockConfig = sendConfig('live');
  mockDb = db();
  resetRateLimit?.();
});

const post = (auth?: string, body: any = {}) => {
  const r = request(app).post('/api/v1/companion/test-card');
  return (auth ? r.set('Authorization', `Bearer ${auth}`) : r).send(body);
};

describe('VTID-05588: POST /api/v1/companion/test-card', () => {
  it('401 without a token', async () => {
    const r = await post();
    expect(r.status).toBe(401);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('403 for a member who is not an exafy admin', async () => {
    const r = await post('member');
    expect(r.status).toBe(403);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('400 for an unknown moment_key, or any user id in the body (strict)', async () => {
    expect((await post('admin', { moment_key: 'invite_friend' })).status).toBe(400);
    expect((await post('admin', { user_id: MEMBER })).status).toBe(400);
    expect((await post('admin', { receiver_id: MEMBER })).status).toBe(400);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('409 STAGING_DISABLED on staging', async () => {
    mockConfig = { ...sendConfig('live'), mode: 'disabled-on-staging', reason: 'staging_shares_production_database' };
    const r = await post('admin');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: 'STAGING_DISABLED' });
    // Refused before any database read or Bedrock call.
    expect(mockDb.inserts).toHaveLength(0);
    expect(mockDb.touched.size).toBe(0);
    expect(mockFetchIndex).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it.each(['off', 'shadow'])('409 SEND_NOT_AVAILABLE when the mode is %s (the kill switch stops test cards)', async (mode) => {
    mockConfig = sendConfig(mode);
    const r = await post('admin');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: 'SEND_NOT_AVAILABLE', mode });
    // Refused before any database read or Bedrock call.
    expect(mockDb.inserts).toHaveLength(0);
    expect(mockDb.touched.size).toBe(0);
    expect(mockFetchIndex).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('works in staff mode too', async () => {
    mockConfig = sendConfig('staff');
    expect((await post('admin')).status).toBe(200);
  });

  it('422 NO_VITANA_INDEX when the caller has no Index, and writes nothing', async () => {
    mockFetchIndex.mockResolvedValue(null);
    const r = await post('admin');
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ ok: false, error: 'NO_VITANA_INDEX' });
    expect(mockCompose).not.toHaveBeenCalled();
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('502 COMPOSE_FAILED when composition fails, and writes nothing', async () => {
    mockCompose.mockResolvedValue({ ok: false, error: 'empty' });
    const r = await post('admin');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: 'COMPOSE_FAILED' });
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('503 when no service-role client is configured', async () => {
    mockDb = null;
    const r = await post('admin');
    expect(r.status).toBe(503);
  });

  it('sends exactly one Vitana-bot DM to the caller with the tick card metadata plus test: true', async () => {
    const r = await post('admin', { moment_key: 'vitana_index' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true, chat_message_id: 'msg-1', moment_key: 'vitana_index', card_type: 'F2',
      text: 'Guten Morgen Dragan! Dein Vitana Index ist 512.',
    });

    expect(mockDb.inserts).toHaveLength(1);
    const { table, row } = mockDb.inserts[0];
    expect(table).toBe('chat_messages');
    expect(row).toMatchObject({
      tenant_id: T, sender_id: VITANA_BOT_USER_ID, receiver_id: ADMIN, message_type: 'text',
      content: 'Guten Morgen Dragan! Dein Vitana Index ist 512.',
    });
    expect(row.metadata).toMatchObject({ source: 'companion', moment_key: 'vitana_index', test: true });
    // Same card shape a tick message carries (delivery.ts buildCompanionMetadata).
    const tickShape = buildCompanionMetadata({ momentKey: 'vitana_index', cardType: 'F2', facts: {
      score: 512, tier: 'Early', weakest_pillar: 'sleep', strongest_pillar: 'nutrition', trend_7d: 14, points_to_really_good: 88,
    } } as any);
    expect(row.metadata).toEqual({ ...tickShape, test: true });
    expect(row.metadata.card).toEqual({
      kind: 'vitana_card', v: 1, card_type: 'F2', params: { score: 512, trend_7d: 14, points_to_really_good: 88 },
    });

    // The composer got the caller's context and the real Vitana Index moment.
    const [ctx, moment] = mockCompose.mock.calls[0];
    expect(ctx).toMatchObject({ userId: ADMIN, tenantId: T, firstName: 'Dragan', locale: 'de', vitanaIndex: INDEX });
    expect(moment).toMatchObject({ momentKey: 'vitana_index', cardType: 'F2' });

    // No ledger, pacer, push or member-metric side effect.
    expect(mockDb.touched.has('companion_messages_ledger')).toBe(false);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    const types = mockEmit.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['companion.test_card.sent']);
    expect(mockEmit.mock.calls[0][0].payload).toMatchObject({
      actor_user_id: ADMIN, moment_key: 'vitana_index', card_type: 'F2', chat_message_id: 'msg-1', mode: 'live',
    });
  });

  it('a refused or failed press does not use up the minute', async () => {
    mockFetchIndex.mockResolvedValueOnce(null);
    expect((await post('admin')).status).toBe(422);
    mockCompose.mockResolvedValueOnce({ ok: false, error: 'empty' });
    expect((await post('admin')).status).toBe(502);
    expect((await post('admin')).status).toBe(200);
    expect(mockDb.inserts).toHaveLength(1);
  });

  it('429 RATE_LIMITED for a second press inside 60 s', async () => {
    expect((await post('admin')).status).toBe(200);
    const r = await post('admin');
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ ok: false, error: 'RATE_LIMITED' });
    expect(r.body.retry_after_s).toBeGreaterThan(0);
    expect(mockDb.inserts).toHaveLength(1);
  });
});
