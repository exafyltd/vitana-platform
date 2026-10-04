/**
 * Command Hub Overview Phase 1 — the supervisor cockpit (VTID-04876).
 *
 * Source-level and sandboxed checks in the style of
 * vtid-04869-overview-phase0.test.ts (app.js is vanilla JS with no build
 * step and no render harness). Pure helpers are evaluated in isolation.
 *
 * Covers: the status bar / queue renderers, the 30 s poll on the real router
 * keys, the UNKNOWN "Cockpit blind — check GChat" rule (fetch error or 2x the
 * poll interval), severity as icon + text + colour, aria-live, delegated
 * data-action handlers (no onclick), the /ops/action-required → /ops/attention
 * migration, the ?vtid= / ?session= deep-link contract (with the toast +
 * list fallback), and a walk of every adapter deeplink against
 * NAVIGATION_CONFIG.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ATTENTION_ADAPTERS,
  DEEPLINK_QUERY_CONTRACT,
  type Deeplink,
} from '../../src/services/ops-attention-adapters';
import { fakeReads } from '../fixtures/ops-attention-fakes';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const STYLES_PATH = join(__dirname, '../../src/frontend/command-hub/styles.css');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');
const SRC = readFileSync(APP_JS_PATH, 'utf8');
const CSS = readFileSync(STYLES_PATH, 'utf8');

function fnBody(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/** The Overview code region (same bounds as the Phase 0 test). */
function overviewRegion(): string {
  const start = SRC.indexOf('// VTID-01864: Supervisor Dashboard — Utility Functions');
  const end = SRC.indexOf('async function fetchOverviewReleasesSilent(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** The new cockpit block: from its header comment to renderOverviewSystemPanels. */
function cockpitRegion(): string {
  const start = SRC.indexOf('// VTID-04876: Overview Phase 1 — the supervisor cockpit');
  const end = SRC.indexOf('function renderOverviewSystemPanels() {');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

function navigationConfig(): Array<{ section: string; basePath: string; tabs: Array<{ key: string; path: string }> }> {
  const start = SRC.indexOf('const NAVIGATION_CONFIG = [');
  const end = SRC.indexOf('\n];', start);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${SRC.slice(start + 'const NAVIGATION_CONFIG = '.length, end + 2)};`)();
}

function frontendContract(): Record<string, string[]> {
  const start = SRC.indexOf('var OVERVIEW_DEEPLINK_QUERY_CONTRACT = {');
  const end = SRC.indexOf('};', start);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${SRC.slice(start + 'var OVERVIEW_DEEPLINK_QUERY_CONTRACT = '.length, end + 1)};`)();
}

/** Evaluate the cockpit's pure helpers in isolation. */
function loadPure(): {
  computeOpsAttentionStatus: (view: unknown, now: number) => { verdict: string; blind: boolean; cls: string; label: string; detail: string };
  opsAttentionEnvLabel: (env: unknown) => string;
  opsAttentionQueryString: (q: unknown) => string;
  OPS_ATTENTION_POLL_MS: number;
  OPS_ATTENTION_BLIND_MS: number;
  OPS_ATTENTION_SEVERITY: Record<string, { icon: string; label: string; cls: string }>;
} {
  const consts = SRC.slice(SRC.indexOf('var OPS_ATTENTION_POLL_MS'), SRC.indexOf('function opsAttentionIsOpen() {'));
  const parts = [
    consts,
    fnBody('function computeOpsAttentionStatus(view, nowMs) {'),
    fnBody('function opsAttentionEnvLabel(env) {'),
    fnBody('function opsAttentionQueryString(query) {'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${parts}\nreturn { computeOpsAttentionStatus, opsAttentionEnvLabel, opsAttentionQueryString, OPS_ATTENTION_POLL_MS, OPS_ATTENTION_BLIND_MS, OPS_ATTENTION_SEVERITY };`,
  )();
}

describe('VTID-04876: status bar', () => {
  const NOW = 1_000_000_000;
  const good = (o: object = {}) => ({ data: { verdict: 'OK', counts: { p1: 0, p2: 0, p3: 0 }, sources: [], env: 'production' }, error: null, lastOkAt: NOW, ...o });

  it('polls every 30 s and goes blind after 2x the poll interval', () => {
    const p = loadPure();
    expect(p.OPS_ATTENTION_POLL_MS).toBe(30_000);
    expect(p.OPS_ATTENTION_BLIND_MS).toBe(60_000);
    expect(p.computeOpsAttentionStatus(good(), NOW + 60_000).verdict).toBe('OK');
    const blind = p.computeOpsAttentionStatus(good(), NOW + 60_001);
    expect(blind).toMatchObject({ verdict: 'UNKNOWN', blind: true, cls: 'ops-verdict-unknown' });
    expect(blind.detail).toContain('Cockpit blind \u2014 check GChat');
  });

  it('any fetch error, or no answer yet, is UNKNOWN — never OK', () => {
    const p = loadPure();
    expect(p.computeOpsAttentionStatus(good({ error: 'HTTP 401 UNAUTHENTICATED' }), NOW)).toMatchObject({ verdict: 'UNKNOWN', blind: true });
    expect(p.computeOpsAttentionStatus(good({ error: 'HTTP 401 UNAUTHENTICATED' }), NOW).detail).toContain('HTTP 401');
    expect(p.computeOpsAttentionStatus({ data: null, error: null, lastOkAt: null }, NOW).verdict).toBe('UNKNOWN');
    expect(p.computeOpsAttentionStatus(null, NOW).verdict).toBe('UNKNOWN');
  });

  it('shows the server verdict when fresh; an unknown or unrecognised verdict stays UNKNOWN', () => {
    const p = loadPure();
    for (const [v, cls] of [['CRITICAL', 'ops-verdict-critical'], ['ATTENTION', 'ops-verdict-attention'], ['OK', 'ops-verdict-ok'], ['UNKNOWN', 'ops-verdict-unknown']]) {
      const r = p.computeOpsAttentionStatus(good({ data: { ...good().data, verdict: v } }), NOW);
      expect([r.verdict, r.cls, r.blind]).toEqual([v, cls, false]);
    }
    expect(p.computeOpsAttentionStatus(good({ data: { ...good().data, verdict: 'GREEN' } }), NOW).verdict).toBe('UNKNOWN');
    expect(p.computeOpsAttentionStatus(good({ data: { ...good().data, verdict: 'UNKNOWN' } }), NOW).detail).toContain('not an all-clear');
  });

  it('labels staging as "Staging build · production data"', () => {
    const p = loadPure();
    expect(p.opsAttentionEnvLabel('staging')).toBe('Staging build \u00b7 production data');
    expect(p.opsAttentionEnvLabel('production')).toBe('Production');
  });

  it('renders verdict, P1/P2/P3 counts, sources fresh x/y, generated_at, env and refresh', () => {
    const body = fnBody('function renderOpsAttentionStatusBar(view, nowMs) {');
    expect(body).toContain("countChip('P1', counts.p1) + countChip('P2', counts.p2) + countChip('P3', counts.p3)");
    expect(body).toContain('>Sources fresh \'');
    expect(body).toContain("'Generated ' + escapeHtml(dashboardRelativeTime(data.generated_at))");
    expect(body).toContain('opsAttentionEnvLabel(env)');
    expect(body).toContain('data-action="ops-attention-refresh"');
    expect(body).toContain("bar.setAttribute('role', 'status');");
    // Blind → counts and freshness are '?', not stale numbers.
    expect(body).toContain("(st.blind ? '?' : String(n))");
  });
});

describe('VTID-04876: ranked queue', () => {
  it('severity is icon + text label + colour class', () => {
    const p = loadPure();
    for (const sev of ['P1', 'P2', 'P3']) {
      const s = p.OPS_ATTENTION_SEVERITY[sev];
      expect(s.icon.length).toBeGreaterThan(0);
      expect(s.label.startsWith(sev)).toBe(true);
      expect(s.cls).toBe(`ops-sev-${sev.toLowerCase()}`);
      expect(CSS).toMatch(new RegExp(`\\.ops-sev-${sev.toLowerCase()}\\s*\\{`));
    }
    const item = fnBody('function renderOpsAttentionItemHtml(item) {');
    expect(item).toContain('sev.icon');
    expect(item).toContain('escapeHtml(sev.label)');
    expect(item).toContain("'<li class=\"ops-item ' + sev.cls + '\">'");
  });

  it('the queue body is aria-live="polite" and has a "Needs attention now" heading', () => {
    const body = fnBody('function renderOpsAttentionQueue(view) {');
    expect(body).toContain('<div class="ops-queue-body" aria-live="polite">');
    expect(body).toContain('Needs attention now');
  });

  it('domain filters are data-action buttons with aria-pressed', () => {
    const body = fnBody('function renderOpsAttentionQueue(view) {');
    expect(body).toContain('data-action="ops-attention-filter" data-domain="');
    expect(body).toContain('aria-pressed=');
    expect(SRC).toContain("{ key: 'decisions', label: 'Decisions' }");
  });

  it('an empty queue with unknown sources is explicitly not an all-clear', () => {
    const body = fnBody('function renderOpsAttentionQueue(view) {');
    expect(body).toContain('this is not an all-clear');
    expect(body).toContain('cockpit blind, check GChat');
  });

  it('each item is a real link carrying its deeplink and navigates via navigateToScreen(section, tab, query)', () => {
    const item = fnBody('function renderOpsAttentionItemHtml(item) {');
    expect(item).toContain('data-action="ops-attention-open"');
    expect(item).toContain('opsAttentionQueryString(dl.query)');
    const open = fnBody('function openOpsAttentionDeeplink(section, tab, query) {');
    expect(open).toContain('navigateToScreen(section, tab, query)');
    expect(open).toContain('showToast(');
  });
});

describe('VTID-04876: no inline handlers', () => {
  it("no 'onclick=' anywhere in the Overview region", () => {
    expect(overviewRegion()).not.toMatch(/onclick\s*=\s*["\\]/i);
    expect(overviewRegion()).not.toContain('onclick=');
  });

  it('the cockpit assigns no on* handler properties; one delegated listener reads data-action', () => {
    const region = cockpitRegion();
    expect(region).not.toMatch(/\.on(click|mouseenter|mouseleave|change|keydown)\s*=/);
    expect(region).toContain("wrap.addEventListener('click', handleOpsAttentionClick);");
    const handler = fnBody('function handleOpsAttentionClick(ev) {');
    expect(handler).toContain("ev.target.closest('[data-action]')");
    for (const a of ['ops-attention-refresh', 'ops-attention-filter', 'ops-attention-open']) expect(handler).toContain(`'${a}'`);
  });

  it('the cockpit block is CSP-clean (no inline style or eval)', () => {
    const region = cockpitRegion();
    expect(region).not.toMatch(/\.style\b/);
    expect(region).not.toMatch(/style\s*=/i);
    expect(region).not.toMatch(/\beval\s*\(/);
  });

  it('says why its strings are English (admin-facing by design)', () => {
    expect(cockpitRegion()).toContain('The Command Hub is admin-facing and English by design');
  });
});

describe('VTID-04876: polling and the /ops/attention migration', () => {
  it('renderOverviewSystemView renders the cockpit and polls every 30 s on the real router keys only', () => {
    const body = fnBody('function renderOverviewSystemView() {');
    expect(body).toContain('container.appendChild(renderOpsAttentionCockpit());');
    const idx = SRC.indexOf('state._opsAttentionTimer = setInterval(function () {');
    const timer = SRC.slice(idx, SRC.indexOf('}, OPS_ATTENTION_POLL_MS);', idx));
    expect(timer).toContain("state.currentModuleKey === 'overview' && state.currentTab === 'system-overview' && !state.isOperatorOpen");
    expect(timer).toContain('fetchOpsAttention(true);');
  });

  it('the old panels are kept, collapsed, and rendered only when opened', () => {
    const body = fnBody('function renderOverviewSystemView() {');
    expect(body).toContain("details.className = 'ops-attention-legacy';");
    expect(body).toMatch(/if \(state\.opsAttention\.legacyOpen\) \{\s*details\.open = true;\s*details\.appendChild\(renderOverviewSystemPanels\(\)\);/);
  });

  it('fetches GET /api/v1/ops/attention with the signed-in headers; nothing reads /ops/action-required any more', () => {
    const body = fnBody('async function fetchOpsAttention(silentRefresh) {');
    expect(body).toContain("fetchWT('/api/v1/ops/attention'");
    expect(body).toContain('buildContextHeaders(');
    expect(SRC).not.toContain('/api/v1/ops/action-required');
  });

  it('keeps showing the last good answer on error but marks the cockpit blind', () => {
    const body = fnBody('async function fetchOpsAttention(silentRefresh) {');
    expect(body).toMatch(/view\.error = 'HTTP ' \+ r\.status/);
    expect(body).toContain('view.lastOkAt = Date.now();');
    expect(body).not.toMatch(/view\.data = null/);
  });
});

describe('VTID-04876: deep-link contract (?vtid= / ?session=)', () => {
  it('the frontend contract equals the backend DEEPLINK_QUERY_CONTRACT', () => {
    expect(frontendContract()).toEqual(DEEPLINK_QUERY_CONTRACT);
    expect(frontendContract()).toEqual({
      'command-hub/tasks': ['vtid'],
      'oasis/vtid-ledger': ['vtid'],
      'voice/sessions': ['session'],
    });
  });

  it('params are read on navigation: navigateToScreen, back/forward and page load', () => {
    expect(fnBody('function navigateToScreen(sectionKey, tabKey, query) {')).toContain('applyDeepLinkParams();');
    const pop = SRC.slice(SRC.indexOf('window.onpopstate = () => {'), SRC.indexOf('};', SRC.indexOf('window.onpopstate = () => {')));
    expect(pop).toContain('applyDeepLinkParams();');
    expect(SRC).toContain('// VTID-04876: a page loaded on a deep link (?vtid= / ?session=) opens its drawer.\n        applyDeepLinkParams();');
  });

  it('applyDeepLinkParams keys on the real router state', () => {
    expect(fnBody('function applyDeepLinkParams() {')).toContain("var screen = state.currentModuleKey + '/' + state.currentTab;");
  });

  /** Run the deep-link functions in a sandbox with stubbed browser globals. */
  async function runDeepLink(search: string, screen: string, responses: Record<string, { ok: boolean; body: unknown }>) {
    const code = [
      SRC.slice(SRC.indexOf('var OVERVIEW_DEEPLINK_QUERY_CONTRACT = {'), SRC.indexOf('};', SRC.indexOf('var OVERVIEW_DEEPLINK_QUERY_CONTRACT = {')) + 2),
      fnBody('function applyDeepLinkParams() {'),
      fnBody('function deepLinkFallback(what, value) {'),
      fnBody('async function openTaskDrawerFromDeepLink(vtid) {'),
      fnBody('async function openLedgerDrawerFromDeepLink(vtid) {'),
      fnBody('async function openVoiceSessionFromDeepLink(sessionId) {'),
    ].join('\n');
    const [section, tab] = screen.split('/');
    const env: any = {
      state: { currentModuleKey: section, currentTab: tab },
      window: { location: { search, pathname: `/command-hub/${screen}/` }, openVoiceLabSessionDrawer: jest.fn() },
      history: { replaceState: jest.fn() },
      showToast: jest.fn(),
      renderApp: jest.fn(),
      buildContextHeaders: () => ({}),
      oasisVtidDetail: { selectedVtid: null, data: null, error: null },
      fetch: jest.fn(async (url: string) => {
        const key = Object.keys(responses).find((k) => url.includes(k));
        const r = key ? responses[key] : { ok: false, body: null };
        return { ok: r.ok, status: r.ok ? 200 : 404, json: async () => r.body };
      }),
    };
    env.fetchOasisVtidDetail = jest.fn(async (vtid: string) => {
      const r = Object.keys(responses).find((k) => vtid && k.includes(vtid));
      env.oasisVtidDetail.selectedVtid = vtid;
      if (r && responses[r].ok) env.oasisVtidDetail.data = responses[r].body;
      else env.oasisVtidDetail.error = 'VTID detail fetch failed: 404';
    });
    // eslint-disable-next-line no-new-func
    const run = new Function(...Object.keys(env), `${code}\napplyDeepLinkParams();`);
    run(...Object.values(env));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return env;
  }

  it('?vtid= on command-hub/tasks opens the task drawer', async () => {
    const env = await runDeepLink('?vtid=VTID-04876', 'command-hub/tasks', {
      '/api/v1/vtid/VTID-04876': { ok: true, body: { ok: true, data: { vtid: 'VTID-04876', title: 'Cockpit', status: 'in_progress' } } },
    });
    expect(env.state.selectedTask).toMatchObject({ vtid: 'VTID-04876', title: 'Cockpit' });
    expect(env.renderApp).toHaveBeenCalled();
    expect(env.showToast).not.toHaveBeenCalled();
  });

  it('an unresolvable ?vtid= on the task list shows a toast and falls back to the list', async () => {
    const env = await runDeepLink('?vtid=VTID-99999', 'command-hub/tasks', {});
    expect(env.state.selectedTask).toBeUndefined();
    expect(env.showToast).toHaveBeenCalledWith(expect.stringContaining('VTID-99999'), 'warning');
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', '/command-hub/command-hub/tasks/');
  });

  it('?vtid= on oasis/vtid-ledger opens the ledger drawer; unresolvable → toast + list', async () => {
    const ok = await runDeepLink('?vtid=VTID-01001', 'oasis/vtid-ledger', { 'VTID-01001': { ok: true, body: { vtid: 'VTID-01001' } } });
    expect(ok.fetchOasisVtidDetail).toHaveBeenCalledWith('VTID-01001');
    expect(ok.showToast).not.toHaveBeenCalled();
    const bad = await runDeepLink('?vtid=VTID-00000', 'oasis/vtid-ledger', {});
    expect(bad.oasisVtidDetail.selectedVtid).toBeNull();
    expect(bad.showToast).toHaveBeenCalled();
    expect(bad.history.replaceState).toHaveBeenCalled();
  });

  it('?session= on voice/sessions opens the voice session drawer; unresolvable → toast + list', async () => {
    const ok = await runDeepLink('?session=s-1', 'voice/sessions', { '/api/v1/voice-lab/live/sessions/s-1': { ok: true, body: { ok: true, session: { id: 's-1' } } } });
    expect(ok.window.openVoiceLabSessionDrawer).toHaveBeenCalledWith('s-1');
    const bad = await runDeepLink('?session=nope', 'voice/sessions', {});
    expect(bad.window.openVoiceLabSessionDrawer).not.toHaveBeenCalled();
    expect(bad.showToast).toHaveBeenCalledWith(expect.stringContaining('nope'), 'warning');
  });

  it('a param on a screen outside the contract is ignored', async () => {
    const env = await runDeepLink('?vtid=VTID-1', 'autonomy/self-healing', {});
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.showToast).not.toHaveBeenCalled();
  });
});

describe('VTID-04876: every adapter deeplink resolves against NAVIGATION_CONFIG', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const H = 3_600_000;

  /** Fake reads that make every adapter emit every kind of item it can. */
  const everything = fakeReads({
    healthSummary: async () => ({
      checked_at: ago(0),
      items: [
        { name: 'Gateway', url: '/health', group: 'Core', golden_path: true, status: 'down', healthy: false, http_status: 503, latency_ms: 1 },
        { name: 'Redis', url: '/r', group: 'Data', status: 'degraded', healthy: false, http_status: 200, latency_ms: 1 },
      ],
    }),
    latestEvent: async (topics) => {
      const t = topics[0];
      if (t === 'prod.deploy.completed') return { topic: 'prod.deploy.rolled_back', created_at: ago(H / 2) };
      if (t === 'staging.verify.passed') return { topic: 'staging.verify.failed', created_at: ago(H) };
      if (t === 'deploy.gateway.failed') return { topic: 'deploy.gateway.failed', created_at: ago(H) };
      if (t === 'dev_autopilot.kill_switch.activated') return { topic: t, created_at: ago(H) };
      return null;
    },
    buildInfo: async (w) => ({ status: 'ok', commit: w === 'prod' ? 'aaa' : 'bbb' }),
    voiceOverview: async () => ({
      verdict_summary: 'system_wide', window: '1h', generated_at: ago(0),
      verdicts: [{ scope: 'system', key: 'silent', label: 'All', metric: 'silent', severity: 'critical', message: 'm', sessions: 50 }],
    }),
    voiceQuarantines: async () => [{ class: 'stall', quarantined_at: ago(H), reason: null }],
    voiceArchitectureReports: async () => [{ id: 'r1', class: 'stall', generated_at: ago(H), track: 'replace' }],
    supervisorAlerts: async () => ['registry', 'scanners', 'auto-approve', 'runs', 'live', 'engine', 'impact-rules', 'nonexistent-tab'].map((tab, i) => ({
      severity: i % 2 ? 'warning' : 'critical', text: `alert ${tab}`, tab,
    })) as any,
    selfHealOutcomes: async () => [{ vtid: 'VTID-01000', endpoint: '/api/v1/a/health', failure_class: 'x', outcome: 'rolled_back', created_at: ago(H) }],
    inProgressLedger: async () => [{ vtid: 'VTID-02000', title: 't', metadata: { autonomous_execution: true }, claimed_by: 'w', claim_started_at: ago(3 * H), claim_expires_at: null, updated_at: ago(0) }],
    systemControls: async () => [
      { key: 'autopilot_execution_enabled', enabled: false, updated_by: 'x', updated_at: ago(H) },
      { key: 'vtid_allocator_enabled', enabled: false, updated_by: 'x', updated_at: ago(H) },
    ],
    devAutopilotKillSwitch: async () => ({ engaged: true }),
    openViolations: async () => [{ id: 'v1', severity: 5, status: 'OPEN', created_at: ago(H) }, { id: 'v2', severity: 1, status: 'OPEN', created_at: ago(H) }],
    devAutopilotAwaitingApproval: async () => [{ id: 'e1', waiting_since: ago(5 * H) }, { id: 'e2', waiting_since: ago(5 * H) }],
    selfHealPendingApproval: async () => [{ id: 's1', vtid: 'VTID-03000', waiting_since: ago(2 * H) }],
    prApprovalsPending: async () => [{ id: 'VTID-04000', vtid: 'VTID-04000', waiting_since: ago(2 * H) }],
  });

  async function allDeeplinks(): Promise<Array<{ source: string; dl: Deeplink }>> {
    const out: Array<{ source: string; dl: Deeplink }> = [];
    for (const a of ATTENTION_ADAPTERS) {
      const r = await a.run(everything, { now: NOW });
      expect(r.candidates.length).toBeGreaterThan(0);
      for (const c of r.candidates) out.push({ source: a.id, dl: c.deeplink });
    }
    return out;
  }

  it('every section/tab exists, every query key is one its screen reads, every screen is dispatched', async () => {
    const nav = navigationConfig();
    const links = await allDeeplinks();
    expect(new Set(links.map((l) => l.source)).size).toBe(7);
    const problems: string[] = [];
    for (const { source, dl } of links) {
      const section = nav.find((s) => s.section === dl.section);
      const tab = section && section.tabs.find((t) => t.key === dl.tab);
      if (!section || !tab) {
        problems.push(`${source}: ${dl.section}/${dl.tab} not in NAVIGATION_CONFIG`);
        continue;
      }
      const screen = `${dl.section}/${dl.tab}`;
      const allowed = DEEPLINK_QUERY_CONTRACT[screen] || [];
      for (const k of Object.keys(dl.query)) {
        if (!allowed.includes(k)) problems.push(`${source}: ${screen} does not read ?${k}=`);
      }
      const dispatched =
        SRC.includes(`moduleKey === '${dl.section}' && tab === '${dl.tab}'`) ||
        (dl.section === 'overview' && dl.tab === 'system-overview' && SRC.includes('renderOverviewSystemView()'));
      if (!dispatched) problems.push(`${source}: ${screen} is not rendered by the dispatcher`);
    }
    expect(problems).toEqual([]);
  });

  it('the drawers are reachable: ?vtid= deeplinks are emitted for tasks and the ledger', async () => {
    const links = await allDeeplinks();
    expect(links.some((l) => l.dl.section === 'command-hub' && l.dl.tab === 'tasks' && l.dl.query.vtid)).toBe(true);
    expect(links.some((l) => l.dl.section === 'oasis' && l.dl.tab === 'vtid-ledger' && l.dl.query.vtid)).toBe(true);
  });
});

describe('VTID-04876: styles and asset version', () => {
  it('the cockpit styles exist (UNKNOWN is grey) and use logical properties', () => {
    for (const cls of ['.ops-status-bar', '.ops-verdict-unknown', '.ops-verdict-critical', '.ops-queue-list', '.ops-filter', '.ops-attention-legacy']) {
      expect(CSS).toContain(cls);
    }
    const block = CSS.slice(CSS.indexOf('VTID-04876: Overview Phase 1'));
    expect(block).not.toMatch(/margin-left|margin-right|padding-left|padding-right|border-left|text-align:\s*left/);
  });

  it('index.html loads app.js and styles.css at the VTID-04876 version', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(html).toContain('/command-hub/app.js?v=20261027-vtid-04876');
    expect(html).toContain('/command-hub/styles.css?v=20261027-vtid-04876');
  });
});
