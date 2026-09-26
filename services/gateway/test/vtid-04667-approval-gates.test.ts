/**
 * VTID-04667 (P4.2–P4.4): pure pre-approval gates for autonomous approvals.
 */
import {
  isNeverAutoExecuteSignal,
  summarizeFindingSpend,
  isOverFindingBudget,
  resolveFindingBudget,
  inOutageRequeueCooldown,
  resolveOutageRequeueCooldownMs,
  planFilesMissingFromIndex,
  isPlanFileCheckEnabled,
  DEFAULT_FINDING_BUDGET_USD,
  DEFAULT_FINDING_BUDGET_INPUT_TOKENS,
  DEFAULT_OUTAGE_REQUEUE_COOLDOWN_MS,
} from '../src/services/dev-autopilot-approval-gates';
import { scoreSignal } from '../src/services/dev-autopilot-synthesis';

const OUTAGE = { error: 'LLM call failed after 0s: both providers failed: primary=Bedrock invoke_failed; fallback=DeepSeek 402 Insufficient Balance' };
const REAL = { error: 'jest failed: 2 suites' };

describe('large_file is never auto-executed', () => {
  it('isNeverAutoExecuteSignal', () => {
    expect(isNeverAutoExecuteSignal({ signal_type: 'large_file' })).toBe(true);
    expect(isNeverAutoExecuteSignal({ signal_type: 'todo' })).toBe(false);
    expect(isNeverAutoExecuteSignal(null)).toBe(false);
  });
  it('synthesis never marks a large_file finding auto_exec_eligible, whatever its severity', () => {
    for (const severity of ['low', 'medium', 'high'] as const) {
      const s = scoreSignal({ type: 'large_file', severity, file_path: 'services/gateway/src/x.ts', message: 'm', scanner: 'large-file-scanner' } as any);
      expect(s.auto_exec_eligible).toBe(false);
    }
    // control: a low-risk high-impact signal stays eligible
    expect(scoreSignal({ type: 'dead_code', severity: 'high', file_path: 'a.ts', message: 'm', scanner: 's' } as any).auto_exec_eligible).toBe(true);
  });
});

describe('per-finding token budget', () => {
  const run = (id: string, cost: number, tokens: number) => ({ execution_id: id, cost_usd: cost, input_tokens: tokens });
  it('sums runs across outcome rows, deduplicated by execution_id', () => {
    const spend = summarizeFindingSpend([
      { metadata: { agent_runs: [run('a', 1, 1_000_000), run('b', 0.5, 500_000)], agent_cost_usd_total: 1.5 } },
      { metadata: { agent_runs: [run('b', 0.5, 500_000), run('c', 0.25, 250_000)] } },
      { metadata: null },
    ]);
    expect(spend).toEqual({ cost_usd: 1.75, input_tokens: 1_750_000, runs: 3 });
  });
  it('the rows\' own totals win when agent_runs[] was truncated', () => {
    expect(summarizeFindingSpend([{ metadata: { agent_runs: [run('z', 0.1, 10)], agent_cost_usd_total: 4.2 } }]).cost_usd).toBe(4.2);
  });
  it('over budget on either axis (defaults $3 / 5M input tokens)', () => {
    const b = resolveFindingBudget({});
    expect(b).toEqual({ max_cost_usd: DEFAULT_FINDING_BUDGET_USD, max_input_tokens: DEFAULT_FINDING_BUDGET_INPUT_TOKENS });
    expect([DEFAULT_FINDING_BUDGET_USD, DEFAULT_FINDING_BUDGET_INPUT_TOKENS]).toEqual([3, 5_000_000]);
    expect(isOverFindingBudget({ cost_usd: 3, input_tokens: 0, runs: 1 }, b)).toBe(true);
    expect(isOverFindingBudget({ cost_usd: 0.1, input_tokens: 5_500_000, runs: 1 }, b)).toBe(true); // one npm-audit attempt
    expect(isOverFindingBudget({ cost_usd: 2.99, input_tokens: 4_999_999, runs: 1 }, b)).toBe(false);
  });
  it('env overrides; garbage falls back', () => {
    expect(resolveFindingBudget({ DEV_AUTOPILOT_FINDING_BUDGET_USD: '10', DEV_AUTOPILOT_FINDING_BUDGET_INPUT_TOKENS: '20000000' }))
      .toEqual({ max_cost_usd: 10, max_input_tokens: 20_000_000 });
    expect(resolveFindingBudget({ DEV_AUTOPILOT_FINDING_BUDGET_USD: '-1', DEV_AUTOPILOT_FINDING_BUDGET_INPUT_TOKENS: 'lots' }))
      .toEqual({ max_cost_usd: 3, max_input_tokens: 5_000_000 });
  });
});

describe('outage requeue cap', () => {
  const now = 1_800_000_000_000;
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  it('an outage failure < 60 min ago blocks re-approval', () => {
    expect(DEFAULT_OUTAGE_REQUEUE_COOLDOWN_MS).toBe(3_600_000);
    expect(inOutageRequeueCooldown({ status: 'failed', updated_at: at(59 * 60_000), metadata: OUTAGE }, now, 3_600_000)).toBe(true);
  });
  it('after 60 min, or a non-outage failure, or a non-failure: no cooldown', () => {
    expect(inOutageRequeueCooldown({ status: 'failed', updated_at: at(61 * 60_000), metadata: OUTAGE }, now, 3_600_000)).toBe(false);
    expect(inOutageRequeueCooldown({ status: 'failed', updated_at: at(60_000), metadata: REAL }, now, 3_600_000)).toBe(false);
    expect(inOutageRequeueCooldown({ status: 'completed', updated_at: at(60_000), metadata: OUTAGE }, now, 3_600_000)).toBe(false);
    expect(inOutageRequeueCooldown(null, now)).toBe(false);
  });
  it('DEV_AUTOPILOT_OUTAGE_REQUEUE_MINUTES overrides', () => {
    expect(resolveOutageRequeueCooldownMs({})).toBe(3_600_000);
    expect(resolveOutageRequeueCooldownMs({ DEV_AUTOPILOT_OUTAGE_REQUEUE_MINUTES: '15' })).toBe(900_000);
  });
});

describe('plan files exist in the codebase index', () => {
  const index = {
    risk: { files: { 'services/gateway/src/a.ts': {} } },
    byFile: new Map<string, unknown>([['services/gateway/src/b.ts', [1]]]),
  };
  it('reports non-test code files the index does not know', () => {
    expect(planFilesMissingFromIndex([
      'services/gateway/src/a.ts',
      './services/gateway/src/b.ts',
      'services/gateway/src/ghost.ts',
      'services/gateway/test/ghost.test.ts', // tests may be new
      'docs/validation/VTID-1/acceptance.md', // non-code: not reliably indexed
      'supabase/migrations/x.sql',
    ], index)).toEqual(['services/gateway/src/ghost.ts']);
  });
  it('switches: DEV_AUTOPILOT_PLAN_FILE_CHECK=false or AGENT_CODE_INDEX_ENABLED=false disable it', () => {
    expect(isPlanFileCheckEnabled({})).toBe(true);
    expect(isPlanFileCheckEnabled({ DEV_AUTOPILOT_PLAN_FILE_CHECK: 'false' })).toBe(false);
    expect(isPlanFileCheckEnabled({ AGENT_CODE_INDEX_ENABLED: 'false' })).toBe(false);
  });
});
