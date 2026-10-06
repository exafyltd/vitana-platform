/**
 * VTID-04923: DAILY_API_KEY (Live Rooms video, VTID-04904) reaches the gateway
 * task definitions as a Secrets Manager reference — optional on staging, from
 * the owner's full ARN on production (applied only on an approved prod deploy).
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

function step(file: string, name: string): string {
  const i = file.indexOf(`- name: ${name}`);
  expect(i).toBeGreaterThan(-1);
  const j = file.indexOf('\n      - name:', i + 1);
  return file.slice(i, j === -1 ? undefined : j);
}

describe('VTID-04923 Daily key wiring', () => {
  const s = step(stage, 'Resolve Live Rooms Daily key');
  const p = step(prod, 'Build task-definition (Live Rooms Daily key)');

  test('staging probes its own secret and tolerates its absence', () => {
    expect(s).toContain('vitana/gateway/staging/daily-api-key');
    expect(s).toMatch(/describe-secret[^\n]*\|\| true/);
    expect(s).not.toMatch(/exit 1/);
  });

  test('staging wires it as a secret reference into connected-apps.json, never a plain value', () => {
    expect(s).toContain('$RUNNER_TEMP/connected-apps.json');
    expect(s).toMatch(/\.sec \+= \[\{name:"DAILY_API_KEY", valueFrom:\$a\}\]/);
    expect(stage).not.toMatch(/name:"DAILY_API_KEY", value:/);
  });

  test('staging step runs after the Jev step and before the task definition is registered', () => {
    const jev = stage.indexOf('- name: Resolve Jev decision config');
    const daily = stage.indexOf('- name: Resolve Live Rooms Daily key');
    const roll = stage.indexOf('- name: Register task-definition revision + roll the service');
    expect(jev).toBeLessThan(daily);
    expect(daily).toBeLessThan(roll);
  });

  test('production uses the full prod ARN (with suffix), strip-then-add, as a secret', () => {
    expect(p).toMatch(/arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana\/gateway\/prod\/daily-api-key-[A-Za-z0-9]{6}\b/);
    expect(p).toContain('select(.name != "DAILY_API_KEY")');
    expect(p).toContain('{name:"DAILY_API_KEY", valueFrom:$D}');
    expect(prod).not.toMatch(/name:"DAILY_API_KEY", value:/);
    expect(prod).not.toContain('vitana/gateway/staging/daily-api-key');
  });
});
