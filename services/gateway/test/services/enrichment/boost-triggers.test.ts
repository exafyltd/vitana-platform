/**
 * VTID-05143 (Unified Card System Phase 3, step 15) — boost triggers G1–G3:
 *   G1 Complete Your Profile — weighted profile completion < 80 % (the
 *      sections and weights of vitana-v1 src/hooks/useProfileProgress.ts),
 *   G2 Unread Matches — unseen live daily_matches > 0,
 *   G3 Streak at Risk — no diary entry yesterday (or today) AND the streak
 *      ending the day before yesterday is > 3 days (UTC days).
 * Each trigger's true/false edges, the caller-only parallel reads, the loud
 * error on a failed read, and the catalog rule (screens, urgency G3 → G2 → G1,
 * 7-day cooldown).
 */

jest.mock('../../../src/services/enrichment/completion-resolver-repository', () => ({
  fetchProfileProgressFields: jest.fn(),
  countUnseenLiveMatches: jest.fn(),
  fetchRecentDiaryEntryTimes: jest.fn(),
  DIARY_STREAK_LOOKBACK_DAYS: 120,
}));

import * as repo from '../../../src/services/enrichment/completion-resolver-repository';
import {
  computeBoostTriggers,
  computeProfileCompletionPct,
  computeStreakAtRisk,
  EnrichmentDataError,
  PROFILE_PROGRESS_SECTIONS,
  resolveBoostTriggers,
  type ProfileProgressFields,
} from '../../../src/services/enrichment/completion-resolver';
import {
  BOOST_PRIORITY,
  SCREEN_BOOST_CARDS,
  eligibleBoostCards,
  isDismissibleCardType,
  type BoostTrigger,
  type BoostCardType,
} from '../../../src/services/enrichment/card-catalog';

const m = repo as jest.Mocked<typeof repo>;
const USER = 'user-a';
const sb = {} as any;
const NOW = new Date('2026-10-13T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** ISO timestamp `n` UTC days before NOW's day, at the given hour. */
const daysAgo = (n: number, hour = 9) => {
  const d = new Date(Date.UTC(2026, 9, 13 - n, hour, 0, 0));
  return d.toISOString();
};

const FULL: ProfileProgressFields = {
  display_name: 'Mia',
  handle: 'mia',
  avatar_url: 'https://x/a.png',
  bio: 'b'.repeat(51),
  location: 'Berlin',
  links: [{ label: 'site', url: 'https://mia.example' }],
  cover_url: 'https://x/c.png',
  languages: ['de'],
  service_offerings: { offers: [{ category: 'coaching', title: 'Breathwork' }] },
};

beforeEach(() => jest.clearAllMocks());

describe('G1 — weighted profile completion (useProfileProgress.ts)', () => {
  it('uses the same eight sections and weights as the frontend, summing to 100', () => {
    expect(PROFILE_PROGRESS_SECTIONS.map((s) => [s.id, s.weight])).toEqual([
      ['identity', 20], ['avatar', 15], ['about', 20], ['location', 10],
      ['links', 10], ['cover', 15], ['languages', 5], ['services', 5],
    ]);
    expect(PROFILE_PROGRESS_SECTIONS.reduce((a, s) => a + s.weight, 0)).toBe(100);
  });

  it('a complete profile is 100 %, no profile row is 0 %', () => {
    expect(computeProfileCompletionPct(FULL)).toBe(100);
    expect(computeProfileCompletionPct(null)).toBe(0);
    expect(computeProfileCompletionPct({})).toBe(0);
  });

  it.each([
    ['identity needs both display_name and handle', { handle: null }, 80],
    ['identity: blank display_name', { display_name: '  ' }, 80],
    ['avatar', { avatar_url: '' }, 85],
    ['about: bio of exactly 50 trimmed characters', { bio: ` ${'b'.repeat(50)} ` }, 80],
    ['location', { location: null }, 90],
    ['links: empty array', { links: [] }, 90],
    ['links: not an array', { links: {} }, 90],
    ['cover: neither cover field', { cover_url: null, universal_intent_cover_url: '' }, 85],
    ['languages: only blanks', { languages: [''] }, 95],
    ['services: no offers', { service_offerings: { offers: [] } }, 95],
    ['services: empty object (column default)', { service_offerings: {} }, 95],
  ])('%s → missing that section\'s weight', (_name, over, pct) => {
    expect(computeProfileCompletionPct({ ...FULL, ...(over as ProfileProgressFields) })).toBe(pct);
  });

  it('the cover library field counts as a cover (same rule as E11)', () => {
    expect(computeProfileCompletionPct({ ...FULL, cover_url: null, universal_intent_cover_url: 'https://x/u.png' })).toBe(100);
  });

  it('fires below 80 %, not at 80 %', () => {
    const at80 = computeBoostTriggers({ profile: { ...FULL, handle: null }, unseenMatchCount: 0, diaryEntryTimes: [], now: NOW });
    expect(at80.get('G1')).toEqual({ card_type: 'G1', fired: false, data: { completion_pct: 80 } });
    // identity (20) + languages (5) missing → 75 %
    const at75 = computeBoostTriggers({ profile: { ...FULL, handle: null, languages: [] }, unseenMatchCount: 0, diaryEntryTimes: [], now: NOW });
    expect(at75.get('G1')).toEqual({ card_type: 'G1', fired: true, data: { completion_pct: 75 } });
  });
});

describe('G2 — unseen live matches', () => {
  it.each([
    [0, false],
    [1, true],
    [4, true],
  ])('%i unseen matches → fired %p, count returned', (count, fired) => {
    const t = computeBoostTriggers({ profile: FULL, unseenMatchCount: count, diaryEntryTimes: [], now: NOW });
    expect(t.get('G2')).toEqual({ card_type: 'G2', fired, data: { unread_match_count: count } });
  });
});

describe('G3 — streak at risk (UTC days)', () => {
  const streak = (fromDaysAgo: number, length: number) =>
    Array.from({ length }, (_, i) => daysAgo(fromDaysAgo + i));

  it('a 4-day streak ending the day before yesterday, nothing yesterday or today → fires with 4', () => {
    expect(computeStreakAtRisk(streak(2, 4), NOW)).toEqual({ fired: true, streak_days: 4 });
  });

  it('a 3-day streak is not > 3 → does not fire', () => {
    expect(computeStreakAtRisk(streak(2, 3), NOW)).toEqual({ fired: false, streak_days: 3 });
  });

  it('an entry yesterday → not at risk (the streak is alive)', () => {
    expect(computeStreakAtRisk([daysAgo(1), ...streak(2, 6)], NOW).fired).toBe(false);
  });

  it('an entry today → not at risk', () => {
    expect(computeStreakAtRisk([daysAgo(0, 1), ...streak(2, 6)], NOW).fired).toBe(false);
  });

  it('a long streak that ended 3+ days ago is already lost → does not fire', () => {
    expect(computeStreakAtRisk(streak(3, 10), NOW)).toEqual({ fired: false, streak_days: 0 });
  });

  it('several entries on one day count as one day; a gap ends the run', () => {
    const times = [daysAgo(2, 8), daysAgo(2, 20), daysAgo(3), daysAgo(4), daysAgo(5), daysAgo(6), daysAgo(8)];
    expect(computeStreakAtRisk(times, NOW)).toEqual({ fired: true, streak_days: 5 });
  });

  it('uses the UTC day boundary: 23:30 UTC two days ago is still that day', () => {
    const times = [daysAgo(2, 23), daysAgo(3, 0), daysAgo(4), daysAgo(5)];
    expect(computeStreakAtRisk(times, NOW)).toEqual({ fired: true, streak_days: 4 });
  });

  it('no entries or unparsable timestamps → does not fire', () => {
    expect(computeStreakAtRisk([], NOW)).toEqual({ fired: false, streak_days: 0 });
    expect(computeStreakAtRisk(['not a date'], NOW)).toEqual({ fired: false, streak_days: 0 });
  });

  it('is returned through computeBoostTriggers with the streak count', () => {
    const t = computeBoostTriggers({ profile: FULL, unseenMatchCount: 0, diaryEntryTimes: streak(2, 7), now: NOW });
    expect(t.get('G3')).toEqual({ card_type: 'G3', fired: true, data: { streak_days: 7 } });
  });
});

describe('resolveBoostTriggers — through the repository', () => {
  const ok = (data: unknown, count?: number) => Promise.resolve({ data, error: null, count } as any);

  function setRepo(over: { profile?: unknown; count?: number; diary?: unknown } = {}) {
    m.fetchProfileProgressFields.mockImplementation(() => ok('profile' in over ? over.profile : FULL));
    m.countUnseenLiveMatches.mockImplementation(() => ok(null, over.count ?? 0));
    m.fetchRecentDiaryEntryTimes.mockImplementation(() => ok(over.diary ?? []));
  }

  it('reads only the caller, once each, and computes all three triggers', async () => {
    setRepo({
      profile: { ...FULL, avatar_url: null, cover_url: null },
      count: 3,
      diary: [daysAgo(2), daysAgo(3), daysAgo(4), daysAgo(5), daysAgo(6)].map((created_at) => ({ created_at })),
    });
    const t = await resolveBoostTriggers(sb, USER, NOW);
    expect(t.get('G1')).toEqual({ card_type: 'G1', fired: true, data: { completion_pct: 70 } });
    expect(t.get('G2')).toEqual({ card_type: 'G2', fired: true, data: { unread_match_count: 3 } });
    expect(t.get('G3')).toEqual({ card_type: 'G3', fired: true, data: { streak_days: 5 } });
    for (const fn of [m.fetchProfileProgressFields, m.countUnseenLiveMatches, m.fetchRecentDiaryEntryTimes]) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect((fn as jest.Mock).mock.calls[0][1]).toBe(USER);
    }
    // live matches are compared with now; the diary look-back starts at a UTC midnight 120 days back
    expect(m.countUnseenLiveMatches.mock.calls[0][2]).toBe(NOW.toISOString());
    expect(m.fetchRecentDiaryEntryTimes.mock.calls[0][2]).toBe(new Date(Date.UTC(2026, 9, 13) - 120 * DAY).toISOString());
  });

  it('a member with a full profile, no unseen matches and a live streak → nothing fires', async () => {
    setRepo({ count: 0, diary: [{ created_at: daysAgo(1) }, { created_at: daysAgo(2) }, { created_at: daysAgo(3) }, { created_at: daysAgo(4) }, { created_at: daysAgo(5) }] });
    const t = await resolveBoostTriggers(sb, USER, NOW);
    expect([...t.values()].map((v) => v.fired)).toEqual([false, false, false]);
  });

  it.each([
    ['fetchProfileProgressFields', 'profiles.profile_progress'],
    ['countUnseenLiveMatches', 'daily_matches'],
    ['fetchRecentDiaryEntryTimes', 'diary_entries'],
  ])('a read error in %s throws EnrichmentDataError naming %s (never a silent "no card")', async (fn, source) => {
    setRepo();
    (m as any)[fn].mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
    await expect(resolveBoostTriggers(sb, USER, NOW)).rejects.toThrow(EnrichmentDataError);
    await expect(resolveBoostTriggers(sb, USER, NOW)).rejects.toThrow(source);
  });
});

describe('eligibleBoostCards — screens, urgency, cooldown', () => {
  const allFired = new Map<BoostCardType, BoostTrigger>([
    ['G1', { card_type: 'G1', fired: true, data: { completion_pct: 40 } }],
    ['G2', { card_type: 'G2', fired: true, data: { unread_match_count: 2 } }],
    ['G3', { card_type: 'G3', fired: true, data: { streak_days: 6 } }],
  ]);

  it('urgency is G3 → G2 → G1', () => {
    expect(BOOST_PRIORITY).toEqual(['G3', 'G2', 'G1']);
    expect(eligibleBoostCards(allFired, [], 'home', NOW)).toEqual([
      { card_type: 'G3', fired: true, data: { streak_days: 6 }, category: 'boost', priority: 1 },
      { card_type: 'G2', fired: true, data: { unread_match_count: 2 }, category: 'boost', priority: 2 },
      { card_type: 'G1', fired: true, data: { completion_pct: 40 }, category: 'boost', priority: 3 },
    ]);
  });

  it.each([
    ['home', ['G3', 'G2', 'G1']],
    ['profile', ['G1']],
    ['longevity-journey', ['G3']],
    ['vitana-index', ['G3']],
    ['calendar', []],
    ['autopilot', ['G3']],
    ['community', []],
    ['make-a-post', []],
    ['talk-to-vitana', []],
    ['messenger', []],
    ['nope', []],
  ])('screen=%s shows %p', (screen, expected) => {
    expect(eligibleBoostCards(allFired, [], screen, NOW).map((c) => c.card_type)).toEqual(expected);
  });

  it('every screen of the catalog is mapped', () => {
    expect(Object.keys(SCREEN_BOOST_CARDS).sort()).toEqual(
      ['autopilot', 'calendar', 'community', 'home', 'longevity-journey', 'make-a-post', 'messenger', 'profile', 'talk-to-vitana', 'vitana-index'],
    );
  });

  it('a trigger that did not fire, or is missing, is not shown', () => {
    const some = new Map<BoostCardType, BoostTrigger>([
      ['G1', { card_type: 'G1', fired: false, data: { completion_pct: 90 } }],
      ['G3', { card_type: 'G3', fired: true, data: { streak_days: 4 } }],
    ]);
    expect(eligibleBoostCards(some, [], 'home', NOW).map((c) => c.card_type)).toEqual(['G3']);
    expect(eligibleBoostCards(new Map(), [], 'home', NOW)).toEqual([]);
  });

  it('a dismissal hides the boost card for 7 days, then it is back', () => {
    const rows = [{ card_type: 'G2', dismissed_at: NOW.toISOString(), cooldown_days: 7 }];
    expect(eligibleBoostCards(allFired, rows, 'home', new Date(NOW.getTime() + 7 * DAY - 1)).map((c) => c.card_type)).toEqual(['G3', 'G1']);
    expect(eligibleBoostCards(allFired, rows, 'home', new Date(NOW.getTime() + 7 * DAY + 1)).map((c) => c.card_type)).toEqual(['G3', 'G2', 'G1']);
  });

  it('G1–G3 are dismissible; G4 and unknown types are not', () => {
    for (const t of ['E1', 'E11', 'G1', 'G2', 'G3']) expect(isDismissibleCardType(t)).toBe(true);
    for (const t of ['G4', 'F1', 'E12', '', 7, null]) expect(isDismissibleCardType(t)).toBe(false);
  });
});
