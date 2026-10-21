/**
 * VTID-04272: jest's transformIgnorePatterns must allow-list an ESM-only
 * package at ANY nesting depth under node_modules/, not only when it sits
 * directly under the first node_modules/ segment.
 *
 * Real regression, caught live: `npm audit fix` (this VTID's CVE remediation
 * for finding 9e1bdb97 — the auto_exec_eligible Dev Autopilot finding stuck
 * in a 5-attempt failure loop because the agent executor's tool surface has
 * no package-manager tool) bumped sanitize-html's own recorded dependency on
 * htmlparser2 from ^10.1.0 (CJS) to ^12.0.0 (ESM-only, "type":"module").
 * npm nested it at node_modules/sanitize-html/node_modules/htmlparser2/
 * rather than hoisting it, because a different, older htmlparser2 is still
 * used directly by another top-level dependency. The pre-existing
 * transformIgnorePatterns regex only ever matched a package name appearing
 * immediately after the FIRST node_modules/ segment in a path — an
 * unanchored regex .test() against the nested path still found a match (at
 * the "sanitize-html" segment, via the alternation itself) before it could
 * ever reach "htmlparser2" deeper in the string, so Jest left the nested
 * ESM file untransformed and 97 suites failed with
 * "SyntaxError: Cannot use import statement outside a module". Confirmed
 * this was a Jest-only defect, not a production runtime bug: plain
 * `node -e "require('sanitize-html')"` works fine (Node's own CJS/package.json
 * "exports" resolution handles it; Jest's default config does not transform
 * node_modules/ files at all).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const JEST_CONFIG_PATH = join(__dirname, '../jest.config.js');

describe('VTID-04272: jest transformIgnorePatterns matches nested node_modules packages', () => {
  let src: string;
  let pattern: RegExp;

  beforeAll(() => {
    src = readFileSync(JEST_CONFIG_PATH, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../jest.config.js');
    const raw = config.transformIgnorePatterns[0];
    pattern = new RegExp(raw);
  });

  it('does not match (i.e. WILL transform) a top-level allow-listed package under node_modules/', () => {
    expect(pattern.test('node_modules/htmlparser2/lib/index.js')).toBe(false);
  });

  it('does not match (i.e. WILL transform) an allow-listed package nested under another package', () => {
    // The exact real-world path this fix repairs.
    expect(
      pattern.test('node_modules/sanitize-html/node_modules/htmlparser2/dist/index.js')
    ).toBe(false);
  });

  it('does not match (i.e. WILL transform) a pnpm-nested allow-listed package', () => {
    expect(
      pattern.test('node_modules/.pnpm/htmlparser2@12.0.0/node_modules/htmlparser2/dist/index.js')
    ).toBe(false);
  });

  it('still matches (i.e. Jest will IGNORE) an unrelated package, top-level or nested', () => {
    expect(pattern.test('node_modules/lodash/index.js')).toBe(true);
    expect(pattern.test('node_modules/sanitize-html/node_modules/lodash/index.js')).toBe(true);
  });

  it('the raw pattern source requires a trailing slash after the alternation (anchors on the package boundary)', () => {
    expect(src).toMatch(
      /node_modules\/\(\?!\(\.\*\/\)\?\(\\\\\.pnpm\/\)\?\([^)]+\)\/\)/
    );
  });
});
