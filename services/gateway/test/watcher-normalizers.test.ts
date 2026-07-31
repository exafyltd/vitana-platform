/**
 * VTID-03460 — Watcher Phase 1 normalizer tests.
 *
 * These are the load-bearing tests for the phase. The observer rescans an
 * overlap window on every tick, so a normalizer that is not deterministic
 * silently produces duplicate-but-different rows, and the whole timeline
 * becomes untrustworthy. Determinism and the allowlist boundary are what
 * get exercised hardest here.
 */

import {
  SOURCE_EXECUTIONS,
  SOURCE_OASIS,
  deriveOutcome,
  normalizeExecution,
  normalizeOasisEvent,
  observedTopics,
  type ExecutionRow,
  type OasisEventRow,
} from '../src/services/watcher/normalizers';

function oasisRow(overrides: Partial<OasisEventRow> = {}): OasisEventRow {
  return {
    id: 'evt-1',
    topic: 'dev_autopilot.plan.generated',
    vtid: 'VTID-01234',
    status: 'success',
    message: 'plan generated',
    service: 'gateway',
    source: 'dev-autopilot',
    metadata: {},
    created_at: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

function execRow(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: 'exec-1',
    status: 'ci',
    finding_id: 'find-1',
    branch: 'claude/x',
    pr_url: 'https://github.com/exafyltd/vitana-platform/pull/1',
    pr_number: 1,
    failure_stage: null,
    self_healing_vtid: null,
    parent_execution_id: null,
    auto_fix_depth: 0,
    updated_at: '2026-07-30T11:00:00.000Z',
    ...overrides,
  };
}

describe('deriveOutcome', () => {
  it.each([
    ['success', 'success'],
    ['ok', 'success'],
    ['passed', 'success'],
    ['error', 'failure'],
    ['failed', 'failure'],
    ['failure', 'failure'],
    ['skipped', 'skipped'],
    ['declined', 'skipped'],
  ])('maps %s -> %s', (input, expected) => {
    expect(deriveOutcome(input)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(deriveOutcome('SUCCESS')).toBe('success');
    expect(deriveOutcome('Error')).toBe('failure');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(deriveOutcome(null)).toBe('unknown');
    expect(deriveOutcome(undefined)).toBe('unknown');
    expect(deriveOutcome('')).toBe('unknown');
    expect(deriveOutcome('in_progress')).toBe('unknown');
  });
});

describe('normalizeOasisEvent — allowlist boundary', () => {
  it('maps an allowlisted development topic', () => {
    const step = normalizeOasisEvent(oasisRow());
    expect(step).not.toBeNull();
    expect(step!.step).toBe('planned');
    expect(step!.outcome).toBe('success');
    expect(step!.actor).toBe('autopilot');
    expect(step!.source).toBe(SOURCE_OASIS);
  });

  /**
   * The whole reason the allowlist exists. These are real production topics
   * with very high volume — `autopilot.health.stuck_task` fired 2,692 times
   * in 45 days. If any of them starts producing steps, the timeline drowns.
   */
  it.each([
    'autopilot.health.stuck_task',
    'autopilot.heartbeat.matches_delivered',
    'autopilot.recommendation.scheduled.completed',
    'autopilot.recommendation.community.completed',
    'vtid.daily_recompute.completed',
    'vtid.daily_recompute.started',
    'vtid.live.session.start',
    'vtid.live.session.stop',
    'vtid.live.audio.in.chunk',
    'vtid.stage.matches.success',
    'vtid.stage.topics.success',
    'vtid.stage.longevity.success',
    'vtid.stage.index.success',
    'vtid.stage.community_recs.success',
    'worker_runner.registered',
    'dev_autopilot.scan.started',
    'dev_autopilot.scan.completed',
  ])('ignores product/telemetry topic %s', (topic) => {
    expect(normalizeOasisEvent(oasisRow({ topic }))).toBeNull();
  });

  it('ignores an unknown topic instead of inventing a step', () => {
    expect(normalizeOasisEvent(oasisRow({ topic: 'something.brand.new' }))).toBeNull();
    expect(normalizeOasisEvent(oasisRow({ topic: null }))).toBeNull();
    expect(normalizeOasisEvent(oasisRow({ topic: '' }))).toBeNull();
  });

  it('does not let the worker-stage prefix rule swallow product stages', () => {
    // vitally: vtid.stage.matches.success shares the vtid.stage. prefix with
    // vtid.stage.worker_backend.success but must not match.
    expect(normalizeOasisEvent(oasisRow({ topic: 'vtid.stage.matches.success' }))).toBeNull();
    expect(normalizeOasisEvent(oasisRow({ topic: 'vtid.stage.worker_backend.success' }))).not.toBeNull();
  });

  it.each([
    ['vtid.stage.worker_backend.start', 'running', 'unknown'],
    ['vtid.stage.worker_backend.success', 'running', 'success'],
    ['vtid.stage.worker_memory.failed', 'running', 'failure'],
    ['vtid.stage.worker_orchestrator.claimed', 'queued', 'success'],
    ['vtid.stage.worker_orchestrator.released', 'queued', 'skipped'],
  ])('maps worker stage %s -> %s/%s', (topic, step, outcome) => {
    const s = normalizeOasisEvent(oasisRow({ topic }));
    expect(s).not.toBeNull();
    expect(s!.step).toBe(step);
    expect(s!.outcome).toBe(outcome);
    expect(s!.actor).toBe('worker-runner');
  });

  it('treats a declined auto-merge as skipped, not failed', () => {
    // A safety gate doing its job must never be learned as a mistake.
    const s = normalizeOasisEvent(
      oasisRow({ topic: 'dev_autopilot.execution.auto_merge_declined', status: 'warning' }),
    );
    expect(s!.step).toBe('merged');
    expect(s!.outcome).toBe('skipped');
  });

  it('derives outcome from status only for derive-rules', () => {
    const derived = normalizeOasisEvent(
      oasisRow({ topic: 'worker_runner.exec_completed', status: 'error' }),
    );
    expect(derived!.outcome).toBe('failure');

    // Fixed-outcome rules ignore a contradicting status field.
    const fixed = normalizeOasisEvent(
      oasisRow({ topic: 'dev_autopilot.execution.ci_passed', status: 'error' }),
    );
    expect(fixed!.outcome).toBe('success');
  });
});

describe('normalizeOasisEvent — work unit + idempotency', () => {
  it('keys the work unit on the VTID when present', () => {
    const s = normalizeOasisEvent(oasisRow({ vtid: 'VTID-09999' }));
    expect(s!.work_unit_kind).toBe('vtid');
    expect(s!.work_unit_id).toBe('VTID-09999');
    expect(s!.vtid).toBe('VTID-09999');
  });

  it('keeps an event that has no VTID rather than dropping ungoverned work', () => {
    const s = normalizeOasisEvent(oasisRow({ vtid: null }));
    expect(s).not.toBeNull();
    expect(s!.vtid).toBeNull();
    expect(s!.work_unit_id).toBe('evt-1');
  });

  it('treats a blank/whitespace VTID as absent', () => {
    expect(normalizeOasisEvent(oasisRow({ vtid: '   ' }))!.vtid).toBeNull();
  });

  it('uses the event id as source_ref so replay is idempotent', () => {
    const s = normalizeOasisEvent(oasisRow({ id: 'evt-abc' }));
    expect(s!.source_ref).toBe('evt-abc');
  });

  it('is deterministic — same row in, identical step out', () => {
    const row = oasisRow();
    expect(normalizeOasisEvent(row)).toEqual(normalizeOasisEvent(row));
  });

  it('carries observed_at from the source row, never from the clock', () => {
    const s = normalizeOasisEvent(oasisRow({ created_at: '2026-01-01T00:00:00.000Z' }));
    expect(s!.observed_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('normalizeExecution', () => {
  it.each([
    ['queued', 'queued', 'unknown'],
    ['cooling', 'queued', 'unknown'],
    ['running', 'running', 'unknown'],
    ['ci', 'ci', 'unknown'],
    ['merging', 'merged', 'unknown'],
    ['deploying', 'deploying', 'unknown'],
    ['verifying', 'verified', 'unknown'],
    ['completed', 'completed', 'success'],
    ['failed', 'failed', 'failure'],
    ['reverted', 'reverted', 'failure'],
    ['self_healed', 'completed', 'success'],
    ['failed_escalated', 'escalated', 'failure'],
    ['cancelled', 'failed', 'skipped'],
  ])('maps execution status %s -> %s/%s', (status, step, outcome) => {
    const s = normalizeExecution(execRow({ status }));
    expect(s).not.toBeNull();
    expect(s!.step).toBe(step);
    expect(s!.outcome).toBe(outcome);
    expect(s!.source).toBe(SOURCE_EXECUTIONS);
  });

  it('skips auto_archived — archiving is bookkeeping, not lifecycle', () => {
    // Recording it would stamp a step at archive time, long after the work.
    expect(normalizeExecution(execRow({ status: 'auto_archived' }))).toBeNull();
  });

  it('ignores an unrecognised status rather than guessing', () => {
    expect(normalizeExecution(execRow({ status: 'wat' }))).toBeNull();
  });

  it('keys source_ref on (id, status) so one execution can contribute many steps', () => {
    const ci = normalizeExecution(execRow({ id: 'e1', status: 'ci' }));
    const merged = normalizeExecution(execRow({ id: 'e1', status: 'merging' }));
    expect(ci!.source_ref).toBe('e1:ci');
    expect(merged!.source_ref).toBe('e1:merging');
    expect(ci!.source_ref).not.toBe(merged!.source_ref);
  });

  it('re-observing the same status yields the same source_ref (dedupes on rescan)', () => {
    const a = normalizeExecution(execRow({ id: 'e1', status: 'ci' }));
    const b = normalizeExecution(execRow({ id: 'e1', status: 'ci', updated_at: '2026-07-30T12:00:00.000Z' }));
    expect(a!.source_ref).toBe(b!.source_ref);
  });

  it('preserves PR and failure provenance in evidence', () => {
    const s = normalizeExecution(execRow({ status: 'failed', failure_stage: 'deploy', pr_number: 42 }));
    expect(s!.evidence).toMatchObject({
      execution_status: 'failed',
      failure_stage: 'deploy',
      pr_number: 42,
    });
  });

  it('picks up the self-healing VTID when the execution carries one', () => {
    const s = normalizeExecution(execRow({ self_healing_vtid: 'VTID-02222' }));
    expect(s!.vtid).toBe('VTID-02222');
  });
});

describe('observedTopics', () => {
  it('is non-empty and sorted', () => {
    const topics = observedTopics();
    expect(topics.length).toBeGreaterThan(0);
    expect([...topics].sort()).toEqual(topics);
  });

  it('contains no user-facing product topics', () => {
    for (const t of observedTopics()) {
      expect(t).not.toMatch(/^autopilot\.(recommendation|heartbeat|health|intent|automation)\./);
      expect(t).not.toMatch(/^vtid\.(live|daily_recompute)\./);
    }
  });
});
