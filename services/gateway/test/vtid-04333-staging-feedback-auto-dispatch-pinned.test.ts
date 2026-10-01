/**
 * VTID-04333 — FEEDBACK_AUTO_DISPATCH_ENABLED is pinned to exact "true" on the
 * AWS STAGING gateway workflow only (owner decision 2026-09-23). Prod is not
 * touched: its workflow neither declares nor strips the flag.
 */
import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const FLAG = 'FEEDBACK_AUTO_DISPATCH_ENABLED';

function envStripList(): string {
  const block = staging.slice(
    staging.indexOf('.containerDefinitions[0].environment |='),
    staging.indexOf('.containerDefinitions[0].secrets |='),
  );
  return block.slice(0, block.indexOf('| not) ]'));
}

describe('VTID-04333: staging pins FEEDBACK_AUTO_DISPATCH_ENABLED=true', () => {
  it('pins the flag to exact "true" on the staging task def', () => {
    expect(staging).toContain(`{name:"${FLAG}", value:"true"}`);
  });

  it('strips an inherited value first, so a stale value cannot survive a deploy', () => {
    expect(envStripList()).toContain(`"${FLAG}"`);
  });

  it('is pinned exactly once (no duplicate env entry)', () => {
    expect(staging.split(`{name:"${FLAG}"`).length - 1).toBe(1);
  });

  it('is NOT declared on the prod gateway deploy workflow', () => {
    expect(prod).not.toContain(FLAG);
  });

  it('the drafter reads it with the exact-string check (a typo is off)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/feedback-spec-drafter.ts'), 'utf8');
    expect(src).toContain("env.FEEDBACK_AUTO_DISPATCH_ENABLED === 'true'");
  });
});
