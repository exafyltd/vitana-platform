/**
 * VTID-05080 — regen-screens-catalog.mjs must not produce a diff that only
 * bumps `last_synced`. Runs the real script on a scratch copy of its inputs.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const GATEWAY = path.resolve(__dirname, '..');
const REL = {
  script: 'scripts/regen-screens-catalog.mjs',
  spec: 'specs/dev-screen-inventory-v1.json',
  overrides: 'specs/screens-overrides.json',
  app: 'src/frontend/command-hub/app.js',
  navConfig: 'src/frontend/command-hub/navigation-config.js',
};

describe('VTID-05080 regen-screens-catalog last_synced', () => {
  let dir: string;
  let gw: string;

  const run = (args: string[] = []) =>
    spawnSync('node', [path.join(gw, REL.script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, VITANA_V1_ROOT: path.join(dir, 'no-such-vitana-v1') },
    });
  const readSpec = () => fs.readFileSync(path.join(gw, REL.spec), 'utf8');

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05080-regen-'));
    gw = path.join(dir, 'services/gateway');
    for (const rel of Object.values(REL)) {
      fs.mkdirSync(path.dirname(path.join(gw, rel)), { recursive: true });
      fs.copyFileSync(path.join(GATEWAY, rel), path.join(gw, rel));
    }
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a date-only difference is "no change": nothing is rewritten, --check passes', () => {
    const spec = JSON.parse(readSpec());
    spec.screen_inventory.last_synced = '2001-01-01';
    fs.writeFileSync(path.join(gw, REL.spec), JSON.stringify(spec, null, 2) + '\n');
    const before = readSpec();

    const check = run(['--check']);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('in sync');

    const regen = run();
    expect(regen.status).toBe(0);
    expect(regen.stdout).toContain('no changes');
    expect(readSpec()).toBe(before);
    expect(JSON.parse(readSpec()).screen_inventory.last_synced).toBe('2001-01-01');
  });

  it('a real difference regenerates the spec AND stamps today', () => {
    const spec = JSON.parse(readSpec());
    spec.screen_inventory.screens = spec.screen_inventory.screens.slice(1);
    fs.writeFileSync(path.join(gw, REL.spec), JSON.stringify(spec, null, 2) + '\n');

    expect(run(['--check']).status).toBe(1);
    const regen = run();
    expect(regen.status).toBe(0);
    expect(regen.stdout).toContain('regenerated');
    const today = new Date().toISOString().slice(0, 10);
    expect(JSON.parse(readSpec()).screen_inventory.last_synced).toBe(today);
    expect(run(['--check']).status).toBe(0);
  });
});
