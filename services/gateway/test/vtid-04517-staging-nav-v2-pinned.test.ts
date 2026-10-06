/**
 * VTID-04517 / VTID-04541 — registry-backed voice navigation: both gateways
 * point at the screen registry their own frontend publishes.
 *
 * VTID-04880: NAV_V2_ENABLED is retired. The legacy navigator is gone and no
 * code reads the flag, so neither workflow sets it any more. Both still strip
 * it, so the next deploy removes the stale value from the task definition.
 */
import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

function envStripList(): string {
  const block = staging.slice(
    staging.indexOf('.containerDefinitions[0].environment |='),
    staging.indexOf('.containerDefinitions[0].secrets |='),
  );
  return block.slice(0, block.indexOf('| not) ]'));
}

describe('VTID-04517: registry navigation on both gateways', () => {
  it('pins the registry to the staging frontend, exactly once, after stripping it', () => {
    expect(staging).toContain('{name:"NAV_REGISTRY_URL", value:"https://preview-aws.vitanaland.com/nav-registry.json"}');
    expect(envStripList()).toContain('"NAV_REGISTRY_URL"');
    expect(staging.split('{name:"NAV_REGISTRY_URL"').length - 1).toBe(1);
  });

  it('points production at its own registry, never the staging one (VTID-04541)', () => {
    expect(prod).toContain('{name:"NAV_REGISTRY_URL", value:"https://vitanaland.com/nav-registry.json"}');
    expect(prod).not.toContain('preview-aws.vitanaland.com/nav-registry.json');
  });
});

describe('VTID-04880: NAV_V2_ENABLED is retired', () => {
  it('is never set by either deploy workflow', () => {
    expect(staging).not.toContain('{name:"NAV_V2_ENABLED"');
    expect(prod).not.toContain('{name:"NAV_V2_ENABLED"');
  });

  it('is still stripped by both, so the stale value leaves the task definitions', () => {
    expect(envStripList()).toContain('"NAV_V2_ENABLED"');
    expect(prod).toMatch(/IN\("NAV_V2_ENABLED","NAV_REGISTRY_URL"\) \| not/);
  });

  it('is not read by the code (VTID-04846)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/orb-tools-shared.ts'), 'utf8');
    expect(src).not.toContain('NAV_V2_ENABLED');
  });
});
