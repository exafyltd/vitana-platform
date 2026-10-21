/**
 * VTID-05084: Command Hub → Autonomy → Loops (frontend/command-hub/loops-catalog.js).
 * Rendered on a minimal DOM from the real catalog response, plus the app.js
 * wiring (nav tab, render hook, redirect of the old placeholder), index.html
 * load order, modules.json, CSP hygiene and the stylesheet.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FakeEl, fakeDocument } from './fixtures/fake-dom';
import { buildCatalogResponse, resetCatalogCache } from '../../src/services/loop-catalog';

const HUB = path.resolve(__dirname, '../../src/frontend/command-hub');
const JS = fs.readFileSync(path.join(HUB, 'loops-catalog.js'), 'utf8');
const CSS = fs.readFileSync(path.join(HUB, 'loops-catalog.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(HUB, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');
const MODULES = JSON.parse(fs.readFileSync(path.join(HUB, 'modules.json'), 'utf8'));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LC = require('../../src/frontend/command-hub/loops-catalog.js').LoopsCatalog;

const flush = () => new Promise((r) => setImmediate(r));

async function mount(body: unknown): Promise<{ el: FakeEl; calls: Array<{ url: string; init: any }> }> {
  LC.reset();
  const calls: Array<{ url: string; init: any }> = [];
  const fetch = (url: string, init: any) => { calls.push({ url, init }); return Promise.resolve({ json: () => Promise.resolve(body) }); };
  const el: FakeEl = LC.render({ doc: fakeDocument, fetch, headers: (extra: Record<string, string>) => ({ ...extra, Authorization: 'Bearer t' }) });
  await flush();
  await flush();
  return { el, calls };
}

let response: any;
beforeAll(async () => {
  resetCatalogCache();
  response = { ok: true, data: JSON.parse(JSON.stringify(await buildCatalogResponse(null))) };
});

describe('VTID-05084 Loops screen — rendering', () => {
  it('fetches GET /api/v1/autonomy/loops once with the Command Hub auth headers', async () => {
    const { calls } = await mount(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/autonomy/loops');
    expect(calls[0].init.headers.Authorization).toBe('Bearer t');
  });

  it('shows the three layers, the KPIs and 14 loop cards in two groups', async () => {
    const { el } = await mount(response);
    expect(el.all('loops-layer').map((l) => l.byTag('strong')[0].textContent)).toEqual(['Sensors', 'Loops', 'Shared engine']);
    const kpi = (label: string) => el.all('loops-kpi').find((k) => k.one('loops-kpi-label').textContent === label)!.one('loops-kpi-value').textContent;
    expect(kpi('Loops')).toBe('14');
    expect(kpi('Live')).toBe('2');
    expect(kpi('Partial')).toBe('9');
    expect(kpi('Planned')).toBe('3');
    expect(kpi('Cases folded in')).toBe('100');
    expect(kpi('Orphan sensors')).toBe('0');
    const grids = el.all('loops-grid');
    expect(grids).toHaveLength(2);
    expect(grids[0].all('loops-card').map((c) => c.getAttribute('data-loop'))).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(grids[1].all('loops-card')).toHaveLength(8);
  });

  it('cards are keyboard-reachable buttons with an accessible name and the signal state', async () => {
    const { el } = await mount(response);
    const cards = el.all('loops-card');
    for (const c of cards) {
      expect(c.tagName).toBe('BUTTON');
      expect((c as any).type).toBe('button');
      expect(c.getAttribute('aria-label')).toMatch(/^L\d+ .+, (LIVE|PARTIAL|PLANNED), risk R[0-3]$/);
      expect(c.getAttribute('aria-expanded')).toBe('false');
    }
    const signal = (id: string) => cards.find((c) => c.getAttribute('data-loop') === id)!.one('loops-card-signal').textContent;
    expect(signal('L1')).toBe('Run signal unavailable');
    expect(signal('L4')).toBe('No run ledger yet');
  });

  it('clicking a card opens its detail: the contract, owned sensors with links, and the folded cases', async () => {
    const { el } = await mount(response);
    el.all('loops-card').find((c) => c.getAttribute('data-loop') === 'L1')!.click();
    const root = LC._internals.state.el as FakeEl;
    const detail = root.one('loops-detail');
    expect(detail.getAttribute('aria-label')).toBe('Loop L1 details');
    expect(detail.byTag('dt').map((d) => d.textContent)).toEqual(expect.arrayContaining(
      ['Trigger', 'Goal (finish line)', 'Act', 'Verify', 'Stop', 'Human gate', 'Budget', 'Metrics', 'Runs today in'],
    ));
    const links = detail.all('loops-sensor-link').map((a) => [a.textContent, (a as any).href]);
    expect(links).toEqual([
      ['Routines', '/command-hub/routines/catalog/'],
      ['Scheduled workflows', '/command-hub/testing-qa/catalog/'],
      ['Test contracts', '/command-hub/testing-qa/test-contracts/'],
    ]);
    expect(detail.one('loops-cases').byTag('li')).toHaveLength(15);
    const opened = root.all('loops-card').find((c) => c.getAttribute('data-loop') === 'L1')!;
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    opened.click();
    expect(() => (LC._internals.state.el as FakeEl).one('loops-detail')).toThrow();
  });

  it('shows the shared engine and the Simplification panel with coverage and the overlaps', async () => {
    const { el } = await mount(response);
    expect(el.all('loops-engine-item')).toHaveLength(6);
    const simplify = el.one('loops-simplify');
    expect(simplify.getAttribute('aria-label')).toBe('Simplification');
    const coverage = simplify.one('loops-coverage').textContent;
    expect(coverage).toContain('Service Health groups: 18/18 owned');
    expect(coverage).toContain('Test contracts: 11/11 owned');
    expect(simplify.one('loops-overlaps').byTag('li').length).toBeGreaterThanOrEqual(10);
  });

  it('an API error shows the error and a Retry button that refetches', async () => {
    const { el, calls } = await mount({ ok: false, error: 'FORBIDDEN' });
    expect(el.one('loops-error').textContent).toBe('Could not load loops: FORBIDDEN');
    const retry = el.byTag('button').find((b) => b.textContent === 'Retry')!;
    retry.click();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('signalText names the four states', () => {
    const t = LC._internals.signalText;
    expect(t({ run_plane: null }, {})).toBe('No run ledger yet');
    expect(t({ run_plane: 'x' }, { x: { state: 'unavailable' } })).toBe('Run signal unavailable');
    expect(t({ run_plane: 'x' }, { x: { state: 'ok', total: 0, by_status: {} } })).toBe('No runs in 7 days');
    expect(t({ run_plane: 'x' }, { x: { state: 'ok', total: 3, capped: false, by_status: { failed: 1, succeeded: 2 } } }))
      .toBe('3 runs in 7 days (1 failed, 2 succeeded)');
  });
});

describe('VTID-05084 Loops screen — wiring', () => {
  it('Autonomy nav has "loops" in place of the "autopilot-admin" placeholder', () => {
    expect(APP).toContain('{ "key": "loops", "path": "/command-hub/autonomy/loops/" }');
    expect(APP).not.toContain('"key": "autopilot-admin"');
    expect(APP).not.toContain('renderAutopilotAdminView');
  });

  it('the render switch hands the tab to window.LoopsCatalog and guards a missing module', () => {
    expect(APP).toMatch(/tab === 'loops'\) \{[\s\S]{0,200}if \(window\.LoopsCatalog\) \{\s*container\.appendChild\(window\.LoopsCatalog\.render\(\{ headers: buildContextHeaders \}\)\);/);
    expect(APP).toContain('The Loops module did not load. Reload the page.');
  });

  it('old placeholder links redirect to the Loops tab', () => {
    expect(APP).toContain("'/command-hub/autonomy/autopilot-admin/':     { section: 'autonomy', tab: 'loops' }");
  });

  it('index.html loads the module and stylesheet with ?v= before app.js; modules.json agrees', () => {
    const mod = INDEX.indexOf('/command-hub/loops-catalog.js?v=20261121-vtid-05153');
    const app = INDEX.indexOf('/command-hub/app.js?v=20261121-vtid-05082');
    expect(mod).toBeGreaterThan(0);
    expect(app).toBeGreaterThan(mod);
    expect(INDEX).toContain('<link rel="stylesheet" href="/command-hub/loops-catalog.css?v=20261117-vtid-05098" />');
    const files = MODULES.bundle.map((b: any) => b.file);
    expect(MODULES.bundle.find((b: any) => b.file === 'loops-catalog.js').kind).toBe('module');
    expect(files.indexOf('loops-catalog.js')).toBeLessThan(files.indexOf('app.js'));
  });

  it('CSP: no innerHTML, no inline handlers, no eval; text only through textContent', () => {
    expect(JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(['"]on/);
    expect(JS).not.toMatch(/\.on[a-z]+\s*=/);
  });

  it('the stylesheet uses logical properties (RTL-safe) and the Command Hub tokens', () => {
    expect(CSS).toContain('var(--color-border');
    expect(CSS).toContain('text-align: start');
    expect(CSS).not.toMatch(/(margin|padding)-(left|right)|text-align:\s*(left|right)/);
  });
});
