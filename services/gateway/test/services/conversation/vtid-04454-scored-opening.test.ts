/**
 * VTID-04454 — the relevance score chooses the opening (BRAIN_SCORED_OPENING=true).
 *
 * Part 1 pins the pure selector (scored-opening.ts). Part 2 runs the real
 * decideWakeBriefForSession with decideContinuation mocked, so the provider
 * candidates are fixed and only the choice between them is under test.
 */

import type { AssistantContinuation, AssistantContinuationDecision } from '../../../src/services/assistant-continuation/types';
import {
  applyScoredOpening,
  isScoredOpeningEnabled,
  scoredOpeningTimeoutMs,
  withinBound,
  SCORED_OPENING_TIMEOUT_DEFAULT_MS,
} from '../../../src/services/conversation/scored-opening';
import type { ShadowRanking } from '../../../src/services/conversation/candidate-scoring';

const decideContinuationMock = jest.fn<Promise<AssistantContinuationDecision>, [any]>();
jest.mock('../../../src/services/assistant-continuation/decide-continuation', () => ({
  decideContinuation: (...args: any[]) => decideContinuationMock(...args),
}));
// The weights read goes through the real implementation unless a test makes it hang.
const weightsOverride: { hang: boolean } = { hang: false };
jest.mock('../../../src/services/conversation/candidate-scoring', () => {
  const actual = jest.requireActual('../../../src/services/conversation/candidate-scoring');
  return {
    ...actual,
    loadScoringWeights: (...a: any[]) => (weightsOverride.hang ? new Promise(() => {}) : actual.loadScoringWeights(...a)),
  };
});

import { decideWakeBriefForSession } from '../../../src/services/wake-brief-wiring';
import { createWakeTimelineRecorder } from '../../../src/services/wake-timeline/wake-timeline-recorder';

function cand(id: string, priority: number, route: string | null = null): AssistantContinuation {
  return {
    id,
    kind: 'wake_brief',
    surface: 'orb_wake',
    userFacingLine: `lead ${id}`,
    priority,
    dedupeKey: `${id}:k`,
    privacyMode: 'safe_to_speak',
    evidence: [],
    cta: route ? { type: 'navigate', route } : { type: 'none' },
  } as unknown as AssistantContinuation;
}

function decisionOf(results: Array<{ key: string; c?: AssistantContinuation; status?: 'returned' | 'suppressed' }>, winnerKey: string | null): AssistantContinuationDecision {
  const sourceProviderResults = results.map((r) => ({
    providerKey: r.key,
    status: r.status ?? 'returned',
    latencyMs: 5,
    ...(r.c ? { candidate: r.c } : { reason: 'nothing' }),
  })) as AssistantContinuationDecision['sourceProviderResults'];
  const winner = winnerKey ? results.find((r) => r.key === winnerKey)?.c ?? null : null;
  return {
    decisionId: 'd-1',
    selectedContinuation: winner,
    decisionStartedAt: new Date(0).toISOString(),
    decisionFinishedAt: new Date(0).toISOString(),
    sourceProviderResults,
    telemetryContext: { surface: 'orb_wake' },
  };
}

function ranking(shadow: string | null, live: string | null): ShadowRanking {
  return { weights_version: 1, live_winner: live, shadow_winner: shadow, agree: shadow === live, candidates: [] };
}

describe('VTID-04454 scored-opening: flag and bound', () => {
  it('is on only for exact "true"', () => {
    expect(isScoredOpeningEnabled({ BRAIN_SCORED_OPENING: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'false', 'staging-only']) {
      expect(isScoredOpeningEnabled({ BRAIN_SCORED_OPENING: v })).toBe(false);
    }
  });

  it('clamps the time bound to 100-1500 ms, garbage to the default', () => {
    expect(scoredOpeningTimeoutMs({})).toBe(SCORED_OPENING_TIMEOUT_DEFAULT_MS);
    expect(scoredOpeningTimeoutMs({ BRAIN_SCORED_OPENING_TIMEOUT_MS: 'abc' })).toBe(SCORED_OPENING_TIMEOUT_DEFAULT_MS);
    expect(scoredOpeningTimeoutMs({ BRAIN_SCORED_OPENING_TIMEOUT_MS: '5' })).toBe(100);
    expect(scoredOpeningTimeoutMs({ BRAIN_SCORED_OPENING_TIMEOUT_MS: '99999' })).toBe(1500);
    expect(scoredOpeningTimeoutMs({ BRAIN_SCORED_OPENING_TIMEOUT_MS: '250' })).toBe(250);
  });

  it('withinBound resolves the value, null on timeout, null on rejection', async () => {
    await expect(withinBound(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withinBound(new Promise(() => {}), 20)).resolves.toBeNull();
    await expect(withinBound(Promise.reject(new Error('x')), 50)).resolves.toBeNull();
  });
});

describe('VTID-04454 applyScoredOpening', () => {
  const a = cand('a', 92);
  const b = cand('b', 90);
  const fixed = decisionOf([{ key: 'login_briefing', c: a }, { key: 'unread_messages_announce', c: b }], 'login_briefing');

  it('serves the scored winner when it differs, without mutating the fixed decision', () => {
    const r = applyScoredOpening(fixed, ranking('unread_messages_announce', 'login_briefing'));
    expect(r.mode).toBe('scored');
    expect(r.fixed_winner).toBe('login_briefing');
    expect(r.served_winner).toBe('unread_messages_announce');
    expect(r.decision.selectedContinuation).toBe(b);
    expect(fixed.selectedContinuation).toBe(a);
    expect(r.decision.sourceProviderResults).toBe(fixed.sourceProviderResults);
  });

  it('returns the same decision when both rankings agree', () => {
    const r = applyScoredOpening(fixed, ranking('login_briefing', 'login_briefing'));
    expect(r.mode).toBe('scored');
    expect(r.decision).toBe(fixed);
  });

  it('keeps the fixed decision when a pinned provider returned a candidate', () => {
    const w = cand('w', 95);
    const d = decisionOf([{ key: 'first_time_welcome', c: w }, { key: 'login_briefing', c: a }], 'first_time_welcome');
    const r = applyScoredOpening(d, ranking('login_briefing', 'first_time_welcome'));
    expect(r.mode).toBe('fixed_pinned');
    expect(r.reason).toBe('pinned:first_time_welcome');
    expect(r.decision).toBe(d);
  });

  it('falls back to the fixed decision without a ranking, a candidate, or a returned scored winner', () => {
    expect(applyScoredOpening(fixed, null)).toMatchObject({ mode: 'fixed_fallback', reason: 'ranking_unavailable', served_winner: 'login_briefing' });
    const none = decisionOf([{ key: 'login_briefing', status: 'suppressed' }], null);
    expect(applyScoredOpening(none, ranking(null, null))).toMatchObject({ mode: 'fixed_fallback', reason: 'no_candidate' });
    expect(applyScoredOpening(fixed, ranking('journey_guide', 'login_briefing'))).toMatchObject({ mode: 'fixed_fallback', reason: 'scored_winner_not_returned' });
  });
});

describe('VTID-04454 decideWakeBriefForSession with the scored opening', () => {
  const OLD_ENV = process.env;
  function recorder() {
    return createWakeTimelineRecorder({ now: () => new Date(1_700_000_000_000), getDb: () => null });
  }
  // Close priorities, different screen fit: the user is on /journey, so the
  // candidate that navigates to /journey scores screen 0.2 and the one that
  // navigates elsewhere scores 0.5 — enough to outweigh a 2-point priority gap.
  const high = cand('high', 92, '/journey');
  const lower = cand('lower', 90, '/messages');
  const fixed = decisionOf([{ key: 'journey_guide', c: high }, { key: 'unread_messages_announce', c: lower }], 'journey_guide');
  const baseArgs = {
    sessionId: 's1', tenantId: 't1', userId: 'u1', bucket: 'today' as const, isReconnect: false, lang: 'en', currentRoute: '/journey',
  };

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    weightsOverride.hang = false;
    decideContinuationMock.mockReset();
    decideContinuationMock.mockResolvedValue(fixed);
  });
  afterAll(() => { process.env = OLD_ENV; });

  async function rankedEvent(rec: ReturnType<typeof recorder>) {
    const row = await rec.getTimeline('s1');
    return (row?.events ?? []).find((e: any) => e.name === 'continuation_shadow_ranked') as any;
  }

  it('flag off: the fixed winner is served', async () => {
    delete process.env.BRAIN_SCORED_OPENING;
    const d = await decideWakeBriefForSession({ ...baseArgs } as any, { recorder: recorder() });
    expect(d.selectedContinuation).toBe(high);
  });

  it('flag on: the scored winner is served and the ranking records both winners', async () => {
    process.env.BRAIN_SCORED_OPENING = 'true';
    const rec = recorder();
    const d = await decideWakeBriefForSession({ ...baseArgs } as any, { recorder: rec });
    expect(d.selectedContinuation).toBe(lower);
    const ev = await rankedEvent(rec);
    expect(ev.metadata).toMatchObject({
      ranking_mode: 'scored',
      live_winner: 'journey_guide',
      shadow_winner: 'unread_messages_announce',
      served_winner: 'unread_messages_announce',
      agree: false,
    });
  });

  it('flag on: an explicit selection keeps the fixed decision and is not scored', async () => {
    process.env.BRAIN_SCORED_OPENING = 'true';
    const rec = recorder();
    const d = await decideWakeBriefForSession({ ...baseArgs, guidedTopicId: 'T001' } as any, { recorder: rec });
    expect(d.selectedContinuation).toBe(high);
    expect(await rankedEvent(rec)).toBeUndefined();
  });

  it('flag on: a pinned provider keeps the fixed decision', async () => {
    process.env.BRAIN_SCORED_OPENING = 'true';
    const welcome = cand('welcome', 95, '/journey');
    decideContinuationMock.mockResolvedValue(
      decisionOf([{ key: 'first_time_welcome', c: welcome }, { key: 'unread_messages_announce', c: lower }], 'first_time_welcome'),
    );
    const rec = recorder();
    const d = await decideWakeBriefForSession({ ...baseArgs } as any, { recorder: rec });
    expect(d.selectedContinuation).toBe(welcome);
    expect((await rankedEvent(rec)).metadata).toMatchObject({ ranking_mode: 'fixed_pinned', served_winner: 'first_time_welcome' });
  });

  it('flag on: when scoring cannot finish in time, the fixed winner is served', async () => {
    process.env.BRAIN_SCORED_OPENING = 'true';
    process.env.BRAIN_SCORED_OPENING_TIMEOUT_MS = '100';
    weightsOverride.hang = true;
    const rec = recorder();
    const d = await decideWakeBriefForSession({ ...baseArgs } as any, { recorder: rec });
    expect(d.selectedContinuation).toBe(high);
    expect((await rankedEvent(rec)).metadata).toMatchObject({
      ranking_mode: 'fixed_fallback', ranking_reason: 'scoring_timeout_or_error', served_winner: 'journey_guide',
    });
  });
});

describe('VTID-04454 deploy pins', () => {
  const { readFileSync } = jest.requireActual('fs');
  const { join } = jest.requireActual('path');
  const wf = (f: string) => readFileSync(join(__dirname, '../../../../../.github/workflows', f), 'utf8');

  it('is pinned on staging (strip-then-add) and not on production', () => {
    const stage = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(stage).toMatch(/"BRAIN_PERSONAL_WEIGHTS","BRAIN_SCORED_OPENING",/);
    expect(stage).toMatch(/\{name:"BRAIN_SCORED_OPENING", value:"true"\}/);
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toMatch(/BRAIN_SCORED_OPENING/);
  });
});

describe('VTID-04454 comparison summary', () => {
  it('counts the openings the score chose and the ones it changed', () => {
    const { summarizeShadowComparisons } = jest.requireActual('../../../src/services/conversation/shadow-comparison');
    const ev = (m: Record<string, unknown>) => ({ session_id: 's', events: [{ name: 'continuation_shadow_ranked', metadata: m }] });
    const s = summarizeShadowComparisons([
      ev({ live_winner: 'a', shadow_winner: 'b', served_winner: 'b', ranking_mode: 'scored' }),
      ev({ live_winner: 'a', shadow_winner: 'a', served_winner: 'a', ranking_mode: 'scored' }),
      ev({ live_winner: 'a', shadow_winner: 'b', served_winner: 'a', ranking_mode: 'fixed_pinned' }),
      ev({ live_winner: 'a', shadow_winner: 'b' }),
    ], 7);
    expect(s.sessions_ranked).toBe(4);
    expect(s.scored_openings).toBe(2);
    expect(s.scored_changed_opening).toBe(1);
  });
});
