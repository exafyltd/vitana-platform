/**
 * Self-Healing reliability — "classify, don't delete" (Step 2).
 *
 * Dev Autopilot pipeline-stage failures are intentionally surfaced into
 * self_healing_log so the Self-Healing screen shows them. But most are infra /
 * policy events a human must resolve, not auto-fix candidates — and they were
 * escalating with generic classes + confidence 0, drowning out the genuinely
 * fixable failures. classifyAutopilotFailure() tags them:
 *   - environmental blockers are normalised to 'environmental_blocker' so the
 *     reconciler short-circuits retries (no SELF-HEAL retry loop), and
 *   - safety-gate / policy blocks are flagged actionable=false while keeping
 *     their own class.
 */

import { classifyAutopilotFailure } from '../src/services/dev-autopilot-self-heal-log';

describe('classifyAutopilotFailure', () => {
  it('normalises the worker-queue "unclaimed" failure to environmental_blocker', () => {
    // The canonical 2026-04-28 outage row: message says binary missing / daemon
    // down, but does NOT match isEnvironmentalBlocker()'s text patterns — the
    // class-based rule is what catches it.
    const result = classifyAutopilotFailure({
      failure_class: 'dev_autopilot_worker_queue_unclaimed',
      diagnosis: {
        summary:
          'no worker claimed task in 42m (worker daemon down / binary missing / network) — restart worker daemon',
      },
    });
    expect(result.failure_class).toBe('environmental_blocker');
    expect(result.actionable).toBe(false);
    expect(result.non_actionable_reason).toBe('environmental');
  });

  it('catches environmental blockers detected by isEnvironmentalBlocker (e.g. ENOENT spawn) from the summary text', () => {
    const result = classifyAutopilotFailure({
      failure_class: 'dev_autopilot_plan_gen_failed',
      diagnosis: { summary: 'spawn /usr/bin/claude ENOENT — Is Claude Code installed and on PATH' },
    });
    expect(result.failure_class).toBe('environmental_blocker');
    expect(result.actionable).toBe(false);
    expect(result.non_actionable_reason).toBe('environmental');
  });

  it('flags safety-gate blocks as non-actionable policy decisions but keeps their class', () => {
    const result = classifyAutopilotFailure({
      failure_class: 'dev_autopilot_safety_gate_blocked',
      diagnosis: { summary: 'Safety gate blocked approval: deny_scope hit' },
    });
    expect(result.failure_class).toBe('dev_autopilot_safety_gate_blocked');
    expect(result.actionable).toBe(false);
    expect(result.non_actionable_reason).toBe('policy_block');
  });

  it('classifies a Cloud Run deploy concurrency race as environmental (real EXEC-DEPLOY failure 2026-06-07)', () => {
    // Verbatim gcloud error from a failed gateway EXEC-DEPLOY run where three
    // deploys overlapped; the same commit deployed fine on retry. A code retry
    // can't fix a deploy-time optimistic-concurrency conflict.
    const result = classifyAutopilotFailure({
      failure_class: 'deploy',
      diagnosis: {
        summary:
          "ERROR: (gcloud.run.deploy) ABORTED: Conflict for resource 'gateway': version '1780664786361038' was specified but current version is '1780664788904494'.",
      },
    });
    expect(result.failure_class).toBe('environmental_blocker');
    expect(result.actionable).toBe(false);
    expect(result.non_actionable_reason).toBe('environmental');
  });

  it('leaves a genuinely auto-fixable code failure actionable and unchanged', () => {
    const result = classifyAutopilotFailure({
      failure_class: 'dev_autopilot_pr_open_failed',
      diagnosis: { summary: 'PR creation failed: branch ref already exists' },
    });
    expect(result.failure_class).toBe('dev_autopilot_pr_open_failed');
    expect(result.actionable).toBe(true);
    expect(result.non_actionable_reason).toBeNull();
  });

  it('handles a missing diagnosis summary without throwing', () => {
    const result = classifyAutopilotFailure({ failure_class: 'dev_autopilot_execute_run_failed' });
    expect(result.actionable).toBe(true);
    expect(result.non_actionable_reason).toBeNull();
  });
});
