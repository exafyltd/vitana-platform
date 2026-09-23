/**
 * VTID-04435 (Plan v1 WS-4.3) — outcomes feed the scoring, per user, within
 * fixed limits.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_SCORING_WEIGHTS,
  rankInShadow,
  type ScorableCandidate,
  type ScoringContext,
} from '../../../src/services/conversation/candidate-scoring';
import {
  PERSONAL_WEIGHT_LIMITS as L,
  isPersonalWeightsLive,
  personalAdjustment,
  personalizeWeights,
} from '../../../src/services/conversation/personal-weights';
import { summarizeShadowComparisons } from '../../../src/services/conversation/shadow-comparison';

const SRC = join(__dirname, '../../../src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const o = (accepted: number, declined: number, ignored: number) => ({ accepted, declined, ignored, settled: accepted + declined + ignored });

describe('the flag', () => {
  it('the live re-ranking uses personal weights only for the exact string true', () => {
    expect(isPersonalWeightsLive({ BRAIN_PERSONAL_WEIGHTS: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'false']) expect(isPersonalWeightsLive({ BRAIN_PERSONAL_WEIGHTS: v })).toBe(false);
  });

  it('is pinned on staging only', () => {
    const wf = (f: string) => readFileSync(join(__dirname, '../../../../../.github/workflows', f), 'utf8');
    expect(wf('AWS-STAGE-DEPLOY-GATEWAY.yml')).toMatch(/\{name:"BRAIN_PERSONAL_WEIGHTS", value:"true"\}/);
    expect(wf('AWS-STAGE-DEPLOY-GATEWAY.yml')).toMatch(/"ORB_TOOL_SELECTION_ENABLED","BRAIN_PERSONAL_WEIGHTS",/);
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toMatch(/BRAIN_PERSONAL_WEIGHTS/);
  });
});

describe('personalAdjustment', () => {
  it('changes nothing below the minimum evidence', () => {
    expect(personalAdjustment({})).toMatchObject({ applied: false, evidence: 0, outcome_mult: 1, freshness_mult: 1 });
    expect(personalAdjustment({ a: o(3, 0, 0), b: o(0, 1, 0) })).toMatchObject({ applied: false, evidence: 4 });
    expect(personalAdjustment(null).applied).toBe(false);
  });

  it('raises the outcome weight when acceptance differs a lot between providers', () => {
    const a = personalAdjustment({ journey_guide: o(18, 1, 1), login_briefing: o(0, 15, 5) });
    expect(a.applied).toBe(true);
    expect(a.confidence).toBe(1);
    expect(a.spread).toBeGreaterThan(0.7);
    expect(a.outcome_mult).toBeGreaterThan(1.5);
    expect(a.outcome_mult).toBeLessThanOrEqual(L.outcomeMultMax);
  });

  it('lowers the outcome weight when acceptance is flat', () => {
    const a = personalAdjustment({ a: o(8, 7, 0), b: o(8, 7, 0) });
    expect(a.spread).toBe(0);
    expect(a.outcome_mult).toBeLessThan(1);
    expect(a.outcome_mult).toBeGreaterThanOrEqual(L.outcomeMultMin);
  });

  it('leaves the outcome weight alone with only one measurable provider', () => {
    expect(personalAdjustment({ a: o(20, 10, 0), b: o(1, 0, 0) }).outcome_mult).toBe(1);
  });

  it('raises freshness for a user who ignores most offers, within its band', () => {
    const tired = personalAdjustment({ a: o(2, 2, 26), b: o(1, 1, 18) });
    expect(tired.ignored_share).toBeGreaterThan(0.8);
    expect(tired.freshness_mult).toBe(L.freshnessMultMax);
    const engaged = personalAdjustment({ a: o(20, 5, 1), b: o(10, 5, 1) });
    expect(engaged.freshness_mult).toBe(1);
  });

  it('grows with evidence and never leaves its limits', () => {
    const small = personalAdjustment({ a: o(5, 0, 0), b: o(0, 3, 2) });
    const large = personalAdjustment({ a: o(50, 0, 0), b: o(0, 30, 20) });
    expect(small.confidence).toBeLessThan(large.confidence);
    expect(small.outcome_mult).toBeLessThan(large.outcome_mult);
    let seed = 4435; // deterministic LCG so a failure reproduces
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 40; };
    for (let i = 0; i < 200; i++) {
      const a = personalAdjustment({ a: o(rnd(), rnd(), rnd()), b: o(rnd(), rnd(), rnd()), c: o(rnd(), rnd(), rnd()) });
      expect(a.outcome_mult).toBeGreaterThanOrEqual(L.outcomeMultMin);
      expect(a.outcome_mult).toBeLessThanOrEqual(L.outcomeMultMax);
      expect(a.freshness_mult).toBeGreaterThanOrEqual(L.freshnessMultMin);
      expect(a.freshness_mult).toBeLessThanOrEqual(L.freshnessMultMax);
    }
  });
});

describe('personalizeWeights', () => {
  it('changes only the outcome and freshness weights and never mutates the shared weights', () => {
    const before = JSON.stringify(DEFAULT_SCORING_WEIGHTS);
    const { weights, adjustment } = personalizeWeights(DEFAULT_SCORING_WEIGHTS, { a: o(18, 1, 1), b: o(0, 15, 25) });
    expect(adjustment.applied).toBe(true);
    expect(JSON.stringify(DEFAULT_SCORING_WEIGHTS)).toBe(before);
    for (const k of ['urgency', 'screen', 'time_of_day', 'profile'] as const) expect(weights.weights[k]).toBe(DEFAULT_SCORING_WEIGHTS.weights[k]);
    expect(weights.weights.outcome).toBeGreaterThan(DEFAULT_SCORING_WEIGHTS.weights.outcome);
    expect(weights.weights.freshness).toBeGreaterThan(DEFAULT_SCORING_WEIGHTS.weights.freshness);
    expect(weights.version).toBe(DEFAULT_SCORING_WEIGHTS.version);
  });

  it('returns the shared object itself when nothing applies', () => {
    expect(personalizeWeights(DEFAULT_SCORING_WEIGHTS, {}).weights).toBe(DEFAULT_SCORING_WEIGHTS);
  });

  it('can change the shadow pick for a user whose history favours a lower-priority provider', () => {
    const cands: ScorableCandidate[] = [
      { provider: 'login_briefing', kind: 'wake_brief', dedupeKey: 'lb', priority: 90, ctaRoute: null },
      { provider: 'journey_guide', kind: 'wake_brief', dedupeKey: 'jg', priority: 60, ctaRoute: null },
    ];
    const outcomes = { journey_guide: o(28, 1, 1), login_briefing: o(0, 20, 10) };
    const ctx: ScoringContext = { recentlyServed: [], recentWindow: 5, currentRoute: null, partOfDay: null, outcomes };
    const shared = { ...DEFAULT_SCORING_WEIGHTS, weights: { ...DEFAULT_SCORING_WEIGHTS.weights, outcome: 0.1 } };
    expect(rankInShadow(cands, null, ctx, shared).shadow_winner).toBe('login_briefing');
    expect(rankInShadow(cands, null, ctx, personalizeWeights(shared, outcomes).weights).shadow_winner).toBe('journey_guide');
  });
});

describe('where it is used', () => {
  it('the shadow ranking records the personal adjustment and the shared-weights winner', () => {
    const src = read('services/wake-brief-wiring.ts');
    expect(src).toMatch(/const personal = personalizeWeights\(weights, outcomes\);/);
    expect(src).toMatch(/personal: personal\.adjustment,\s*shadow_winner_shared_weights: baseWinner,/);
  });

  it('the live turn re-ranking uses the personal copy only behind the flag', () => {
    const src = read('services/conversation/turn-candidates.ts');
    expect(src).toMatch(/const useWeights = isPersonalWeightsLive\(\) \? personalizeWeights\(weights, outcomes\)\.weights : weights;/);
    expect(src).toMatch(/\}, useWeights\);/);
  });

  it('loadUserOutcomes keeps declined and ignored counts', () => {
    expect(read('services/conversation/candidate-scoring.ts')).toMatch(/settled: r\.accepted \+ r\.declined \+ r\.ignored, declined: r\.declined, ignored: r\.ignored/);
  });
});

describe('Monitor and inspector', () => {
  const ev = (live: string, shadow: string, personal: Record<string, unknown> | null, sharedWinner?: string) => ({
    session_id: `s-${live}-${shadow}-${personal ? String(personal.applied) : 'none'}-${sharedWinner ?? ''}`,
    started_at: '2026-09-23T12:00:00Z',
    events: [{ name: 'continuation_shadow_ranked', metadata: { weights_version: 1, live_winner: live, shadow_winner: shadow, candidates: [], personal, shadow_winner_shared_weights: sharedWinner } }],
  });

  it('the shadow summary counts personalised openings and changed picks', () => {
    const s = summarizeShadowComparisons([
      ev('a', 'b', { applied: true }, 'a'),
      ev('a', 'a', { applied: true }, 'a'),
      ev('a', 'a', { applied: false }),
      ev('a', 'a', null),
    ], 7);
    expect(s).toMatchObject({ sessions_ranked: 4, personalized: 2, personal_changed_winner: 1 });
  });

  it('the inspector shows a session\'s adjustment', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { summarizeWakeTimeline } = require('../../../src/services/conversation/session-brain-inspector');
    const c = summarizeWakeTimeline([{ name: 'continuation_shadow_ranked', metadata: {
      weights_version: 1, live_winner: 'a', shadow_winner: 'b', agree: false, candidates: [],
      personal: { applied: true, evidence: 32, outcome_mult: 1.6, freshness_mult: 1.2 }, shadow_winner_shared_weights: 'a',
    } }]);
    expect(c.shadow.personal).toEqual({ evidence: 32, outcome_mult: 1.6, freshness_mult: 1.2, shared_weights_winner: 'a' });
    const plain = summarizeWakeTimeline([{ name: 'continuation_shadow_ranked', metadata: { weights_version: 1, candidates: [] } }]);
    expect(plain.shadow.personal).toBeUndefined();
  });

  it('the Command Hub shows both', () => {
    const app = read('frontend/command-hub/app.js');
    expect(app).toMatch(/_convTile\('Personal weights', String\(d\.personalized \|\| 0\)/);
    expect(app).toMatch(/var bodyPersonal = 'Personal weights from '/);
  });
});
