/**
 * VTID-04275: the inline todo-scanner-v1 in scripts/ci/dev-autopilot-scan.mjs
 * flags its own detection-pattern source as an unresolved TODO/FIXME.
 *
 * Live evidence: `autopilot_recommendations` rows `5fbe06e1...` and
 * `8caa3710...` ("Address TODO/FIXME in dev-autopilot-scan.mjs") pointed at
 * this exact file's own line
 *   `severity: m[1] === 'FIXME' || m[1] === 'HACK' ? 'medium' : 'low',`
 * — a string comparison against the literal `'FIXME'`, matched by the
 * scanner's own `TODO_PATTERN` word-boundary regex, not an actual TODO
 * comment. `scripts/ci/scanners/registry.mjs`'s own metadata description
 * ("TODO / FIXME / HACK markers") self-matches the same way.
 *
 * Both are structural — the scanner's job IS to contain those words — so
 * the fix is a targeted self-match denylist, not a change to what counts
 * as a real TODO everywhere else. Verified against the real scanner via a
 * spawned Node process (see secret-exposure-scanner.test.ts for why: this
 * repo's `.mjs` scanners have no jest transform and Jest's `import()`
 * cannot load a bare `.mjs` module directly).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const SCANNER_PATH = path.resolve(__dirname, '../../../../scripts/ci/dev-autopilot-scan.mjs');

type Signal = { file_path: string; message: string; severity: string };

describe('VTID-04275: todo-scanner-v1 self-match false positives', () => {
  let tmpDir: string;

  beforeAll(() => {
    expect(fs.existsSync(SCANNER_PATH)).toBe(true);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-scanner-test-'));
    fs.mkdirSync(path.join(tmpDir, 'scripts', 'ci', 'scanners'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'services'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScanTodos(relFiles: string[]): Signal[] {
    const absFiles = relFiles.map(f => path.join(tmpDir, f));
    const driver = [
      `import { scanTodos } from ${JSON.stringify(SCANNER_PATH)};`,
      `const signals = scanTodos(${JSON.stringify(absFiles)});`,
      `process.stdout.write(JSON.stringify(signals));`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      timeout: 15_000,
      cwd: tmpDir,
    });
    return JSON.parse(out) as Signal[];
  }

  it('does not flag its own file at scripts/ci/dev-autopilot-scan.mjs', () => {
    const selfPath = 'scripts/ci/dev-autopilot-scan.mjs';
    fs.writeFileSync(
      path.join(tmpDir, selfPath),
      "const TODO_PATTERN = /\\b(TODO|FIXME|HACK|XXX)\\b[:\\s]?([^\\n]*)/;\n" +
        "const x = m[1] === 'FIXME' || m[1] === 'HACK' ? 'medium' : 'low';\n",
    );
    const signals = runScanTodos([selfPath]);
    expect(signals).toEqual([]);
  });

  it('does not flag scripts/ci/scanners/registry.mjs\'s own scanner metadata', () => {
    const registryPath = 'scripts/ci/scanners/registry.mjs';
    fs.writeFileSync(
      path.join(tmpDir, registryPath),
      "export const SCANNERS = [{\n" +
        "  title: 'TODO / FIXME / HACK markers',\n" +
        "  description: 'Flags unresolved TODO, FIXME, HACK, XXX markers.',\n" +
        "}];\n",
    );
    const signals = runScanTodos([registryPath]);
    expect(signals).toEqual([]);
  });

  it('still flags a genuine TODO comment in a sibling scanner file', () => {
    const siblingPath = 'scripts/ci/scanners/secret-exposure.mjs';
    fs.writeFileSync(
      path.join(tmpDir, siblingPath),
      '// TODO: this really needs a follow-up\n',
    );
    const signals = runScanTodos([siblingPath]);
    expect(signals).toHaveLength(1);
    expect(signals[0].file_path).toBe(siblingPath);
  });

  it('still flags a genuine TODO comment anywhere outside the denylist', () => {
    const otherPath = 'services/real-thing.ts';
    fs.writeFileSync(
      path.join(tmpDir, otherPath),
      '// FIXME: replace this placeholder value before shipping\n',
    );
    const signals = runScanTodos([otherPath]);
    expect(signals).toHaveLength(1);
    expect(signals[0].file_path).toBe(otherPath);
    expect(signals[0].severity).toBe('medium');
  });
});
