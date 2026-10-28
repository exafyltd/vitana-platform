/**
 * VTID-04646 — where the PUBLISH gate sits, pinned against the source.
 *
 * The gate must run on the commit AWS staging actually serves, before the
 * bake check, the VTID allocation and the workflow dispatch, so a refused
 * publish leaves nothing behind. Both Command Hub publish buttons must go
 * through the override prompt.
 */
import * as fs from 'fs';
import * as path from 'path';

const operatorSrc = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
const stagingJs = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/command-hub-staging.js'),
  'utf8',
);
const indexHtml = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/index.html'), 'utf8');
const cicdTypes = fs.readFileSync(path.join(__dirname, '../src/types/cicd.ts'), 'utf8');

function awsFlowBody(): string {
  const start = operatorSrc.indexOf('async function publishAwsFlow(');
  expect(start).toBeGreaterThan(-1);
  const end = operatorSrc.indexOf('\nasync function ', start + 10);
  return operatorSrc.slice(start, end === -1 ? undefined : end);
}

describe('VTID-04646 publish gate wiring', () => {
  it('evaluates the gate on the staging commit before bake, allocation and dispatch', () => {
    const body = awsFlowBody();
    const gate = body.indexOf('evaluatePublishGate({ commit: stagingCommit');
    const commitResolved = body.indexOf('const stagingCommit = staging.commitSha');
    const bake = body.indexOf('bake_time_not_met');
    const alloc = body.indexOf("allocateVtid('publish.api'");
    expect(commitResolved).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(commitResolved);
    expect(bake).toBeGreaterThan(gate);
    expect(alloc).toBeGreaterThan(gate);
  });

  it('refuses with 409 staging_not_verified and records the refusal', () => {
    const body = awsFlowBody();
    expect(body).toMatch(/if \(!gate\.allowed\)/);
    expect(body).toMatch(/production\.publish\.blocked/);
    expect(body).toMatch(/status\(409\)[\s\S]{0,80}error: 'staging_not_verified'/);
    expect(body).toMatch(/override_allowed: true/);
  });

  it('records an override on the publish event and as its own event', () => {
    const body = awsFlowBody();
    expect(body).toMatch(/staging_verify_gate: gate\.status/);
    expect(body).toMatch(/override_reason: gate\.override_reason/);
    expect(body).toMatch(/production\.publish\.verification_overridden/);
  });

  it('declares the two new CICD event types', () => {
    expect(cicdTypes).toContain("'production.publish.blocked'");
    expect(cicdTypes).toContain("'production.publish.verification_overridden'");
  });

  it('routes both Command Hub publish buttons through the override prompt', () => {
    expect(stagingJs).toMatch(/function postPublish\(payload, headers\)/);
    expect(stagingJs).toMatch(/error !== 'staging_not_verified'/);
    expect(stagingJs).toMatch(/override_reason: reason\.trim\(\)/);
    const calls = stagingJs.match(/postPublish\(\{ confirm_short_sha/g) || [];
    expect(calls).toHaveLength(2);
    // The only raw POST left is the one inside postPublish itself.
    expect((stagingJs.match(/fetch\('\/api\/v1\/operator\/publish'/g) || [])).toHaveLength(1);
  });

  it('bumps the staging script cache-bust', () => {
    expect(indexHtml).toContain('command-hub-staging.js?v=20261014-vtid-04646');
  });
});
