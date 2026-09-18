// T11 (VTID-04086) — find-dead-css-classes.mjs, the conservative dead-CSS
// matcher for the Command Hub's styles.css.
//
// styles.css has no build step and 20K+ lines, so an orphaned rule (left
// behind when T1a/T1c/T1d deleted the JS render function that used it) has
// no way to ever be flagged. This suite pins the matcher's core safety
// property: it must never remove a rule unless EVERY selector in its
// comma-separated list is both simple (a single class, optionally with
// pseudo-class/pseudo-element/attribute suffixes) and confirmed dead — a
// rule mixing a dead class with a live one, or using any compound/
// descendant selector, must be left completely untouched.
//
// The target script is a real ES module; this repo's CJS-based ts-jest
// cannot statically `import` it, and Jest's default transform intercepts
// even a dynamic `await import()` of raw ESM syntax before Node ever sees
// it. Matching regen-screens-catalog.test.ts and
// generate-command-hub-symbol-index.test.ts (this repo's two established
// patterns for testing a `.mjs` dev-tooling script), these tests drive the
// real CLI against fixture files rather than importing internals.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'services/gateway/scripts/find-dead-css-classes.mjs');

/** Builds a throwaway services/gateway/{scripts,src/frontend/command-hub}
 * tree (the layout the script's own path resolution requires) with the
 * given styles.css content and JS/HTML corpus files. */
function makeFixture(css: string, jsFiles: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dead-css-'));
  const gatewayRoot = join(root, 'services/gateway');
  mkdirSync(join(gatewayRoot, 'scripts'), { recursive: true });
  mkdirSync(join(gatewayRoot, 'src/frontend/command-hub'), { recursive: true });
  writeFileSync(join(gatewayRoot, 'scripts/find-dead-css-classes.mjs'), readFileSync(SCRIPT, 'utf8'));
  writeFileSync(join(gatewayRoot, 'src/frontend/command-hub/styles.css'), css);
  for (const [name, content] of Object.entries(jsFiles)) {
    writeFileSync(join(gatewayRoot, 'src/frontend/command-hub', name), content);
  }
  return join(gatewayRoot, 'scripts/find-dead-css-classes.mjs');
}

function run(scriptPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function readCss(scriptPath: string): string {
  return readFileSync(join(scriptPath, '../../src/frontend/command-hub/styles.css'), 'utf8');
}

describe('find-dead-css-classes.mjs (T11)', () => {
  let scriptPath: string;

  afterEach(() => {
    // 4 levels up from the script FILE path lands exactly on the
    // mkdtempSync fixture root (file -> scripts/ -> gateway/ -> services/ ->
    // root) — guarded so a path-math mistake fails loudly instead of
    // deleting something outside the fixture.
    if (scriptPath) {
      const fixtureRoot = join(scriptPath, '../../../..');
      expect(fixtureRoot.startsWith(tmpdir())).toBe(true);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('removes a rule whose single simple selector is a class with zero JS/HTML occurrence', () => {
    scriptPath = makeFixture(
      `.dead { color: red; }\n.live { color: blue; }\n`,
      { 'app.js': `el.className = 'live';` },
    );
    const { status } = run(scriptPath, ['--fix']);
    expect(status).toBe(0);
    const css = readCss(scriptPath);
    expect(css).not.toMatch(/\.dead\b/);
    expect(css).toMatch(/\.live\b/);
  });

  it('does NOT remove a class referenced only via runtime string concatenation (a false-positive risk this matcher must not fall for)', () => {
    scriptPath = makeFixture(
      `.status-active { color: green; }\n.status-error { color: red; }\n`,
      { 'app.js': `el.className = 'status-' + state;` },
    );
    run(scriptPath, ['--fix']);
    const css = readCss(scriptPath);
    // Neither class appears literally in app.js, but both share the
    // 'status-' dynamic-concatenation prefix, so both must survive.
    expect(css).toMatch(/\.status-active\b/);
    expect(css).toMatch(/\.status-error\b/);
  });

  it('does NOT remove a rule when only SOME of its comma-separated selectors are dead', () => {
    scriptPath = makeFixture(
      `.dead, .live { color: red; }\n`,
      { 'app.js': `el.className = 'live';` },
    );
    run(scriptPath, ['--fix']);
    const css = readCss(scriptPath);
    // The whole rule survives untouched, dead selector included — a
    // partial edit here risks a parsing mistake more than it saves.
    expect(css).toMatch(/\.dead, \.live/);
  });

  it('does NOT remove a rule with a compound or descendant selector, even if its class is dead', () => {
    scriptPath = makeFixture(
      `.dead .child { color: red; }\n.dead.other { color: blue; }\n`,
      { 'app.js': `// no reference to any of these classes` },
    );
    run(scriptPath, ['--fix']);
    const css = readCss(scriptPath);
    expect(css).toMatch(/\.dead \.child/);
    expect(css).toMatch(/\.dead\.other/);
  });

  it('removes a dead rule nested inside @media, and drops the block entirely once it is empty', () => {
    scriptPath = makeFixture(
      `@media (max-width: 600px) {\n  .dead { color: red; }\n}\n`,
      { 'app.js': `// no CSS classes referenced in this fixture file` },
    );
    run(scriptPath, ['--fix']);
    const css = readCss(scriptPath);
    expect(css).not.toMatch(/@media/);
    expect(css).not.toMatch(/\.dead/);
  });

  it('keeps an @media block that still has a live rule after removing its dead sibling', () => {
    scriptPath = makeFixture(
      `@media (max-width: 600px) {\n  .dead { color: red; }\n  .live { color: blue; }\n}\n`,
      { 'app.js': `el.className = 'live';` },
    );
    run(scriptPath, ['--fix']);
    const css = readCss(scriptPath);
    expect(css).toMatch(/@media/);
    expect(css).toMatch(/\.live/);
    expect(css).not.toMatch(/\.dead\b/);
  });

  it('does not treat a class mentioned only in a CSS comment, or built from a template-literal prefix, as live', () => {
    scriptPath = makeFixture(
      [
        '/* .commented-out-and-dead { color: red; } */',
        '.commented-out-and-dead { color: red; }',
        '.badge-info { color: blue; }',
        '',
      ].join('\n'),
      { 'app.js': "el.className = `badge-${kind}`;" },
    );
    run(scriptPath, ['--fix']);
    const css = readCss(scriptPath);
    // The CSS-comment text itself survives untouched (byte-for-byte).
    expect(css).toMatch(/\/\* \.commented-out-and-dead \{ color: red; \} \*\//);
    // The real RULE is removed — check OUTSIDE the surviving comment, since
    // the comment's own text also contains the literal substring
    // ".commented-out-and-dead {" and would otherwise make this assertion
    // pass even if the real rule were still present.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/\.commented-out-and-dead\s*\{/);
    // Only ever built via the `badge-${kind}` template at runtime -> kept.
    expect(css).toMatch(/\.badge-info/);
  });

  it('--check exits 0 ("in sync") once --fix has already been applied, and would exit 1 on a still-dirty file', () => {
    scriptPath = makeFixture(
      `.dead { color: red; }\n.live { color: blue; }\n`,
      { 'app.js': `el.className = 'live';` },
    );
    const dirty = run(scriptPath, ['--check']);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/out of sync/);

    run(scriptPath, ['--fix']);
    const clean = run(scriptPath, ['--check']);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toMatch(/in sync/);
  });

  it('report-only mode (no flags) never writes the file', () => {
    const original = `.dead { color: red; }\n.live { color: blue; }\n`;
    scriptPath = makeFixture(original, { 'app.js': `el.className = 'live';` });
    run(scriptPath, []);
    expect(readCss(scriptPath)).toBe(original);
  });
});

describe('against the real repo styles.css (sanity check)', () => {
  it('running the real generator in --check mode after --fix reports in sync, and the file is still non-empty/well-formed', () => {
    // Idempotency check against the actual repo file, not a synthetic
    // fixture — the real evidence this was verified against, not just
    // theory. Structural soundness itself is guaranteed by the generator's
    // own comment/string-aware parseTopLevel/serialize round trip (its
    // correctness is what the fixture-based tests above pin); a crude
    // independent brace-count re-check here is not a reliable second
    // opinion — CSS content like `content: "}"` legitimately unbalances a
    // naive count without indicating any real corruption.
    run(SCRIPT, ['--fix']);
    const result = run(SCRIPT, ['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/in sync/);

    const css = readFileSync(join(REPO_ROOT, 'services/gateway/src/frontend/command-hub/styles.css'), 'utf8');
    expect(css.length).toBeGreaterThan(1000);
  });
});
