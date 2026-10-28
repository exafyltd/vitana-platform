/**
 * VTID-04617: the agent runner also runs the suites that read a changed
 * frontend asset (Command Hub app.js / styles.css / index.html), which have no
 * basename-paired test. Seen live on VTID-04614 / PR #3736: the runner ran one
 * paired suite, CI then failed three cache-bust pins the runner never ran.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectAssetReferencingTests, selectRunnerJestTargets } from '../src/services/autopilot-agent/agent-validate';

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-04617-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const GW = 'services/gateway';

describe('selectAssetReferencingTests', () => {
  const dir = repo({
    [`${GW}/src/frontend/command-hub/app.js`]: 'x',
    [`${GW}/src/frontend/command-hub/index.html`]: 'x',
    [`${GW}/test/command-hub/pin.test.ts`]: "readFileSync('command-hub/index.html')",
    [`${GW}/test/app-guard.test.ts`]: "path.join(ROOT, 'app.js')",
    [`${GW}/test/unrelated.test.ts`]: "expect(1).toBe(1)",
    [`${GW}/test/helper.ts`]: "'index.html'",
  });

  it('finds the suites that name a changed asset, and only those', () => {
    const out = selectAssetReferencingTests(dir, [`${GW}/src/frontend/command-hub/index.html`]);
    expect(out).toEqual([{ project: GW, patterns: ['test/command-hub/pin.test.ts'] }]);
  });

  it('covers several assets at once', () => {
    const out = selectAssetReferencingTests(dir, [`${GW}/src/frontend/command-hub/index.html`, `${GW}/src/frontend/command-hub/app.js`]);
    expect(out[0].patterns).toEqual(['test/app-guard.test.ts', 'test/command-hub/pin.test.ts']);
  });

  it('ignores TypeScript sources and paths outside src/frontend', () => {
    expect(selectAssetReferencingTests(dir, [`${GW}/src/services/app.ts`, `${GW}/src/frontend/widget.ts`, 'docs/app.js'])).toEqual([]);
  });

  it('returns nothing when the project has no test directory', () => {
    expect(selectAssetReferencingTests(repo({}), [`${GW}/src/frontend/command-hub/app.js`])).toEqual([]);
  });
});

describe('selectRunnerJestTargets', () => {
  it('merges the paired suites with the asset-reading suites per project', () => {
    const dir = repo({ [`${GW}/test/pin.test.ts`]: "'styles.css'" });
    const out = selectRunnerJestTargets(dir, [`${GW}/src/services/greeting.ts`, `${GW}/src/frontend/command-hub/styles.css`]);
    expect(out).toHaveLength(1);
    expect(out[0].project).toBe(GW);
    expect(out[0].patterns).toEqual(expect.arrayContaining(['greeting\\.(test|spec)\\.[jt]sx?$', 'test/pin.test.ts']));
  });

  it('with no frontend asset it is exactly the paired selection', () => {
    const out = selectRunnerJestTargets(repo({}), [`${GW}/src/services/greeting.ts`]);
    expect(out).toEqual([{ project: GW, patterns: ['greeting\\.(test|spec)\\.[jt]sx?$'] }]);
  });
});

describe('wiring', () => {
  it('the runner re-verifies with selectRunnerJestTargets', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');
    expect(src).toContain('for (const target of selectRunnerJestTargets(repoDir, changedPaths))');
  });
});
