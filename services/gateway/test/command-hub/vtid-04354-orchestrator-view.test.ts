/**
 * VTID-04354 (Orchestrator v2, P7 v0): Autopilot › Orchestrator tab.
 *
 * A read-only view over GET /api/v1/orchestrator/{runs/summary,runs,agents,
 * policy}. app.js is a plain browser script, so the view block is evaluated in
 * isolation against a tiny fake DOM (no jsdom in this package) and the wiring
 * is pinned by source text — the established pattern in this directory.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const STYLES = readFileSync(join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');
const ROUTES_SRC = readFileSync(join(__dirname, '../../src/routes/orchestrator.ts'), 'utf8');
const GUARD = readFileSync(join(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

const BLOCK_START = APP_JS.indexOf('// VTID-04354 (Orchestrator v2, P7 v0)');
const BLOCK_END = APP_JS.indexOf('function renderAutopilotMissionAlignmentView()');
const BLOCK = APP_JS.slice(APP_JS.lastIndexOf('\n// ====', BLOCK_START), BLOCK_END);

class FakeEl {
  tagName: string;
  className = '';
  textContent = '';
  children: FakeEl[] = [];
  type = '';
  title = '';
  disabled = false;
  onclick: null | (() => void) = null;
  constructor(tag: string) { this.tagName = tag; }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  insertBefore(c: FakeEl, ref: FakeEl | null) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  allText(): string { return [this.textContent, ...this.children.map((c) => c.allText())].join(' '); }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = pred(this) ? [this] : [];
    for (const c of this.children) out.push(...c.find(pred));
    return out;
  }
}

function loadView(sections: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const state: any = { autopilot: { orchestrator: { loading: false, sections, fetchedAt: null, days: 7, plane: '', status: '', ...extra } } };
  const calls: string[] = [];
  const fetchImpl = (url: string) => { calls.push(url); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, data: {} }) }); };
  const timers: Array<() => void> = [];
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'setTimeout',
    BLOCK + '\nreturn { render: renderAutopilotOrchestratorView, endpoints: ORCH_ENDPOINTS, fetchView: fetchOrchestratorView };',
  )(state, { createElement: (t: string) => new FakeEl(t) }, fetchImpl, () => ({}), () => undefined, (fn: () => void) => timers.push(fn));
  return { api, state, calls, timers };
}

const OK = (data: unknown) => ({ ok: true, data, error: null });
const FULL = {
  summary: OK({ days: 7, truncated: false, planes: [{ plane: 'dev_autopilot', total: 5, by_status: { succeeded: 3, failed: 2 } }] }),
  runs: OK({ runs: [{ run_key: 'dev_autopilot:1', plane: 'dev_autopilot', agent_id: 'autopilot-executor', status: 'failed', vtid: 'VTID-01234', title: 'Fix x', error: 'tsc failed', created_at: '2026-09-23T10:00:00Z' }] }),
  agents: OK({ agents: [{ agent_id: 'operator', display_name: 'Operator Console', status: 'active', enabled: true, llm_stage: 'operator', surfaces_allowed: ['command_hub'] }] }),
  policy: OK({
    defaults: { domains: ['community', 'commerce', 'dev'], roles: { community: { community: 'commit' }, developer: { dev: 'commit' } }, channels: { voice: 'draft' }, approval_channels: ['web'] },
    platform_role: 'developer', channel: 'web',
  }),
};

describe('VTID-04354 Orchestrator view — wiring', () => {
  it('adds the Autopilot › Orchestrator tab and routes it to the view', () => {
    expect(APP_JS).toContain('{ "key": "orchestrator", "path": "/command-hub/autopilot/orchestrator/" }');
    expect(APP_JS).toMatch(/moduleKey === 'autopilot' && tab === 'orchestrator'\) \{\s*\n\s*container\.appendChild\(renderAutopilotOrchestratorView\(\)\)/);
    expect(APP_JS).toMatch(/orchestrator: \{ loading: false, sections: null/);
  });

  it('only calls routes the orchestrator router actually serves', () => {
    const { api } = loadView(null);
    const o = { days: 7, plane: 'dev_autopilot', status: 'failed' };
    const urls = Object.keys(api.endpoints).map((k) => api.endpoints[k](o));
    expect(urls).toEqual([
      '/api/v1/orchestrator/runs/summary?days=7',
      '/api/v1/orchestrator/runs?limit=50&plane=dev_autopilot&status=failed',
      '/api/v1/orchestrator/agents',
      '/api/v1/orchestrator/policy',
    ]);
    for (const path of ["'/runs/summary'", "'/runs'", "'/agents'", "'/policy'"]) {
      expect(ROUTES_SRC).toContain(`router.get(${path}`);
    }
  });

  it('is read-only and CSP-safe: GET only, no innerHTML, no inline style', () => {
    expect(BLOCK).not.toMatch(/method\s*:/);
    expect(BLOCK).not.toContain('innerHTML');
    expect(BLOCK).not.toMatch(/\.style\b/);
    expect(BLOCK).not.toMatch(/style\s*=/);
  });

  it('ships styles, bumps ?v= and is allowlisted in the ownership guard', () => {
    for (const cls of ['.orch-container', '.orch-plane-grid', '.orch-table-wrap', '.orch-agent-card', '.orch-tier--commit']) {
      expect(STYLES).toContain(cls);
    }
    const appVer = (INDEX_HTML.match(/app\.js\?v=([^"']+)/) || [])[1] || '';
    const cssVer = (INDEX_HTML.match(/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(appVer >= '20261005-vtid-04354-orchestrator-view').toBe(true);
    expect(cssVer >= '20261005-vtid-04354-orchestrator-view').toBe(true);
    expect(GUARD).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04354/);
  });
});

describe('VTID-04354 Orchestrator view — render', () => {
  it('schedules one fetch on first render and shows loading placeholders', () => {
    const { api, timers } = loadView(null);
    const root: FakeEl = api.render();
    expect(timers).toHaveLength(1);
    expect(root.allText()).toContain('Loading');
  });

  it('fetches all four sections, each independently', async () => {
    const { api, calls, state } = loadView(null);
    api.fetchView();
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(4);
    expect(Object.keys(state.autopilot.orchestrator.sections).sort()).toEqual(['agents', 'policy', 'runs', 'summary']);
  });

  it('renders planes, runs, agents and the grant matrix from real-shaped payloads', () => {
    const { api } = loadView(FULL);
    const text: string = api.render().allText();
    expect(text).toContain('dev_autopilot');
    expect(text).toContain('succeeded 3');
    expect(text).toContain('VTID-01234');
    expect(text).toContain('tsc failed');
    expect(text).toContain('Operator Console');
    expect(text).toContain('command_hub');
    expect(text).toContain('shadow');
    expect(text).toContain('Your role: developer');
  });

  it('marks commerce as org-derived in the grant matrix, never a role tier', () => {
    const { api } = loadView(FULL);
    const cells = (api.render() as FakeEl).find((e) => e.tagName === 'td' && /orch-tier--/.test(e.className));
    const commerce = cells.filter((c) => c.className.includes('orch-tier--org'));
    expect(commerce.length).toBe(2);
  });

  it('shows one section error without hiding the others (e.g. 403 on runs)', () => {
    const { api } = loadView({ ...FULL, runs: { ok: false, data: null, error: 'Orchestrator view requires developer access (exafy_admin)' } });
    const root: FakeEl = api.render();
    const errors = root.find((e) => e.className === 'orch-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toContain('exafy_admin');
    expect(root.allText()).toContain('Operator Console');
  });

  it('clicking a plane card filters the run list to that plane', () => {
    const { api, state, calls } = loadView(FULL);
    const card = (api.render() as FakeEl).find((e) => e.className.startsWith('orch-plane-card'))[0];
    card.onclick!();
    expect(state.autopilot.orchestrator.plane).toBe('dev_autopilot');
    expect(calls.some((u) => u.includes('plane=dev_autopilot'))).toBe(true);
  });
});
