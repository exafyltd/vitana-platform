/**
 * VTID-04668 (P2): evidence-based priority for developer recommendations.
 * Pure scoring table, the quality floor, reuse of the P4 breaker stats and
 * of the P4 agent-run reader for cost medians.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import {
  scoreRecommendation,
  passesQualityFloor,
  resolveQualityFloor,
  computeCostStats,
  extractEventCount,
  extractFilePaths,
  isScorableDeveloperRecommendation,
  isExecutableRecommendation,
  AUDIENCE_WEIGHTS,
  SEVERITY_WEIGHTS,
  VALUE_MIX,
  CONFIDENCE_WEIGHTS,
  NON_EXECUTABLE_SUCCESS_PRIOR,
  SUCCESS_ODDS_NO_HISTORY,
  DEFAULT_EXPECTED_COST_USD,
  COST_FLOOR_USD,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_SUCCESS_ODDS,
} from '../src/services/recommendation-quality/priority';
import { computeBreakerStates, resolveBreakerThresholds, type LoadedBreakers } from '../src/services/dev-autopilot-scanner-breaker';
import { extractAgentRuns, summarizeFindingSpend } from '../src/services/dev-autopilot-approval-gates';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

function breakers(rows: Array<{ key: string; status: string; i: number }>): LoadedBreakers {
  const thresholds = resolveBreakerThresholds({});
  return {
    ok: true,
    thresholds,
    states: computeBreakerStates(rows.map((r) => ({ key: r.key, status: r.status, updated_at: daysAgo(r.i / 100), metadata: { error: 'tsc failed' } })), thresholds),
  };
}

const todoFinding = {
  id: 'f1',
  source_type: 'dev_autopilot',
  user_id: null,
  risk_class: 'medium',
  impact_score: 6,
  effort_score: 3,
  seen_count: 1,
  last_seen_at: daysAgo(1),
  spec_snapshot: { signal_type: 'todo', scanner: 'todo-scanner-v1', severity: 'medium', file_path: 'services/gateway/src/a.ts' },
};

describe('value table', () => {
  it('audience × severity × frequency, times trend, per the documented weights', () => {
    const r = scoreRecommendation(todoFinding, { nowMs: NOW });
    // todo → ci_only (0.3); severity medium (0.6); seen 1 → log2(2)/log2(11)
    const freq = Math.log2(2) / Math.log2(11);
    const expected = AUDIENCE_WEIGHTS.ci_only * VALUE_MIX.audience + SEVERITY_WEIGHTS.medium * VALUE_MIX.severity + freq * VALUE_MIX.frequency;
    expect(r.quality.value).toBeCloseTo(expected, 3);
    expect(r.quality.basis.audience).toContain('ci_only');
  });

  it('a member-facing security signal outranks CI hygiene at equal severity', () => {
    const auth = scoreRecommendation({ ...todoFinding, spec_snapshot: { ...todoFinding.spec_snapshot, signal_type: 'missing_auth' } }, { nowMs: NOW });
    const todo = scoreRecommendation(todoFinding, { nowMs: NOW });
    expect(auth.quality.value).toBeGreaterThan(todo.quality.value);
  });

  it('frequency grows with seen_count and event counts; stale signals decay', () => {
    const once = scoreRecommendation({ ...todoFinding, seen_count: 1 }, { nowMs: NOW });
    const many = scoreRecommendation({ ...todoFinding, seen_count: 10 }, { nowMs: NOW });
    expect(many.quality.value).toBeGreaterThan(once.quality.value);
    const oasis = { source_type: 'oasis', user_id: null, risk_level: 'high', source_ref: 'llm.call.failed', summary: 'Recurring error pattern: x (250 occurrences in 24h)', last_seen_at: daysAgo(0) };
    expect(extractEventCount(oasis)).toBe(250);
    const fresh = scoreRecommendation(oasis, { nowMs: NOW });
    const stale = scoreRecommendation({ ...oasis, last_seen_at: daysAgo(30) }, { nowMs: NOW });
    expect(stale.quality.value).toBeCloseTo(fresh.quality.value * 0.5, 3);
  });
});

describe('confidence', () => {
  it('file + scanner id = floor; reproduced adds evidence; a file missing from the index is penalised', () => {
    const base = scoreRecommendation(todoFinding, { nowMs: NOW });
    expect(base.quality.confidence).toBeCloseTo(CONFIDENCE_WEIGHTS.base + CONFIDENCE_WEIGHTS.concrete_file + CONFIDENCE_WEIGHTS.scanner_id, 3);
    const seen = scoreRecommendation({ ...todoFinding, seen_count: 3 }, { nowMs: NOW });
    expect(seen.quality.confidence).toBeCloseTo(base.quality.confidence + CONFIDENCE_WEIGHTS.reproduced, 3);
    const inIndex = scoreRecommendation(todoFinding, { nowMs: NOW, fileExists: () => true });
    expect(inIndex.quality.confidence).toBeGreaterThan(base.quality.confidence);
    const missing = scoreRecommendation(todoFinding, { nowMs: NOW, fileExists: () => false });
    expect(missing.quality.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
    expect(missing.quality.basis.confidence).toContain('no named file exists in the code index');
  });

  it('a first-sighting oasis card with only a topic is below the floor until reproduced', () => {
    const oasis = { source_type: 'oasis', user_id: null, source_ref: 'orb.x.failed', summary: 'Recurring error pattern (12 occurrences in 24h)', seen_count: 1, last_seen_at: daysAgo(0) };
    expect(passesQualityFloor(scoreRecommendation(oasis, { nowMs: NOW }).quality)).toBe(false);
    expect(passesQualityFloor(scoreRecommendation({ ...oasis, seen_count: 2 }, { nowMs: NOW }).quality)).toBe(true);
  });

  it('extracts concrete paths only', () => {
    expect(extractFilePaths({ spec_snapshot: { file_path: './services/a.ts' }, suggested_files: ['services/b.ts', 'README'] })).toEqual(['services/a.ts', 'services/b.ts']);
  });
});

describe('success odds reuse the P4 breaker stats (Laplace)', () => {
  it('(successes + 1) / (samples + 2) from the scanner breaker state', () => {
    const b = breakers([
      { key: 'todo-scanner-v1', status: 'failed', i: 1 },
      { key: 'todo-scanner-v1', status: 'failed', i: 2 },
      { key: 'todo-scanner-v1', status: 'completed', i: 3 },
      { key: 'other', status: 'completed', i: 4 },
    ]);
    const r = scoreRecommendation(todoFinding, { nowMs: NOW, breakers: b });
    expect(r.quality.success_odds).toBeCloseTo(2 / 5, 4);
    expect(r.quality.executable).toBe(true);
    expect(r.quality.basis.success_odds).toContain('1/3');
  });

  it('no history → 0.5; history unavailable → 0.5', () => {
    const empty = breakers([]);
    expect(scoreRecommendation(todoFinding, { nowMs: NOW, breakers: empty }).quality.success_odds).toBe(SUCCESS_ODDS_NO_HISTORY);
    expect(scoreRecommendation(todoFinding, { nowMs: NOW, breakers: { ...empty, ok: false } }).quality.success_odds).toBe(SUCCESS_ODDS_NO_HISTORY);
  });

  it('non-executable types use the fixed prior and are marked executable:false', () => {
    const r = scoreRecommendation({ source_type: 'roadmap', user_id: null, source_ref: 'VTID-01', seen_count: 3 }, { nowMs: NOW, breakers: breakers([]) });
    expect(r.quality.executable).toBe(false);
    expect(r.quality.success_odds).toBe(NON_EXECUTABLE_SUCCESS_PRIOR);
  });
});

describe('expected cost reuses the P4 agent-run reader', () => {
  it('extractAgentRuns dedupes by execution_id and summarizeFindingSpend still agrees', () => {
    const rows = [
      { metadata: { agent_runs: [{ execution_id: 'e1', cost_usd: 1, input_tokens: 100 }, { execution_id: 'e2', cost_usd: 3, input_tokens: 300 }], agent_cost_usd_total: 4 } },
      { metadata: { agent_runs: [{ execution_id: 'e2', cost_usd: 3, input_tokens: 300 }] } },
    ];
    expect(extractAgentRuns(rows).map((r) => r.execution_id)).toEqual(['e1', 'e2']);
    expect(summarizeFindingSpend(rows)).toEqual({ cost_usd: 4, input_tokens: 400, runs: 2 });
  });

  it('median per key, prior when no runs, cost floor in the divisor', () => {
    const stats = computeCostStats(new Map([['todo-scanner-v1', [
      { cost_usd: 0.5, input_tokens: 100 }, { cost_usd: 2, input_tokens: 900 }, { cost_usd: 1, input_tokens: 300 },
    ]]]));
    expect(stats.get('todo-scanner-v1')).toEqual({ median_cost_usd: 1, median_input_tokens: 300, runs: 3 });
    const withCost = scoreRecommendation(todoFinding, { nowMs: NOW, costByKey: stats });
    expect(withCost.quality.expected_cost_usd).toBe(1);
    const prior = scoreRecommendation(todoFinding, { nowMs: NOW });
    expect(prior.quality.expected_cost_usd).toBe(DEFAULT_EXPECTED_COST_USD);
    const cheap = scoreRecommendation(todoFinding, { nowMs: NOW, costByKey: new Map([['todo-scanner-v1', { median_cost_usd: 0, median_input_tokens: 0, runs: 1 }]]) });
    const q = cheap.quality;
    expect(cheap.priority_score).toBeCloseTo((q.value * q.confidence * q.success_odds) / COST_FLOOR_USD, 3);
  });
});

describe('priority + legacy mapping', () => {
  it('priority = value × confidence × success_odds / max(cost, floor); impact/effort mapped to 1..10', () => {
    const r = scoreRecommendation(todoFinding, { nowMs: NOW });
    const q = r.quality;
    expect(r.priority_score).toBeCloseTo((q.value * q.confidence * q.success_odds) / q.expected_cost_usd, 3);
    expect(r.impact_score).toBe(Math.round(1 + q.value * 9));
    expect(r.effort_score).toBe(Math.round(1 + 9 * (DEFAULT_EXPECTED_COST_USD / 3)));
    expect(r.quality.version).toBe(1);
    expect(r.quality.scored_at).toBe(new Date(NOW).toISOString());
  });
});

describe('quality floor', () => {
  it('confidence ≥ 0.6 and (non-executable or success ≥ 0.3); env-overridable', () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.6);
    expect(DEFAULT_MIN_SUCCESS_ODDS).toBe(0.3);
    expect(passesQualityFloor({ confidence: 0.6, success_odds: 0.3, executable: true })).toBe(true);
    expect(passesQualityFloor({ confidence: 0.59, success_odds: 0.9, executable: true })).toBe(false);
    expect(passesQualityFloor({ confidence: 0.9, success_odds: 0.29, executable: true })).toBe(false);
    expect(passesQualityFloor({ confidence: 0.9, success_odds: 0.0, executable: false })).toBe(true);
    expect(passesQualityFloor(null)).toBe(false);
    const floor = resolveQualityFloor({ AUTOPILOT_QUALITY_MIN_CONFIDENCE: '0.8', AUTOPILOT_QUALITY_MIN_SUCCESS_ODDS: '0.1' });
    expect(floor).toEqual({ min_confidence: 0.8, min_success_odds: 0.1 });
    expect(resolveQualityFloor({ AUTOPILOT_QUALITY_MIN_CONFIDENCE: 'x' }).min_confidence).toBe(0.6);
  });

  it('a scanner whose findings keep failing drops below the success floor', () => {
    const b = breakers([1, 2, 3].map((i) => ({ key: 'todo-scanner-v1', status: 'failed', i })));
    const r = scoreRecommendation(todoFinding, { nowMs: NOW, breakers: b });
    expect(r.quality.success_odds).toBeCloseTo(1 / 5, 4);
    expect(passesQualityFloor(r.quality)).toBe(false);
  });
});

describe('scope: developer recommendations only', () => {
  it('community and operator_onramp rows are not scorable; operator_onramp is not "executable" here', () => {
    expect(isScorableDeveloperRecommendation({ user_id: null, source_type: 'dev_autopilot' })).toBe(true);
    expect(isScorableDeveloperRecommendation({ user_id: null, source_type: 'oasis' })).toBe(true);
    expect(isScorableDeveloperRecommendation({ user_id: 'u', source_type: 'dev_autopilot' })).toBe(false);
    expect(isScorableDeveloperRecommendation({ user_id: null, source_type: 'community' })).toBe(false);
    expect(isScorableDeveloperRecommendation({ user_id: null, source_type: 'operator_onramp' })).toBe(false);
    expect(isExecutableRecommendation({ source_type: 'operator_onramp' })).toBe(false);
    expect(isExecutableRecommendation({ source_type: 'dev_autopilot_impact' })).toBe(true);
  });
});
