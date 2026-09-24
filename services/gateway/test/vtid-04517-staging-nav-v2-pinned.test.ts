/**
 * VTID-04517 — registry-backed voice navigation is switched on for the AWS
 * STAGING gateway only. Production neither declares nor strips the flag.
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

describe('VTID-04517: staging pins registry navigation', () => {
  it('pins NAV_V2_ENABLED to exact "true" and the registry to the staging frontend', () => {
    expect(staging).toContain('{name:"NAV_V2_ENABLED", value:"true"}');
    expect(staging).toContain('{name:"NAV_REGISTRY_URL", value:"https://preview-aws.vitanaland.com/nav-registry.json"}');
  });

  it('strips inherited values first and pins each exactly once', () => {
    for (const flag of ['NAV_V2_ENABLED', 'NAV_REGISTRY_URL']) {
      expect(envStripList()).toContain(`"${flag}"`);
      expect(staging.split(`{name:"${flag}"`).length - 1).toBe(1);
    }
  });

  it('leaves production alone', () => {
    expect(prod).not.toContain('NAV_V2_ENABLED');
    expect(prod).not.toContain('NAV_REGISTRY_URL');
  });

  it('is read with the exact-string check (a typo is off)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/orb-tools-shared.ts'), 'utf8');
    expect(src).toContain("process.env.NAV_V2_ENABLED === 'true'");
  });
});
