/**
 * Command Hub Overview Phase 0 — stop false signals (VTID-04869).
 *
 * The System Overview showed signals that were not true:
 *   1. Its polling timers and re-render guards read state.activeModule /
 *      state.activeTab. The router only ever sets currentModuleKey /
 *      currentTab, so the 60 s dashboard refresh and the 30 s Action
 *      Required poll never fired and the page went stale silently.
 *   2. Within 90 s of a Service Health poll the dashboard reused the shared
 *      result, wrapped in a {status, value} object that Promise.allSettled
 *      wrapped again — results[0].value.map threw on every such refresh.
 *   3. The live-metrics attention cards called navigateTo(), which is not
 *      defined anywhere — every click threw.
 *   4. "View all" was an inline onclick string (CSP) that also wrote the
 *      unused activeModule/activeTab keys.
 *   5. The status banner defaulted to OPERATIONAL when nothing was measured,
 *      computeSystemStatus counted failed/unavailable/misconfigured as
 *      healthy, a failed failures fetch read "No failures in the last 24h",
 *      and a deployment row with no service read 'gateway'.
 *   6. The ORB card showed Gemini Live / Vertex Project / Google Auth badges
 *      (GCP is decommissioned) and labelled every non-LiveKit provider
 *      "Vertex".
 *   7. Several cards claimed time windows (24h, 7d) the data does not have.
 *
 * Structural/source-level, the established pattern for app.js (vanilla JS,
 * no build step, no render harness) — see t5d-stale-gcp-labels-fixed.test.ts.
 * overviewHealthClass is pure, so it is also run.
 *
 * VTID-04887 (Overview Phase 4, cleanup) deleted the code several of these
 * fixes lived in: the four old Overview tabs, the pre-Phase-1 panels other
 * than the grouped Service Health panel, fetchOverviewDashboard and its
 * helpers (computeSystemStatus, computeOrbSessionStats, ...), the 60 s
 * dashboard poll and the old pipeline-summary fetch. Where a fix's code is
 * gone, its test now pins that the code — and the false signal — stays gone;
 * everything that still exists is still checked as before.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const STYLES_PATH = join(__dirname, '../../src/frontend/command-hub/styles.css');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

const SRC = readFileSync(APP_JS_PATH, 'utf8');

/** Drop whole-line `//` comments so change notes naming old strings don't count. */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

/** Slice a top-level function body: from its signature to the next top-level `\n}`. */
function fnBody(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end + 2);
}

/**
 * The Overview code: helpers, fetchers and renderers, from the utility
 * header to the Operator task queue. VTID-04887: the old end marker (the
 * release feed) was deleted with the tab.
 */
function overviewRegion(): string {
  const start = SRC.indexOf('// VTID-01864: Supervisor Dashboard — Utility Functions');
  const end = SRC.indexOf('async function fetchOperatorTaskQueue(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** Evaluate the pure health classifier in isolation. */
function loadHealthHelpers(): {
  overviewHealthClass: (svc: unknown) => string;
} {
  const cls = SRC.slice(
    SRC.indexOf('var OVERVIEW_HEALTHY_STATUSES'),
    SRC.indexOf('\n}', SRC.indexOf('function overviewHealthClass(')) + 2,
  );
  // eslint-disable-next-line no-new-func
  return new Function(`${cls}\nreturn { overviewHealthClass };`)();
}

describe('VTID-04869 fix 1: Overview uses the real router keys', () => {
  it('no Overview code reads or writes state.activeModule / state.activeTab', () => {
    const code = stripLineComments(overviewRegion());
    expect(code).not.toMatch(/state\.activeModule\b/);
    expect(code).not.toMatch(/state\.activeTab\b/);
  });

  it('nothing in app.js reads state.activeModule / state.activeTab any more', () => {
    const code = stripLineComments(SRC);
    expect(code).not.toMatch(/state\.activeModule\b/);
    expect(code).not.toMatch(/state\.activeTab\b/);
  });

  it('the 60 s dashboard poll is gone with the panels it refreshed (VTID-04887)', () => {
    expect(SRC).not.toMatch(/function\s+startOverviewDashboardPolling\s*\(/);
    expect(SRC).not.toMatch(/\bstartOverviewDashboardPolling\(/);
    expect(SRC).not.toContain('overviewDashboardRefreshInterval');
  });

  it('the 30 s Overview poll is gated on currentModuleKey/currentTab', () => {
    // VTID-04876: the Action Required poll became the ops/attention cockpit poll.
    const idx = SRC.indexOf('state._opsAttentionTimer = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, SRC.indexOf('}, OPS_ATTENTION_POLL_MS);', idx));
    expect(body).toContain(
      "state.currentModuleKey === 'overview' && state.currentTab === 'system-overview' && !state.isOperatorOpen",
    );
  });

  it('fetchOpsAttention re-renders on the real keys', () => {
    // VTID-04876: fetchActionRequired was replaced by fetchOpsAttention.
    expect(fnBody('async function fetchOpsAttention(silentRefresh) {')).toContain('if (opsAttentionIsOpen()) {');
    expect(fnBody('function opsAttentionIsOpen() {')).toContain(
      "state.currentModuleKey === 'overview' && state.currentTab === 'system-overview'",
    );
    // VTID-04887: fetchOverviewTimeseries fed only the deleted metrics grid;
    // the cockpit's sparklines come from /ops/attention (VTID-04886).
    expect(SRC).not.toMatch(/function\s+fetchOverviewTimeseries\s*\(/);
  });
});

describe('VTID-04869 fix 2: shared and fresh health paths both yield an array', () => {
  it('the dashboard fetch that double-wrapped the shared health result is gone (VTID-04887)', () => {
    // The grouped Service Health panel reads state.serviceHealth directly;
    // nothing re-wraps it any more.
    expect(SRC).not.toMatch(/function\s+fetchOverviewDashboard\s*\(/);
    expect(SRC).not.toMatch(/\bfetchOverviewDashboard\(/);
    expect(SRC).not.toContain("Promise.resolve({ status: 'fulfilled', value:");
    expect(fnBody('function renderOverviewSystemPanels() {')).toContain('var allHealthServices = state.serviceHealth.items || [];');
  });
});

describe('VTID-04869 fix 3: no call to an undefined navigateTo()', () => {
  it('navigateTo( is never called (it is not defined)', () => {
    const code = stripLineComments(SRC);
    expect(code).not.toMatch(/function\s+navigateTo\s*\(/);
    expect(code).not.toMatch(/\bnavigateTo\(/);
  });

  it('navigateToScreen sets the router keys, pushes the tab path and renders once', () => {
    // VTID-04876: navigateToScreen takes an optional deep-link query.
    const body = fnBody('function navigateToScreen(sectionKey, tabKey, query) {');
    expect(body).toContain('NAVIGATION_CONFIG.find(');
    expect(body).toContain('state.currentModuleKey = sectionKey;');
    expect(body).toContain("state.currentTab = tab ? tab.key : '';");
    expect(body).toContain('history.pushState(null, ');
    expect((body.match(/renderApp\(\)/g) || []).length).toBe(1);
    expect(body).toContain('opsAttentionQueryString(query)');
    expect(body).toContain('applyDeepLinkParams();');
  });

  it('the live-metrics and VTID attention cards are gone with their tab and panel (VTID-04887)', () => {
    expect(SRC).not.toMatch(/function\s+renderOverviewLiveMetricsView\s*\(/);
    expect(SRC).not.toMatch(/function\s+renderVtidAttentionCard\s*\(/);
    expect(SRC).not.toMatch(/function\s+renderVtidAttentionSection\s*\(/);
  });
});

describe('VTID-04869 fix 4: no inline onclick strings in Overview renderers', () => {
  it("no 'onclick=' in the Overview region", () => {
    expect(overviewRegion()).not.toMatch(/onclick\s*=\s*["\\]/i);
    expect(overviewRegion()).not.toContain('onclick=');
  });

  it('the live activity panel and its "View all" link are gone (VTID-04887)', () => {
    // The panel linked to the Recent Events tab, which is a redirect now.
    expect(SRC).not.toContain('overview-view-all-events');
    expect(SRC).not.toContain("navigateToScreen('overview', 'recent-events')");
    expect(fnBody('function renderOverviewSystemPanels() {')).not.toContain('livePanel');
  });
});

describe('VTID-04869 fix 5: UNKNOWN instead of a fabricated all-clear', () => {
  it('the status bar starts at UNKNOWN, never OPERATIONAL (VTID-04876 cockpit)', () => {
    // VTID-04876: the old banner was replaced by the ops/attention status bar,
    // which is UNKNOWN on any fetch error or missing answer.
    const body = fnBody('function computeOpsAttentionStatus(view, nowMs) {');
    expect(body).toContain("verdict: 'UNKNOWN', blind: true");
    expect(body).toContain("label: 'UNKNOWN'");
    expect(body).not.toContain('OPERATIONAL');
    expect(fnBody('function renderOverviewSystemPanels() {')).not.toContain('OPERATIONAL');
  });

  it('the UNKNOWN banner has its own (grey) style', () => {
    // VTID-04876: the banner became the cockpit status bar; its UNKNOWN style
    // is .ops-verdict-unknown (the old .overview-status-unknown rule is dead
    // CSS now and was removed).
    expect(readFileSync(STYLES_PATH, 'utf8')).toMatch(/\.ops-verdict-unknown\s*\{/);
  });

  it('computeSystemStatus is gone with the banner it fed (VTID-04887)', () => {
    // The verdict is computed server-side by /ops/attention and rendered by
    // computeOpsAttentionStatus (UNKNOWN when blind), pinned above.
    expect(SRC).not.toMatch(/function\s+computeSystemStatus\s*\(/);
    expect(SRC).not.toMatch(/\bcomputeSystemStatus\(/);
  });

  it('overviewHealthClass never calls an unrecognised status healthy', () => {
    const { overviewHealthClass } = loadHealthHelpers();
    expect(overviewHealthClass({ status: 'ok_governance_limited' })).toBe('healthy');
    expect(overviewHealthClass({ status: 'not_configured' })).toBe('unknown');
    expect(overviewHealthClass({ status: 'warning' })).toBe('degraded');
    expect(overviewHealthClass({ status: 'something-new' })).toBe('failed');
  });

  it('the health panel filters use the shared classification', () => {
    const body = fnBody('function renderOverviewSystemPanels() {');
    expect(body).toContain("var failedSvcs = sortedHealth.filter(function (s) { return overviewHealthClass(s) === 'failed'; });");
    expect(body).toContain("var tier2Failed = tier2Services.filter(function (s) { return overviewHealthClass(s) === 'failed'; });");
    expect(body).toContain("svcs.filter(function (s) { return overviewHealthClass(s) === 'failed'; })");
    expect(body).not.toContain("var hdot = 'green';");
  });

  it('the failures, deployments and attention-center panels are gone, and with them their all-clear lines (VTID-04887)', () => {
    const region = overviewRegion();
    expect(region).not.toContain('No failures in the last 24h');
    expect(region).not.toContain("dep.service || dep.service_name || 'gateway'");
    expect(region).not.toContain('Pipeline running smoothly');
    expect(SRC).not.toContain('state.overviewDashboard');
    expect(SRC).not.toContain('state.overviewPipelineSummary');
  });
});

describe('VTID-04869 fix 6: provider-neutral ORB card', () => {
  it("no 'Vertex' label fallback and no Gemini/Vertex/Google badges", () => {
    const body = stripLineComments(fnBody('function renderOverviewSystemPanels() {'));
    expect(body).not.toContain("'LiveKit' : 'Vertex'");
    expect(body).not.toContain("(orbOk ? 'vertex' : null)");
    expect(body).not.toContain("label: 'Gemini Live'");
    expect(body).not.toContain("label: 'Vertex Project'");
    expect(body).not.toContain("label: 'Google Auth'");
    expect(body).not.toContain('VERTEX_PROJECT_ID');
    expect(body).not.toContain('ORB BROKEN');
    // VTID-04887: the ORB card itself is gone (the Voice tile covers it).
    expect(body).not.toContain('orbProvider');
  });

  it('computeOrbSessionStats is gone with the ORB card (VTID-04887)', () => {
    expect(SRC).not.toMatch(/function\s+computeOrbSessionStats\s*\(/);
    expect(stripLineComments(overviewRegion())).not.toMatch(/gemini_live_enabled|vertex_project_configured|google_auth_ready/);
  });

  it('nothing still reads the removed ORB flags', () => {
    const code = stripLineComments(overviewRegion());
    expect(code).not.toMatch(/orbStats\.(gemini_live_enabled|vertex_project_configured|google_auth_ready)/);
  });
});

describe('VTID-04869 fix 7: labels say what the data covers', () => {
  it('no claimed 24h / 7d window on data that has none', () => {
    const body = stripLineComments(fnBody('function renderOverviewSystemPanels() {'));
    expect(body).not.toContain("label: 'Errors (24h)'");
    expect(body).not.toContain("' sessions (24h)'");
    expect(body).not.toContain("label: 'Sessions (24h)'");
    expect(body).not.toContain("label: 'Failures (24h)'");
    expect(body).not.toContain("' (7d)'");
    expect(body).not.toContain("subtitle: '7d total'");
    // VTID-04887: the metrics grid that carried these labels is gone.
    expect(SRC).not.toMatch(/function\s+metricCardHTML\s*\(/);
  });
});

describe('VTID-04869: asset version bumped', () => {
  it('index.html loads app.js and styles.css at (or after) the VTID-04869 version', () => {
    // VTID-04876 bumped it again; the version only ever moves forward.
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    const app = (html.match(/app\.js\?v=([^"']+)/) || [])[1] || '';
    const css = (html.match(/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(app >= '20261026-vtid-04869').toBe(true);
    expect(css >= '20261026-vtid-04869').toBe(true);
  });
});
