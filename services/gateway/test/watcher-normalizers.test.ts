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
  PLACEHOLDER_VTID,
  readExecutionId,
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

// =============================================================================
// VTID-03461 — regressions found in Codex review of PR #3024
// =============================================================================

describe('work-unit identity for dev-autopilot events (review finding P1)', () => {
  /**
   * Every dev-autopilot emitter passes the CONSTANT
   * WATCHER_VTID = 'VTID-DEV-AUTOPILOT' (dev-autopilot-watcher.ts:30) as the
   * event's vtid, and puts the real execution UUID in the payload — stored
   * as the `metadata` column. Keying the work unit on vtid collapsed EVERY
   * autopilot execution ever run into one shared unit, which is precisely
   * the case /timeline exists to serve.
   */
  it('keys on metadata.execution_id, not the placeholder VTID', () => {
    const a = normalizeOasisEvent(oasisRow({
      id: 'e1', topic: 'dev_autopilot.execution.ci_passed',
      vtid: 'VTID-DEV-AUTOPILOT', metadata: { execution_id: 'exec-AAA' },
    }));
    const b = normalizeOasisEvent(oasisRow({
      id: 'e2', topic: 'dev_autopilot.execution.pr_merged',
      vtid: 'VTID-DEV-AUTOPILOT', metadata: { execution_id: 'exec-BBB' },
    }));
    expect(a!.work_unit_id).toBe('exec-AAA');
    expect(b!.work_unit_id).toBe('exec-BBB');
    // The whole point: two different executions must NOT share a work unit.
    expect(a!.work_unit_id).not.toBe(b!.work_unit_id);
    expect(a!.work_unit_kind).toBe('execution');
  });

  it('does not write the placeholder into the vtid column', () => {
    // Stamping 'VTID-DEV-AUTOPILOT' on thousands of rows would make the vtid
    // index useless and imply a governed ledger task that does not exist.
    const s = normalizeOasisEvent(oasisRow({
      vtid: 'VTID-DEV-AUTOPILOT', metadata: { execution_id: 'exec-1' },
    }));
    expect(s!.vtid).toBeNull();
    expect(s!.evidence).toMatchObject({ emitter_vtid: 'VTID-DEV-AUTOPILOT' });
  });

  it('still groups by real VTID when the event carries one', () => {
    const s = normalizeOasisEvent(oasisRow({ vtid: 'VTID-01234', metadata: {} }));
    expect(s!.work_unit_kind).toBe('vtid');
    expect(s!.work_unit_id).toBe('VTID-01234');
    expect(s!.vtid).toBe('VTID-01234');
  });

  it('prefers the execution id over a real VTID', () => {
    // An execution is the finer-grained unit of work; the VTID is retained
    // separately so a VTID-wide query still finds the row.
    const s = normalizeOasisEvent(oasisRow({
      vtid: 'VTID-01234', metadata: { execution_id: 'exec-9' },
    }));
    expect(s!.work_unit_id).toBe('exec-9');
    expect(s!.vtid).toBe('VTID-01234');
  });

  it('falls back to the event id when there is neither', () => {
    const s = normalizeOasisEvent(oasisRow({ id: 'evt-x', vtid: null, metadata: null }));
    expect(s!.work_unit_id).toBe('evt-x');
    expect(s!.vtid).toBeNull();
  });

  it('accepts executionId as well as execution_id', () => {
    const s = normalizeOasisEvent(oasisRow({ metadata: { executionId: 'exec-camel' } }));
    expect(s!.work_unit_id).toBe('exec-camel');
  });

  it('ignores a non-string or blank execution id', () => {
    expect(normalizeOasisEvent(oasisRow({ vtid: 'VTID-1', metadata: { execution_id: 42 } }))!.work_unit_id).toBe('VTID-1');
    expect(normalizeOasisEvent(oasisRow({ vtid: 'VTID-1', metadata: { execution_id: '  ' } }))!.work_unit_id).toBe('VTID-1');
  });
});

describe('pr_opened topic (review finding P2)', () => {
  /**
   * Emitted at dev-autopilot-execute.ts:2483 on the SUCCESS path, where the
   * row goes straight to status='ci' — so the execution-row poll can only
   * ever yield a 'ci' step and pr_opened would never appear at all.
   *
   * It was missing because it did not show up in the 45-day topic census.
   * "Absent from the census" means "did not fire recently", NOT "does not
   * exist" — the emitting code is the authority, not the sample.
   */
  it('is observed and maps to the pr_opened step', () => {
    const s = normalizeOasisEvent(oasisRow({ topic: 'dev_autopilot.execution.pr_opened' }));
    expect(s).not.toBeNull();
    expect(s!.step).toBe('pr_opened');
    expect(s!.outcome).toBe('success');
  });

  it('is on the observed-topics list', () => {
    expect(observedTopics()).toContain('dev_autopilot.execution.pr_opened');
  });
});
