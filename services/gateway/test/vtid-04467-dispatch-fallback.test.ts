/**
 * VTID-04467 — an agent execution whose executor task could not be started
 * is never run inside the gateway process (which has no tsc).
 *
 * AC-1 single-shot, or an agent run on a process that has the toolchain →
 *      in-process, exactly as before.
 * AC-2 agent run without the toolchain → requeue (back to `cooling`, growing
 *      delay) until MAX_DISPATCH_ATTEMPTS, then fail.
 * AC-3 the failure reason names the dispatch error and matches the retry
 *      breaker's outage pattern, so it never counts against the finding.
 * AC-4 the dispatch loop consults the decision before its in-process
 *      fallback, requeues/fails through one helper that releases the run
 *      lease, and never routes a dispatch failure through the self-heal bridge.
 * AC-5 the toolchain probe looks for tsc in the linked node_modules and git.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_DISPATCH_ATTEMPTS, agentToolchainPresent, decideDispatchFallback, dispatchFailureError, priorDispatchFailures,
  requeueDelayMs, resetToolchainCache, resolveMaxDispatchAttempts,
} from '../src/services/dev-autopilot-dispatch-fallback';
import { decideRetryBreaker, isProviderOutageFailure } from '../src/services/dev-autopilot-retry-breaker';

describe('decideDispatchFallback (AC-1, AC-2)', () => {
  test('single-shot always runs in-process', () => {
    expect(decideDispatchFallback({ mode: 'single-shot', toolchainPresent: false, priorDispatchFailures: 9 })).toBe('in_process');
  });
  test('an agent run on a process with the toolchain runs in-process', () => {
    expect(decideDispatchFallback({ mode: 'agent', toolchainPresent: true, priorDispatchFailures: 0 })).toBe('in_process');
  });
  test('an agent run without the toolchain requeues, then fails on the last attempt', () => {
    expect(MAX_DISPATCH_ATTEMPTS).toBe(3);
    expect(decideDispatchFallback({ mode: 'agent', toolchainPresent: false, priorDispatchFailures: 0 })).toBe('requeue');
    expect(decideDispatchFallback({ mode: 'agent', toolchainPresent: false, priorDispatchFailures: 1 })).toBe('requeue');
    expect(decideDispatchFallback({ mode: 'agent', toolchainPresent: false, priorDispatchFailures: 2 })).toBe('fail');
    expect(decideDispatchFallback({ mode: 'agent', toolchainPresent: false, priorDispatchFailures: 0, maxAttempts: 1 })).toBe('fail');
  });
  test('requeue delay grows 2, 4, 8 … minutes, capped at 30', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => requeueDelayMs(n) / 60_000)).toEqual([2, 4, 8, 16, 30, 30]);
  });
  test('prior failures are read from the row metadata; garbage is zero', () => {
    expect(priorDispatchFailures({ dispatch_failures: 2 })).toBe(2);
    expect(priorDispatchFailures({ dispatch_failures: 'x' })).toBe(0);
    expect(priorDispatchFailures(null)).toBe(0);
  });
  test('max attempts is env-tunable within 1..20', () => {
    expect(resolveMaxDispatchAttempts({ DEV_AUTOPILOT_MAX_DISPATCH_ATTEMPTS: '5' } as any)).toBe(5);
    expect(resolveMaxDispatchAttempts({ DEV_AUTOPILOT_MAX_DISPATCH_ATTEMPTS: '0' } as any)).toBe(3);
    expect(resolveMaxDispatchAttempts({ DEV_AUTOPILOT_MAX_DISPATCH_ATTEMPTS: 'many' } as any)).toBe(3);
    expect(resolveMaxDispatchAttempts({} as any)).toBe(3);
  });
});

describe('failure reason (AC-3)', () => {
  const live = 'AccessDeniedException: Operation not allowed on RunTask';
  const err = dispatchFailureError(3, live);

  test('names the attempts and the dispatch error', () => {
    expect(err).toContain('after 3 attempt(s)');
    expect(err).toContain(live);
    expect(err).toContain('never run inside the gateway process');
  });
  test('is an outage-class failure even when the dispatch error itself is not', () => {
    expect(isProviderOutageFailure({ error: dispatchFailureError(3, 'InvalidParameterException: no capacity') })).toBe(true);
  });
  test('five of them never snooze the finding', () => {
    const rows = Array.from({ length: 5 }, () => ({ metadata: { error: err } }));
    expect(decideRetryBreaker(rows)).toBe('admit');
  });
});

describe('dispatch loop wiring (AC-4)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  const loopStart = src.indexOf('let dispatchError: string | null = null;');
  const loopEnd = src.indexOf('runExecutionSession(s, exec.id).then(', loopStart);
  const loop = src.slice(loopStart, loopEnd);
  const helperStart = src.indexOf('async function handleDispatchFailure(');
  const helper = src.slice(helperStart, src.indexOf('VTID-02703: dispatch a Cloud Run Job execution', helperStart));

  test('the helper slice is bounded', () => {
    expect(helperStart).toBeGreaterThan(0);
    expect(helper.length).toBeGreaterThan(200);
    expect(helper.length).toBeLessThan(5000);
  });
  test('the decision sits between the dispatch attempt and the in-process fallback', () => {
    expect(loopStart).toBeGreaterThan(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(loop).toContain('decideDispatchFallback({');
    expect(loop).toContain('toolchainPresent: agentToolchainPresent()');
    expect(loop).toMatch(/if \(fallback !== 'in_process'\) \{\s*await handleDispatchFailure\(s, exec, fallback, dispatchError \|\| 'unknown dispatch error'\);\s*continue;/);
  });
  test('requeue is a conditional PATCH back to cooling with execute_after and the attempt count', () => {
    expect(helper).toContain("status: 'cooling'");
    expect(helper).toContain('execute_after: executeAfter');
    expect(helper).toContain('dispatch_failures: attempts');
    expect(helper).toContain('&status=eq.running');
  });
  test('both outcomes release the run lease and emit their own event', () => {
    expect(helper).toContain('releaseDevRunLease(');
    expect(helper).toContain("'dev_autopilot.execution.dispatch_deferred'");
    expect(helper).toContain("'dev_autopilot.execution.dispatch_failed'");
  });
  test('a dispatch failure never goes through applyExecutionResult (no self-heal bridge)', () => {
    expect(helper).not.toContain('applyExecutionResult(');
    expect(helper).toContain('buildExecutionFailurePatch(');
  });
  test('the event types are declared', () => {
    const types = fs.readFileSync(path.join(__dirname, '../src/types/cicd.ts'), 'utf8');
    expect(types).toContain("'dev_autopilot.execution.dispatch_deferred'");
    expect(types).toContain("'dev_autopilot.execution.dispatch_failed'");
  });
});

describe('agentToolchainPresent (AC-5)', () => {
  afterEach(() => resetToolchainCache());

  test('false when the linked node_modules has no tsc (the gateway image)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
    expect(agentToolchainPresent(dir)).toBe(false);
  });
  test('true when tsc is present and git runs (the executor image)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
    fs.mkdirSync(path.join(dir, '.bin'));
    fs.writeFileSync(path.join(dir, '.bin', 'tsc'), '');
    expect(agentToolchainPresent(dir)).toBe(true);
  });
  test('the answer is cached for the process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
    expect(agentToolchainPresent(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, '.bin'));
    fs.writeFileSync(path.join(dir, '.bin', 'tsc'), '');
    expect(agentToolchainPresent(dir)).toBe(false);
  });
});
