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
 * computeSystemStatus/overviewHealthClass are pure, so they are also run.
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

/** The Overview code: helpers, fetchers and renderers, computeSystemStatus → end of release feed. */
function overviewRegion(): string {
  const start = SRC.indexOf('// VTID-01864: Supervisor Dashboard — Utility Functions');
  const end = SRC.indexOf('async function fetchOverviewReleasesSilent(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** Evaluate the two pure helpers in isolation. */
function loadHealthHelpers(): {
  overviewHealthClass: (svc: unknown) => string;
  computeSystemStatus: (checks: unknown[]) => { status: string; message: string };
} {
  const cls = SRC.slice(
    SRC.indexOf('var OVERVIEW_HEALTHY_STATUSES'),
    SRC.indexOf('\n}', SRC.indexOf('function overviewHealthClass(')) + 2,
  );
  const sys = fnBody('function computeSystemStatus(healthChecks) {');
  // eslint-disable-next-line no-new-func
  return new Function(`${cls}\n${sys}\nreturn { overviewHealthClass, computeSystemStatus };`)();
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

  it('the 60 s dashboard poll is gated on currentModuleKey/currentTab', () => {
    const body = fnBody('function startOverviewDashboardPolling() {');
    expect(body).toContain("state.currentModuleKey === 'overview' && state.currentTab === 'system-overview'");
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

  it('fetchOpsAttention / fetchOverviewTimeseries re-render on the real keys', () => {
    // VTID-04876: fetchActionRequired was replaced by fetchOpsAttention.
    expect(fnBody('async function fetchOpsAttention(silentRefresh) {')).toContain('if (opsAttentionIsOpen()) {');
    expect(fnBody('function opsAttentionIsOpen() {')).toContain(
      "state.currentModuleKey === 'overview' && state.currentTab === 'system-overview'",
    );
    expect(fnBody('async function fetchOverviewTimeseries(silentRefresh) {')).toContain(
      "state.currentModuleKey === 'overview' && state.currentTab === 'system-overview' && !silentRefresh",
    );
  });
});

describe('VTID-04869 fix 2: shared and fresh health paths both yield an array', () => {
  it('the shared branch resolves to the mapped array, not a {status, value} wrapper', () => {
    const body = fnBody('async function fetchOverviewDashboard() {');
    expect(body).toContain(
      "healthCheckPromise = Promise.resolve(state.serviceHealth.items.map(function (s) { return { status: 'fulfilled', value: s }; }));",
    );
    expect(body).not.toContain("Promise.resolve({ status: 'fulfilled', value:");
    expect(body).toContain("results[0].status === 'fulfilled' && Array.isArray(results[0].value)");
  });

  it('the parse step works for both shapes', async () => {
    const item = { name: 'Gateway', status: 'healthy' };
    const shared = (await Promise.allSettled([Promise.resolve([{ status: 'fulfilled', value: item }])]))[0];
    const fresh = (await Promise.allSettled([Promise.allSettled([Promise.resolve(item)])]))[0];
    for (const r of [shared, fresh]) {
      expect(r.status).toBe('fulfilled');
      expect(Array.isArray((r as PromiseFulfilledResult<unknown>).value)).toBe(true);
    }
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

  it('the live-metrics attention card and the VTID attention card navigate through it', () => {
    expect(SRC).toContain("navigateToScreen('command-hub', 'tasks');");
    const card = fnBody('function renderVtidAttentionCard(item) {');
    expect(card).toContain("navigateToScreen('oasis', 'vtid-ledger');");
    expect(card).toContain('fetchOasisVtidDetail(item.vtid);');
  });
});

describe('VTID-04869 fix 4: no inline onclick strings in Overview renderers', () => {
  it("no 'onclick=' in the Overview region", () => {
    expect(overviewRegion()).not.toMatch(/onclick\s*=\s*["\\]/i);
    expect(overviewRegion()).not.toContain('onclick=');
  });

  it('"View all" is a data-action link handled by a delegated listener', () => {
    const body = fnBody('function renderOverviewSystemPanels() {');
    expect(body).toContain('data-action="overview-view-all-events"');
    expect(body).toContain("livePanel.addEventListener('click', function (ev) {");
    expect(body).toContain("navigateToScreen('overview', 'recent-events');");
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
    expect(fnBody('function renderOverviewSystemPanels() {')).not.toContain("var statusLabel = 'OPERATIONAL';");
  });

  it('the UNKNOWN banner has its own (grey) style', () => {
    expect(readFileSync(STYLES_PATH, 'utf8')).toMatch(/\.overview-status-unknown\s*\{/);
  });

  it('computeSystemStatus treats failed / unavailable / misconfigured as failures', () => {
    const { computeSystemStatus } = loadHealthHelpers();
    for (const status of ['failed', 'unavailable', 'misconfigured', 'down', 'error', 'unhealthy']) {
      const r = computeSystemStatus([
        { name: 'Telemetry', status },
        { name: 'Events', status: 'healthy' },
      ]);
      expect({ status, result: r.status }).toEqual({ status, result: 'degraded' });
    }
    expect(computeSystemStatus([{ name: 'Gateway', status: 'misconfigured' }]).status).toBe('critical');
  });

  it('computeSystemStatus returns unknown when nothing was measured', () => {
    const { computeSystemStatus } = loadHealthHelpers();
    expect(computeSystemStatus([]).status).toBe('unknown');
    expect(computeSystemStatus([{ name: 'Auth', status: 'no_access' }]).status).toBe('unknown');
    expect(computeSystemStatus([{ name: 'Gateway', status: 'healthy', healthy: true }]).status).toBe('operational');
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

  it('a failed failures fetch is not "No failures"', () => {
    const fetchBody = fnBody('async function fetchOverviewDashboard() {');
    expect(fetchBody).toContain(
      "fetchWT('/api/v1/oasis/events?status=error&limit=30').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })",
    );
    expect(fetchBody).toContain('state.overviewDashboard.recentFailuresUnavailable = recentFailuresUnavailable;');
    const body = fnBody('function renderOverviewSystemPanels() {');
    expect(body).not.toContain('No failures in the last 24h');
    expect(body).toContain('Could not load failure events');
  });

  it("a deployment without a service reads 'unknown', not 'gateway'", () => {
    const body = fnBody('function renderOverviewSystemPanels() {');
    expect(body).not.toContain("dep.service || dep.service_name || 'gateway'");
    expect(body).toContain("dep.service || dep.service_name || 'unknown'");
  });

  it('a missing pipeline summary is not "Pipeline running smoothly"', () => {
    const body = fnBody('function renderOverviewSystemPanels() {');
    const idx = body.indexOf('if (!summary) {');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(body.indexOf('Pipeline running smoothly.'));
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
    expect(body).toContain("var orbProvider = (orbStats && orbStats.runtime_provider) || 'unknown';");
  });

  it('computeOrbSessionStats no longer derives Vertex/Gemini/Google flags', () => {
    const body = stripLineComments(fnBody('function computeOrbSessionStats(orbEvents, orbHealthDetails) {'));
    expect(body).not.toContain('gemini_live_enabled');
    expect(body).not.toContain('vertex_project_configured');
    expect(body).not.toContain('google_auth_ready');
    expect(body).toContain('runtime_known: runtimeKnown');
    // No session starts = no rate, not a red 0%.
    expect(body).toContain('var successRate = starts > 0 ?');
    expect(body).toMatch(/: null;/);
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
    expect(body).toContain("label: 'Errors (last 30)'");
    expect(body).not.toContain("' sessions (24h)'");
    expect(body).not.toContain("label: 'Sessions (24h)'");
    expect(body).not.toContain("label: 'Failures (24h)'");
    expect(body).not.toContain("' (7d)'");
    expect(body).not.toContain("subtitle: '7d total'");
    expect(body).toContain("'Errors (last 30)': '<svg");
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
