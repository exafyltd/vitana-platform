/**
 * VTID-04281 — supervisor snapshot: every open finding gets a blocker
 * diagnosis that mirrors a real gate, scan cadence flags a missed schedule,
 * and the execution funnel surfaces the dominant failure reason.
 * Fixtures are the live cases seen on staging 2026-09-22.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  diagnoseFinding,
  summarizeScanCadence,
  summarizeExecutions,
  summarizeRuleHits,
  normalizeFailureReason,
  nextScheduledScan,
  buildAlerts,
  type OpenFinding,
  type DiagnoseContext,
  type SupervisorConfig,
} from '../src/services/dev-autopilot-supervisor';

const NOW = Date.parse('2026-09-22T20:00:00Z');
const cfg: SupervisorConfig = {
  kill_switch: false,
  auto_approve_enabled: true,
  auto_approve_impact_enabled: true,
  auto_approve_risk_classes: ['low', 'medium'],
  auto_approve_max_effort: 8,
  auto_approve_scanners: ['todo-scanner-v1', 'route-auth-scanner-v1', 'dead-code-scanner-v1'],
  auto_approve_impact_rules: ['new-route-needs-test'],
  daily_budget: 500,
  concurrency_cap: 4,
};
function finding(over: Partial<OpenFinding> = {}): OpenFinding {
  return {
    id: 'f1', title: 't', status: 'new', source_type: 'dev_autopilot', risk_class: 'medium',
    effort_score: 4, impact_score: 5, snoozed_until: null, created_at: '2026-09-21T15:21:00Z',
    spec_snapshot: { scanner: 'route-auth-scanner-v1' }, ...over,
  };
}
function ctx(over: Partial<DiagnoseContext> = {}): DiagnoseContext {
  return { cfg, hasPlan: true, execs: [], planFailures: { count: 0, lastMs: null }, nowMs: NOW, budgetLeft: 490, concurrencyLeft: 4, ...over };
}

describe('VTID-04281 diagnoseFinding', () => {
  it('high-risk large-file refactor needs a human', () => {
    const d = diagnoseFinding(finding({ risk_class: 'high', effort_score: 7, spec_snapshot: { scanner: 'large-file-scanner-v1' } }), ctx({ hasPlan: false }));
    expect(d.code).toBe('risk_too_high');
    expect(d.actor).toBe('human');
  });

  it('a reverted execution with an unrecorded PR is a system blocker (the #3547 case)', () => {
    const d = diagnoseFinding(finding(), ctx({ execs: [
      { finding_id: 'f1', status: 'failed', pr_number: null, pr_url: null, pr_closed: null, error: 'x', updated_at: '2026-09-21T19:28:00Z' },
      { finding_id: 'f1', status: 'reverted', pr_number: 3547, pr_url: 'https://github.com/o/r/pull/3547', pr_closed: null, error: null, updated_at: '2026-09-21T19:27:00Z' },
    ] }));
    expect(d.code).toBe('stranded_pr');
    expect(d.actor).toBe('system');
    expect(d.label).toContain('#3547');
  });

  it('the same row stops blocking once the PR is recorded closed', () => {
    const d = diagnoseFinding(finding(), ctx({ execs: [
      { finding_id: 'f1', status: 'reverted', pr_number: 3547, pr_url: 'u', pr_closed: '2026-09-21T19:27:00Z', error: null, updated_at: '2026-09-21T19:27:00Z' },
    ] }));
    expect(d.code).toBe('ready');
  });

  it('a planless low/medium finding is queued for the planner; exhausted planning is a system blocker', () => {
    expect(diagnoseFinding(finding({ spec_snapshot: { scanner: 'todo-scanner-v1' } }), ctx({ hasPlan: false })).code).toBe('awaiting_plan');
    const d = diagnoseFinding(finding(), ctx({ hasPlan: false, planFailures: { count: 6, lastMs: NOW - 60_000 } }));
    expect(d.code).toBe('plan_failed');
    expect(d.actor).toBe('system');
  });

  it('in-flight and awaiting-approval executions win over every other gate', () => {
    expect(diagnoseFinding(finding({ risk_class: 'high' }), ctx({ execs: [
      { finding_id: 'f1', status: 'running', pr_number: null, pr_url: null, pr_closed: null, error: null, updated_at: 'x' },
    ] })).actor).toBe('moving');
    const d = diagnoseFinding(finding(), ctx({ execs: [
      { finding_id: 'f1', status: 'awaiting_approval', pr_number: null, pr_url: null, pr_closed: null, error: null, updated_at: 'x' },
    ] }));
    expect(d.actor).toBe('human');
    expect(d.label).toMatch(/approval/i);
  });

  it('snoozed, kill switch, scanner/rule allowlists, retry cap and budget each map to their gate', () => {
    expect(diagnoseFinding(finding({ status: 'snoozed', snoozed_until: '2026-09-28T16:28:00Z' }), ctx()).code).toBe('snoozed');
    expect(diagnoseFinding(finding(), ctx({ cfg: { ...cfg, kill_switch: true } })).code).toBe('kill_switch');
    expect(diagnoseFinding(finding({ spec_snapshot: { scanner: 'unknown-v1' } }), ctx()).code).toBe('scanner_not_opted_in');
    expect(diagnoseFinding(finding({ source_type: 'dev_autopilot_impact', spec_snapshot: { rule: 'duplicate-table-name' } }), ctx()).code).toBe('rule_not_opted_in');
    const fails = Array.from({ length: 5 }, () => ({ finding_id: 'f1', status: 'failed', pr_number: null, pr_url: null, pr_closed: null, error: 'cap', updated_at: '2026-09-22T18:00:00Z' }));
    expect(diagnoseFinding(finding(), ctx({ execs: fails })).code).toBe('retry_cap');
    expect(diagnoseFinding(finding(), ctx({ budgetLeft: 0 })).code).toBe('budget_exhausted');
    expect(diagnoseFinding(finding(), ctx({ concurrencyLeft: 0 })).code).toBe('concurrency_full');
  });
});

describe('VTID-04281 scan cadence', () => {
  const run = (started: string, status = 'done', over = {}) => ({
    run_id: started, triggered_by: 'github-actions', status, signal_count: 2300, new_finding_count: 1,
    started_at: started, completed_at: status === 'done' ? started : null, error: null, ...over,
  });

  it('a successful scan 8 h ago is on schedule; the never-finalized run is reported', () => {
    const s = summarizeScanCadence([run('2026-09-22T12:21:00Z'), run('2026-09-21T15:21:00Z', 'ingesting')], NOW);
    expect(s.overdue).toBe(false);
    expect(s.hours_since_success).toBeCloseTo(7.7, 1);
    expect(s.stuck_runs).toHaveLength(1);
  });

  it('the 40-day gap (last success 2026-08-11) is overdue', () => {
    const s = summarizeScanCadence([run('2026-08-11T08:08:00Z')], Date.parse('2026-09-20T12:00:00Z'));
    expect(s.overdue).toBe(true);
    expect(s.runs_7d).toBe(0);
  });

  it('next scheduled scan follows the 07:00/19:00 UTC cron', () => {
    expect(nextScheduledScan(NOW)).toBe('2026-09-23T07:00:00.000Z');
    expect(nextScheduledScan(Date.parse('2026-09-22T10:00:00Z'))).toBe('2026-09-22T19:00:00.000Z');
  });
});

describe('VTID-04281 execution funnel', () => {
  it('computes success rate, auto share and groups failure reasons', () => {
    const mk = (status: string, error: string | null, approved_by: string | null = null) => ({
      id: Math.random().toString(36), finding_id: 'f', status, approved_by, created_at: '2026-09-21T10:00:00Z',
      updated_at: '2026-09-21T10:00:00Z', pr_number: null, error,
    });
    const s = summarizeExecutions([
      mk('failed', 'agent hit the 120-turn cap without calling finish'),
      mk('failed', 'agent hit the 120-turn cap without calling finish'),
      mk('reverted', 'finding 9e1bdb97 already has an unmerged PR https://github.com/o/r/pull/3543 from execution 1a2b3c4d'),
      mk('completed', null, 'user-uuid'),
      mk('running', null),
    ], NOW);
    expect(s.success_rate_7d).toBe(25);
    expect(s.auto_approved_7d).toBe(4);
    expect(s.active).toBe(1);
    expect(s.top_failure_reasons[0]).toEqual({ reason: 'agent hit the 120-turn cap without calling finish', count: 2 });
    expect(s.top_failure_reasons[1].reason).toBe('finding <id> already has an unmerged PR <url> from execution <id>');
  });

  it('only scanner/impact runs count as self-healing; operator runs are not "auto"', () => {
    const mk = (status: string, source_type: string, approved_by: string | null = null) => ({
      id: Math.random().toString(36), finding_id: 'f', status, approved_by, created_at: '2026-09-21T10:00:00Z',
      updated_at: '2026-09-21T10:00:00Z', pr_number: null, error: null, source_type,
    });
    const s = summarizeExecutions([
      mk('completed', 'operator_onramp'), mk('failed', 'operator_onramp'),
      mk('failed', 'dev_autopilot'), mk('failed', 'dev_autopilot'), mk('reverted', 'dev_autopilot'),
    ], NOW);
    expect(s.auto_approved_7d).toBe(3);
    expect(s.by_origin_7d.scanner).toEqual({ total: 3, succeeded: 0, failed: 3 });
    expect(s.by_origin_7d.operator).toEqual({ total: 2, succeeded: 1, failed: 1 });
    const alerts = buildAlerts({ cfg, scan: summarizeScanCadence([], NOW), exec: s, blockers: {}, communityEngineLastRunAt: null, nowMs: NOW });
    expect(alerts.map((a) => a.text)).toContain('Self-healing: 0 of 3 executions started from scanner/impact findings succeeded in 7 days.');
  });

  it('normalizeFailureReason collapses ids, urls and PR numbers', () => {
    expect(normalizeFailureReason(null)).toBe('(no error recorded)');
    expect(normalizeFailureReason('PR #3547 blocked for 1a2b3c4d')).toBe('PR #<n> blocked for <id>');
  });
});

describe('VTID-04281 rule hits and alerts', () => {
  it('a blocker rule with no hits reads as 0 open, not as an open blocker', () => {
    const hits = summarizeRuleHits(
      [{ rule: 'duplicate-table-name', severity: 'blocker', title: 'x' }, { rule: 'new-route-needs-test', severity: 'warning', title: 'y' }],
      [{ rule: 'new-route-needs-test', status: 'rejected', created_at: '2026-09-10T00:00:00Z' }, { rule: 'new-route-needs-test', status: 'new', created_at: '2026-09-20T00:00:00Z' }],
    );
    expect(hits[0]).toMatchObject({ rule: 'duplicate-table-name', open: 0, hits_30d: 0, last_fired_at: null });
    expect(hits[1]).toMatchObject({ open: 1, hits_30d: 2, rejected_30d: 1, last_fired_at: '2026-09-20T00:00:00Z' });
  });

  it('flags a dead community engine, a low success rate and pending approvals', () => {
    const scan = summarizeScanCadence([], NOW);
    const exec = { ...summarizeExecutions([], NOW), success_rate_7d: 20, failed_7d: 40, awaiting_approval: 2,
      top_failure_reasons: [{ reason: 'agent hit the 120-turn cap without calling finish', count: 30 }] };
    const alerts = buildAlerts({ cfg, scan, exec, blockers: { system: 3, human: 2 }, communityEngineLastRunAt: '2026-08-15T19:00:30Z', nowMs: NOW });
    const text = alerts.map((a) => a.text).join('\n');
    expect(text).toMatch(/No successful scan on record/);
    expect(text).toMatch(/Only 20% .*120-turn cap/);
    expect(text).toMatch(/2 execution\(s\) waiting for your approval/);
    expect(text).toMatch(/has not run for 38 days/);
    expect(alerts.find((a) => /Community automation/.test(a.text))!.tab).toBe('registry');
  });
});

describe('VTID-04281 route wiring', () => {
  it('GET /supervisor is dev-role gated and cached', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/dev-autopilot.ts'), 'utf8');
    expect(src).toMatch(/router\.get\('\/supervisor', requireDevRole,/);
    expect(src).toContain('SUPERVISOR_CACHE_MS');
  });
});
