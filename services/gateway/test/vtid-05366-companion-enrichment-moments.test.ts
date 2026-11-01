/**
 * VTID-05366 (plan messenger-vitana-cards-v2, lane companion-enrichment-moments)
 * — the 11 profile-enrichment moments in the Vitana companion DM.
 * `npx jest test/vtid-05366-companion-enrichment-moments.test.ts`
 *
 * Pins the sparred plan:
 *  - a moment fires ONLY when the tick put its card in eligibleEnrichmentCardTypes;
 *  - absolute companion-scale priorities E1=39 … E11=29 (R2-F3/R3-F1): below every
 *    health/habit moment (diary 40–50, Index 50–70, journey 65), above
 *    feature_tip (20) and invite_friend (15);
 *  - topic: E3/E6/E7 are 'community' (silent when community is off), the rest null (R1-F2);
 *  - repeatAfterDays 4 (profile cards) / 7 (connector cards) (R2-F2);
 *  - intent is a composer instruction (rule 41); the card copy travels as facts,
 *    and the card itself carries numbers only (R3-F2);
 *  - end to end: a member with no profile rows gets an enrichment DM card, and
 *    E6/E7 never while the Meta OAuth client is unset.
 */
const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import {
  pickMoment, COMPANION_MOMENTS, ENRICHMENT_MOMENTS, ENRICHMENT_MOMENT_INTENT, enrichmentMomentKey,
  type MemberContext,
} from '../src/services/companion/moments';
import { buildCompanionMetadata } from '../src/services/companion/delivery';
import { runCompanionTick } from '../src/services/companion/companion-service';
import type { CompanionConfig } from '../src/services/companion/config';
import { ENRICHMENT_CARD_TIPS } from '../src/data/enrichment-card-tips';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M = '55555555-5555-4555-8555-555555555555';
const TODAY = '2026-10-20';
const NOW = new Date('2026-10-20T06:15:00Z'); // 08:15 Berlin
const ALL = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11'] as const;

const shadowConfig: CompanionConfig = {
  mode: 'shadow', reason: 'shadow', windowStartMin: 450, windowEndMin: 570,
  shadowComposeLimit: 20, model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
};

/** A quiet member: no Index, no journey, no diary, no activity — only what the test adds. */
function ctx(over: Partial<MemberContext> = {}): MemberContext {
  return {
    userId: M, tenantId: T, firstName: 'Mila', locale: 'de', localDate: TODAY,
    topics: { health: true, community: true, business: false },
    vitanaIndex: null, lastUsed: {}, journey: null, diaryLastEntryDate: null, activeDays: 0, recentFeatureTips: [],
    ...over,
  };
}
const eligible = (...cards: string[]) => ({ eligibleEnrichmentCardTypes: new Set(cards) });

describe('VTID-05366: the enrichment moments', () => {
  it('there are exactly 11, one per card, keyed enrichment_e1 … enrichment_e11', () => {
    expect(ENRICHMENT_MOMENTS.map((m) => m.key)).toEqual(ALL.map((c) => enrichmentMomentKey(c)));
    expect(COMPANION_MOMENTS.slice(-11)).toEqual(ENRICHMENT_MOMENTS);
  });

  it('pins the absolute priorities E1=39 … E11=29, the topics and the repeat windows', () => {
    const c = ctx(eligible(...ALL));
    const built = Object.fromEntries(ENRICHMENT_MOMENTS.map((m) => {
      const b = m.build(c)!;
      return [b.cardType, { priority: b.priority, topic: b.topic, repeat: b.repeatAfterDays }];
    }));
    expect(built).toEqual({
      E1: { priority: 39, topic: null, repeat: 4 },
      E2: { priority: 38, topic: null, repeat: 4 },
      E3: { priority: 37, topic: 'community', repeat: 7 },
      E4: { priority: 36, topic: null, repeat: 4 },
      E5: { priority: 35, topic: null, repeat: 4 },
      E6: { priority: 34, topic: 'community', repeat: 7 },
      E7: { priority: 33, topic: 'community', repeat: 7 },
      E8: { priority: 32, topic: null, repeat: 7 },
      E9: { priority: 31, topic: null, repeat: 7 },
      E10: { priority: 30, topic: null, repeat: 7 },
      E11: { priority: 29, topic: null, repeat: 4 },
    });
  });

  it('a card that is not in the eligible set never fires (absent set = nothing)', () => {
    for (const m of ENRICHMENT_MOMENTS) expect(m.build(ctx())).toBeNull();
    expect(pickMoment(ctx(eligible('E8'))).cardType).toBe('E8');
    expect(pickMoment(ctx()).momentKey).toBe('morning_greeting');
  });

  it('picks the highest-priority eligible card', () => {
    expect(pickMoment(ctx(eligible(...ALL))).momentKey).toBe('enrichment_e1');
    expect(pickMoment(ctx(eligible('E11', 'E5', 'E9'))).momentKey).toBe('enrichment_e5');
  });

  it('R1-F2: a member who switched community off never gets E3/E6/E7', () => {
    const off = { topics: { health: true, community: false, business: false } };
    expect(pickMoment(ctx({ ...off, ...eligible('E3', 'E6', 'E7') })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ ...off, ...eligible('E3', 'E8') })).momentKey).toBe('enrichment_e8');
  });

  it('R2-F2: an E1 used yesterday is not offered again today; after 4 days it is', () => {
    expect(pickMoment(ctx({ ...eligible('E1', 'E2'), lastUsed: { enrichment_e1: '2026-10-19' } })).momentKey).toBe('enrichment_e2');
    expect(pickMoment(ctx({ ...eligible('E1', 'E2'), lastUsed: { enrichment_e1: '2026-10-16' } })).momentKey).toBe('enrichment_e1');
    // A connector card waits a week.
    expect(pickMoment(ctx({ ...eligible('E8'), lastUsed: { enrichment_e8: '2026-10-14' } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ ...eligible('E8'), lastUsed: { enrichment_e8: '2026-10-13' } })).momentKey).toBe('enrichment_e8');
  });
});

describe('VTID-05366: health and habit cards always come first', () => {
  const index = {
    total: 500, tier: 'Early', trend_7d: 0, points_to_really_good: 1,
    weakest_pillar: { name: 'sleep' }, strongest_pillar: { name: 'mind' },
  } as any;

  it('the Vitana Index (50–70) beats every enrichment card', () => {
    expect(pickMoment(ctx({ ...eligible(...ALL), vitanaIndex: index })).momentKey).toBe('vitana_index');
  });

  it('a freshly lapsed diary (diary_nudge 40) beats the top enrichment card (39)', () => {
    // Last entry 3 days ago = the minimum diary_nudge priority of 40.
    expect(pickMoment(ctx({ ...eligible(...ALL), diaryLastEntryDate: '2026-10-17' })).momentKey).toBe('diary_nudge');
  });

  it('the Guided Journey step (65) beats every enrichment card', () => {
    const journey = {
      mode: 'guided' as const, onboardingStatus: 'in_progress', currentSession: 3, doneToday: false,
      lastOpenedTopicId: null, completedPracticeCount: 1, qualificationThreshold: 5,
    };
    expect(pickMoment(ctx({ ...eligible(...ALL), journey })).momentKey).toBe('guided_journey_step');
  });

  it('even the lowest enrichment card (E11, 29) beats a feature tip (20) and an invite (15)', () => {
    expect(pickMoment(ctx({ ...eligible('E11'), activeDays: 9 })).momentKey).toBe('enrichment_e11');
  });
});

describe('VTID-05366: what the composer and the card get', () => {
  it('the intent is an instruction (rule 41), the card copy travels as English facts', () => {
    expect(ENRICHMENT_MOMENT_INTENT).toMatch(/^Greet the member/);
    expect(ENRICHMENT_MOMENT_INTENT).not.toMatch(/["“„]/);
    const c = ctx(eligible('E1'));
    const m = pickMoment(c);
    expect(m.intent).toBe(ENRICHMENT_MOMENT_INTENT);
    expect(m.facts).toEqual({
      card_type: 'E1',
      card_title: ENRICHMENT_CARD_TIPS.E1.title.en,
      card_description: ENRICHMENT_CARD_TIPS.E1.description.en,
    });
  });

  it('the DM card carries the card id and no strings from the facts', () => {
    const m = pickMoment(ctx(eligible('E8')));
    const meta = buildCompanionMetadata({ momentKey: m.momentKey, cardType: m.cardType, facts: m.facts }) as any;
    expect(meta.card).toMatchObject({ kind: 'vitana_card', card_type: 'E8', params: {} });
  });
});

// ── end to end through the tick, with the REAL bulk enrichment reads ────────
function fakeDb(tables: Record<string, any[]>) {
  const ledger = (tables.companion_messages_ledger ??= []);
  let nextId = 1;
  const rpc = jest.fn(async (fn: string, a: any) => {
    if (fn === 'claim_companion_message') {
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
  return { client: { from, rpc } as any, ledger };
}

function tick(tables: Record<string, any[]>) {
  // A fresh ledger per tick, so a second tick in one test is not "already_today".
  const db = fakeDb({ ...tables, companion_messages_ledger: [] });
  return runCompanionTick({
    sb: db.client, now: NOW, config: shadowConfig,
    emit: jest.fn(async () => ({ ok: true })) as any,
    pacer: jest.fn(async () => ({ allow: true, reason: 'ok' as const })) as any,
    fetchIndex: jest.fn(async () => null),
    compose: jest.fn(async () => ({ ok: true as const, text: 'Hallo Mila!', model: 'm' })) as any,
    locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
  }).then((r) => ({ r, row: db.ledger.find((x) => x.user_id === M && x.local_date === TODAY) }));
}

const META_ENV = ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'FACEBOOK_CLIENT_ID', 'FACEBOOK_CLIENT_SECRET'];
const saved: Record<string, string | undefined> = {};

describe('VTID-05366: end to end in the shadow tick', () => {
  beforeEach(() => {
    for (const k of META_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    mockStrict.mockResolvedValue({ ok: true, ids: new Set<string>() });
  });
  afterEach(() => {
    for (const k of META_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  const base = () => ({
    user_tenants: [{ user_id: M, tenant_id: T, is_primary: true }],
    profiles: [{ user_id: M, first_name: 'Mila', timezone: 'Europe/Berlin' }],
  } as Record<string, any[]>);

  it('a member who has set nothing up gets the top enrichment card (E1) as the day\'s Vitana card', async () => {
    const { r, row } = await tick(base());
    expect(r).toMatchObject({ ok: true, decided: 1, moments: { enrichment_e1: 1 } });
    expect(row).toMatchObject({ moment_key: 'enrichment_e1', card_type: 'E1' });
  });

  it('a member who did everything except Instagram/Facebook gets no E6/E7 while Meta OAuth is unset', async () => {
    const t = base();
    t.profiles = [{
      user_id: M, first_name: 'Mila', timezone: 'Europe/Berlin',
      avatar_url: 'a', bio: 'A bio that is clearly longer than fifty characters so it counts.', location: 'Berlin',
      cover_url: 'c', universal_intent_cover_url: null, interests: ['sleep'],
    }];
    t.profile_posts = [{ user_id: M }];
    t.connected_app_settings = [{ user_id: M, app_id: 'google-calendar', enabled: true }];
    t.contacts = [{ user_id: M }];
    t.user_device_tokens = [{ user_id: M, revoked_at: null, fcm_token: 'tok' }];
    const { row } = await tick(t);
    expect(row?.moment_key).toBe('morning_greeting');
    for (const k of META_ENV) process.env[k] = 'x';
    const configured = await tick(t);
    expect(configured.row?.moment_key).toBe('enrichment_e6');
  });

  it('a card dismissed 2 days ago is skipped for the next one', async () => {
    const t = base();
    t.user_enrichment_cards = [{ user_id: M, card_type: 'E1', dismissed_at: '2026-10-18T06:15:00Z', cooldown_days: 7 }];
    const { row } = await tick(t);
    expect(row).toMatchObject({ moment_key: 'enrichment_e2', card_type: 'E2' });
  });
});
