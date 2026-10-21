/**
 * VTID-04247 — the executor claim stamps `metadata.executor` from the
 * process pin so the bridge's fix-mode gate (isFixModeEligible) sees an
 * agent parent instead of reverting it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claimExecutorStamp } from '../src/services/autopilot-agent/executor-mode';
import { isFixModeEligible } from '../src/services/dev-autopilot-bridge';

describe('VTID-04247 claimExecutorStamp', () => {
  it('stamps the process pin when the row has no executor of its own', () => {
    expect(claimExecutorStamp({}, { DEV_AUTOPILOT_EXECUTOR: 'agent' } as NodeJS.ProcessEnv)).toEqual({ executor: 'agent' });
    expect(claimExecutorStamp(null, { DEV_AUTOPILOT_EXECUTOR: ' Agent ' } as NodeJS.ProcessEnv)).toEqual({ executor: 'agent' });
    expect(claimExecutorStamp({ claimed_env: 'staging' }, { DEV_AUTOPILOT_EXECUTOR: 'single-shot' } as NodeJS.ProcessEnv)).toEqual({ executor: 'single-shot' });
  });

  it('never overrides a row that already names its executor', () => {
    expect(claimExecutorStamp({ executor: 'single-shot' }, { DEV_AUTOPILOT_EXECUTOR: 'agent' } as NodeJS.ProcessEnv)).toEqual({});
    expect(claimExecutorStamp({ executor: 'agent' }, { DEV_AUTOPILOT_EXECUTOR: 'single-shot' } as NodeJS.ProcessEnv)).toEqual({});
  });

  it('stamps nothing when the process has no pin (a process without the pin must not force single-shot onto the ECS executor)', () => {
    expect(claimExecutorStamp({}, {} as NodeJS.ProcessEnv)).toEqual({});
    expect(claimExecutorStamp({}, { DEV_AUTOPILOT_EXECUTOR: '' } as NodeJS.ProcessEnv)).toEqual({});
    expect(claimExecutorStamp({}, { DEV_AUTOPILOT_EXECUTOR: 'bogus' } as NodeJS.ProcessEnv)).toEqual({});
  });

  it('a stamped auto-approved parent is fix-mode eligible at stage ci', () => {
    const parent = {
      branch: 'dev-autopilot/abcd1234', pr_number: 3548, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3548',
      metadata: { claimed_env: 'staging', ...claimExecutorStamp({ claimed_env: 'staging' }, { DEV_AUTOPILOT_EXECUTOR: 'agent' } as NodeJS.ProcessEnv) },
    };
    expect(isFixModeEligible(parent, 'ci', false)).toBe(true);
    // The pre-fix shape (no executor on the row) was never eligible — the live 2026-09-21 revert.
    expect(isFixModeEligible({ ...parent, metadata: { claimed_env: 'staging' } }, 'ci', false)).toBe(false);
  });
});

describe('VTID-04247 executor claim wiring (source contract)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  it('the cooling→running claim PATCH merges claimExecutorStamp into the row metadata', () => {
    expect(src).toMatch(/status=eq\.cooling`, \{[\s\S]*?status: 'running',[\s\S]*?metadata: \{ \.\.\.\(exec\.metadata \|\| \{\}\), \.\.\.claimStamp\(\), \.\.\.claimExecutorStamp\(exec\.metadata\) \},/);
  });
});
