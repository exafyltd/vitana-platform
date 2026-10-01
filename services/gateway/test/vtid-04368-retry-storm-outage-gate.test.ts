/**
 * VTID-04368: the IMPACT auto-approve pass gets the same retry breaker as the
 * baseline pass, provider-outage failures never count against a finding, and
 * the loop stops approving/claiming while every execution dies on the LLM.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  isProviderOutageFailure,
  findingOwnedFailures,
  decideRetryBreaker,
  detectProviderOutage,
  slotsUnderOutage,
  AUTO_RETRY_CAP,
  OUTAGE_WINDOW_MS,
} from '../src/services/dev-autopilot-retry-breaker';
import { buildAlerts } from '../src/services/dev-autopilot-supervisor';

// Verbatim error shapes from dev_autopilot_executions, 2026-09-22/23.
const BEDROCK_BLOCKED = { error: 'LLM call failed after 0s: both providers failed: primary=Bedrock invoke_failed: Operation not allowed; fallback=Bedrock invoke_failed: Operation not allowed' };
const DEEPSEEK_402 = { error: 'LLM call failed on turn 1: both providers failed: primary=DeepSeek 402: {"error":{"message":"Insufficient Balance"}}' };
const TURN_CAP = { error: 'agent hit the 120-turn cap without calling finish' };
const REAL = { error: 'tsc failed after 3 fix round(s): src/x.ts(1,1): error TS2322' };

const at = (msAgo: number, metadata: Record<string, unknown>, now = 1_800_000_000_000) =>
  ({ updated_at: new Date(now - msAgo).toISOString(), metadata });
const NOW = 1_800_000_000_000;

describe('isProviderOutageFailure', () => {
  it('matches the live Bedrock-block and DeepSeek-402 shapes', () => {
    expect(isProviderOutageFailure(BEDROCK_BLOCKED)).toBe(true);
    expect(isProviderOutageFailure(DEEPSEEK_402)).toBe(true);
    expect(isProviderOutageFailure({ error: 'unable to place a task because your account is currently blocked' })).toBe(true);
  });
  it('does not match a failure that is the finding\'s own', () => {
    expect(isProviderOutageFailure(TURN_CAP)).toBe(false);
    expect(isProviderOutageFailure(REAL)).toBe(false);
    expect(isProviderOutageFailure(null)).toBe(false);
    expect(isProviderOutageFailure({})).toBe(false);
  });
});

describe('decideRetryBreaker', () => {
  it('461 outage failures never snooze a finding', () => {
    const rows = Array.from({ length: 461 }, () => ({ metadata: BEDROCK_BLOCKED }));
    expect(findingOwnedFailures(rows)).toHaveLength(0);
    expect(decideRetryBreaker(rows)).toBe('admit');
  });
  it('snoozes at the cap on real failures, outages excluded from the count', () => {
    const four = Array.from({ length: AUTO_RETRY_CAP - 1 }, () => ({ metadata: REAL }));
    expect(decideRetryBreaker([...four, { metadata: DEEPSEEK_402 }, { metadata: BEDROCK_BLOCKED }])).toBe('admit');
    expect(decideRetryBreaker([...four, { metadata: REAL }])).toBe('snooze_retry_cap');
  });
  it('one turn-cap failure snoozes (VTID-04243 behaviour kept)', () => {
    expect(decideRetryBreaker([{ metadata: TURN_CAP }])).toBe('snooze_turn_cap');
  });
  it('admits a finding with no failures', () => {
    expect(decideRetryBreaker([])).toBe('admit');
    expect(decideRetryBreaker(null)).toBe('admit');
  });
});

describe('detectProviderOutage', () => {
  it('outage: the newest three are outage failures and recent', () => {
    expect(detectProviderOutage([at(1_000, BEDROCK_BLOCKED), at(60_000, DEEPSEEK_402), at(120_000, BEDROCK_BLOCKED)], NOW)).toBe('outage');
  });
  it('probe: newest is an outage but outside the window, or the streak is short', () => {
    expect(detectProviderOutage([at(OUTAGE_WINDOW_MS + 1_000, BEDROCK_BLOCKED), at(OUTAGE_WINDOW_MS + 2_000, BEDROCK_BLOCKED), at(OUTAGE_WINDOW_MS + 3_000, BEDROCK_BLOCKED)], NOW)).toBe('probe');
    expect(detectProviderOutage([at(1_000, BEDROCK_BLOCKED), at(2_000, REAL), at(3_000, BEDROCK_BLOCKED)], NOW)).toBe('probe');
    expect(detectProviderOutage([at(1_000, BEDROCK_BLOCKED)], NOW)).toBe('probe');
  });
  it('clear: newest failure is a real one, or there are none', () => {
    expect(detectProviderOutage([at(1_000, REAL), at(2_000, BEDROCK_BLOCKED), at(3_000, BEDROCK_BLOCKED)], NOW)).toBe('clear');
    expect(detectProviderOutage([], NOW)).toBe('clear');
    expect(detectProviderOutage(null, NOW)).toBe('clear');
  });
  it('slots: none during an outage, one while probing, unchanged when clear', () => {
    expect(slotsUnderOutage('outage', 5)).toBe(0);
    expect(slotsUnderOutage('probe', 5)).toBe(1);
    expect(slotsUnderOutage('probe', 0)).toBe(0);
    expect(slotsUnderOutage('clear', 5)).toBe(5);
  });
});

describe('wiring in dev-autopilot-execute.ts', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  const impactStart = src.indexOf('// Second pass: IMPACT findings.');
  const impact = src.slice(impactStart, src.indexOf('approveAutoExecute({ finding_id: f.id })', impactStart));
  const tickStart = src.indexOf('export async function autoApproveTick');
  const baseline = src.slice(tickStart, impactStart);

  it('the impact pass runs the retry breaker before approving', () => {
    expect(impact).toContain("retryBreakerAdmits(s, f.id, 'impact')");
  });
  it('the baseline pass uses the same breaker (no second copy of the cap)', () => {
    expect(baseline).toContain("retryBreakerAdmits(s, f.id, 'baseline')");
    expect(baseline).not.toMatch(/const AUTO_RETRY_CAP = /);
  });
  it('approval and claiming both go through the outage gate', () => {
    expect(baseline).toMatch(/slotsUnderOutage\(await loadOutageState\(s\)/);
    const claim = src.slice(src.indexOf('export async function backgroundExecutorTick'), tickStart);
    expect(claim).toMatch(/slotsUnderOutage\(await loadOutageState\(s\)/);
  });
});

describe('supervisor alert', () => {
  const base = {
    cfg: { kill_switch: false } as any,
    scan: { overdue: false, failed_7d: 0, stuck_runs: [] } as any,
    exec: { success_rate_7d: null, failed_7d: 0, top_failure_reasons: [], by_origin_7d: {}, awaiting_approval: 0 } as any,
    blockers: {},
    communityEngineLastRunAt: new Date().toISOString(),
    nowMs: Date.now(),
  };
  it('is critical during an outage and names the provider error', () => {
    const a = buildAlerts({ ...base, providerOutage: { state: 'outage', failures_7d: 800, last_error: 'Operation not allowed' } });
    const hit = a.find((x) => /LLM providers are failing/.test(x.text));
    expect(hit?.severity).toBe('critical');
    expect(hit?.text).toContain('paused');
    expect(hit?.text).toContain('Operation not allowed');
  });
  it('is absent when clear', () => {
    const a = buildAlerts({ ...base, providerOutage: { state: 'clear', failures_7d: 0, last_error: null } });
    expect(a.some((x) => /LLM providers/.test(x.text))).toBe(false);
  });
});
