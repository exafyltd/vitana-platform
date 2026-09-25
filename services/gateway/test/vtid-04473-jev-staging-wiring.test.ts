/**
 * VTID-04473: Jev staging wiring is optional and never reaches production.
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

function step(name: string): string {
  const i = stage.indexOf(`- name: ${name}`);
  expect(i).toBeGreaterThan(-1);
  const j = stage.indexOf('\n      - name:', i + 1);
  return stage.slice(i, j === -1 ? undefined : j);
}

describe('VTID-04473 Jev staging wiring', () => {
  const s = step('Resolve Jev decision config');

  test('probes the staging secret with describe-secret and tolerates its absence', () => {
    expect(s).toContain('vitana/gateway/staging/typesafe-api-key');
    expect(s).toMatch(/describe-secret[^\n]*\|\| true/);
  });

  test('the key is a secret reference, never a plain env value', () => {
    expect(s).toMatch(/\.sec \+= \[\{name:"TYPESAFE_API_KEY", valueFrom:\$a\}\]/);
    expect(s).not.toMatch(/name:"TYPESAFE_API_KEY", value:/);
  });

  test('the flag is always written: true with the key, false without', () => {
    expect(s).toContain('{name:"JEV_DECISIONS_ENABLED", value:"false"}');
    expect(s).toContain('{name:"JEV_DECISIONS_ENABLED", value:"true"}');
  });

  test('runs after connected-apps.json is written and before the task definition is registered', () => {
    const ca = stage.indexOf('- name: Resolve Connected Apps sign-in config');
    const jev = stage.indexOf('- name: Resolve Jev decision config');
    const roll = stage.indexOf('- name: Register task-definition revision + roll the service');
    expect(ca).toBeLessThan(jev);
    expect(jev).toBeLessThan(roll);
    expect(s).toContain('$RUNNER_TEMP/connected-apps.json');
  });

  test('community stays off everywhere; production is not wired', () => {
    expect(stage).not.toMatch(/name:\s*"?JEV_COMMUNITY_ENABLED/);
    expect(prod).not.toMatch(/JEV_|TYPESAFE/);
  });
});
