/**
 * BOOTSTRAP-MATCHMAKING-INDEX — match-journey derivation + flag tests.
 *
 * Covers:
 *   1. Pure derivation (deriveMatchJourneyContext) — stage mapping from
 *      latest match state, Index-tier anchoring, silence warning.
 *   2. Provider flag behaviour — FEATURE_MATCH_JOURNEY_CONTEXT OFF (the
 *      default) returns the historical { journeyStage: 'none' } stub.
 */

import {
  deriveMatchJourneyContext,
  normaliseMatchState,
} from '../../../src/orb/context/providers/match-journey-derivation';
import {
  compileMatchJourneyContext,
  type MatchJourneyContextProviderInput,
} from '../../../src/orb/context/providers/match-journey-context-provider';
import type { MatchJourneyFetcher } from '../../../src/orb/context/providers/match-journey-fetcher';

const FIXED_NOW = Date.UTC(2026, 4, 11, 18, 30, 0);

describe('BOOTSTRAP-MATCHMAKING-INDEX — deriveMatchJourneyContext (pure)', () => {
  it('no match rows → browsing, no pending decision', () => {
    const ctx = deriveMatchJourneyContext({
      latestMatch: null,
      indexScoreTotal: 350, // momentum tier — no low-momentum warning
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('browsing');
    expect(ctx.pendingUserDecision).toBeUndefined();
    expect(ctx.recommendedNextMove).toBeUndefined();
    expect(ctx.warnings).toBeUndefined();
  });

  it('latest state suggested → pre_interest with show_interest decision', () => {
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm1',
        intentId: 'i1',
        state: 'suggested',
        stateChangedAt: '2026-05-11T18:00:00Z',
      },
      indexScoreTotal: 500, // resonance — no low-momentum warning
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('pre_interest');
    expect(ctx.matchId).toBe('m1');
    expect(ctx.intentId).toBe('i1');
    expect(ctx.pendingUserDecision).toBe('show_interest');
    expect(ctx.recommendedNextMove).toBe('ask_should_i_show_interest');
    expect(ctx.lastMatchEventAt).toBe('2026-05-11T18:00:00Z');
    expect(ctx.silenceDuration).toBe(FIXED_NOW - Date.parse('2026-05-11T18:00:00Z'));
  });

  it('latest state accepted → mutual_match with send_opener', () => {
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm2',
        intentId: 'i2',
        state: 'accepted',
        stateChangedAt: '2026-05-11T17:00:00Z',
      },
      indexScoreTotal: 600,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('mutual_match');
    expect(ctx.pendingUserDecision).toBe('send_opener');
    expect(ctx.recommendedNextMove).toBe('stage_opener');
  });

  it('latest state dismissed → browsing (back to pool)', () => {
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm3',
        intentId: 'i3',
        state: 'dismissed',
        stateChangedAt: '2026-05-10T10:00:00Z',
      },
      indexScoreTotal: 700,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('browsing');
    expect(ctx.pendingUserDecision).toBeUndefined();
  });

  // ---- Real intent_matches.state values (the bug this PR fixes) ----

  it('real state "new" → pre_interest with show_interest (not browsing)', () => {
    expect(normaliseMatchState('new')).toBe('new');
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm-new',
        intentId: 'i-new',
        state: 'new',
        stateChangedAt: '2026-05-11T18:00:00Z',
      },
      indexScoreTotal: 500,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('pre_interest');
    expect(ctx.pendingUserDecision).toBe('show_interest');
    expect(ctx.recommendedNextMove).toBe('ask_should_i_show_interest');
  });

  it('real state "responded_by_b" → pre_interest with reply_to_match (other side replied, our turn)', () => {
    expect(normaliseMatchState('responded_by_b')).toBe('responded_by_b');
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm-rbb',
        intentId: 'i-rbb',
        state: 'responded_by_b',
        stateChangedAt: '2026-05-11T18:00:00Z',
      },
      indexScoreTotal: 500,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('pre_interest');
    expect(ctx.pendingUserDecision).toBe('reply_to_match');
    expect(ctx.recommendedNextMove).toBe('ask_should_i_show_interest');
  });

  it('real state "responded_by_a" → interest_sent, no pending decision (waiting on the other side)', () => {
    expect(normaliseMatchState('responded_by_a')).toBe('responded_by_a');
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm-rba',
        intentId: 'i-rba',
        state: 'responded_by_a',
        stateChangedAt: '2026-05-11T18:00:00Z',
      },
      indexScoreTotal: 500,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('interest_sent');
    expect(ctx.pendingUserDecision).toBeUndefined();
    expect(ctx.recommendedNextMove).toBeUndefined();
  });

  it('real state "mutual_interest" → mutual_match with send_opener', () => {
    expect(normaliseMatchState('mutual_interest')).toBe('mutual_interest');
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm-mi',
        intentId: 'i-mi',
        state: 'mutual_interest',
        stateChangedAt: '2026-05-11T17:00:00Z',
      },
      indexScoreTotal: 600,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('mutual_match');
    expect(ctx.pendingUserDecision).toBe('send_opener');
    expect(ctx.recommendedNextMove).toBe('stage_opener');
  });

  it('real state "declined" → browsing (back to pool)', () => {
    expect(normaliseMatchState('declined')).toBe('declined');
    const ctx = deriveMatchJourneyContext({
      latestMatch: {
        matchId: 'm-dec',
        intentId: 'i-dec',
        state: 'declined',
        stateChangedAt: '2026-05-10T10:00:00Z',
      },
      indexScoreTotal: 700,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('browsing');
    expect(ctx.pendingUserDecision).toBeUndefined();
  });

  it('real "mutual_interest" with >3d silence flips next move to nudge_reply + match_silence warning', () => {
    const fourDaysAgo = new Date(FIXED_NOW - 4 * 24 * 60 * 60 * 1000).toISOString();
    const ctx = deriveMatchJourneyContext({
      latestMatch: { matchId: 'm', intentId: 'i', state: 'mutual_interest', stateChangedAt: fourDaysAgo },
      indexScoreTotal: 600,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('mutual_match');
    expect(ctx.recommendedNextMove).toBe('nudge_reply');
    expect(ctx.warnings).toContain('match_silence');
  });

  it('real states never collapse to "browsing" when actionable (regression guard)', () => {
    const actionable: Array<'new' | 'responded_by_b' | 'responded_by_a' | 'mutual_interest'> = [
      'new',
      'responded_by_b',
      'responded_by_a',
      'mutual_interest',
    ];
    for (const s of actionable) {
      const ctx = deriveMatchJourneyContext({
        latestMatch: { matchId: 'm', intentId: 'i', state: s, stateChangedAt: null },
        indexScoreTotal: 400,
        nowMs: FIXED_NOW,
      });
      expect(ctx.journeyStage).not.toBe('browsing');
      expect(ctx.journeyStage).not.toBe('none');
    }
  });

  it('low Index tier (foundation) surfaces a vitana_index_tier warning', () => {
    const ctx = deriveMatchJourneyContext({
      latestMatch: { matchId: 'm', intentId: 'i', state: 'suggested', stateChangedAt: null },
      indexScoreTotal: 50, // foundation
      nowMs: FIXED_NOW,
    });
    expect(ctx.warnings).toContain('vitana_index_tier:foundation');
  });

  it('null Index score → unknown tier → low-momentum warning', () => {
    const ctx = deriveMatchJourneyContext({
      latestMatch: null,
      indexScoreTotal: null,
      nowMs: FIXED_NOW,
    });
    expect(ctx.warnings).toContain('vitana_index_tier:unknown');
  });

  it('mutual_match with >3d silence flips next move to nudge_reply + match_silence warning', () => {
    const fourDaysAgo = new Date(FIXED_NOW - 4 * 24 * 60 * 60 * 1000).toISOString();
    const ctx = deriveMatchJourneyContext({
      latestMatch: { matchId: 'm', intentId: 'i', state: 'accepted', stateChangedAt: fourDaysAgo },
      indexScoreTotal: 600, // resonance — only the silence warning expected
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('mutual_match');
    expect(ctx.recommendedNextMove).toBe('nudge_reply');
    expect(ctx.warnings).toContain('match_silence');
  });

  it('unknown raw state collapses to browsing', () => {
    expect(normaliseMatchState('weird')).toBeNull();
    const ctx = deriveMatchJourneyContext({
      latestMatch: { matchId: 'm', intentId: 'i', state: normaliseMatchState('weird'), stateChangedAt: null },
      indexScoreTotal: 500,
      nowMs: FIXED_NOW,
    });
    expect(ctx.journeyStage).toBe('browsing');
  });

  it('never emits the "none" sentinel — that is reserved for the flag-OFF stub', () => {
    const states: Array<
      | 'new'
      | 'responded_by_a'
      | 'responded_by_b'
      | 'mutual_interest'
      | 'declined'
      | 'suggested'
      | 'accepted'
      | 'dismissed'
    > = ['new', 'responded_by_a', 'responded_by_b', 'mutual_interest', 'declined', 'suggested', 'accepted', 'dismissed'];
    for (const s of states) {
      const ctx = deriveMatchJourneyContext({
        latestMatch: { matchId: 'm', intentId: 'i', state: s, stateChangedAt: null },
        indexScoreTotal: 400,
        nowMs: FIXED_NOW,
      });
      expect(ctx.journeyStage).not.toBe('none');
    }
  });
});

describe('BOOTSTRAP-MATCHMAKING-INDEX — compileMatchJourneyContext flag gate', () => {
  const ORIGINAL = process.env.FEATURE_MATCH_JOURNEY_CONTEXT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FEATURE_MATCH_JOURNEY_CONTEXT;
    else process.env.FEATURE_MATCH_JOURNEY_CONTEXT = ORIGINAL;
  });

  const baseInput: MatchJourneyContextProviderInput = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    envelope: null,
    nowMs: FIXED_NOW,
  };

  // A fetcher that, if ever called, would yield a non-'none' stage. Lets
  // us prove the flag-OFF path never touches the fetcher.
  const liveFetcher: MatchJourneyFetcher = {
    fetch: jest.fn().mockResolvedValue({
      latestMatch: { matchId: 'm', intentId: 'i', state: 'new', stateChangedAt: null },
      indexScoreTotal: 400,
      sourceHealth: {
        profiles: { ok: true },
        intent_matches: { ok: true },
        vitana_index_scores: { ok: true },
      },
    }),
  };

  it('flag OFF (unset) → returns the { journeyStage: "none" } stub and does not call the fetcher', async () => {
    delete process.env.FEATURE_MATCH_JOURNEY_CONTEXT;
    (liveFetcher.fetch as jest.Mock).mockClear();
    const ctx = await compileMatchJourneyContext({ ...baseInput, fetcher: liveFetcher });
    expect(ctx).toEqual({ journeyStage: 'none' });
    expect(liveFetcher.fetch).not.toHaveBeenCalled();
  });

  it('flag set to non-"true" → still the stub', async () => {
    process.env.FEATURE_MATCH_JOURNEY_CONTEXT = '1';
    const ctx = await compileMatchJourneyContext({ ...baseInput, fetcher: liveFetcher });
    expect(ctx.journeyStage).toBe('none');
  });

  it('flag ON → derives real stage from fetched state', async () => {
    process.env.FEATURE_MATCH_JOURNEY_CONTEXT = 'true';
    const ctx = await compileMatchJourneyContext({ ...baseInput, fetcher: liveFetcher });
    expect(ctx.journeyStage).toBe('pre_interest');
    expect(ctx.pendingUserDecision).toBe('show_interest');
  });

  it('flag ON but missing userId → stub (nothing to anchor on)', async () => {
    process.env.FEATURE_MATCH_JOURNEY_CONTEXT = 'true';
    const ctx = await compileMatchJourneyContext({ ...baseInput, userId: null, fetcher: liveFetcher });
    expect(ctx.journeyStage).toBe('none');
  });

  it('flag ON but fetcher throws → fail-safe stub', async () => {
    process.env.FEATURE_MATCH_JOURNEY_CONTEXT = 'true';
    const throwing: MatchJourneyFetcher = { fetch: jest.fn().mockRejectedValue(new Error('boom')) };
    const ctx = await compileMatchJourneyContext({ ...baseInput, fetcher: throwing });
    expect(ctx.journeyStage).toBe('none');
  });
});
