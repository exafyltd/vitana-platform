/**
 * Command Hub Overview Phase 2 — domain tiles, the routable Feedback module
 * and the ?ticket= deep link (VTID-04885).
 *
 * Source-level and sandboxed checks in the style of the VTID-04876 cockpit
 * test (app.js is vanilla JS with no build step). Pure helpers are evaluated
 * in isolation; the rendered cockpit is checked offline in headless Chromium
 * (docs/validation/VTID-04885/outputs).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ATTENTION_ADAPTERS, DEEPLINK_QUERY_CONTRACT, TILE_DOMAINS } from '../../src/services/ops-attention-adapters';
import { fakeReads, phase2Everything } from '../fixtures/ops-attention-fakes';

const SRC = readFileSync(join(__dirname, '../../src/frontend/command-hub/app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '../../src/frontend/command-hub/styles.css'), 'utf8');
const HTML = readFileSync(join(__dirname, '../../src/frontend/command-hub/index.html'), 'utf8');

function fnBody(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\n}', start) + 2);
}

function navigationConfig(): Array<{ section: string; basePath: string; sidebar?: boolean; tabs: Array<{ key: string; path: string }> }> {
  const start = SRC.indexOf('const NAVIGATION_CONFIG = [');
  const end = SRC.indexOf('\n];', start);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${SRC.slice(start + 'const NAVIGATION_CONFIG = '.length, end + 2)};`)();
}

function loadTileView(): (domain: unknown, blind: boolean) => { cls: string; icon: string; label: string; note: string } {
  const sev = SRC.slice(SRC.indexOf('var OPS_ATTENTION_SEVERITY = {'), SRC.indexOf('var OPS_ATTENTION_DOMAINS = ['));
  // eslint-disable-next-line no-new-func
  return new Function(`${sev}\n${fnBody('function opsAttentionTileView(domain, blind) {')}\nreturn opsAttentionTileView;`)();
}

function filterKeys(): string[] {
  const start = SRC.indexOf('var OPS_ATTENTION_DOMAINS = [');
  const end = SRC.indexOf('];', start);
  // eslint-disable-next-line no-new-func
  const list = new Function(`return ${SRC.slice(start + 'var OPS_ATTENTION_DOMAINS = '.length, end + 1)};`)() as Array<{ key: string }>;
  return list.map((d) => d.key);
}

const dispatched = (section: string, tab: string) =>
  SRC.includes(`moduleKey === '${section}' && tab === '${tab}'`) ||
  (section === 'overview' && tab === 'system-overview' && SRC.includes('renderOverviewSystemView()'));

describe('VTID-04885: domain tiles', () => {
  const view = loadTileView();
  const d = (o: object) => ({ monitored: true, status: 'ok', worst_severity: null, open: 0, ...o });

  it('a blind cockpit shows every tile UNKNOWN; an unmonitored domain says "Not yet monitored", never OK', () => {
    expect(view(d({ worst_severity: 'P1' }), true)).toMatchObject({ label: 'UNKNOWN', cls: 'ops-tile-unknown' });
    expect(view({ monitored: false, status: 'not_monitored' }, false)).toMatchObject({ label: 'Not yet monitored', cls: 'ops-tile-unmonitored' });
    expect(view(null, false).label).toBe('UNKNOWN');
  });

  it('worst severity wins (icon + text label + colour class); unknown with nothing open is UNKNOWN; clean is OK', () => {
    expect(view(d({ worst_severity: 'P2', open: 3 }), false)).toMatchObject({ label: 'P2 High', icon: '⚠', cls: 'ops-sev-p2' });
    const sevUnknown = view(d({ worst_severity: 'P3', status: 'unknown' }), false);
    expect(sevUnknown).toMatchObject({ label: 'P3 Watch', note: 'Some sources unknown — not an all-clear' });
    expect(view(d({ status: 'unknown' }), false)).toMatchObject({ label: 'UNKNOWN', cls: 'ops-tile-unknown' });
    expect(view(d({}), false)).toMatchObject({ label: 'OK', cls: 'ops-tile-ok' });
  });

  it('the tiles render inside the cockpit from data.domains, with data-action links (no onclick)', () => {
    const cockpit = fnBody('function renderOpsAttentionCockpit() {');
    expect(cockpit).toContain('renderOpsAttentionTiles(view, Date.now())');
    const tiles = fnBody('function renderOpsAttentionTiles(view, nowMs) {');
    expect(tiles).toContain('data.domains');
    expect(tiles).toContain('data-action="ops-attention-open"');
    expect(tiles).toContain('Sources fresh');
    expect(tiles).toContain(' open</span>');
    expect(tiles).not.toMatch(/onclick|\.style\b|style=/);
    // An unmonitored tile is not a link.
    expect(tiles).toContain("if (!d.monitored) return '<li class=\"ops-tile ' + tv.cls + '\"><div class=\"ops-tile-body\">'");
  });

  it('every tile deep link is a NAVIGATION_CONFIG screen the dispatcher renders', () => {
    const nav = navigationConfig();
    const problems: string[] = [];
    for (const t of TILE_DOMAINS) {
      const s = nav.find((x) => x.section === t.deeplink.section);
      if (!s || !s.tabs.some((x) => x.key === t.deeplink.tab)) problems.push(`${t.key}: ${t.deeplink.section}/${t.deeplink.tab} missing`);
      else if (!dispatched(t.deeplink.section, t.deeplink.tab)) problems.push(`${t.key}: not dispatched`);
    }
    expect(problems).toEqual([]);
  });

  it('the queue filters cover every domain a Phase 2 adapter emits', async () => {
    const keys = filterKeys();
    const reads = fakeReads({
      ...phase2Everything(Date.parse('2026-10-04T12:00:00.000Z')),
      inProgressLedger: async () => [{ vtid: 'VTID-9', title: 't', metadata: {}, claimed_by: null, claim_started_at: null, claim_expires_at: null, updated_at: '2026-09-01T00:00:00Z' }],
    });
    const domains = new Set<string>();
    for (const a of ATTENTION_ADAPTERS.slice(7)) {
      for (const c of (await a.run(reads, { now: Date.parse('2026-10-04T12:00:00.000Z') })).candidates) domains.add(c.domain);
    }
    expect([...domains].sort()).toEqual(['cost', 'jobs', 'llm', 'operator', 'quality', 'support']);
    for (const dom of domains) expect(keys).toContain(dom);
  });
});

describe('VTID-04885: the Feedback module is routable without a sidebar entry', () => {
  it('NAVIGATION_CONFIG has a feedback section with the four dispatched tabs, flagged sidebar:false', () => {
    const fb = navigationConfig().find((s) => s.section === 'feedback')!;
    expect(fb).toBeDefined();
    expect(fb.sidebar).toBe(false);
    expect(fb.basePath).toBe('/command-hub/feedback/');
    expect(fb.tabs.map((t) => t.key)).toEqual(['inbox', 'handoffs', 'kpis', 'audit']);
    for (const t of fb.tabs) expect(dispatched('feedback', t.key)).toBe(true);
    // Only the Feedback section is hidden from the sidebar.
    expect(navigationConfig().filter((s) => s.sidebar === false).map((s) => s.section)).toEqual(['feedback']);
  });

  it('renderSidebar skips sidebar:false sections, so the sidebar is unchanged', () => {
    const sidebar = fnBody('function renderSidebar() {');
    expect(sidebar).toContain('if (mod.sidebar === false) return;');
  });

  it('?ticket= on feedback/inbox opens the ticket drawer; an unknown id falls back with a toast', () => {
    expect(DEEPLINK_QUERY_CONTRACT['feedback/inbox']).toEqual(['ticket']);
    const apply = fnBody('function applyDeepLinkParams() {');
    expect(apply).toContain("if (ticket && screen === 'feedback/inbox') {");
    expect(apply).toContain('openTicketDrawerFromDeepLink(ticket);');
    const open = fnBody('async function openTicketDrawerFromDeepLink(ticketId) {');
    expect(open).toContain("fetchFeedbackJSON('/api/v1/admin/feedback/tickets/' + encodeURIComponent(ticketId))");
    expect(open).toContain("deepLinkFallback('Ticket', ticketId)");
    expect(open).toContain('openFeedbackTicketDrawer(ticketId);');
  });
});

describe('VTID-04885: styles and asset version', () => {
  it('the tile styles exist and use logical properties only', () => {
    const block = CSS.slice(CSS.indexOf('VTID-04885: Overview Phase 2'));
    for (const cls of ['.ops-tile-grid', '.ops-tile-unmonitored', '.ops-tile-unknown', '.ops-tile-ok', '.ops-tile-link']) expect(block).toContain(cls);
    expect(block).not.toMatch(/margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*left/);
    // Targets >= 24px.
    expect(block).toMatch(/\.ops-tile-body \{[^}]*min-height: 44px/);
  });

  it('index.html loads app.js and styles.css at (or after) the VTID-04885 version', () => {
    const app = (HTML.match(/app\.js\?v=([^"']+)/) || [])[1] || '';
    const css = (HTML.match(/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(app >= '20261028-vtid-04885').toBe(true);
    expect(css >= '20261028-vtid-04885').toBe(true);
  });
});
