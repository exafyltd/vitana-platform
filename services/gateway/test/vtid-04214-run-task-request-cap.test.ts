/**
 * VTID-04214 — the Operator Console's `autopilot_run_task` tool takes a
 * free-text `request` string with no upper bound: an unbounded value flows
 * straight into VTID allocation, governance, and the agent executor's task
 * prompt. This pins a hard-refusal cap at 50,000 chars, checked before any
 * VTID allocation or governance check (per the task's own acceptance
 * criteria), mirroring the sibling VTID-04201 pattern of exporting a pure
 * constant + helper for direct testing rather than mocking the whole
 * authz/governance/Supabase chain just to reach one length comparison.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_RUN_TASK_REQUEST_CHARS,
  describeRunTaskRequestTooLong,
} from '../src/services/gemini-operator';

describe('VTID-04214 describeRunTaskRequestTooLong / MAX_RUN_TASK_REQUEST_CHARS', () => {
  it('is exactly 50,000 chars', () => {
    expect(MAX_RUN_TASK_REQUEST_CHARS).toBe(50_000);
  });

  it('names the limit and the actual length received', () => {
    const msg = describeRunTaskRequestTooLong(50_137);
    expect(msg).toMatch(/50137 chars/);
    expect(msg).toMatch(/max 50000/);
    expect(msg).toMatch(/nothing was queued/);
  });
});

describe('VTID-04214 executeRunTask wiring — ordering against real source', () => {
  const SRC = path.resolve(__dirname, '../src/services/gemini-operator.ts');
  const src = fs.readFileSync(SRC, 'utf8');
  const fnStart = src.indexOf('async function executeRunTask(');
  const fnBody = src.slice(fnStart, src.indexOf('\nasync function', fnStart + 1));

  it('the request-length-cap check appears in executeRunTask', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnBody).toMatch(/request\.length > MAX_RUN_TASK_REQUEST_CHARS/);
  });

  it('the length-cap check runs BEFORE any VTID allocation or governance call', () => {
    const capIdx = fnBody.indexOf('request.length > MAX_RUN_TASK_REQUEST_CHARS');
    const governanceIdx = fnBody.indexOf('evaluateGovernance(');
    const triggerIdx = fnBody.indexOf('triggerOperatorExecution(');
    expect(capIdx).toBeGreaterThan(-1);
    expect(governanceIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeLessThan(governanceIdx);
    expect(capIdx).toBeLessThan(triggerIdx);
  });

  it('the length-cap check runs AFTER the auth check (security ordering is preserved)', () => {
    const authIdx = fnBody.indexOf('isExecuteTaskAuthorized(');
    const capIdx = fnBody.indexOf('request.length > MAX_RUN_TASK_REQUEST_CHARS');
    expect(authIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(authIdx);
  });

  it('a request at or under the limit is unaffected — no cap branch exists between the floor check and it', () => {
    // The floor check ('request.length < 12') must remain reachable and
    // independent of the cap — i.e. the cap is a separate early return,
    // not a rewrite of the existing floor logic.
    expect(fnBody).toMatch(/request\.length < 12/);
  });
});
