/**
 * VTID-05101 — Vitana Companion Messages, Phase 3: the remaining moments and
 * the back-off. `npx jest test/vtid-05101-companion-generators.test.ts`
 *
 * Sparred plan (docs/validation/VTID-05099/plan-sparring.md, owner approved
 * 2026-10-12). Pins: guided_journey_step → F1, diary_nudge → F3, feature_tip
 * → F8, invite_friend → F7 (fires / does not fire / topic switch /
 * anti-repeat); the back-off read only from the ledger (3 unreplied real
 * sends → every other day, 7 → weekly, a reply resets, shadow rows never
 * count); the tick reading the signals in one batch per page, applying the
 * back-off, and honouring a proactive pause through the presence pacer.
 * Everything stays shadow: no table write, only the two ledger RPCs.
 */
const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
const mockIsPaused = jest.fn();
jest.mock('../src/services/guide/pause-check', () => ({ isPaused: (...a: unknown[]) => mockIsPaused(...a) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));

import {
  pickMoment, COMPANION_MOMENTS, MOMENTS, pickFeatureTip, memberOffset,
  guidedJourneyStep, diaryNudge, featureTip, inviteFriend,
  DIARY_NUDGE_AFTER_DAYS, INVITE_MIN_ACTIVE_DAYS,
  type MemberContext, type JourneySignal,
} from '../src/services/companion/moments';
import { backoffDecision, type BackoffLedgerRow } from '../src/services/companion/backoff';
import { memberSignals } from '../src/services/companion/signals';
import { runCompanionTick } from '../src/services/companion/companion-service';
import type { CompanionConfig } from '../src/services/companion/config';
import { FEATURE_TIPS } from '../src/data/feature-tips';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '11111111-1111-4111-8111-111111111111'; // Berlin, inside the window at NOW
const E = '55555555-5555-4555-8555-555555555555'; // Berlin, inside the window at NOW
// 2026-10-20 06:15 UTC = 08:15 Berlin (CEST).
const NOW = new Date('2026-10-20T06:15:00Z');
const TODAY = '2026-10-20';

const GUIDED: JourneySignal = {
  mode: 'guided', onboardingStatus: 'in_progress', currentSession: 7, doneToday: false,
  lastOpenedTopicId: 'sleep-basics', completedPracticeCount: 12, qualificationThreshold: 60,
};

function ctx(over: Partial<MemberContext> = {}): MemberContext {
  return {
    userId: A, tenantId: T, firstName: 'Dragan', locale: 'de', localDate: TODAY,
    topics: { health: true, community: true, business: false },
    vitanaIndex: null, lastUsed: {}, ...over,
  };
}

const shadowConfig: CompanionConfig = {
  mode: 'shadow', reason: 'shadow', windowStartMin: 450, windowEndMin: 570,
  shadowComposeLimit: 20, model: 'eu.anthropic.claude-sonnet-4-6', fallbackModel: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
};

// ── guided_journey_step → F1 ────────────────────────────────────────────────
describe('VTID-05101: guided_journey_step (card F1)', () => {
  it('fires for an active guided journey whose next step is not done today', () => {
    const m = pickMoment(ctx({ journey: GUIDED }));
    expect(m).toMatchObject({ momentKey: 'guided_journey_step', cardType: 'F1', topic: 'health', repeatAfterDays: 2 });
    expect(m.facts).toMatchObject({ next_session: 7, completed_practice_count: 12, qualification_threshold: 60, last_opened_topic_id: 'sleep-basics' });
  });

  it('does not fire when today\'s step is done, the member is in the full app, finished or skipped, or has no journey', () => {
    expect(guidedJourneyStep.build(ctx({ journey: { ...GUIDED, doneToday: true } }))).toBeNull();
    expect(guidedJourneyStep.build(ctx({ journey: { ...GUIDED, mode: 'full' } }))).toBeNull();
    expect(guidedJourneyStep.build(ctx({ journey: { ...GUIDED, onboardingStatus: 'completed' } }))).toBeNull();
    expect(guidedJourneyStep.build(ctx({ journey: { ...GUIDED, onboardingStatus: 'skipped' } }))).toBeNull();
    expect(guidedJourneyStep.build(ctx({ journey: null }))).toBeNull();
    expect(guidedJourneyStep.build(ctx())).toBeNull();
  });

  it('respects the health topic switch', () => {
    expect(pickMoment(ctx({ journey: GUIDED, topics: { health: false, community: true, business: false } })).momentKey)
      .not.toBe('guided_journey_step');
  });

  it('anti-repeat: not the day after, again two days later', () => {
    expect(pickMoment(ctx({ journey: GUIDED, lastUsed: { guided_journey_step: '2026-10-19' } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ journey: GUIDED, lastUsed: { guided_journey_step: '2026-10-18' } })).momentKey).toBe('guided_journey_step');
  });

  it('ranks above a quiet Vitana Index, below an Index that moved a lot', () => {
    const quiet = { total: 500, tier: 'Early', trend_7d: 2, points_to_really_good: 100, weakest_pillar: { name: 'sleep' }, strongest_pillar: { name: 'nutrition' } } as any;
    expect(pickMoment(ctx({ journey: GUIDED, vitanaIndex: quiet })).momentKey).toBe('guided_journey_step');
    expect(pickMoment(ctx({ journey: GUIDED, vitanaIndex: { ...quiet, trend_7d: 20 } })).momentKey).toBe('vitana_index');
  });
});

// ── diary_nudge → F3 ────────────────────────────────────────────────────────
describe('VTID-05101: diary_nudge (card F3)', () => {
  it(`fires after ${DIARY_NUDGE_AFTER_DAYS} days without an entry, with days_since_last_entry`, () => {
    const m = pickMoment(ctx({ diaryLastEntryDate: '2026-10-17' }));
    expect(m).toMatchObject({ momentKey: 'diary_nudge', cardType: 'F3', topic: 'health', priority: 40, repeatAfterDays: 4 });
    expect(m.facts).toEqual({ days_since_last_entry: 3 });
    expect(diaryNudge.build(ctx({ diaryLastEntryDate: '2026-10-10' }))!.priority).toBe(47);
  });

  it('does not fire for a recent entry, no entry in the window, or a stale entry beyond the window', () => {
    expect(diaryNudge.build(ctx({ diaryLastEntryDate: '2026-10-18' }))).toBeNull();
    expect(diaryNudge.build(ctx({ diaryLastEntryDate: TODAY }))).toBeNull();
    expect(diaryNudge.build(ctx({ diaryLastEntryDate: null }))).toBeNull();
    expect(diaryNudge.build(ctx())).toBeNull();
    expect(diaryNudge.build(ctx({ diaryLastEntryDate: '2026-09-01' }))).toBeNull();
  });

  it('respects the health topic switch and its 4-day anti-repeat', () => {
    expect(pickMoment(ctx({ diaryLastEntryDate: '2026-10-15', topics: { health: false, community: true, business: false } })).momentKey).not.toBe('diary_nudge');
    expect(pickMoment(ctx({ diaryLastEntryDate: '2026-10-15', lastUsed: { diary_nudge: '2026-10-17' } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ diaryLastEntryDate: '2026-10-15', lastUsed: { diary_nudge: '2026-10-16' } })).momentKey).toBe('diary_nudge');
  });
});

// ── feature_tip → F8 ────────────────────────────────────────────────────────
describe('VTID-05101: feature_tip (card F8)', () => {
  it('fires for a member who uses the app, low priority, community topic', () => {
    const m = pickMoment(ctx({ activeDays: 2 }));
    expect(m).toMatchObject({ momentKey: 'feature_tip', cardType: 'F8', topic: 'community', priority: 20, repeatAfterDays: 5 });
    const tip = FEATURE_TIPS.find((t) => t.key === m.facts.tip_key)!;
    expect(m.facts).toEqual({ tip_key: tip.key, feature_name: tip.title.en, feature_summary: tip.description.en });
  });

  it('does not fire without app usage', () => {
    expect(featureTip.build(ctx({ activeDays: 0 }))).toBeNull();
    expect(featureTip.build(ctx())).toBeNull();
  });

  it('respects the community topic switch and its anti-repeat window', () => {
    expect(pickMoment(ctx({ activeDays: 2, topics: { health: true, community: false, business: false } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ activeDays: 2, lastUsed: { feature_tip: '2026-10-16' } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ activeDays: 2, lastUsed: { feature_tip: '2026-10-15' } })).momentKey).toBe('feature_tip');
  });

  it('rotates per member, never repeats a recent tip, and skips features the member already uses', () => {
    const first = pickFeatureTip(ctx())!;
    expect(first.key).toBe(FEATURE_TIPS[memberOffset(A, FEATURE_TIPS.length)].key);
    const next = pickFeatureTip(ctx({ recentFeatureTips: [first.key] }))!;
    expect(next.key).not.toBe(first.key);
    // Already uses the Index / the diary; business switched off → those tips never come.
    const seen = new Set<string>();
    let recent: string[] = [];
    for (let i = 0; i < FEATURE_TIPS.length; i++) {
      const t = pickFeatureTip(ctx({
        vitanaIndex: { total: 1 } as any, diaryLastEntryDate: '2026-10-19', recentFeatureTips: recent,
      }));
      if (!t) break;
      seen.add(t.key);
      recent = [t.key, ...recent];
    }
    expect(seen.has('vitana-index')).toBe(false);
    expect(seen.has('daily-diary')).toBe(false);
    expect(seen.has('my-business')).toBe(false);
    expect(seen.size).toBe(FEATURE_TIPS.length - 3);
    // Every tip already used recently → no tip (the greeting stays the fallback).
    expect(pickFeatureTip(ctx({ recentFeatureTips: FEATURE_TIPS.map((t) => t.key) }))).toBeNull();
  });

  it('the tip anti-repeat list comes from the ledger facts, newest first, capped', () => {
    const rows = ['01', '02', '03', '04', '05', '06', '07', '08'].map((d, i) => ({
      user_id: A, local_date: `2026-10-${d}`, mode: 'shadow', moment_key: 'feature_tip', facts: { tip_key: FEATURE_TIPS[i].key },
    }));
    rows.push({ user_id: A, local_date: '2026-10-09', mode: 'shadow', moment_key: 'vitana_index', facts: { score: 1 } as any });
    const s = memberSignals({}, rows, TODAY);
    expect(s.recentFeatureTips).toEqual([7, 6, 5, 4, 3, 2].map((i) => FEATURE_TIPS[i].key));
  });
});

// ── invite_friend → F7 ──────────────────────────────────────────────────────
describe('VTID-05101: invite_friend (card F7)', () => {
  it(`fires only after ${INVITE_MIN_ACTIVE_DAYS} active days, below a feature tip`, () => {
    expect(inviteFriend.build(ctx({ activeDays: INVITE_MIN_ACTIVE_DAYS - 1 }))).toBeNull();
    const c = inviteFriend.build(ctx({ activeDays: 9 }))!;
    expect(c).toMatchObject({ momentKey: 'invite_friend', cardType: 'F7', topic: 'community', priority: 15, repeatAfterDays: 14 });
    expect(c.facts).toEqual({ active_days_last_30: 9 });
    expect(pickMoment(ctx({ activeDays: 9 })).momentKey).toBe('feature_tip');
    expect(pickMoment(ctx({ activeDays: 9, lastUsed: { feature_tip: '2026-10-19' } })).momentKey).toBe('invite_friend');
  });

  it('respects the community topic switch and a 14-day anti-repeat', () => {
    const quiet = { feature_tip: '2026-10-19' };
    expect(pickMoment(ctx({ activeDays: 9, lastUsed: quiet, topics: { health: true, community: false, business: false } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ activeDays: 9, lastUsed: { ...quiet, invite_friend: '2026-10-07' } })).momentKey).toBe('morning_greeting');
    expect(pickMoment(ctx({ activeDays: 9, lastUsed: { ...quiet, invite_friend: '2026-10-06' } })).momentKey).toBe('invite_friend');
  });
});

describe('VTID-05101: every moment', () => {
  it('names a card and carries an English intent, never a finished sentence (rule 41)', () => {
    const rich = ctx({
      vitanaIndex: { total: 500, tier: 'Early', trend_7d: 1, points_to_really_good: 1, weakest_pillar: { name: 'sleep' }, strongest_pillar: { name: 'mind' } } as any,
      journey: GUIDED, diaryLastEntryDate: '2026-10-15', activeDays: 9,
      // VTID-05366: every enrichment card eligible, so each enrichment moment builds.
      eligibleEnrichmentCardTypes: new Set(ENRICHMENT_ALL),
    });
    expect(COMPANION_MOMENTS.map((m) => m.key)).toEqual([
      'morning_greeting', 'vitana_index', 'guided_journey_step', 'diary_nudge', 'feature_tip', 'invite_friend',
      // VTID-05366: the 11 profile-enrichment moments, E1 → E11.
      'enrichment_e1', 'enrichment_e2', 'enrichment_e3', 'enrichment_e4', 'enrichment_e5', 'enrichment_e6',
      'enrichment_e7', 'enrichment_e8', 'enrichment_e9', 'enrichment_e10', 'enrichment_e11',
    ]);
    expect(COMPANION_MOMENTS.slice(0, MOMENTS.length)).toEqual(MOMENTS);
    for (const m of COMPANION_MOMENTS) {
      const c = m.build(rich);
      expect(c).not.toBeNull();
      expect(c!.momentKey).toBe(m.key);
      expect(c!.cardType).toMatch(/^[EFG]\d+$/);
      expect(c!.intent).toMatch(/^(Warmly greet|Greet) the member/);
      expect(c!.intent).not.toMatch(/["“„]/);
      expect(c!.repeatAfterDays).toBeGreaterThanOrEqual(0);
    }
    expect(Object.fromEntries(COMPANION_MOMENTS.map((m) => [m.key, m.build(rich)!.cardType]))).toEqual({
      morning_greeting: 'F4', vitana_index: 'F2', guided_journey_step: 'F1', diary_nudge: 'F3', feature_tip: 'F8', invite_friend: 'F7',
      enrichment_e1: 'E1', enrichment_e2: 'E2', enrichment_e3: 'E3', enrichment_e4: 'E4', enrichment_e5: 'E5', enrichment_e6: 'E6',
      enrichment_e7: 'E7', enrichment_e8: 'E8', enrichment_e9: 'E9', enrichment_e10: 'E10', enrichment_e11: 'E11',
    });
  });
});

// ── back-off ────────────────────────────────────────────────────────────────
function sent(dates: string[], over: Partial<BackoffLedgerRow> = {}): BackoffLedgerRow[] {
  return dates.map((d) => ({ local_date: d, mode: 'live', status: 'sent', replied_at: null, ...over }));
}

describe('VTID-05101: back-off (ledger only)', () => {
  it('2 unreplied real sends → still daily', () => {
    expect(backoffDecision(sent(['2026-10-19', '2026-10-18']), TODAY)).toMatchObject({ allow: true, level: 'none', unreplied: 2 });
  });

  it('3 unreplied → every other day: skip the consecutive day, allowed the next', () => {
    const rows = sent(['2026-10-19', '2026-10-18', '2026-10-17']);
    expect(backoffDecision(rows, TODAY)).toMatchObject({ allow: false, level: 'every_other_day', unreplied: 3, lastSentDate: '2026-10-19' });
    expect(backoffDecision(rows, '2026-10-21')).toMatchObject({ allow: true, level: 'every_other_day' });
  });

  it('7 unreplied → weekly', () => {
    const rows = sent(['2026-10-13', '2026-10-11', '2026-10-09', '2026-10-07', '2026-10-05', '2026-10-04', '2026-10-03']);
    expect(backoffDecision(rows, '2026-10-19')).toMatchObject({ allow: false, level: 'weekly', unreplied: 7 });
    expect(backoffDecision(rows, TODAY)).toMatchObject({ allow: true, level: 'weekly' });
  });

  it('a reply resets: only the unreplied sends after the newest reply count', () => {
    const replied = sent(['2026-10-19'], { replied_at: '2026-10-19T09:00:00Z' });
    expect(backoffDecision([...replied, ...sent(['2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15'])], TODAY))
      .toMatchObject({ allow: true, level: 'none', unreplied: 0 });
    const rows = [...sent(['2026-10-19', '2026-10-18', '2026-10-17']), ...sent(['2026-10-16'], { replied_at: '2026-10-16T10:00:00Z' })];
    expect(backoffDecision(rows, TODAY)).toMatchObject({ allow: false, unreplied: 3 });
  });

  it('shadow rows, failed/pending rows and today\'s row never count as sent', () => {
    const shadow = ['2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16'].map((d) => ({ local_date: d, mode: 'shadow', status: 'shadow', replied_at: null }));
    expect(backoffDecision(shadow, TODAY)).toMatchObject({ allow: true, unreplied: 0 });
    expect(backoffDecision([...sent(['2026-10-19', '2026-10-18']), ...sent(['2026-10-17'], { status: 'failed' })], TODAY).allow).toBe(true);
    expect(backoffDecision(sent([TODAY, '2026-10-19', '2026-10-18']), TODAY)).toMatchObject({ allow: true, unreplied: 2 });
    expect(backoffDecision([], TODAY)).toEqual({ allow: true, level: 'none', unreplied: 0, lastSentDate: null });
  });
});

// ── the tick ────────────────────────────────────────────────────────────────
function fakeDb(tables: Record<string, any[]>, failTables: string[] = []) {
  const writes: Array<{ table: string; op: string }> = [];
  const reads: string[] = [];
  const ledger = (tables.companion_messages_ledger ??= []);
  let nextId = 1;
  const rpc = jest.fn(async (fn: string, a: any) => {
    if (fn === 'claim_companion_message') {
      const taken = ledger.some((r) => r.user_id === a.p_user_id && r.local_date === a.p_local_date && r.mode === a.p_mode);
      if (taken) return { data: { ok: true, claimed: false, reason: 'already_decided_today' }, error: null };
      const row = { id: nextId++, user_id: a.p_user_id, tenant_id: a.p_tenant_id, local_date: a.p_local_date, mode: a.p_mode,
        sender: a.p_sender, moment_key: a.p_moment_key, card_type: a.p_card_type, facts: a.p_facts, status: 'pending',
        composed_text: null, created_at: NOW.toISOString() };
      ledger.push(row);
      return { data: { ok: true, claimed: true, id: row.id }, error: null };
    }
    if (fn === 'finish_companion_message') {
      const row = ledger.find((r) => r.id === a.p_id && r.status === 'pending');
      if (!row) return { data: { ok: false, error: 'NOT_PENDING' }, error: null };
      Object.assign(row, { status: a.p_status, composed_text: a.p_composed_text });
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
      delete: () => { writes.push({ table, op: 'delete' }); return q; },
      then: (ok: any, ko: any) => {
        reads.push(table);
        if (failTables.includes(table)) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(ok, ko);
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { client: { from, rpc } as any, writes, reads, rpc, ledger };
}

function seed(): Record<string, any[]> {
  return {
    user_tenants: [A, E].map((id) => ({ user_id: id, tenant_id: T, is_primary: true })),
    profiles: [
      { user_id: A, first_name: 'Dragan', timezone: 'Europe/Berlin' },
      { user_id: E, first_name: 'Eva', timezone: 'Europe/Berlin' },
    ],
    companion_preferences: [],
    onboarding_touch_ledger: [],
  };
}

function deps(db: ReturnType<typeof fakeDb>, over: Record<string, unknown> = {}) {
  return {
    sb: db.client, now: NOW, config: shadowConfig,
    emit: jest.fn(async () => ({ ok: true })),
    pacer: jest.fn(async () => ({ allow: true, reason: 'ok' as const })),
    fetchIndex: jest.fn(async () => null),
    compose: jest.fn(async () => ({ ok: true as const, text: 'Guten Morgen!', model: 'eu.anthropic.claude-sonnet-4-6' })),
    locales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'de']))),
    // VTID-05366: these tests are about the Phase 3 moments; members are fully set
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

const momentOf = (db: ReturnType<typeof fakeDb>, id: string) => db.ledger.find((r) => r.user_id === id && r.local_date === TODAY);

describe('VTID-05101: the shadow tick with the Phase 3 moments', () => {
  beforeEach(() => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set<string>() });
    mockIsPaused.mockReset();
    mockIsPaused.mockResolvedValue({ paused: false });
  });

  it('reads the signals in one batch for the whole page and decides the right card per member', async () => {
    const db = fakeDb(seed());
    const signals = jest.fn(async (_sb: unknown, ids: string[]) => ({
      by: new Map<string, any>([
        [A, { journey: { user_id: A, mode: 'guided', onboarding_status: 'in_progress', current_session: 4, completed_practice_count: 3,
          qualification_threshold: 60, last_opened_topic_id: null, metadata: { daily_listen: { date: '2026-10-19', sessions: [3] } } } }],
        [E, { journey: null, lastDiaryDate: '2026-10-14', activeDays: 1 }],
      ].filter(([id]) => ids.includes(id as string)) as any),
      unavailable: [],
    }));
    const r = await runCompanionTick(deps(db, { signals }) as any);
    expect(signals).toHaveBeenCalledTimes(1);
    expect((signals.mock.calls[0] as any)[1].sort()).toEqual([A, E].sort());
    expect(r).toMatchObject({ decided: 2, moments: { guided_journey_step: 1, diary_nudge: 1 } });
    expect(momentOf(db, A)).toMatchObject({ moment_key: 'guided_journey_step', card_type: 'F1', facts: expect.objectContaining({ next_session: 4 }), mode: 'shadow', status: 'shadow' });
    expect(momentOf(db, E)).toMatchObject({ moment_key: 'diary_nudge', card_type: 'F3', facts: { days_since_last_entry: 6 } });
    expect(db.writes).toEqual([]);
  });

  it('the default signal reads hit the real tables, once per page, and feed the moments', async () => {
    const tables = seed();
    tables.user_guided_journey_state = [{ user_id: A, mode: 'guided', onboarding_status: 'in_progress', current_session: 2,
      completed_practice_count: 1, qualification_threshold: 60, last_opened_topic_id: null,
      metadata: { daily_listen: { date: TODAY, sessions: [1] } } }]; // done today → no journey step
    tables.diary_entries = [
      { user_id: A, created_at: '2026-10-12T19:00:00Z' }, { user_id: A, created_at: '2026-10-15T07:00:00Z' },
      { user_id: E, created_at: '2026-10-19T20:00:00Z' },
    ];
    tables.user_active_days = ['2026-10-18', '2026-10-19', '2026-10-19'].map((d) => ({ user_id: E, active_date: d }));
    const db = fakeDb(tables);
    const r = await runCompanionTick(deps(db) as any);
    for (const t of ['user_guided_journey_state', 'diary_entries', 'user_active_days']) {
      expect(db.reads.filter((x) => x === t)).toHaveLength(1);
    }
    expect(r.signals_unavailable).toBeUndefined();
    expect(momentOf(db, A)).toMatchObject({ moment_key: 'diary_nudge', facts: { days_since_last_entry: 5 } });
    // E wrote yesterday (no nudge) and was active on 2 days → a feature tip, never the diary tip.
    expect(momentOf(db, E)).toMatchObject({ moment_key: 'feature_tip', card_type: 'F8' });
    expect(momentOf(db, E)!.facts.tip_key).not.toBe('daily-diary');
  });

  it('a signal source that fails is reported and only its moments go quiet', async () => {
    const tables = seed();
    tables.diary_entries = [{ user_id: A, created_at: '2026-10-14T08:00:00Z' }];
    const db = fakeDb(tables, ['diary_entries']);
    const r = await runCompanionTick(deps(db) as any);
    expect(r).toMatchObject({ ok: true, decided: 2, signals_unavailable: ['diary'] });
    expect(momentOf(db, A)?.moment_key).toBe('morning_greeting');
  });

  it('back-off: 3 unreplied real sends skip the next consecutive day; a reply lets Vitana write again', async () => {
    const rows = ['2026-10-19', '2026-10-18', '2026-10-17'].map((d, i) => ({
      id: 900 + i, user_id: A, local_date: d, mode: 'live', moment_key: 'morning_greeting', status: 'sent', replied_at: null,
    }));
    let tables = seed();
    tables.companion_messages_ledger = rows.map((x) => ({ ...x }));
    let db = fakeDb(tables);
    let r = await runCompanionTick(deps(db) as any);
    expect(r.skipped).toMatchObject({ backoff: 1 });
    expect(momentOf(db, A)).toBeUndefined();
    expect(momentOf(db, E)).toBeDefined();

    tables = seed();
    tables.companion_messages_ledger = rows.map((x, i) => ({ ...x, replied_at: i === 0 ? '2026-10-19T08:30:00Z' : null }));
    db = fakeDb(tables);
    r = await runCompanionTick(deps(db) as any);
    expect(r.skipped?.backoff).toBeUndefined();
    expect(momentOf(db, A)).toBeDefined();
  });

  it('back-off never counts shadow rows (Phase 1–3 run in shadow)', async () => {
    const tables = seed();
    tables.companion_messages_ledger = Array.from({ length: 10 }, (_, i) => ({
      id: 800 + i, user_id: A, local_date: `2026-10-${String(10 + i).padStart(2, '0')}`, mode: 'shadow', moment_key: 'morning_greeting', status: 'shadow', replied_at: null,
    }));
    const db = fakeDb(tables);
    const r = await runCompanionTick(deps(db) as any);
    expect(r.skipped?.backoff).toBeUndefined();
    expect(momentOf(db, A)).toBeDefined();
  });

  it('a proactive pause (user_proactive_pause) skips the member through the presence pacer', async () => {
    // Both members paused ("not now" from the chat): the real pacer stops before any touch read.
    mockIsPaused.mockResolvedValue({ paused: true, pause: { scope: 'all', scope_value: null, paused_until: '2026-10-27T00:00:00Z' } });
    const db = fakeDb(seed());
    const d = deps(db) as any;
    delete d.pacer; // the real canSurfaceProactively → isPaused
    const r = await runCompanionTick(d);
    expect(mockIsPaused).toHaveBeenCalledWith(expect.objectContaining({ user_id: A, channel: 'text' }));
    expect(mockIsPaused).toHaveBeenCalledWith(expect.objectContaining({ user_id: E, channel: 'text' }));
    expect(r).toMatchObject({ decided: 0, skipped: { pacer_paused: 2 } });
    expect(db.ledger).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
