/**
 * VTID-04291: dead-code-scanner-v1 advertised a `// @public-api` escape hatch
 * in its own `suggested_action` string, but never implemented it — the
 * scanner had no marker handling at all, so annotating an export changed
 * nothing and the identical `dead_code` finding came back on the very next
 * scan (the non-convergence this repo's Dev Autopilot continuity loop
 * depends on not having).
 *
 * The false positive that surfaced it: `services/gateway/src/capabilities/
 * index-repository.ts`, whose five exports are all live but reached through
 * a namespace import in capabilities/index.ts —
 *   `import * as repo from './index-repository';`
 *   `await repo.fetchActiveSocialConnectionProviders(supabase, userId);`
 * The scanner's cross-file check is a literal `\bname\b` grep, and with the
 * namespace alias in play the symbol name never appears as a bare identifier
 * in any other file, so all five looked unreferenced.
 *
 * `scripts/ci/scanners/*.mjs` is deliberately zero-dep, plain ESM with no
 * jest harness (see secret-exposure-scanner.test.ts for the long form), so
 * this spawns a real Node process and runs the real `run()` — not a
 * reimplementation of the marker logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const SCANNER_PATH = path.resolve(__dirname, '../../../../scripts/ci/scanners/dead-code.mjs');

type Signal = { file_path: string; message: string; raw?: { symbols: string[] } };

describe('VTID-04291: dead-code-scanner-v1 @public-api escape hatch', () => {
  let tmpDir: string;

  beforeAll(() => {
    expect(fs.existsSync(SCANNER_PATH)).toBe(true);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-public-api-'));
    fs.mkdirSync(path.join(tmpDir, 'services', 'gateway', 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScanner(): Signal[] {
    const driver = [
      `import { run } from ${JSON.stringify(SCANNER_PATH)};`,
      `const signals = await run({ repoRoot: ${JSON.stringify(tmpDir)} });`,
      `process.stdout.write(JSON.stringify(signals));`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return JSON.parse(out) as Signal[];
  }

  function scanSource(relFile: string, content: string): Signal[] {
    const abs = path.join(tmpDir, 'services', 'gateway', 'src', relFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return runScanner();
  }

  it('still flags an unreferenced export with no annotation', () => {
    const signals = scanSource('lonely.ts', 'export async function trulyUnused(sb: unknown) {\n  return sb;\n}\n');
    expect(signals).toHaveLength(1);
    expect(signals[0].raw?.symbols).toEqual(['trulyUnused']);
  });

  it('does not flag an export carrying // @public-api directly above it', () => {
    const signals = scanSource(
      'seam.ts',
      '// @public-api — reached via repo.* elsewhere.\nexport async function reachedViaNamespace(sb: unknown) {\n  return sb;\n}\n',
    );
    expect(signals).toEqual([]);
  });

  it('recognises the marker inside a block comment above the export', () => {
    const signals = scanSource(
      'seam-block.ts',
      '/**\n * Migration seam.\n * @public-api consumed dynamically.\n */\nexport async function seam(sb: unknown) {\n  return sb;\n}\n',
    );
    expect(signals).toEqual([]);
  });

  it('does not leak an annotation onto the next export below it', () => {
    const signals = scanSource(
      'partial.ts',
      '// @public-api — only this one is exempt.\nexport async function exemptOne(sb: unknown) {\n  return sb;\n}\n\nexport async function stillUnreferenced(sb: unknown) {\n  return sb;\n}\n',
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].raw?.symbols).toEqual(['stillUnreferenced']);
  });

  it('leaves the five capabilities/index-repository.ts seam exports unflagged', () => {
    const realPath = path.resolve(
      __dirname,
      '../../src/capabilities/index-repository.ts',
    );
    const src = fs.readFileSync(realPath, 'utf8');
    const signals = scanSource('capabilities/index-repository.ts', src);
    expect(signals).toEqual([]);
  });

  it('still flags the same seam source once the annotations are stripped', () => {
    const realPath = path.resolve(
      __dirname,
      '../../src/capabilities/index-repository.ts',
    );
    const src = fs.readFileSync(realPath, 'utf8');
    const stripped = src
      .split('\n')
      .filter(line => !line.includes('@public-api'))
      .join('\n');
    const signals = scanSource('capabilities/index-repository.ts', stripped);
    expect(signals).toHaveLength(1);
    expect(signals[0].raw?.symbols).toContain('fetchActiveSocialConnectionProviders');
  });
});
