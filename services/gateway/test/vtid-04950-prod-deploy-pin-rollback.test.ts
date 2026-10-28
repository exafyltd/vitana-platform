/**
 * VTID-04950 (plan E3) — every production deploy workflow can be pinned to the
 * approved commit, and every one that rolls a long-running ECS service can
 * roll itself back. Source contracts: the workflows have no runtime harness.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const WF = join(__dirname, '..', '..', '..', '.github', 'workflows');
const read = (f: string) => readFileSync(join(WF, f), 'utf8');

const SERVICES = [
  'AWS-PROD-DEPLOY-OASIS-OPERATOR.yml',
  'AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml',
  'AWS-PROD-DEPLOY-ORB-AGENT.yml',
  'AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml',
];

describe('VTID-04950 production deploys are pinned and roll back', () => {
  it.each([...SERVICES, 'AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml'])('%s checks out the pinned commit and verifies it', (f) => {
    const src = read(f);
    expect(src).toMatch(/commit_sha:\n\s+description:/);
    expect(src).toMatch(/ref: \$\{\{ inputs\.commit_sha \|\| github\.sha \}\}/);
    expect(src).toMatch(/Verify the pinned commit/);
  });

  it.each(SERVICES)('%s captures a rollback target before building and refuses to deploy without one', (f) => {
    const src = read(f);
    const capture = src.indexOf('id: prev');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(src.indexOf('- name: Build and push image'));
    expect(src).toMatch(/refusing to deploy without a rollback target/);
  });

  it.each(SERVICES)('%s rolls back on failure to the captured task definition, behind the kill switch', (f) => {
    const src = read(f);
    expect(src).toMatch(/id: roll\n/);
    expect(src).toMatch(/failure\(\) && steps\.prev\.outputs\.arn != '' && steps\.roll\.outcome != 'skipped' && vars\.PROD_AUTO_ROLLBACK_DISABLED != 'true'/);
    expect(src).toMatch(/--task-definition "\$PREV_ARN"/);
  });

  it('the gateway keeps its own rollback (VTID-04647)', () => {
    expect(read('AWS-PROD-DEPLOY-GATEWAY.yml')).toMatch(/Roll back to the previous task definition/);
  });
});
