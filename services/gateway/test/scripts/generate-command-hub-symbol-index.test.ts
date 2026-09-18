// T8 (VTID-04085) — generate-command-hub-symbol-index.mjs.
//
// app.js alone is 55K+ lines with no build step; navigating it by hand or by
// repeated search_text/read_file calls is a real, measured cost (CLAUDE.md's
// VTID-04037 Run #6 record: ~40 of 60 turns spent just locating code). This
// script builds a function-name -> line-range index so a lookup replaces a
// search-and-scroll.
//
// These tests exercise the real generator against small synthetic fixtures
// (so line-range correctness doesn't depend on app.js's current contents,
// which change constantly) and against the real repo files for a basic
// sanity/regression check.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'services/gateway/scripts/generate-command-hub-symbol-index.mjs');

/**
 * Builds a throwaway `services/gateway/scripts/` + `src/frontend/command-hub/`
 * + `specs/` tree so the script's own relative path resolution
 * (`GATEWAY_ROOT = path.resolve(__dirname, '..')`) works unmodified, then
 * copies the real generator script into it — the script itself is the thing
 * under test, only its inputs are faked.
 */
function makeFixture(appJsSrc: string): string {
  const root = mkdtempSync(join(tmpdir(), 'symbol-index-'));
  const gatewayRoot = join(root, 'services/gateway');
  mkdirSync(join(gatewayRoot, 'scripts'), { recursive: true });
  mkdirSync(join(gatewayRoot, 'src/frontend/command-hub'), { recursive: true });
  mkdirSync(join(gatewayRoot, 'specs'), { recursive: true });
  writeFileSync(join(gatewayRoot, 'scripts/generate-command-hub-symbol-index.mjs'), readFileSync(SCRIPT, 'utf8'));
  writeFileSync(join(gatewayRoot, 'src/frontend/command-hub/app.js'), appJsSrc);
  return join(gatewayRoot, 'scripts/generate-command-hub-symbol-index.mjs');
}

function runGenerator(scriptPath: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function readIndex(scriptPath: string): any {
  const specsPath = join(scriptPath, '../../specs/command-hub-symbol-index.json');
  return JSON.parse(readFileSync(specsPath, 'utf8'));
}

describe('generate-command-hub-symbol-index.mjs (T8)', () => {
  let scriptPath: string;

  afterEach(() => {
    // 4 levels up from the script FILE path lands exactly on the mkdtempSync
    // fixture root (file -> scripts/ -> gateway/ -> services/ -> root) —
    // verified against a real path, not assumed, since one level too many
    // here would rm a directory outside the fixture.
    if (scriptPath) {
      const fixtureRoot = join(scriptPath, '../../../..');
      expect(fixtureRoot.startsWith(tmpdir())).toBe(true);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('finds a simple top-level function and its exact line range', () => {
    scriptPath = makeFixture(
      `// header comment\nfunction alpha(x) {\n  return x + 1;\n}\n\nfunction beta() {\n  return 2;\n}\n`,
    );
    const { status } = runGenerator(scriptPath);
    expect(status).toBe(0);
    const index = readIndex(scriptPath);
    const alpha = index.files['app.js'].find((f: any) => f.name === 'alpha');
    const beta = index.files['app.js'].find((f: any) => f.name === 'beta');
    expect(alpha).toMatchObject({ kind: 'function', startLine: 2, endLine: 4 });
    expect(beta).toMatchObject({ kind: 'function', startLine: 6, endLine: 8 });
  });

  it('finds nested function declarations inside another function body', () => {
    scriptPath = makeFixture(
      `function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}\n`,
    );
    runGenerator(scriptPath);
    const index = readIndex(scriptPath);
    const names = index.files['app.js'].map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(['outer', 'inner']));
    const inner = index.files['app.js'].find((f: any) => f.name === 'inner');
    expect(inner).toMatchObject({ startLine: 2, endLine: 4 });
  });

  it('marks an IIFE (`(function name() {...})()`) with kind "iife", not "function"', () => {
    scriptPath = makeFixture(`(function selfInvoking() {\n  console.log('hi');\n})();\n`);
    runGenerator(scriptPath);
    const index = readIndex(scriptPath);
    const fn = index.files['app.js'].find((f: any) => f.name === 'selfInvoking');
    expect(fn.kind).toBe('iife');
  });

  it('does not mis-parse a brace character inside a string or template literal as function-body structure', () => {
    scriptPath = makeFixture(
      // The string/template bodies below contain literal `{`/`}` that must
      // NOT be counted as real brace depth — otherwise the function's end
      // line would be found in the wrong place (or not at all).
      [
        'function withBraceInString() {',
        "  var s = '{ not real code }';",
        '  var t = `also { not real } code`;',
        '  return s + t;',
        '}',
        '',
        'function after() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
    const { status, stderr } = runGenerator(scriptPath);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const index = readIndex(scriptPath);
    const withBrace = index.files['app.js'].find((f: any) => f.name === 'withBraceInString');
    const after = index.files['app.js'].find((f: any) => f.name === 'after');
    expect(withBrace).toMatchObject({ startLine: 1, endLine: 5 });
    expect(after).toMatchObject({ startLine: 7, endLine: 9 });
  });

  it('does not treat a `function` mention inside a comment as a real declaration', () => {
    scriptPath = makeFixture(
      [
        '// this used to call function ghost() { } before it was removed',
        '/* function alsoGhost() { return 1; } */',
        'function real() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
    runGenerator(scriptPath);
    const index = readIndex(scriptPath);
    const names = index.files['app.js'].map((f: any) => f.name);
    expect(names).toEqual(['real']);
  });

  it('finds an async function and labels it correctly', () => {
    scriptPath = makeFixture(`async function fetchThing() {\n  return await Promise.resolve(1);\n}\n`);
    runGenerator(scriptPath);
    const index = readIndex(scriptPath);
    const fn = index.files['app.js'].find((f: any) => f.name === 'fetchThing');
    expect(fn.kind).toBe('async function');
  });

  it('--check exits 0 and prints "in sync" when the stored index already matches, and exits 1 when the source changed', () => {
    scriptPath = makeFixture(`function one() {\n  return 1;\n}\n`);
    runGenerator(scriptPath); // writes the index
    const inSync = runGenerator(scriptPath, ['--check']);
    expect(inSync.status).toBe(0);
    expect(inSync.stdout).toMatch(/in sync/);

    writeFileSync(join(scriptPath, '../../src/frontend/command-hub/app.js'), `function one() {\n  return 1;\n}\nfunction two() {\n  return 2;\n}\n`);
    const outOfSync = runGenerator(scriptPath, ['--check']);
    expect(outOfSync.status).toBe(1);
    expect(outOfSync.stderr).toMatch(/out of sync/);
  });

  describe('against the real repo (sanity/regression check)', () => {
    it('runs clean against the real Command Hub source and finds known functions at plausible line ranges', () => {
      const { status, stderr } = runGenerator(SCRIPT);
      expect(status).toBe(0);
      expect(stderr).toBe('');

      const realIndexPath = join(REPO_ROOT, 'services/gateway/specs/command-hub-symbol-index.json');
      const index = JSON.parse(readFileSync(realIndexPath, 'utf8'));
      expect(index.total_functions).toBeGreaterThan(500);

      // A real, well-known nested case: installAuthFetchInterceptor is an
      // IIFE with getActiveRole/getRefreshToken/performRefresh nested
      // inside it — regression-pins that nested declarations are still
      // found (the defect the second scanner design fixed).
      const app = index.files['app.js'];
      const outerFn = app.find((f: any) => f.name === 'installAuthFetchInterceptor');
      expect(outerFn.kind).toBe('iife');
      const nested = app.find((f: any) => f.name === 'getActiveRole');
      expect(nested).toBeTruthy();
      expect(nested.startLine).toBeGreaterThan(outerFn.startLine);
      expect(nested.endLine).toBeLessThan(outerFn.endLine);
    });
  });
});
