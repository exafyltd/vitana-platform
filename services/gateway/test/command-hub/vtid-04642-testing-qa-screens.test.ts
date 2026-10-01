/**
 * VTID-04642 — Testing & QA rebuild P3: Overview / Catalog / Runs.
 *
 * Pins the shape of the rebuilt module: the four tabs in both navigation
 * sources and the screen inventory, old URLs landing on the new tabs, each
 * screen reading the admin API it is built on, and the CSP rule (the new code
 * styles with tq-* classes, never inline styles).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const HUB = join(__dirname, '../../src/frontend/command-hub');
const APP = readFileSync(join(HUB, 'app.js'), 'utf8');
const NAV = readFileSync(join(HUB, 'navigation-config.js'), 'utf8');
const CSS = readFileSync(join(HUB, 'styles.css'), 'utf8');
const INVENTORY = JSON.parse(readFileSync(join(__dirname, '../../specs/dev-screen-inventory-v1.json'), 'utf8'));

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const TQ_CODE = between(APP, '// ─── Testing & QA: Overview / Catalog / Runs (VTID-04642)', 'function renderTestingE2eView() {');

describe('VTID-04642 Testing & QA screens', () => {
  it('declares overview, catalog, runs, run-tests (VTID-04643) and e2e in app.js, navigation-config.js and the screen inventory', () => {
    const section = between(APP, '"section": "testing-qa"', ']');
    expect([...section.matchAll(/"key": "([a-z0-9-]+)"/g)].map((m) => m[1])).toEqual(['overview', 'catalog', 'runs', 'run-tests', 'e2e']);
    const nav = between(NAV, 'module: "testing-qa"', ']');
    expect([...nav.matchAll(/key: "([a-z0-9-]+)"/g)].map((m) => m[1])).toEqual(['overview', 'catalog', 'runs', 'run-tests', 'e2e']);
    expect(INVENTORY.module_catalog['testing-qa']).toEqual(['overview', 'catalog', 'runs', 'run-tests', 'e2e']);
    const paths = INVENTORY.screen_inventory.screens.filter((s: any) => s.module === 'Testing & QA').map((s: any) => s.url_path);
    expect(paths).toEqual(['overview', 'catalog', 'runs', 'run-tests', 'e2e'].map((k) => `/command-hub/testing-qa/${k}/`));
  });

  it('sends the old tab URLs to the new tabs', () => {
    expect(APP).toContain("'/command-hub/testing-qa/unit-tests/':        { section: 'testing-qa', tab: 'catalog' }");
    expect(APP).toContain("'/command-hub/testing-qa/integration-tests/': { section: 'testing-qa', tab: 'catalog' }");
    expect(APP).toContain("'/command-hub/testing-qa/validator-tests/':   { section: 'testing-qa', tab: 'catalog' }");
    expect(APP).toContain("'/command-hub/testing-qa/ci-reports/':        { section: 'testing-qa', tab: 'runs' }");
  });

  it('renders each tab from its own view', () => {
    expect(APP).toContain("tab === 'overview') {\n        container.appendChild(renderTestingOverviewView());");
    expect(APP).toContain("tab === 'catalog') {\n        container.appendChild(renderTestingCatalogView());");
    expect(APP).toContain("tab === 'runs') {\n        container.appendChild(renderTestingRunsView());");
  });

  it('reads the admin APIs from P1 and P2, with the auth headers', () => {
    expect(TQ_CODE).toContain("'/api/v1/testing/results/summary'");
    expect(TQ_CODE).toContain("'/api/v1/testing/catalog'");
    expect(TQ_CODE).toContain("'/api/v1/testing/results/runs?'");
    expect(TQ_CODE).toContain("'/api/v1/testing/catalog/suite?id='");
    expect(TQ_CODE).toContain("'/api/v1/testing/results/sync', { method: 'POST' }");
    expect(TQ_CODE).toMatch(/init\.headers = buildContextHeaders\(/);
  });

  it('labels the four environments the supervisor tells apart', () => {
    for (const k of ['dev_pr', 'nightly', 'staging', 'production']) expect(TQ_CODE).toContain(`key: '${k}'`);
    expect(TQ_CODE).toContain('Read-only monitors and health checks');
  });

  it('never styles inline (CSP): no .style and no style= in the new code', () => {
    expect(TQ_CODE).not.toMatch(/\.style\b/);
    expect(TQ_CODE).not.toMatch(/style=/);
    for (const cls of ['tq-view', 'tq-env-grid', 'tq-pill-bad', 'tq-table-wrap', 'tq-filter-bar']) expect(CSS).toContain(`.${cls}`);
  });

  it('escapes by construction: data is written with textContent, never innerHTML', () => {
    expect(TQ_CODE).not.toMatch(/innerHTML/);
  });
});
