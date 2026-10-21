/**
 * VTID-05098: Loop Engineering Phase 2 (Simplify) in the Command Hub.
 *  - Infrastructure → Health (same 5 probes as Diagnostics → Health Checks)
 *    is removed and redirected; Diagnostics → Health Checks is unchanged.
 *  - Autonomy Pulse shows self-healing and test-contract items with an Open
 *    link only; acting happens in their own tabs.
 *  - The Loops screen shows what the Simplify loop did with each overlap.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FakeEl, fakeDocument } from './fixtures/fake-dom';
import { buildCatalogResponse, resetCatalogCache } from '../../src/services/loop-catalog';

const HUB = path.resolve(__dirname, '../../src/frontend/command-hub');
const APP = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(HUB, 'index.html'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LC = require('../../src/frontend/command-hub/loops-catalog.js').LoopsCatalog;

function fnBody(name: string): string {
  const start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next < 0 ? undefined : next);
}

describe('VTID-05098 one Health tab', () => {
  it('Infrastructure no longer has a health tab; Diagnostics keeps health-checks', () => {
    expect(APP).not.toContain('"path": "/command-hub/infrastructure/health/"');
    expect(APP).toContain('{ "key": "health-checks", "path": "/command-hub/diagnostics/health-checks/" }');
    expect(APP).not.toContain("tab === 'health')");
    expect(APP).not.toContain('function renderInfraHealthView(');
  });

  it('old Infrastructure → Health links redirect to Diagnostics → Health Checks', () => {
    expect(APP).toContain("'/command-hub/infrastructure/health/':        { section: 'diagnostics', tab: 'health-checks' }");
  });

  it('Diagnostics → Health Checks still probes its same 5 endpoints (unchanged)', () => {
    const body = fnBody('fetchDiagHealthChecks');
    for (const ep of ['/health', '/api/v1/cicd/health', '/api/v1/operator/health', '/api/v1/autopilot/health', '/api/v1/assistant/health']) {
      expect(body).toContain(`'${ep}'`);
    }
  });

  it('Infrastructure → Services keeps its own data (fetchInfraServices stays)', () => {
    expect(APP).toContain('function fetchInfraServices(');
    expect(APP).toContain('function renderInfraServicesView(');
  });
});

describe('VTID-05098 Autonomy Pulse: one place to act', () => {
  it('investigate is labelled Open and only navigates', () => {
    expect(fnBody('autonomyPulseActionSpec')).toContain("case 'investigate':    return { label: 'Open', color: '#3b82f6' };");
    expect(fnBody('autonomyPulseDoAction')).toMatch(/action === 'investigate'\) \{\s*window\.location\.href = item\.source_url;/);
  });

  it('no Pulse code path still posts to the self-healing approve/reject routes or knows the removed verbs', () => {
    const pulse = fnBody('autonomyPulseDoAction') + fnBody('autonomyPulseActionSpec');
    for (const gone of ['apply_heal', 'discard_heal', 'rerun_contract', 'open_contract', '/api/v1/self-healing/approve', '/api/v1/self-healing/reject']) {
      expect(pulse).not.toContain(gone);
    }
  });

  it('the self-healing tab still acts with {id, operator}', () => {
    expect(APP).toMatch(/\/api\/v1\/self-healing\/approve[\s\S]{0,300}id: /);
  });
});

describe('VTID-05098 Loops screen shows overlap outcomes', () => {
  let body: any;
  beforeAll(async () => {
    resetCatalogCache();
    body = { ok: true, data: JSON.parse(JSON.stringify(await buildCatalogResponse(null))) };
  });

  it('each overlap carries its status badge and resolution', async () => {
    LC.reset();
    const fetch = () => Promise.resolve({ json: () => Promise.resolve(body) });
    const el: FakeEl = LC.render({ doc: fakeDocument, fetch, headers: () => ({}) });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const items = el.one('loops-overlaps').byTag('li');
    expect(items).toHaveLength(10);
    const badge = (id: string) => items.find((li) => li.getAttribute('data-overlap') === id)!.one('loops-badge');
    expect(badge('O1').textContent).toBe('Resolved');
    expect(badge('O1').className).toContain('loops-badge--overlap-resolved');
    expect(badge('O2').textContent).toBe('Resolved'); // VTID-05141 closed it
    expect(badge('O9').textContent).toBe('Not a duplicate');
    expect(items[0].one('loops-overlap-resolution').textContent).toContain('VTID-05098');
  });

  it('index.html serves the Phase 2 versions of app.js, styles.css and the Loops module', () => {
    // app.js/styles.css were re-bumped by VTID-05122 (spec-approve fix), then VTID-05146 and VTID-05148.
    for (const f of ['app.js', 'styles.css']) {
      expect(INDEX).toContain(`/command-hub/${f}?v=20261121-vtid-05082`);
    }
    // loops-catalog.js was re-bumped by VTID-05148 (L3 metrics on the card).
    expect(INDEX).toContain('/command-hub/loops-catalog.js?v=20261121-vtid-05153');
    expect(INDEX).toContain('/command-hub/loops-catalog.css?v=20261117-vtid-05098');
  });
});
