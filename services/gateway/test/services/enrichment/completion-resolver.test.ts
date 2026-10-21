/**
 * VTID-05143 (builds VTID-05085 Phase 1) — completion resolver: every E-check
 * true and false through a mocked repository, the reads run for the caller
 * only, and any read error throws (the route turns it into 500, never an
 * empty list).
 */

jest.mock('../../../src/services/enrichment/completion-resolver-repository', () => ({
  fetchProfileEnrichmentFields: jest.fn(),
  fetchAnyProfilePost: jest.fn(),
  fetchActiveSocialConnections: jest.fn(),
  fetchEnabledCalendarApp: jest.fn(),
  fetchAnyContact: jest.fn(),
  fetchActiveDeviceToken: jest.fn(),
  fetchEnrichmentCardStates: jest.fn(),
  fetchProfileProgressFields: jest.fn(),
  countUnseenLiveMatches: jest.fn(),
  fetchRecentDiaryEntryTimes: jest.fn(),
  DIARY_STREAK_LOOKBACK_DAYS: 120,
}));

import * as repo from '../../../src/services/enrichment/completion-resolver-repository';
import {
  computeCompletions,
  EnrichmentDataError,
  loadEnrichmentCardState,
  resolveCompletions,
  type EnrichmentFacts,
} from '../../../src/services/enrichment/completion-resolver';

const m = repo as jest.Mocked<typeof repo>;
const USER = 'user-a';
const sb = {} as any;

const ok = (data: unknown) => Promise.resolve({ data, error: null } as any);

function setRepo(over: Partial<Record<keyof typeof repo, unknown>> = {}) {
  const defaults: Record<string, unknown> = {
    fetchProfileEnrichmentFields: { avatar_url: null, bio: null, location: null, cover_url: null, interests: [] },
    fetchAnyProfilePost: [],
    fetchActiveSocialConnections: [],
    fetchEnabledCalendarApp: [],
    fetchAnyContact: [],
    fetchActiveDeviceToken: [],
    fetchEnrichmentCardStates: [],
    fetchProfileProgressFields: null,
    countUnseenLiveMatches: null,
    fetchRecentDiaryEntryTimes: [],
  };
  for (const [k, v] of Object.entries({ ...defaults, ...over })) {
    (m as any)[k].mockImplementation(() => ok(v));
  }
}

const emptyFacts = (): EnrichmentFacts => ({
  profile: null,
  hasPost: false,
  activeSocialProviders: [],
  hasEnabledCalendar: false,
  hasContact: false,
  hasActiveDeviceToken: false,
});

beforeEach(() => jest.clearAllMocks());

describe('computeCompletions — each E-check', () => {
  it('a member with nothing done has E1–E11 all false', () => {
    const c = computeCompletions(emptyFacts());
    expect([...c.keys()]).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11']);
    expect([...c.values()].every((v) => v === false)).toBe(true);
  });

  it('E1 avatar: set → true, empty string → false', () => {
    expect(computeCompletions({ ...emptyFacts(), profile: { avatar_url: 'https://x/a.png' } }).get('E1')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), profile: { avatar_url: '  ' } }).get('E1')).toBe(false);
  });

  it('E2 bio: trimmed length must be > 50', () => {
    const fifty = 'a'.repeat(50);
    expect(computeCompletions({ ...emptyFacts(), profile: { bio: fifty + 'b' } }).get('E2')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), profile: { bio: fifty } }).get('E2')).toBe(false);
    expect(computeCompletions({ ...emptyFacts(), profile: { bio: `   ${fifty}    ` } }).get('E2')).toBe(false);
  });

  it('E3 post', () => {
    expect(computeCompletions({ ...emptyFacts(), hasPost: true }).get('E3')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), hasPost: false }).get('E3')).toBe(false);
  });

  it('E4 interests: non-empty slugs → true; [] or blanks → false', () => {
    expect(computeCompletions({ ...emptyFacts(), profile: { interests: ['fitness'] } }).get('E4')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), profile: { interests: [] } }).get('E4')).toBe(false);
    expect(computeCompletions({ ...emptyFacts(), profile: { interests: [''] } }).get('E4')).toBe(false);
    expect(computeCompletions({ ...emptyFacts(), profile: { interests: null } }).get('E4')).toBe(false);
  });

  it('E5 location', () => {
    expect(computeCompletions({ ...emptyFacts(), profile: { location: 'Berlin' } }).get('E5')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), profile: { location: '' } }).get('E5')).toBe(false);
  });

  it('E6/E7 instagram and facebook independently', () => {
    const ig = computeCompletions({ ...emptyFacts(), activeSocialProviders: ['instagram'] });
    expect(ig.get('E6')).toBe(true);
    expect(ig.get('E7')).toBe(false);
    const fb = computeCompletions({ ...emptyFacts(), activeSocialProviders: ['facebook'] });
    expect(fb.get('E6')).toBe(false);
    expect(fb.get('E7')).toBe(true);
  });

  it('E8 calendar, E9 contacts, E10 device token', () => {
    const c = computeCompletions({ ...emptyFacts(), hasEnabledCalendar: true, hasContact: true, hasActiveDeviceToken: true });
    expect([c.get('E8'), c.get('E9'), c.get('E10')]).toEqual([true, true, true]);
    const n = computeCompletions(emptyFacts());
    expect([n.get('E8'), n.get('E9'), n.get('E10')]).toEqual([false, false, false]);
  });

  it('E11 cover', () => {
    expect(computeCompletions({ ...emptyFacts(), profile: { cover_url: 'https://x/c.png' } }).get('E11')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), profile: { cover_url: null } }).get('E11')).toBe(false);
    // The cover library (CoverLibraryDrawer) writes universal_intent_cover_url — that counts too.
    expect(computeCompletions({ ...emptyFacts(), profile: { cover_url: null, universal_intent_cover_url: 'https://x/u.png' } }).get('E11')).toBe(true);
    expect(computeCompletions({ ...emptyFacts(), profile: { cover_url: '  ', universal_intent_cover_url: '' } }).get('E11')).toBe(false);
  });
});

describe('resolveCompletions — through the repository', () => {
  it('maps every source to its card and reads only the caller', async () => {
    setRepo({
      fetchProfileEnrichmentFields: {
        avatar_url: 'a', bio: 'x'.repeat(60), location: 'Wien', cover_url: 'c', interests: ['nutrition'],
      },
      fetchAnyProfilePost: [{ id: 'p1' }],
      fetchActiveSocialConnections: [{ provider: 'instagram' }, { provider: 'facebook' }],
      fetchEnabledCalendarApp: [{ app_id: 'google-calendar' }],
      fetchAnyContact: [{ id: 'c1' }],
      fetchActiveDeviceToken: [{ id: 't1' }],
    });
    const c = await resolveCompletions(sb, USER);
    expect([...c.values()].every((v) => v === true)).toBe(true);
    const reads = Object.values(m).filter((fn) => jest.isMockFunction(fn));
    expect(reads).toHaveLength(10);
    for (const fn of reads) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect((fn as jest.Mock).mock.calls[0][1]).toBe(USER);
    }
  });

  it('a member with no profile row and no data has every card incomplete', async () => {
    setRepo({ fetchProfileEnrichmentFields: null, fetchActiveSocialConnections: null });
    const c = await resolveCompletions(sb, USER);
    expect([...c.values()].every((v) => v === false)).toBe(true);
  });

  it('loadEnrichmentCardState returns the dismissal rows and a computed trigger for each of G1–G3', async () => {
    const rows = [{ card_type: 'E1', dismissed_at: '2026-10-01T00:00:00Z', cooldown_days: 7 }];
    setRepo({ fetchEnrichmentCardStates: rows });
    const state = await loadEnrichmentCardState(sb, USER);
    expect(state.dismissals).toEqual(rows);
    expect([...state.boosts.keys()]).toEqual(['G1', 'G2', 'G3']);
  });

  it.each([
    ['fetchProfileEnrichmentFields', 'profiles'],
    ['fetchAnyProfilePost', 'profile_posts'],
    ['fetchActiveSocialConnections', 'social_connections'],
    ['fetchEnabledCalendarApp', 'connected_app_settings'],
    ['fetchAnyContact', 'contacts'],
    ['fetchActiveDeviceToken', 'user_device_tokens'],
    ['fetchEnrichmentCardStates', 'user_enrichment_cards'],
    ['fetchProfileProgressFields', 'profiles.profile_progress'],
    ['countUnseenLiveMatches', 'daily_matches'],
    ['fetchRecentDiaryEntryTimes', 'diary_entries'],
  ])('a read error in %s throws EnrichmentDataError naming %s', async (fn, source) => {
    setRepo();
    (m as any)[fn].mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
    await expect(loadEnrichmentCardState(sb, USER)).rejects.toThrow(EnrichmentDataError);
    await expect(loadEnrichmentCardState(sb, USER)).rejects.toThrow(source);
  });
});
