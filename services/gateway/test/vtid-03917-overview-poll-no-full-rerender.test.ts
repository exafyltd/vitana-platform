/**
 * VTID-03917 — Command Hub Overview: 30s Action Required poll no longer
 * forces a full renderApp() rebuild.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03906-08-operator-scroll-mic-fullscreen.test.ts.
 *
 * Reported live: the System Overview screen "flickering" and "frozen" (nav
 * clicks not registering at all), plus the sidebar nav list snapping back to
 * the top whenever scrolled. Root cause: `renderOverviewSystemView()` arms a
 * 30s interval (`state._actionRequiredTimer`) that calls
 * `fetchActionRequired(true)` — silentRefresh=true — while the Overview /
 * System Overview tab is active. `fetchActionRequired()`'s trailing
 * `renderApp()` call was UNCONDITIONAL: it ignored the `silentRefresh` flag
 * entirely and always did a full `root.innerHTML=''` + rebuild of the whole
 * app (sidebar, header, every card) every 30 seconds while sitting on this
 * tab — unlike its sibling `fetchServiceHealth(silentRefresh)`, which
 * already correctly branches to a lightweight pill update instead of a full
 * render on a silent refresh. The full rebuild is what produced the visible
 * flicker, the window where a click lands on an element mid-teardown and
 * never fires ("frozen"), and the sidebar's `.nav-section` (which IS scroll-
 * retained via `data-scroll-retain`) visibly resetting to scrollTop=0 for a
 * frame before its own restore rAF corrects it, every single poll tick.
 *
 * Fix: `fetchActionRequired()`'s silentRefresh branch now patches only the
 * `.action-required-panel` DOM node in place via a new
 * `refreshActionRequiredPanel()` helper, instead of calling `renderApp()`.
 * `fetchOverviewTimeseries()` gets the same parity fix defensively (no
 * caller currently passes silentRefresh=true to it, but if one ever does,
 * it must not regress into the same bug).
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

describe('VTID-03917: fetchActionRequired() silent refresh no longer forces a full renderApp()', () => {
  it('the silentRefresh branch calls refreshActionRequiredPanel(), not renderApp()', () => {
    const body = functionBody(SOURCE, 'async function fetchActionRequired(silentRefresh) {');
    expect(body).toMatch(/if\s*\(silentRefresh\)\s*\{\s*refreshActionRequiredPanel\(\);\s*\}\s*else\s*\{\s*renderApp\(\);\s*\}/);
  });

  it('refreshActionRequiredPanel() replaces the existing .action-required-panel node in place', () => {
    const body = functionBody(SOURCE, 'function refreshActionRequiredPanel() {');
    expect(body).toContain("document.querySelector('.action-required-panel')");
    expect(body).toContain('renderActionRequiredPanel()');
    expect(body).toContain('oldPanel.replaceWith(newPanel)');
    // Must not fall back to a full rebuild — that would reintroduce the bug.
    expect(body).not.toContain('renderApp()');
  });

  it('the 30s _actionRequiredTimer still calls fetchActionRequired with silentRefresh=true', () => {
    const idx = SOURCE.indexOf('state._actionRequiredTimer = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, 30000);', idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain('fetchActionRequired(true);');
  });

  it('a non-silent call (initial load) still does a full renderApp()', () => {
    const body = functionBody(SOURCE, 'async function fetchActionRequired(silentRefresh) {');
    // The isInitialLoad-gated first render is unchanged.
    expect(body).toContain('if (isInitialLoad && !silentRefresh) renderApp();');
  });
});

describe('VTID-03917: fetchOverviewTimeseries() parity fix (defensive — no live silentRefresh caller today)', () => {
  it('does not call renderApp() when silentRefresh is true', () => {
    const body = functionBody(SOURCE, 'async function fetchOverviewTimeseries(silentRefresh) {');
    expect(body).toMatch(/state\.activeTab === 'system-overview' && !silentRefresh\)\s*\{\s*renderApp\(\);/);
  });
});

describe('VTID-03917: sibling fetchServiceHealth() pattern this fix now matches', () => {
  it('fetchServiceHealth() already branches silentRefresh away from a full renderApp() (unchanged reference behavior)', () => {
    const body = functionBody(SOURCE, 'async function fetchServiceHealth(silentRefresh) {');
    expect(body).toMatch(/if\s*\(silentRefresh\)\s*\{\s*updateServiceHealthPill\(\);\s*\}\s*else\s*\{\s*renderApp\(\);\s*\}/);
  });
});
