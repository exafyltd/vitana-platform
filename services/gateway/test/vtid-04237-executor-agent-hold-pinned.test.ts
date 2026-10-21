/**
 * VTID-04237 — auto-approved Dev Autopilot executions run on the agentic
 * executor and HOLD before opening a PR, on every process that can run one.
 *
 * autoApproveTick (dev-autopilot-execute.ts) creates execution rows with no
 * `metadata.executor` and no `metadata.require_approval`, so both decisions
 * fall through to the PROCESS env (resolveExecutorMode / approvalRequired):
 *   - the ECS executor task (vitana-autopilot-executor, the normal path since
 *     VTID-03850 dispatches every staging execution there), and
 *   - the staging gateway itself (the in-process fallback when RunTask is
 *     refused).
 * Live 2026-09-21 the executor task def (rev 21) carried neither value, so
 * flipping dev_autopilot_config.auto_approve_enabled would have produced
 * single-shot PRs that the live staging watcher merges on green with no
 * human step. Both workflows pin the two values here; this test keeps them
 * from silently dropping out of either strip/re-add block.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const executor = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

function stripList(src: string): string {
  const block = src.slice(src.indexOf('.containerDefinitions[0].environment |='));
  return block.slice(0, block.indexOf('| not) ]'));
}

describe('VTID-04237: executor task def pins agent mode + approval hold', () => {
  it('pins DEV_AUTOPILOT_EXECUTOR to the exact string "agent"', () => {
    expect(executor).toMatch(/\{name:"DEV_AUTOPILOT_EXECUTOR", value:"agent"\}/);
  });

  it('pins DEV_AUTOPILOT_PR_APPROVAL_REQUIRED to the exact string "true" (approvalRequired() compares exactly)', () => {
    expect(executor).toMatch(/\{name:"DEV_AUTOPILOT_PR_APPROVAL_REQUIRED", value:"true"\}/);
    expect(executor).not.toMatch(/\{name:"DEV_AUTOPILOT_PR_APPROVAL_REQUIRED", value:"false"\}/);
  });

  it('strips both inherited values first, so a stale task-def value cannot survive a deploy', () => {
    const strip = stripList(executor);
    expect(strip).toContain('"DEV_AUTOPILOT_EXECUTOR"');
    expect(strip).toContain('"DEV_AUTOPILOT_PR_APPROVAL_REQUIRED"');
  });
});

describe('VTID-04237: staging gateway (in-process fallback) pins the same two values', () => {
  it('pins DEV_AUTOPILOT_EXECUTOR=agent and DEV_AUTOPILOT_PR_APPROVAL_REQUIRED=true', () => {
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_EXECUTOR", value:"agent"\}/);
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_PR_APPROVAL_REQUIRED", value:"true"\}/);
  });

  it('strips both on staging too', () => {
    const strip = stripList(staging);
    expect(strip).toContain('"DEV_AUTOPILOT_EXECUTOR"');
    expect(strip).toContain('"DEV_AUTOPILOT_PR_APPROVAL_REQUIRED"');
  });

  it('does NOT touch the prod gateway workflow — prod keeps DEV_AUTOPILOT_EXECUTOR_ENABLED as declared by VTID-04227 and gets no new pins here', () => {
    expect(prod).not.toMatch(/\{name:"DEV_AUTOPILOT_EXECUTOR", value:/);
    expect(prod).not.toMatch(/\{name:"DEV_AUTOPILOT_PR_APPROVAL_REQUIRED", value:/);
  });
});

describe('VTID-04237: the pins target the code paths that actually read them', () => {
  const src = path.resolve(__dirname, '../src/services');
  const mode = fs.readFileSync(path.join(src, 'autopilot-agent/executor-mode.ts'), 'utf8');
  const approval = fs.readFileSync(path.join(src, 'dev-autopilot-approval.ts'), 'utf8');

  it('resolveExecutorMode reads DEV_AUTOPILOT_EXECUTOR from the process env', () => {
    expect(mode).toMatch(/env\.DEV_AUTOPILOT_EXECUTOR/);
  });

  it('approvalRequired reads DEV_AUTOPILOT_PR_APPROVAL_REQUIRED === "true" from the process env', () => {
    expect(approval).toMatch(/env\.DEV_AUTOPILOT_PR_APPROVAL_REQUIRED === 'true'/);
  });
});
