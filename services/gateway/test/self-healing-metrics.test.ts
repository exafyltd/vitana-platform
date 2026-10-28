/**
 * Step 5 — Self-Healing observability aggregator.
 *
 * aggregateSelfHealingMetrics() turns the rows the loop already writes into the
 * rates + breakdowns the dashboard surfaces. These lock the contract: outcome
 * tallies, the Step-2 actionable split, escalations-by-class, and the two rates
 * (self-healing resolved-rate, autopilot success-rate) with divide-by-zero
 * guards.
 */

import {
  aggregateSelfHealingMetrics,
  type SelfHealingLogRow,
  type AutopilotExecRow,
} from '../src/services/self-healing-metrics';

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('aggregateSelfHealingMetrics', () => {
  it('returns zeroed rates and empty breakdowns for no data (no divide-by-zero)', () => {
    const m = aggregateSelfHealingMetrics([], [], 7, NOW);
    expect(m.window_days).toBe(7);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.self_healing.total).toBe(0);
    expect(m.self_healing.resolved_rate).toBe(0);
    expect(m.dev_autopilot.success_rate).toBe(0);
    expect(m.self_healing.by_outcome).toEqual({});
  });

  it('tallies outcomes and computes the self-healing resolved-rate (fixed / terminal)', () => {
    const logs: SelfHealingLogRow[] = [
      { outcome: 'fixed', confidence: 0.9 },
      { outcome: 'fixed', confidence: 0.7 },
      { outcome: 'failed', confidence: 0.4 },
      { outcome: 'escalated', failure_class: 'dev_autopilot_low_confidence', confidence: 0.2 },
      { outcome: 'pending' }, // not terminal — excluded from the rate
    ];
    const m = aggregateSelfHealingMetrics(logs, [], 7, NOW);
    expect(m.self_healing.by_outcome).toEqual({ fixed: 2, failed: 1, escalated: 1, pending: 1 });
    // fixed(2) / (fixed 2 + failed 1 + escalated 1) = 2/4 = 0.5
    expect(m.self_healing.resolved_rate).toBe(0.5);
  });

  it('surfaces the Step-2 actionable split and non-actionable reasons', () => {
    const logs: SelfHealingLogRow[] = [
      { outcome: 'escalated', failure_class: 'environmental_blocker', diagnosis: { actionable: false, non_actionable_reason: 'environmental' } },
      { outcome: 'escalated', failure_class: 'dev_autopilot_safety_gate_blocked', diagnosis: { actionable: false, non_actionable_reason: 'policy_block' } },
      { outcome: 'fixed', diagnosis: { actionable: true } },
      { outcome: 'pending' }, // no actionable tag → unknown
    ];
    const m = aggregateSelfHealingMetrics(logs, [], 30, NOW);
    expect(m.self_healing.actionable).toEqual({ actionable: 1, non_actionable: 2, unknown: 1 });
    expect(m.self_healing.non_actionable_reasons).toEqual({ environmental: 1, policy_block: 1 });
    expect(m.self_healing.escalations_by_class).toEqual({
      environmental_blocker: 1,
      dev_autopilot_safety_gate_blocked: 1,
    });
  });

  it('averages triage confidence per outcome (calibration sanity check)', () => {
    const logs: SelfHealingLogRow[] = [
      { outcome: 'fixed', confidence: 0.8 },
      { outcome: 'fixed', confidence: 0.6 },
      { outcome: 'escalated', confidence: '0.2' }, // string tolerated
      { outcome: 'escalated', confidence: null }, // ignored in the average
    ];
    const m = aggregateSelfHealingMetrics(logs, [], 7, NOW);
    expect(m.self_healing.avg_confidence_by_outcome.fixed).toBe(0.7);
    expect(m.self_healing.avg_confidence_by_outcome.escalated).toBe(0.2);
  });

  it('computes autopilot success-rate and failure-stage breakdown', () => {
    const execs: AutopilotExecRow[] = [
      { status: 'completed' },
      { status: 'completed' },
      { status: 'completed' },
      { status: 'failed', failure_stage: 'ci' },
      { status: 'reverted', failure_stage: 'verification' },
      { status: 'failed_escalated', failure_stage: 'verification' },
      { status: 'running' }, // in-flight — excluded from the rate
    ];
    const m = aggregateSelfHealingMetrics([], execs, 7, NOW);
    expect(m.dev_autopilot.completed).toBe(3);
    expect(m.dev_autopilot.failed).toBe(3);
    // 3 / (3 + 3) = 0.5
    expect(m.dev_autopilot.success_rate).toBe(0.5);
    expect(m.dev_autopilot.failure_stage_breakdown).toEqual({ ci: 1, verification: 2 });
    expect(m.dev_autopilot.by_status.running).toBe(1);
  });
});
