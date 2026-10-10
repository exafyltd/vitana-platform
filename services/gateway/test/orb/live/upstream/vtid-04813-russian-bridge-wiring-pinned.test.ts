/**
 * VTID-04813 — pins `VERTEX_RUSSIAN_BRIDGE_ENABLED` into both gateway
 * deploy workflows.
 *
 * Why this test exists at all: VTID-03513 cost four days of staging
 * downtime because task-definition state lived only in AWS and never in
 * this repo, so one bad value cloned itself forward through every
 * subsequent deploy, invisible to code review. Both deploy workflows
 * therefore strip-then-re-add the env vars they own, and each pinned flag
 * gets a test asserting the shape — otherwise a later edit to that jq
 * block silently drops a flag and the bridge goes dark with nothing failing.
 *
 * The strip list matters as much as the add list: without the strip, a
 * re-deploy appends a DUPLICATE entry for the same name instead of
 * replacing it, and which one ECS honours is not something to rely on.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const STAGING = join(REPO_ROOT, '.github', 'workflows', 'AWS-STAGE-DEPLOY-GATEWAY.yml');
const PROD = join(REPO_ROOT, '.github', 'workflows', 'AWS-PROD-DEPLOY-GATEWAY.yml');

const staging = readFileSync(STAGING, 'utf8');
const prod = readFileSync(PROD, 'utf8');

describe.each([
  ['staging', staging],
  ['prod', prod],
])('VTID-04813: %s pins VERTEX_RUSSIAN_BRIDGE_ENABLED', (_env, wf) => {
  it('strips the var before re-adding it, so a re-deploy replaces rather than duplicates', () => {
    expect(wf).toMatch(/"VERTEX_RUSSIAN_BRIDGE_ENABLED",/);
  });

  it('re-adds it as the exact string "true" — the predicate accepts nothing else', () => {
    expect(wf).toMatch(/\{name:"VERTEX_RUSSIAN_BRIDGE_ENABLED", value:"true"\}/);
  });

  it('keeps the Serbian bridge pinned alongside it — this adds a bridge, it does not replace one', () => {
    expect(wf).toMatch(/\{name:"VERTEX_SERBIAN_BRIDGE_ENABLED", value:"true"\}/);
  });

  it('still pins the GCP project and location the bridge needs — a bare flag would fail against a project with no billing', () => {
    // CLAUDE.md §2e-vertex-serbian-bridge: `VERTEX_PROJECT_ID`'s own code
    // default is still the DECOMMISSIONED project, so the flag is only
    // meaningful when GOOGLE_CLOUD_PROJECT is set with it.
    expect(wf).toMatch(/\{name:"GOOGLE_CLOUD_PROJECT", value:"project-da3eb05a-c86e-47cb-85f"\}/);
    expect(wf).toMatch(/\{name:"VERTEX_AI_LOCATION", value:"global"\}/);
    expect(wf).not.toMatch(/lovable-vitana-vers1/);
  });

  it('adds exactly one entry for the flag, not two', () => {
    const adds = wf.match(/\{name:"VERTEX_RUSSIAN_BRIDGE_ENABLED", value:/g) || [];
    expect(adds).toHaveLength(1);
  });
});

describe('VTID-04813: prod deploy stays manual-dispatch only', () => {
  it('has no push trigger — pinning a flag must never create an auto-to-prod path', () => {
    const triggerBlock = prod.slice(0, prod.indexOf('jobs:'));
    expect(triggerBlock).toContain('workflow_dispatch:');
    expect(triggerBlock).not.toMatch(/^\s*push:/m);
  });
});
