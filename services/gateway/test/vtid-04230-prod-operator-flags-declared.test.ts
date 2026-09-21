/**
 * VTID-04230 — prod parity for the Operator Console / Dev Autopilot
 * capability flags. docs/AGENT-REGISTRY.md finding 4: production ran a
 * different operator than staging (rev 114 pinned one flag). The prod
 * gateway deploy workflow now DECLARES the same flags staging pins, with the
 * same values — and this suite pins that the two files cannot drift apart
 * again. Declaring is not deploying: the workflow is workflow_dispatch-only
 * and was NOT dispatched for this change (platform owner: "do NOT dispatch
 * prod").
 *
 * Deliberately NOT mirrored, each with a reason the workflow comment
 * records: the read-only SQL switch + secret (needs a Secrets Manager
 * reference this workflow cannot resolve) and DEEPSEEK_API_KEY (a secret the
 * task role may not read fails provisioning). The Dev Autopilot loop flags
 * (DEV_AUTOPILOT_WATCHER_LIVE / USE_JOB / JOB_CLOUD / LLM_REVIEW_ENABLED /
 * EXECUTOR_ENABLED) are declared by VTID-04227's own block, not this one —
 * test/vtid-04227-prod-dev-autopilot-flags-pinned.test.ts pins those.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

const MIRRORED = [
  'OPERATOR_EXECUTION_ONRAMP_ENABLED',
  'OPERATOR_ONRAMP_EXECUTOR',
  'OPERATOR_CODEBASE_READ_ENABLED',
  'OPERATOR_DB_READONLY_ENABLED',
  'OPERATOR_AWS_READONLY_ENABLED',
  'OPERATOR_BOOTSTRAP_PACK_ENABLED',
  'OPERATOR_BOOTSTRAP_BUILD_INFO_URLS',
  'OPERATOR_VTID_SELF_ALLOCATE_ENABLED',
  'OPERATOR_PR_APPROVAL_REQUIRED',
  'OPERATOR_THREADS_ENABLED',
  'OPERATOR_TURN_MEMORY_ENABLED',
  'OPERATOR_CODEINTEL_ENABLED',
  'OPERATOR_PLANNER_ENABLED',
];

function pinnedValue(yml: string, name: string): string | null {
  const m = yml.match(new RegExp(`\\{name:"${name}", value:"([^"]*)"\\}`));
  return m ? m[1] : null;
}

function prodRationale(): string {
  // The step-level header comment (8-space indent, before `run: |`).
  const start = prod.indexOf('\n        # VTID-04230') + 1;
  expect(start).toBeGreaterThan(0);
  const end = prod.indexOf('\n        run: |', start);
  expect(end).toBeGreaterThan(start);
  return prod.slice(start, end);
}

function prodBlock(): string {
  // The block INSIDE the run: body (10-space indent). The step's header
  // comment carries the long rationale (moved out of the run: scalar for the
  // VTID-03788 20,000-char guard) and is not the jq pass this suite pins.
  const start = prod.indexOf('\n          # VTID-04230') + 1;
  expect(start).toBeGreaterThan(0);
  // Bounded by the next VTID-marked block, whichever it is — sibling blocks
  // (the Dev Autopilot loop flags, the VTID-03618 pins) are not this one's.
  const end = prod.indexOf("\n          # VTID-", start + 1);
  expect(end).toBeGreaterThan(start);
  return prod.slice(start, end);
}

describe('VTID-04230: prod declares the operator/autopilot flags staging pins', () => {
  it.each(MIRRORED)('%s is pinned on prod with exactly the value staging pins', (flag) => {
    const s = pinnedValue(staging, flag);
    const p = pinnedValue(prod, flag);
    expect(s).not.toBeNull();
    expect(p).toBe(s);
  });

  it.each(MIRRORED)('strips an inherited %s first, so a stale value cannot survive a deploy', (flag) => {
    const block = prodBlock();
    const strip = block.slice(0, block.indexOf('| not) ]'));
    expect(strip).toContain(`"${flag}"`);
  });

  it('is one unconditional jq pass in the pinned-flags step, not a dispatch input (so PUBLISH promotes it too)', () => {
    const block = prodBlock();
    expect(block).toContain("NEW_DEF=$(echo \"$NEW_DEF\" | jq '");
    expect(block).not.toMatch(/inputs\./);
    expect(block).not.toMatch(/_INPUT/);
  });

  it('deliberately does not pin the SQL-readonly or DeepSeek wiring on prod, and says why', () => {
    expect(prod).not.toContain('OPERATOR_SQL_READONLY');
    expect(prod).not.toContain('DEEPSEEK_API_KEY');
    expect(prod).not.toContain('CODEINTEL_PLATFORM_REPO_DIR');
    // The rationale lives in the step's header comment (outside the run:
    // scalar, VTID-03788 size guard); the jq pass is what prodBlock() bounds.
    const rationale = prodRationale();
    expect(rationale).toMatch(/does not deploy/);
    expect(rationale).toMatch(/secretsmanager:Describe/);
    expect(rationale).toMatch(/loop-flags block directly above/);
    // The loop flags live in VTID-04227's block, not in this one.
    expect(prodBlock()).not.toContain('"DEV_AUTOPILOT_USE_JOB"');
  });

  it('every mirrored flag is a code-level exact-string gate, so a wrong value is off, never on', () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../src/services', rel), 'utf8');
    expect(src('operator-execution-onramp.ts')).toContain("process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED === 'true'");
    expect(src('gemini-operator.ts')).toContain("process.env.OPERATOR_CODEINTEL_ENABLED !== 'true'");
    expect(src('operator-bootstrap-pack.ts')).toMatch(/OPERATOR_BOOTSTRAP_PACK_ENABLED[^\n]*=== 'true'/);
  });

  it('the prod workflow still has no push trigger — declaring here never deploys on merge', () => {
    expect(prod).not.toMatch(/^\s*push:\s*$/m);
    expect(prod).toMatch(/workflow_dispatch:/);
  });
});
