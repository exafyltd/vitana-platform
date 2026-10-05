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

// VTID-04876: the Action Required panel was replaced by the ops/attention
// cockpit; the same no-full-rerender guarantee now holds for its 30 s poll.
describe('VTID-03917 (via VTID-04876): fetchOpsAttention() silent refresh never forces a full renderApp()', () => {
  it('the silentRefresh branch calls refreshOpsAttentionPanel(), not renderApp()', () => {
    const body = functionBody(SOURCE, 'async function fetchOpsAttention(silentRefresh) {');
    expect(body).toMatch(/if\s*\(silentRefresh\)\s*\{\s*refreshOpsAttentionPanel\(\);\s*\}\s*else\s*\{\s*renderApp\(\);\s*\}/);
  });

  it('refreshOpsAttentionPanel() replaces the existing .ops-attention node in place', () => {
    const body = functionBody(SOURCE, 'function refreshOpsAttentionPanel() {');
    expect(body).toContain("document.querySelector('.ops-attention')");
    expect(body).toContain('old.replaceWith(renderOpsAttentionCockpit())');
    expect(body).not.toContain('renderApp()');
  });

  it('the 30 s _opsAttentionTimer calls fetchOpsAttention with silentRefresh=true', () => {
    const idx = SOURCE.indexOf('state._opsAttentionTimer = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, OPS_ATTENTION_POLL_MS);', idx);
    expect(end).toBeGreaterThan(idx);
    expect(SOURCE.slice(idx, end)).toContain('fetchOpsAttention(true);');
  });

  it('a non-silent call (initial load) still does a full renderApp()', () => {
    const body = functionBody(SOURCE, 'async function fetchOpsAttention(silentRefresh) {');
    expect(body).toContain('if (isInitialLoad && !silentRefresh) renderApp();');
  });

  it('the old Action Required fetcher/panel are gone', () => {
    expect(SOURCE).not.toContain('async function fetchActionRequired(');
    expect(SOURCE).not.toContain('function renderActionRequiredPanel(');
  });
});

describe('VTID-03917: fetchOverviewTimeseries() parity fix (defensive — no live silentRefresh caller today)', () => {
  it('does not call renderApp() when silentRefresh is true', () => {
    const body = functionBody(SOURCE, 'async function fetchOverviewTimeseries(silentRefresh) {');
    // VTID-04869: the guard reads the router's real key (currentTab); the
    // old state.activeTab was never set, so this render never happened.
    expect(body).toMatch(/state\.currentTab === 'system-overview' && !silentRefresh\)\s*\{\s*renderApp\(\);/);
  });
});

describe('VTID-03917: sibling fetchServiceHealth() pattern this fix now matches', () => {
  it('fetchServiceHealth() already branches silentRefresh away from a full renderApp() (unchanged reference behavior)', () => {
    const body = functionBody(SOURCE, 'async function fetchServiceHealth(silentRefresh) {');
    expect(body).toMatch(/if\s*\(silentRefresh\)\s*\{\s*updateServiceHealthPill\(\);\s*\}\s*else\s*\{\s*renderApp\(\);\s*\}/);
  });
});
