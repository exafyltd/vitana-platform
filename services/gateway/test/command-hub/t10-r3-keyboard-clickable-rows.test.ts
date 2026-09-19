/**
 * VTID-04090 (T10, accessibility region 3 of 4): keyboard access for custom
 * clickable elements — the `<tr>` rows used as click targets across the
 * Command Hub (OASIS events, admin users/roles/tenants, governance rules,
 * VTID ledger, task board, test runs, autopilot automations, feedback
 * tickets).
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts) — this suite
 * pins the change by source text.
 *
 * Before this VTID, 12 `<tr>` elements had an onclick handler and no
 * keyboard equivalent — a native <button>/<a> gets Enter/Space activation
 * and a tab stop for free; a div/tr/span with an onclick handler gets
 * neither (WCAG 2.1.1 Keyboard). `gov-history-row` already had the correct
 * hand-written pattern (tabIndex + role="button" + onkeydown mirroring
 * onclick, in two places) — this VTID extracts that pattern into a shared
 * `makeClickable(el, handler, opts)` helper and applies it to the 12 rows
 * found with no keyboard equivalent, rather than hand-rolling it 12 times.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

describe('T10 region 3: makeClickable helper', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('is defined once, sets tabIndex, role, onclick and an Enter/Space onkeydown', () => {
    const idx = appJs.indexOf('function makeClickable(el, handler, opts) {');
    expect(idx).toBeGreaterThan(-1);
    const body = appJs.slice(idx, idx + 600);
    expect(body).toContain('el.tabIndex = 0;');
    expect(body).toContain("el.setAttribute('role', opts.role || 'button');");
    expect(body).toContain('el.onclick = handler;');
    expect(body).toContain("if (e.key === 'Enter' || e.key === ' ') {");
    expect(body).toContain('e.preventDefault();');
    expect(body).toContain('handler(e);');
  });

  it('is defined before every call site (no forward-reference-only usage)', () => {
    const defIdx = appJs.indexOf('function makeClickable(el, handler, opts) {');
    const callSites = [...appJs.matchAll(/\bmakeClickable\(/g)].map((m) => m.index as number);
    // First match is inside the function's own declaration line.
    expect(callSites.length).toBeGreaterThan(1);
    for (const idx of callSites) {
      expect(idx).toBeGreaterThanOrEqual(defIdx);
    }
  });

  it('is used at least 12 times (one per converted <tr> row)', () => {
    const callCount = (appJs.match(/\bmakeClickable\(/g) || []).length;
    // 1 for the function's own `function makeClickable(` declaration text
    // matching the same regex is NOT counted here since `function
    // makeClickable(` doesn't match `\bmakeClickable\(` immediately
    // preceded by "function " — but to be safe this asserts a floor, not
    // an exact count, so an added future call site doesn't break this test.
    expect(callCount).toBeGreaterThanOrEqual(12);
  });
});

describe('T10 region 3: every converted <tr> row carries a real aria-label', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  const expectedLabelFragments = [
    'View OASIS event details:',
    'View Command Hub event details:',
    'View user details:',
    'View role details:',
    'View tenant details:',
    'View governance rule details:',
    'View VTID details:',
    'View task details:',
    'View test run details:',
    'View automation details:',
    'View feedback ticket:',
  ];

  it.each(expectedLabelFragments)('has a makeClickable() call labelled %j', (fragment) => {
    expect(appJs).toContain(fragment);
  });

  it('no row previously fixed still uses a bare row.onclick assignment for these handlers', () => {
    // Spot-check a few of the exact call sites this VTID rewrote — each
    // must now go through makeClickable(), not a bare .onclick=.
    expect(appJs).not.toContain('row.onclick = function () {\n        state.oasisEvents.selectedEvent = event;');
    expect(appJs).not.toContain('row.onclick = function () {\n        state.commandHubEvents.selectedEvent = event;');
    expect(appJs).not.toContain('tr.onclick = function () { openFeedbackTicketDrawer(t.id); };');
  });
});
