/**
 * VTID-04137 — one correct `escapeHtml` in Command Hub app.js.
 *
 * `services/gateway/src/frontend/command-hub/app.js` had accumulated three
 * separate `escapeHtml` declarations:
 *
 *   1. `function escapeHtml(str) { ... }` (the VTID-01173 helper) — top-level,
 *      escapes `& < > " '`.
 *   2. A byte-identical second top-level copy (commented "Helper: Escape HTML
 *      to prevent XSS.") — a straight duplicate of (1); because of JS function
 *      hoisting whichever declaration comes last wins, so the two were literally
 *      interchangeable and removing one is behaviour-preserving.
 *   3. A function-scoped shadow *inside* `renderVoiceToolsCatalogView` — the
 *      only one that did NOT escape the single quote
 *      (`& " > <` via a chained `.replace`), i.e. the one that was actually
 *      less safe.
 *
 * VTID-04137 keeps exactly one implementation (1) and deletes (2) and (3).
 * Every call site is left untouched textually, because each shadow site simply
 * rebinds to the identical top-level helper by lexical scope once the local
 * declaration is gone — that is the "behaviour unchanged" property this suite
 * pins: the kept helper is evaluated out of the file and exercised directly,
 * and the two former shadow scopes are asserted to be free of a local
 * declaration (their `escapeHtml(...)` call sites still present).
 *
 * app.js is a plain browser script with no build step and no render harness, so
 * — matching this repo's established pattern for app.js (see
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts and
 * test/vtid-04033-operator-execution-follow.test.ts) — behaviour is pinned by
 * slicing the declaration out of the source and evaluating it, and structure by
 * source text.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

const APP_JS = readFileSync(APP_JS_PATH, 'utf8');

/**
 * Evaluates the kept `escapeHtml` straight out of app.js so the assertions below
 * exercise the real shipped implementation, not a copy pasted into this test.
 */
function loadKeptEscapeHtml(): (value: unknown) => string {
  const match = APP_JS.match(/\nfunction escapeHtml\(str\) \{[\s\S]*?\n\}\n/);
  if (!match || match.index === undefined) {
    throw new Error('kept escapeHtml(str) declaration not found in app.js');
  }
  // eslint-disable-next-line no-new-func
  return new Function(match[0] + '\nreturn escapeHtml;')() as (value: unknown) => string;
}

/** The body of a top-level function, from its declaration to the next one. */
function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

describe('VTID-04137: app.js declares escapeHtml exactly once', () => {
  it('has a single `function escapeHtml(` declaration in the whole file', () => {
    const declarations = APP_JS.match(/(?:^|\s)function\s+escapeHtml\s*\(/g) || [];
    expect(declarations).toHaveLength(1);
  });

  it('has no shadowing `const`/`let`/`var escapeHtml =` assignment left behind', () => {
    expect(APP_JS).not.toMatch(/(?:const|let|var)\s+escapeHtml\s*=/);
  });

  it('keeps the declaration at top level (column 0), not nested inside another function', () => {
    expect(APP_JS).toMatch(/\nfunction escapeHtml\(str\) \{/);
  });

  it('the kept implementation escapes all five characters', () => {
    const body = fnBody('escapeHtml');
    expect(body).toContain(".replace(/&/g, '&amp;')");
    expect(body).toContain(".replace(/</g, '&lt;')");
    expect(body).toContain(".replace(/>/g, '&gt;')");
    expect(body).toContain('.replace(/"/g, \'&quot;\')');
    expect(body).toContain(".replace(/'/g, '&#039;')");
  });

  it('the two former shadow scopes no longer declare escapeHtml, but still call it', () => {
    for (const name of ['renderVoiceToolsCatalogView', 'renderManualMarkdown']) {
      const body = fnBody(name);
      expect(body).not.toMatch(/(?:function|const|let|var)\s+escapeHtml\s*[=(]/);
      expect(body).toContain('escapeHtml(');
    }
  });
});

describe('VTID-04137: the kept escapeHtml escapes <, >, &, single and double quote', () => {
  const escapeHtml = loadKeptEscapeHtml();

  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#039;'],
  ])('escapes %s as %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('escapes every character together, one entity per occurrence', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#039;');
  });

  it('escapes an inline XSS payload so it cannot break out of an attribute or tag', () => {
    expect(escapeHtml('<img src=x onerror="alert(\'x\')">')).toBe(
      '&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt;',
    );
  });

  it('leaves text with nothing to escape untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });

  it('preserves the pre-existing falsy-input behaviour (empty string, not "null"/"undefined")', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stringifies non-string input', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('VTID-04137: the Command Hub cache-buster was bumped for this change', () => {
  it('bumps app.js and styles.css together, at or after this VTID marker', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (html.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    // "at or after", not exact-match — a later sibling PR legitimately re-bumps
    // this marker (the VTID-04028/04031/04074 pattern).
    expect(appVersion >= '20260920-vtid-04137-single-escape-html').toBe(true);
    expect(html).toContain('styles.css?v=' + appVersion);
  });
});
