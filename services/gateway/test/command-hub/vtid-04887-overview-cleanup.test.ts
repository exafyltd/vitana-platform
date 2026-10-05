/**
 * Command Hub Overview Phase 4 — cleanup (VTID-04887, plan A phase 4).
 *
 *   1. The Overview's four other tabs (live-metrics, recent-events,
 *      errors-violations, release-feed) are router redirects to their
 *      specialised screens, with a short note. No dead tab content: their
 *      renderers, fetchers and hardcoded lists are deleted.
 *   2. The collapsed "Detailed panels" keep only what no tile or adapter
 *      covers: grouped Service Health (every check; the Platform tile only
 *      summarises it) and Vitana Recommends (generate / activate / dismiss).
 *      The other pre-Phase-1 panels are covered by the domain tiles
 *      (VTID-04885), the queue and the timeline (VTID-04886) and are deleted,
 *      with the dashboard fetch, its 60 s poll and the old pipeline-summary
 *      fetch they needed.
 *   3. The Operator Dashboard, the Runbook and Vitana Recommends read the
 *      pipeline summary from the admin-gated GET /api/v1/ops/pipeline-summary
 *      (route test: test/vtid-04887-ops-pipeline-summary-route.test.ts).
 *
 * Source-level plus small evaluations of the real router code, the
 * established pattern for app.js (vanilla JS, no build step).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const CH = join(__dirname, '../../src/frontend/command-hub');
const SRC = readFileSync(join(CH, 'app.js'), 'utf8');
const INDEX_HTML = readFileSync(join(CH, 'index.html'), 'utf8');

const OLD_TABS = ['live-metrics', 'recent-events', 'errors-violations', 'release-feed'];

/** Slice a balanced literal ([...] or {...}) that starts at `marker`. */
function literalAt(marker: string, open: '[' | '{'): string {
  const start = SRC.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const close = open === '[' ? ']' : '}';
  const from = SRC.indexOf(open, start);
  let depth = 0;
  for (let i = from; i < SRC.length; i++) {
    if (SRC[i] === open) depth++;
    else if (SRC[i] === close && --depth === 0) return SRC.slice(from, i + 1);
  }
  throw new Error('unbalanced literal at ' + marker);
}

/** Slice a top-level function body: from its signature to the next top-level `\n}`. */
function fnBody(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\n}', start) + 2);
}

type NavSection = { section: string; basePath: string; tabs: Array<{ key: string; path: string }> };
type Route = { section: string; tab: string; note?: string; subtab?: string };

/** The real router pieces: NAVIGATION_CONFIG, both redirect tables, getRouteFromPath. */
function loadRouter(): {
  nav: NavSection[];
  overviewRedirects: Record<string, Route>;
  getRouteFromPath: (p: string) => Route;
} {
  const nav = literalAt('const NAVIGATION_CONFIG = [', '[');
  const autonomy = literalAt('const AUTONOMY_REDIRECTS = {', '{');
  const overview = literalAt('const OVERVIEW_TAB_REDIRECTS = {', '{');
  const merge = SRC.slice(
    SRC.indexOf('Object.keys(OVERVIEW_TAB_REDIRECTS).forEach('),
    SRC.indexOf('\n', SRC.indexOf('Object.keys(OVERVIEW_TAB_REDIRECTS).forEach(')),
  );
  const route = fnBody('function getRouteFromPath(pathname) {');
  // eslint-disable-next-line no-new-func
  return new Function(
    `const NAVIGATION_CONFIG = ${nav};\n` +
      `const AUTONOMY_REDIRECTS = ${autonomy};\n` +
      `const OVERVIEW_TAB_REDIRECTS = ${overview};\n${merge}\n${route}\n` +
      'return { nav: NAVIGATION_CONFIG, overviewRedirects: OVERVIEW_TAB_REDIRECTS, getRouteFromPath };',
  )();
}

/** Every function Phase 4 deleted (Phase 3 app.js minus this one). */
const REMOVED_FUNCTIONS = [
  'computeDeploySuccessRate',
  'computeOrbSessionStats',
  'computeSystemStatus',
  'fetchOverviewDashboard',
  'fetchOverviewErrors',
  'fetchOverviewHealth',
  'fetchOverviewMetrics',
  'fetchOverviewRecentEvents',
  'fetchOverviewReleases',
  'fetchOverviewReleasesSilent',
  'fetchOverviewTimeseries',
  'fetchPipelineSummary',
  'metricCardHTML',
  'metricColor',
  'metricColorInverse',
  'renderMetricsGroup',
  'renderOverviewErrorsViolationsView',
  'renderOverviewLiveMetricsView',
  'renderOverviewRecentEventsView',
  'renderOverviewReleaseFeedView',
  'renderVtidAttentionCard',
  'renderVtidAttentionSection',
  'sparklineSVG',
  'startOverviewDashboardPolling',
  'startOverviewReleasesAutoRefresh',
  'stopOverviewReleasesAutoRefresh',
];

describe('VTID-04887 (1): the four old Overview tabs are redirects', () => {
  const { nav, overviewRedirects, getRouteFromPath } = loadRouter();

  it('the Overview section has exactly one tab, System Overview', () => {
    const overview = nav.find((s) => s.section === 'overview');
    expect(overview).toBeDefined();
    expect(overview!.tabs.map((t) => t.key)).toEqual(['system-overview']);
    for (const s of nav) for (const t of s.tabs) for (const old of OLD_TABS) expect(t.path).not.toBe(`/command-hub/overview/${old}/`);
  });

  it('there is one redirect per old tab, each with a short note', () => {
    expect(Object.keys(overviewRedirects).sort()).toEqual(OLD_TABS.map((t) => `/command-hub/overview/${t}/`).sort());
    for (const r of Object.values(overviewRedirects)) {
      expect(typeof r.note).toBe('string');
      expect(r.note!.length).toBeGreaterThan(10);
      expect(r.note!.length).toBeLessThan(90);
      expect(r.note).toContain('moved');
    }
  });

  it('every redirect target exists in NAVIGATION_CONFIG (walk)', () => {
    for (const [from, r] of Object.entries(overviewRedirects)) {
      const section = nav.find((s) => s.section === r.section);
      const tab = section ? section.tabs.find((t) => t.key === r.tab) : undefined;
      expect({ from, target: `${r.section}/${r.tab}`, found: !!tab }).toEqual({ from, target: `${r.section}/${r.tab}`, found: true });
      // A redirect never lands on another redirect or on the Overview again.
      expect(r.section).not.toBe('overview');
      expect(Object.keys(overviewRedirects)).not.toContain(tab!.path);
    }
  });

  it('every redirect in the shared table resolves to a real tab too (no dangling legacy link)', () => {
    const all = literalAt('const AUTONOMY_REDIRECTS = {', '{');
    // eslint-disable-next-line no-new-func
    const table = new Function(`return ${all};`)() as Record<string, Route>;
    for (const [from, r] of Object.entries(table)) {
      const section = nav.find((s) => s.section === r.section);
      expect({ from, ok: !!(section && section.tabs.some((t) => t.key === r.tab)) }).toEqual({ from, ok: true });
    }
  });

  it.each(OLD_TABS)('getRouteFromPath sends /command-hub/overview/%s/ (with or without the slash) to its screen', (old) => {
    const expected = overviewRedirects[`/command-hub/overview/${old}/`];
    for (const p of [`/command-hub/overview/${old}/`, `/command-hub/overview/${old}`]) {
      const r = getRouteFromPath(p);
      expect({ section: r.section, tab: r.tab }).toEqual({ section: expected.section, tab: expected.tab });
      expect(r.note).toBe(expected.note);
    }
  });

  it('System Overview itself still routes to the cockpit', () => {
    expect(getRouteFromPath('/command-hub/overview/system-overview/')).toEqual({ section: 'overview', tab: 'system-overview' });
    expect(getRouteFromPath('/command-hub/overview/')).toEqual({ section: 'overview', tab: 'system-overview' });
  });

  it('the note is shown once as an info toast wherever a route is applied', () => {
    const body = fnBody('function applyRouteSubtab(route) {');
    expect(body).toContain("if (route && route.note && typeof showToast === 'function') showToast(route.note, 'info');");
    // Applied on first load and on back/forward.
    expect(SRC.match(/applyRouteSubtab\(route\);/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('on first load the address bar is rewritten to the target tab path', () => {
    const init = SRC.slice(SRC.indexOf("document.addEventListener('DOMContentLoaded', async () => {"));
    expect(init).toContain('const route = getRouteFromPath(window.location.pathname);');
    expect(init).toContain("history.replaceState(null, '', tab.path + (window.location.search || ''));");
  });
});

describe('VTID-04887 (1): no dead tab content', () => {
  it('no render dispatch branch for any old tab remains', () => {
    for (const old of OLD_TABS) {
      expect(SRC).not.toContain(`moduleKey === 'overview' && tab === '${old}'`);
      expect(SRC).not.toContain(`state.currentTab === '${old}'`);
    }
  });

  it.each(REMOVED_FUNCTIONS)('`%s` is deleted and nothing mentions it', (name) => {
    expect(SRC).not.toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
    expect((SRC.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length).toBe(0);
  });

  it('the hardcoded lists and state the old tabs and panels used are gone', () => {
    for (const s of [
      'var NOISE_TOPICS',
      'var EVENT_FILTERS',
      'overviewRecentEventsFilter',
      'overviewRecentEvents:',
      'overviewErrors:',
      'overviewReleases:',
      'overviewMetrics:',
      'overviewPipelineSummary:',
      'overviewTimeseries:',
      'overviewDashboard:',
      'overviewHealth:',
      "var criticalServices = ['Gateway', 'ORB Live', 'CI/CD', 'Autopilot', 'Execute Runner'];",
    ]) {
      expect({ s, present: SRC.includes(s) }).toEqual({ s, present: false });
    }
  });
});

describe('VTID-04887 (2): the detailed panels keep only grouped Service Health and Vitana Recommends', () => {
  const panels = fnBody('function renderOverviewSystemPanels() {');

  it('renders the grouped Service Health panel from the registry poll only', () => {
    expect(panels).toContain("healthPanel.className = 'overview-health-grid';");
    expect(panels).toContain('var allHealthServices = state.serviceHealth.items || [];');
    expect(panels).toContain('fetchServiceHealth();');
  });

  it('no other pre-Phase-1 panel is left', () => {
    for (const gone of [
      'overview-metrics-grid',
      'overview-orb-panel',
      'overview-failures-panel',
      'overview-deploy-panel',
      'overview-attention-center',
      'overview-recommends-panel',
      'livePanel',
      'state.overviewDashboard',
    ]) {
      expect({ gone, present: panels.includes(gone) }).toEqual({ gone, present: false });
    }
  });

  it('the disclosure is labelled for what it holds and stays collapsed until opened', () => {
    const view = fnBody('function renderOverviewSystemView() {');
    expect(view).toContain("summary.textContent = 'Service health and recommendations';");
    expect(view).toContain('if (state.opsAttention.legacyOpen) {');
    expect(view).toContain("details.addEventListener('toggle', function () {");
  });

  it('Vitana Recommends is rendered inside the disclosure, after Service Health', () => {
    expect(panels).toContain('container.appendChild(renderOverviewRecommendsPanel());');
    expect(panels.indexOf('container.appendChild(healthPanel);')).toBeLessThan(panels.indexOf('renderOverviewRecommendsPanel()'));
  });

  it('the cockpit is the only Overview poll (no 60 s dashboard refresh)', () => {
    expect(SRC).not.toContain('overviewDashboardRefreshInterval');
    expect(SRC).toContain('state._opsAttentionTimer = setInterval(function () {');
  });

  it('the Service Health badge names full class names, so the dead-CSS matcher sees them', () => {
    expect(panels).toContain("'overview-count-badge-green' : 'overview-count-badge-amber'");
    expect(readFileSync(join(CH, 'styles.css'), 'utf8')).toMatch(/\.overview-count-badge-green\s*\{/);
  });
});

describe('VTID-04887 (3): browser callers of the pipeline summary use the admin route', () => {
  it('no code line calls the service-token /api/v1/autopilot/pipeline/summary', () => {
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('/api/v1/autopilot/pipeline/summary');
    // Operator Dashboard + Runbook (fetch) and Vitana Recommends (fetchWT).
    expect((code.match(/fetch\('\/api\/v1\/ops\/pipeline-summary', \{/g) || []).length).toBe(2);
    expect((code.match(/fetchWT\('\/api\/v1\/ops\/pipeline-summary', \{/g) || []).length).toBe(1);
  });

  describe('Vitana Recommends', () => {
    const panel = fnBody('function renderOverviewRecommendsPanel() {');
    const fetcher = fnBody('async function fetchOverviewRecommendations() {');

    it('reads the admin route with the bearer token and keeps only the recommendations', () => {
      expect(fetcher).toContain("var r = await fetchWT('/api/v1/ops/pipeline-summary', {");
      expect(fetcher).toContain("headers: buildContextHeaders({ Accept: 'application/json' })");
      expect(fetcher).toContain('view.recommendations = Array.isArray(body.recommendations) ? body.recommendations : [];');
    });

    it('cannot loop: fetched is set in finally, and the panel fetches only when not fetched/loading', () => {
      const fin = fetcher.slice(fetcher.lastIndexOf('} finally {'));
      expect(fin).toContain('view.fetched = true;');
      expect(fin).toContain('view.loading = false;');
      expect(panel).toContain('if (!view.fetched && !view.loading) fetchOverviewRecommendations();');
      // A refresh swaps the panel in place; it never rebuilds the app.
      expect(fnBody('function rerenderOverviewRecommends() {')).toContain("old.replaceWith(renderOverviewRecommendsPanel());");
      expect(fetcher).not.toContain('renderApp()');
    });

    it('a failed or pending read is never "No pending recommendations"', () => {
      expect(panel).toContain("'Could not load recommendations (' + view.error + ').'");
      expect(panel).toContain("'Loading recommendations…'");
      const idx = panel.indexOf('view.error');
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(panel.indexOf('No pending recommendations.'));
    });

    it('keeps Generate, Activate and Dismiss, and refreshes through the admin route', () => {
      expect(panel).toContain("fetch('/api/v1/autopilot/recommendations/generate', { method: 'POST', headers: buildContextHeaders({}) });");
      expect(panel).toContain("fetch('/api/v1/autopilot/recommendations/' + rec.id + '/activate', {");
      expect(panel).toContain('openRecDismissPicker(rec);');
      expect((panel.match(/refreshOverviewRecommendations\(\);/g) || []).length).toBe(3);
      expect(panel).not.toMatch(/\.style\b/);
    });
  });
});

describe('VTID-04887: asset version', () => {
  it('index.html loads app.js and styles.css at (or after) the VTID-04887 version', () => {
    const app = (INDEX_HTML.match(/app\.js\?v=([^"']+)/) || [])[1] || '';
    const css = (INDEX_HTML.match(/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(app >= '20261030-vtid-04887').toBe(true);
    expect(css).toBe(app);
  });
});
