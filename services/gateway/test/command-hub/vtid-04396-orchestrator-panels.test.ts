/**
 * VTID-04396 — Autopilot › Orchestrator: budget, policy-shadow and delegation
 * panels over GET /api/v1/orchestrator/{budgets,policy/shadow,delegations}.
 *
 * AC-1 budgets: today's spend against the platform line with a native
 *      <progress> bar (no inline style), the lines table, over-limit lines
 *      marked and named as "would deny".
 * AC-2 policy shadow: allow/escalate/deny totals, only non-allow rows listed,
 *      and an explicit empty state.
 * AC-3 delegations: one card per target with surfaces and job counts.
 * AC-4 a failing endpoint shows its own error and leaves the other panels.
 * AC-5 every class the panels use has a literal CSS rule (dead-CSS scan
 *      safe), and the block stays read-only and CSP-safe.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const STYLES = readFileSync(join(FE, 'styles.css'), 'utf8');

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
  max?: number;
  value?: number;
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

function render(sections: Record<string, unknown>) {
  const state: any = { autopilot: { orchestrator: { loading: false, sections, fetchedAt: null, days: 7, plane: '', status: '' } } };
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'state', 'document', 'fetch', 'buildContextHeaders', 'renderApp', 'setTimeout',
    BLOCK + '\nreturn { render: renderAutopilotOrchestratorView };',
  )(state, { createElement: (t: string) => new FakeEl(t) }, () => Promise.resolve(), () => ({}), () => undefined, () => undefined);
  return api.render() as FakeEl;
}

const OK = (data: unknown) => ({ ok: true, data, error: null });
const sectionTitled = (root: FakeEl, title: string) =>
  root.find((e) => e.tagName === 'section' && e.children[0]?.textContent.startsWith(title))[0];

const BUDGETS = OK({
  enforced: false, since: '2026-09-23T00:00:00.000Z', truncated: false,
  envelope: { monthly_usd: 6000, monthly_cap_usd: 10000 },
  limits: { platform_per_day_usd: 200 },
  spend: { platform_usd: 88.4, calls: 1200, repriced_calls: 400, unpriced_calls: 3 },
  would_deny: [{ scope: 'agent', key: 'dev-autopilot-planning', spent_usd: 58.39, limit_usd: 25, used_pct: 233.6, over: true }],
  lines: [
    { scope: 'agent', key: 'dev-autopilot-planning', spent_usd: 58.39, limit_usd: 25, used_pct: 233.6, over: true },
    { scope: 'agent', key: 'db-i18n-translator', spent_usd: 30, limit_usd: 40, used_pct: 75, over: false },
  ],
});

const SHADOW = OK({
  shadow: {
    enforced: false, since: '2026-09-23T10:00:00.000Z', total_calls: 12, by_decision: { allow: 9, escalate: 2, deny: 1 },
    aggregates: [
      { role: 'community', tool: 'dev_recent_events', domain: 'dev', tier: 'read', decision: 'deny', reason: 'role ceiling for dev is none', count: 1 },
      { role: 'community', tool: 'send_chat_message', domain: 'community', tier: 'commit', decision: 'escalate', reason: 'voice is capped at draft', count: 2 },
      { role: 'community', tool: 'log_water', domain: 'health', tier: 'commit', decision: 'allow', reason: 'self', count: 9 },
    ],
  },
  catalog: { tools: 548, unclassified: [], by_domain_tier: {} },
});

const DELEGATIONS = OK({
  targets: [{ agent_id: 'operator', description: 'The Vitana Operator', surfaces: ['command-hub'], domain: 'dev', tier: 'draft' }],
  jobs: { total: 3, by_agent: { operator: { running: 1, succeeded: 2, failed: 0, cancelled: 0 } } },
});

describe('VTID-04396 budgets panel (AC-1)', () => {
  it('shows spend vs the platform line with a native progress bar and the over line', () => {
    const root = render({ budgets: BUDGETS });
    const box = sectionTitled(root, 'LLM spend today');
    expect(box).toBeDefined();
    const text = box.allText();
    expect(text).toContain('$88.40 of $200 today');
    expect(text).toContain('would deny: dev-autopilot-planning');
    const bar = box.find((e) => e.tagName === 'progress')[0];
    expect(bar.max).toBe(100);
    expect(Math.round(bar.value!)).toBe(44);
    expect(box.find((e) => e.tagName === 'tr' && e.className === 'is-over')).toHaveLength(1);
  });
});

describe('VTID-04396 policy shadow panel (AC-2)', () => {
  it('totals by decision and lists only non-allow rows', () => {
    const box = sectionTitled(render({ shadow: SHADOW }), 'Policy shadow');
    const text = box.allText();
    expect(text).toContain('allow 9');
    expect(text).toContain('escalate 2');
    expect(text).toContain('deny 1');
    expect(text).toContain('548 tools, 0 unclassified');
    expect(text).toContain('dev_recent_events');
    expect(text).toContain('send_chat_message');
    expect(text).not.toContain('log_water');
  });

  it('explicit empty state when nothing would change', () => {
    const empty = OK({ shadow: { total_calls: 0, by_decision: {}, aggregates: [] }, catalog: null });
    expect(sectionTitled(render({ shadow: empty }), 'Policy shadow').allText()).toContain('No call so far would have been escalated or denied');
  });
});

describe('VTID-04396 delegations panel (AC-3)', () => {
  it('one card per target with surfaces and job counts', () => {
    const text = sectionTitled(render({ delegations: DELEGATIONS }), 'Delegation targets').allText();
    expect(text).toContain('operator');
    expect(text).toContain('Surfaces: command-hub');
    expect(text).toContain('running 1');
    expect(text).toContain('succeeded 2');
  });
});

describe('VTID-04396 isolation and safety (AC-4, AC-5)', () => {
  it('a failing endpoint shows its own error and the others still render', () => {
    const root = render({ budgets: { ok: false, data: null, error: 'Orchestrator view requires developer access (exafy_admin)' }, delegations: DELEGATIONS });
    expect(sectionTitled(root, 'LLM spend today').allText()).toContain('requires developer access');
    expect(sectionTitled(root, 'Delegation targets').allText()).toContain('operator');
  });

  it('every new class has a literal CSS rule; the block stays CSP-safe and read-only', () => {
    for (const cls of ['orch-pill--allow', 'orch-pill--escalate', 'orch-pill--deny', 'orch-budget-head', 'orch-budget-total', 'orch-budget-bar', 'is-over']) {
      expect(STYLES).toContain(cls);
      expect(APP_JS).toContain(`'${cls}`.replace(/^'is-over$/, "'is-over"));
    }
    expect(BLOCK).not.toContain('innerHTML');
    expect(BLOCK).not.toMatch(/\.style\b/);
    expect(BLOCK).not.toMatch(/method\s*:/);
  });
});
