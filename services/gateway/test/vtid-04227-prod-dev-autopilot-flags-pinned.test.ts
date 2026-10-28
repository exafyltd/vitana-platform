/**
 * VTID-04227 — the Dev Autopilot loop's five operating flags are DECLARED on
 * the prod gateway deploy workflow, not left to whatever the live task def
 * happens to carry.
 *
 * Read off `vitana-gateway-awsdr` rev 114 on 2026-09-21: DEV_AUTOPILOT_JOB_CLOUD
 * =aws and DEV_AUTOPILOT_EXECUTOR_ENABLED=false were present; WATCHER_LIVE,
 * USE_JOB and LLM_REVIEW_ENABLED were absent. An absent WATCHER_LIVE means
 * dev-autopilot-watcher.ts runs in DRY_RUN and synthesizes ci_passed /
 * pr_merged / deployed transitions it never checked against GitHub — it did
 * exactly that to a staging row (VTID-04003, gap analysis §7).
 *
 * Declaring is not promoting: this workflow is workflow_dispatch-only, so
 * nothing on prod changes until an owner dispatches it (IF-THEN 26).
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');

const FLAGS: Array<[string, string]> = [
  ['DEV_AUTOPILOT_WATCHER_LIVE', 'true'],
  ['DEV_AUTOPILOT_USE_JOB', 'true'],
  ['DEV_AUTOPILOT_JOB_CLOUD', 'aws'],
  ['DEV_AUTOPILOT_LLM_REVIEW_ENABLED', 'true'],
  ['DEV_AUTOPILOT_EXECUTOR_ENABLED', 'true'],
];

function pinBlock(text: string): string {
  const start = text.indexOf('VTID-04227');
  expect(start).toBeGreaterThan(-1);
  const jq = text.indexOf("NEW_DEF=$(echo \"$NEW_DEF\" | jq '", start);
  const end = text.indexOf("] )')", jq);
  return text.slice(jq, end);
}

describe('VTID-04227: prod gateway workflow declares the Dev Autopilot flags', () => {
  const block = pinBlock(prod);

  for (const [name, value] of FLAGS) {
    it(`pins ${name}="${value}" unconditionally`, () => {
      expect(block).toContain(`{name:"${name}", value:"${value}"}`);
    });

    it(`strips any inherited ${name} first, so a stale live value cannot survive a deploy`, () => {
      const strip = block.slice(0, block.indexOf('| not) ]'));
      expect(strip).toContain(`"${name}"`);
    });
  }

  it('the block is unconditional — not behind an `if [ -n "$…INPUT" ]` guard', () => {
    // The 200 characters before the jq call must not be an input guard.
    const idx = prod.indexOf(block);
    const before = prod.slice(Math.max(0, idx - 200), idx);
    expect(before).not.toMatch(/if \[ -n "\$[A-Z_]+_INPUT" \]; then\s*$/);
  });

  it('the per-dispatch circuit breaker (dev_autopilot_executor_enabled input) still runs AFTER the declaration, so it wins for that dispatch', () => {
    const declIdx = prod.indexOf('VTID-04227');
    const breakerIdx = prod.indexOf('if [ -n "$DEV_AUTOPILOT_EXECUTOR_INPUT" ]; then');
    expect(breakerIdx).toBeGreaterThan(declIdx);
    expect(prod).toContain('dev_autopilot_executor_enabled:');
  });

  it('never pins the gcp job cloud anywhere', () => {
    expect(prod).not.toMatch(/\{name:"DEV_AUTOPILOT_JOB_CLOUD", value:"gcp"\}/);
  });

  it('prod and staging now agree on all five values (VTID-03850 / VTID-03883 staging pins)', () => {
    for (const [name, value] of FLAGS) {
      if (name === 'DEV_AUTOPILOT_EXECUTOR_ENABLED') continue; // staging relies on the code default (!== 'false')
      expect(staging).toMatch(new RegExp(`\\{name:"${name}", value:"${value}"\\}`));
    }
  });

  it('is still workflow_dispatch-only — declaring is not deploying', () => {
    expect(prod).not.toMatch(/^\s+push:\s*$/m);
    expect(prod).toMatch(/workflow_dispatch:/);
  });
});
