/**
 * VTID-04422 (Plan v1 WS-2.2) — relevance scoring of continuation candidates,
 * shadow mode.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_SCORING_WEIGHTS,
  __resetScoringWeightsCacheForTest,
  candidateFeatures,
  loadScoringWeights,
  localHourIn,
  normalizeWeightsRow,
  partOfDayForHour,
  rankInShadow,
  scoreCandidate,
  type ScorableCandidate,
  type ScoringContext,
} from '../../../src/services/conversation/candidate-scoring';
import { summarizeShadowComparisons, readShadowComparison } from '../../../src/services/conversation/shadow-comparison';
import { toScorableCandidates } from '../../../src/services/wake-brief-wiring';
import { isWakeTimelineEventName } from '../../../src/services/wake-timeline/timeline-events';

const W = DEFAULT_SCORING_WEIGHTS;
const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  recentlyServed: [],
  recentWindow: 5,
  currentRoute: null,
  partOfDay: null,
  outcomes: {},
  ...over,
});
const cand = (over: Partial<ScorableCandidate> = {}): ScorableCandidate => ({
  provider: 'journey_guide',
  kind: 'next_step',
  dedupeKey: 'journey_guide:diary',
  priority: 80,
  ctaRoute: null,
  ...over,
});

describe('features', () => {
  it('urgency is the provider priority; neutral features are 0.5; profile is not invented', () => {
    const f = candidateFeatures(cand(), ctx(), W);
    expect(f).toEqual({ urgency: 0.8, freshness: 1, screen: 0.5, time_of_day: 0.5, outcome: 0.5, profile: null });
  });

  it('freshness rises from 0 for the opener served last', () => {
    const recent = ['journey_guide:diary', 'x', 'y', 'z', 'w'];
    expect(candidateFeatures(cand(), ctx({ recentlyServed: recent }), W).freshness).toBe(0);
    expect(candidateFeatures(cand(), ctx({ recentlyServed: ['a', 'b', 'journey_guide:diary'] }), W).freshness).toBeCloseTo(0.4);
  });

  it('screen: navigating to where the user is scores low, within the same section high', () => {
    expect(candidateFeatures(cand({ ctaRoute: '/diary' }), ctx({ currentRoute: '/diary/' }), W).screen).toBe(0.2);
    expect(candidateFeatures(cand({ ctaRoute: '/health/sleep' }), ctx({ currentRoute: '/health/index' }), W).screen).toBe(0.8);
    expect(candidateFeatures(cand({ ctaRoute: '/wallet' }), ctx({ currentRoute: '/diary' }), W).screen).toBe(0.5);
  });

  it('time of day comes from the weights table; outcomes are smoothed per provider', () => {
    const w = { ...W, time_of_day_fit: { next_step: { morning: 0.9 } } };
    expect(candidateFeatures(cand(), ctx({ partOfDay: 'morning' }), w).time_of_day).toBe(0.9);
    expect(candidateFeatures(cand(), ctx({ partOfDay: 'evening' }), w).time_of_day).toBe(0.5);
    expect(candidateFeatures(cand(), ctx({ outcomes: { journey_guide: { accepted: 3, settled: 4 } } }), W).outcome).toBeCloseTo(4 / 6);
  });
});

describe('score and shadow ranking', () => {
  it('a null feature is left out of both sums', () => {
    const s = scoreCandidate(cand(), ctx(), W);
    const expected = (0.4 * 0.8 + 0.25 * 1 + 0.1 * 0.5 + 0.05 * 0.5 + 0.2 * 0.5) / (0.4 + 0.25 + 0.1 + 0.05 + 0.2);
    expect(s.score).toBeCloseTo(expected, 3);
    expect(s.features.profile).toBeNull();
  });

  it('agrees with the live winner when nothing but priority differs', () => {
    const r = rankInShadow(
      [cand({ provider: 'login_briefing', priority: 90, dedupeKey: 'lb' }), cand({ provider: 'journey_guide', priority: 60 })],
      'login_briefing', ctx(), W,
    );
    expect(r.agree).toBe(true);
    expect(r.shadow_winner).toBe('login_briefing');
  });

  it('a stale, often-declined winner loses to a fresh, accepted one', () => {
    const r = rankInShadow(
      [cand({ provider: 'login_briefing', priority: 90, dedupeKey: 'lb' }), cand({ provider: 'journey_guide', priority: 70 })],
      'login_briefing',
      ctx({ recentlyServed: ['lb'], outcomes: { login_briefing: { accepted: 0, settled: 10 }, journey_guide: { accepted: 8, settled: 10 } } }),
      W,
    );
    expect(r.shadow_winner).toBe('journey_guide');
    expect(r.agree).toBe(false);
    expect(r.weights_version).toBe(0);
  });

  it('equal scores keep the live order (no manufactured disagreement)', () => {
    const r = rankInShadow([cand({ provider: 'a' }), cand({ provider: 'b' })], 'a', ctx(), W);
    expect(r.shadow_winner).toBe('a');
  });
});

describe('time helpers', () => {
  it('maps hours to parts of day', () => {
    expect([6, 13, 19, 23, 2].map(partOfDayForHour)).toEqual(['morning', 'afternoon', 'evening', 'night', 'night']);
    expect(partOfDayForHour(null)).toBeNull();
  });
  it('reads the local hour from a timezone, null when unknown', () => {
    expect(localHourIn('UTC', new Date('2026-09-23T07:30:00Z'))).toBe(7);
    expect(localHourIn('Europe/Berlin', new Date('2026-09-23T07:30:00Z'))).toBe(9);
    expect(localHourIn('Not/AZone')).toBeNull();
    expect(localHourIn(null)).toBeNull();
  });
});

describe('weights', () => {
  beforeEach(() => __resetScoringWeightsCacheForTest());

  it('normalizes a DB row and ignores negative or junk weights', () => {
    const w = normalizeWeightsRow({ version: 3, weights: { urgency: 1, outcome: -2, screen: 'x' }, time_of_day_fit: { check_in: { morning: 1 } } });
    expect(w.version).toBe(3);
    expect(w.weights.urgency).toBe(1);
    expect(w.weights.outcome).toBe(W.weights.outcome);
    expect(w.weights.screen).toBe(W.weights.screen);
    expect(w.time_of_day_fit.check_in.morning).toBe(1);
  });

  it('reads the highest active version and caches it; falls back to defaults on error', async () => {
    const calls: string[] = [];
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'order', 'limit']) b[m] = (...a: unknown[]) => { calls.push(`${m}:${JSON.stringify(a)}`); return b; };
    b.maybeSingle = () => Promise.resolve({ data: { version: 2, weights: { urgency: 0.5 } }, error: null });
    const w1 = await loadScoringWeights(b, 1000);
    const w2 = await loadScoringWeights(b, 2000);
    expect(w1.version).toBe(2);
    expect(w2).toBe(w1);
    expect(calls).toContain('eq:["active",true]');
    expect(calls).toContain('order:["version",{"ascending":false}]');

    __resetScoringWeightsCacheForTest();
    const bad: any = { from: () => { throw new Error('down'); } };
    expect(await loadScoringWeights(bad)).toBe(DEFAULT_SCORING_WEIGHTS);
    expect(await loadScoringWeights(null)).toBe(DEFAULT_SCORING_WEIGHTS);
  });
});

describe('wiring', () => {
  it('turns returned provider results into scorable candidates', () => {
    const decision: any = {
      selectedContinuation: null,
      sourceProviderResults: [
        { providerKey: 'journey_guide', status: 'returned', candidate: { id: '1', kind: 'next_step', priority: 80, dedupeKey: 'jg', cta: { type: 'navigate', route: '/diary' } } },
        { providerKey: 'x', status: 'suppressed' },
        { providerKey: 'y', status: 'returned', candidate: { id: '2', kind: 'none_with_reason', priority: 0, dedupeKey: 'n', cta: { type: 'noop' } } },
      ],
    };
    expect(toScorableCandidates(decision)).toEqual([
      { provider: 'journey_guide', kind: 'next_step', dedupeKey: 'jg', priority: 80, ctaRoute: '/diary' },
    ]);
  });

  it('the shadow event is a registered timeline event', () => {
    expect(isWakeTimelineEventName('continuation_shadow_ranked')).toBe(true);
  });

  const root = join(__dirname, '../../../../..');
  const wiring = readFileSync(join(root, 'services/gateway/src/services/wake-brief-wiring.ts'), 'utf8');
  it('shadow scoring runs after the decision, off the path, and skips explicit selections', () => {
    // VTID-04454: when BRAIN_SCORED_OPENING chose the opening, that ranking is
    // already recorded; the after-the-fact shadow pass runs only otherwise.
    expect(wiring).toMatch(/if \(!isExplicitSelection && !scoredOpening\) \{\s*void recordShadowRanking\(recorder, args, decision, storedRecentOpeners\)/);
    expect(wiring).toMatch(/if \(!isExplicitSelection && isScoredOpeningEnabled\(\)\) \{/);
    const at = wiring.indexOf('void recordShadowRanking(');
    expect(wiring.indexOf('return decision;', at)).toBeGreaterThan(at);
  });

  it('wake-brief offers now record the provider key that produced them', () => {
    expect(wiring).toMatch(/provider: winningProviderKey\(decision\) \?\? /);
  });
});

describe('shadow comparison', () => {
  const ev = (live: string | null, shadow: string | null, v = 1) => ({
    name: 'continuation_shadow_ranked',
    metadata: { live_winner: live, shadow_winner: shadow, agree: live === shadow, weights_version: v, candidates: [{ provider: shadow, score: 0.7, priority: 70 }] },
  });

  it('counts agreement, disagreement pairs and wins per provider', () => {
    const s = summarizeShadowComparisons([
      { session_id: 's1', events: [ev('login_briefing', 'login_briefing')] },
      { session_id: 's2', events: [ev('login_briefing', 'journey_guide')] },
      { session_id: 's3', events: [ev('login_briefing', 'journey_guide')] },
      { session_id: 's4', events: [{ name: 'wake_brief_selected', metadata: {} }] },
    ], 7);
    expect(s.sessions_read).toBe(4);
    expect(s.sessions_ranked).toBe(3);
    expect(s.agree).toBe(1);
    expect(s.agree_rate).toBeCloseTo(0.333, 3);
    expect(s.disagreements).toEqual([{ live: 'login_briefing', shadow: 'journey_guide', count: 2 }]);
    expect(s.wins.find((w) => w.provider === 'journey_guide')).toEqual({ provider: 'journey_guide', live: 0, shadow: 2 });
    expect(s.recent_disagreements).toHaveLength(2);
    expect(s.weights_versions).toEqual({ '1': 3 });
  });

  it('reads a bounded, indexed window', async () => {
    const calls: string[] = [];
    const b: any = {};
    for (const m of ['from', 'select', 'gte', 'order', 'limit']) b[m] = (...a: unknown[]) => { calls.push(`${m}:${JSON.stringify(a)}`); return b; };
    b.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
    const r = await readShadowComparison(b, { days: 400, nowMs: Date.parse('2026-09-23T00:00:00Z') });
    expect(r.summary.days).toBe(30);
    expect(calls[0]).toBe('from:["orb_wake_timelines"]');
    expect(calls.some((c) => c.startsWith('gte:["started_at"'))).toBe(true);
    expect(calls).toContain('limit:[1000]');
  });
});

describe('source contracts', () => {
  const root = join(__dirname, '../../../../..');
  const migration = readFileSync(join(root, 'supabase/migrations/20260923200000_vtid_04422_conversation_scoring_weights.sql'), 'utf8');
  const hub = readFileSync(join(root, 'services/gateway/src/routes/conversation-hub.ts'), 'utf8');
  const app = readFileSync(join(root, 'services/gateway/src/frontend/command-hub/app.js'), 'utf8');

  it('the weights table is service-role only and seeds version 1 matching the defaults', () => {
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/REVOKE ALL ON public\.conversation_scoring_weights FROM anon, authenticated/);
    const seeded = JSON.parse(migration.match(/'(\{"urgency"[^']+)'::jsonb/)![1]);
    expect(seeded).toEqual(DEFAULT_SCORING_WEIGHTS.weights);
  });

  it('the comparison endpoint is admin-only and the Monitor shows it', () => {
    expect(hub).toMatch(/router\.get\('\/admin\/conversation\/shadow-ranking', \.\.\.adminOnly,/);
    expect(app).toMatch(/_convRenderShadowRanking\(shadow, 7\);/);
    expect(app).toMatch(/'\/admin\/conversation\/shadow-ranking\?days=' \+ days/);
  });
});

import { summarizeWakeTimeline } from '../../../src/services/conversation/session-brain-inspector';

describe('inspector shows the shadow ranking', () => {
  it('summarizes continuation_shadow_ranked into candidates.shadow', () => {
    const c = summarizeWakeTimeline([
      { name: 'continuation_shadow_ranked', metadata: { weights_version: 1, live_winner: 'a', shadow_winner: 'b', agree: false, candidates: [{ provider: 'b', score: 0.71, priority: 70 }] } },
    ]);
    expect(c?.shadow).toEqual({ weights_version: 1, live_winner: 'a', shadow_winner: 'b', agree: false, scores: [{ provider: 'b', score: 0.71, priority: 70 }] });
  });
});
