/**
 * VTID-05143 (builds VTID-05085 Phase 1) — GET /api/v1/enrichment-cards and
 * POST /dismiss over HTTP: auth, validation, screen filtering, priority order,
 * completed cards excluded, the 7-day dismissal cooldown (fake clock), the
 * localized texts, 500 (never an empty list) on a DB error, and the dismiss
 * write is always the caller's own row. The real resolver and catalog run;
 * only the repository (Supabase reads/writes), auth and locale are mocked.
 */
import express from 'express';
import request from 'supertest';

let identity: any;
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity;
    return next();
  },
}));

let supa: any = {};
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => supa }));

const getUserLocale = jest.fn();
jest.mock('../../src/i18n/server-locale', () => ({ getUserLocale: (...a: unknown[]) => getUserLocale(...a) }));

jest.mock('../../src/services/enrichment/completion-resolver-repository', () => ({
  fetchProfileEnrichmentFields: jest.fn(),
  fetchAnyProfilePost: jest.fn(),
  fetchActiveSocialConnections: jest.fn(),
  fetchEnabledCalendarApp: jest.fn(),
  fetchAnyContact: jest.fn(),
  fetchActiveDeviceToken: jest.fn(),
  fetchEnrichmentCardStates: jest.fn(),
  upsertEnrichmentCardDismissal: jest.fn(),
}));

import * as repo from '../../src/services/enrichment/completion-resolver-repository';
import { ENRICHMENT_CARD_TIPS } from '../../src/data/enrichment-card-tips';
import { eligibleEnrichmentCards } from '../../src/services/enrichment/card-catalog';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/enrichment-cards').default;

const m = repo as jest.Mocked<typeof repo>;
const ME = { user_id: 'user-me', email: 'me@example.test' };
const NOW = new Date('2026-10-13T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/enrichment-cards', router);
  return a;
};

const ok = (data: unknown) => Promise.resolve({ data, error: null } as any);

/** A member with nothing done, no dismissals. */
function setNothingDone(over: Partial<Record<string, unknown>> = {}) {
  const v: Record<string, unknown> = {
    fetchProfileEnrichmentFields: { avatar_url: null, bio: null, location: null, cover_url: null, interests: [] },
    fetchAnyProfilePost: [],
    fetchActiveSocialConnections: [],
    fetchEnabledCalendarApp: [],
    fetchAnyContact: [],
    fetchActiveDeviceToken: [],
    fetchEnrichmentCardStates: [],
    ...over,
  };
  for (const [k, val] of Object.entries(v)) (m as any)[k].mockImplementation(() => ok(val));
}

const ALL_PRIORITY = ['E1', 'E2', 'E3', 'E6', 'E7', 'E8', 'E9', 'E4', 'E5', 'E10', 'E11'];

beforeEach(() => {
  jest.clearAllMocks();
  identity = ME;
  supa = {};
  getUserLocale.mockResolvedValue('de');
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask'],
  });
  setNothingDone();
});

afterEach(() => jest.useRealTimers());

describe('auth and validation', () => {
  it('GET without a token → 401 JSON', async () => {
    identity = null;
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(m.fetchProfileEnrichmentFields).not.toHaveBeenCalled();
  });

  it('POST /dismiss without a token → 401 JSON, nothing written', async () => {
    identity = null;
    const r = await request(app()).post('/api/v1/enrichment-cards/dismiss').send({ card_type: 'E1' });
    expect(r.status).toBe(401);
    expect(m.upsertEnrichmentCardDismissal).not.toHaveBeenCalled();
  });

  it.each([['nope'], [''], ['HOME']])('GET with unknown screen %p → 400 JSON', async (screen) => {
    const r = await request(app()).get(`/api/v1/enrichment-cards?screen=${encodeURIComponent(screen)}`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error: 'INVALID_SCREEN' });
    expect(m.fetchProfileEnrichmentFields).not.toHaveBeenCalled();
  });

  it('GET without a screen → 400', async () => {
    const r = await request(app()).get('/api/v1/enrichment-cards');
    expect(r.status).toBe(400);
  });

  it.each([['E12'], ['G4'], ['F1'], [''], [7]])('POST /dismiss with card_type %p → 400, nothing written', async (card_type) => {
    const r = await request(app()).post('/api/v1/enrichment-cards/dismiss').send({ card_type });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error: 'INVALID_CARD_TYPE' });
    expect(m.upsertEnrichmentCardDismissal).not.toHaveBeenCalled();
  });
});

describe('GET — screen filtering, priority, completion', () => {
  it('home: every incomplete card in static priority order, localized, with profile_completion_pct', async () => {
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.status).toBe(200);
    expect(r.body.cards.map((c: any) => c.card_type)).toEqual(ALL_PRIORITY);
    expect(r.body.cards.map((c: any) => c.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.body.cards[0]).toEqual({
      card_type: 'E1',
      category: 'enrichment',
      priority: 1,
      completed: false,
      dismissed_until: null,
      title: ENRICHMENT_CARD_TIPS.E1.title.de,
      description: ENRICHMENT_CARD_TIPS.E1.description.de,
    });
    expect(r.body.locale).toBe('de');
    expect(r.body.profile_completion_pct).toBe(0);
    // every read was for the caller only
    expect(m.fetchProfileEnrichmentFields.mock.calls[0][1]).toBe(ME.user_id);
    expect(m.fetchEnrichmentCardStates.mock.calls[0][1]).toBe(ME.user_id);
    expect(getUserLocale.mock.calls[0][1]).toBe(ME.user_id);
  });

  it.each([
    ['profile', ALL_PRIORITY],
    ['messenger', ALL_PRIORITY],
    ['calendar', ['E8']],
    ['longevity-journey', ['E4', 'E5']],
    ['autopilot', ['E10']],
    ['community', ['E3', 'E6', 'E7']],
    ['make-a-post', ['E3']],
    ['vitana-index', []],
    ['talk-to-vitana', []],
  ])('screen=%s returns %p', async (screen, expected) => {
    const r = await request(app()).get(`/api/v1/enrichment-cards?screen=${screen}`);
    expect(r.status).toBe(200);
    expect(r.body.cards.map((c: any) => c.card_type)).toEqual(expected);
  });

  it('completed cards are excluded and profile_completion_pct reflects them', async () => {
    setNothingDone({
      fetchProfileEnrichmentFields: { avatar_url: 'a.png', bio: 'short', location: 'Berlin', cover_url: null, interests: [] },
      fetchActiveSocialConnections: [{ provider: 'instagram' }],
      fetchEnabledCalendarApp: [{ app_id: 'outlook-calendar' }],
    });
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards.map((c: any) => c.card_type)).toEqual(['E2', 'E3', 'E7', 'E9', 'E4', 'E10', 'E11']);
    expect(r.body.profile_completion_pct).toBe(Math.round((4 / 11) * 100));
  });

  it('a member with everything done gets an empty list (not an error)', async () => {
    setNothingDone({
      fetchProfileEnrichmentFields: { avatar_url: 'a', bio: 'b'.repeat(51), location: 'L', cover_url: 'c', interests: ['sleep'] },
      fetchAnyProfilePost: [{ id: 1 }],
      fetchActiveSocialConnections: [{ provider: 'instagram' }, { provider: 'facebook' }],
      fetchEnabledCalendarApp: [{ app_id: 'apple-calendar' }],
      fetchAnyContact: [{ id: 1 }],
      fetchActiveDeviceToken: [{ id: 1 }],
    });
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.status).toBe(200);
    expect(r.body.cards).toEqual([]);
    expect(r.body.profile_completion_pct).toBe(100);
  });

  it('?locale= wins over the stored locale (no lookup)', async () => {
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=calendar&locale=ar');
    expect(r.body.locale).toBe('ar');
    expect(r.body.cards[0].title).toBe(ENRICHMENT_CARD_TIPS.E8.title.ar);
    expect(getUserLocale).not.toHaveBeenCalled();
  });

  it('an unsupported ?locale= falls back to the stored locale', async () => {
    getUserLocale.mockResolvedValue('sr');
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=calendar&locale=xx');
    expect(r.body.locale).toBe('sr');
    expect(r.body.cards[0].description).toBe(ENRICHMENT_CARD_TIPS.E8.description.sr);
  });
});

describe('GET — dismissal cooldown (7 days)', () => {
  const dismissedAt = new Date(NOW.getTime()).toISOString();

  it('a card dismissed now is hidden for 7 days and back on day 8', async () => {
    setNothingDone({ fetchEnrichmentCardStates: [{ card_type: 'E1', dismissed_at: dismissedAt, cooldown_days: 7 }] });

    let r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards.map((c: any) => c.card_type)).not.toContain('E1');

    jest.setSystemTime(new Date(NOW.getTime() + 6 * DAY));
    r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards.map((c: any) => c.card_type)).not.toContain('E1');

    jest.setSystemTime(new Date(NOW.getTime() + 7 * DAY - 1000));
    r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards.map((c: any) => c.card_type)).not.toContain('E1');

    jest.setSystemTime(new Date(NOW.getTime() + 8 * DAY));
    r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards[0].card_type).toBe('E1');
  });

  it('the stored cooldown_days is honoured; a row without dismissed_at hides nothing', async () => {
    setNothingDone({
      fetchEnrichmentCardStates: [
        { card_type: 'E2', dismissed_at: dismissedAt, cooldown_days: 1 },
        { card_type: 'E3', dismissed_at: null, cooldown_days: 7 },
      ],
    });
    let r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards.map((c: any) => c.card_type)).not.toContain('E2');
    expect(r.body.cards.map((c: any) => c.card_type)).toContain('E3');
    jest.setSystemTime(new Date(NOW.getTime() + 2 * DAY));
    r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.body.cards.map((c: any) => c.card_type)).toContain('E2');
  });
});

describe('GET — errors', () => {
  it('a database read error → 500 JSON, never an empty list', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (m.fetchAnyContact as jest.Mock).mockImplementation(() => Promise.resolve({ data: null, error: { message: 'relation "contacts" does not exist' } }));
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.status).toBe(500);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body).toEqual({ ok: false, error: 'ENRICHMENT_STATE_UNAVAILABLE' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('no Supabase client → 500 JSON', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    supa = null;
    const r = await request(app()).get('/api/v1/enrichment-cards?screen=home');
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
    spy.mockRestore();
  });
});

describe('POST /dismiss', () => {
  it('upserts only the caller row with now() and returns dismissed_until = now + cooldown', async () => {
    m.upsertEnrichmentCardDismissal.mockResolvedValue({
      data: { card_type: 'E4', dismissed_at: NOW.toISOString(), cooldown_days: 7 }, error: null,
    } as any);
    const r = await request(app())
      .post('/api/v1/enrichment-cards/dismiss')
      .send({ card_type: 'E4', user_id: 'someone-else' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, card_type: 'E4', dismissed_until: new Date(NOW.getTime() + 7 * DAY).toISOString() });
    expect(m.upsertEnrichmentCardDismissal).toHaveBeenCalledTimes(1);
    const [, userId, cardType, nowIso] = m.upsertEnrichmentCardDismissal.mock.calls[0];
    expect(userId).toBe(ME.user_id);
    expect(cardType).toBe('E4');
    expect(nowIso).toBe(NOW.toISOString());
  });

  it('a write error → 500 JSON', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    m.upsertEnrichmentCardDismissal.mockResolvedValue({ data: null, error: { message: 'denied' } } as any);
    const r = await request(app()).post('/api/v1/enrichment-cards/dismiss').send({ card_type: 'E1' });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'DISMISS_FAILED' });
    spy.mockRestore();
  });
});

describe('eligibleEnrichmentCards — the shared rule (route + Messenger companion)', () => {
  const allIncomplete = new Map(ALL_PRIORITY.map((t) => [t, false]));

  it('is the same rule the route serves', () => {
    expect(eligibleEnrichmentCards(allIncomplete, [], 'messenger', NOW).map((c) => c.card_type)).toEqual(ALL_PRIORITY);
    expect(eligibleEnrichmentCards(allIncomplete, [], 'calendar', NOW)).toEqual([
      { card_type: 'E8', category: 'enrichment', priority: 6 },
    ]);
  });

  it('an unknown screen or an unknown completion state shows nothing', () => {
    expect(eligibleEnrichmentCards(allIncomplete, [], 'nope', NOW)).toEqual([]);
    expect(eligibleEnrichmentCards(new Map(), [], 'home', NOW)).toEqual([]);
  });

  it('a dismissal hides the card until dismissed_at + cooldown_days', () => {
    const rows = [{ card_type: 'E8', dismissed_at: NOW.toISOString(), cooldown_days: 7 }];
    expect(eligibleEnrichmentCards(allIncomplete, rows, 'calendar', new Date(NOW.getTime() + 7 * DAY - 1))).toEqual([]);
    expect(eligibleEnrichmentCards(allIncomplete, rows, 'calendar', new Date(NOW.getTime() + 7 * DAY + 1))).toHaveLength(1);
  });
});
