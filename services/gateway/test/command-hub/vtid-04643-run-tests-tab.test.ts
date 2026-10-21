/**
 * VTID-04643 — the Run Tests tab.
 *
 * Pins that the tab reads the launch list from the gateway (never a hand-typed
 * list of workflows in the browser), sends every launch through POST
 * /api/v1/testing/launch with a reason, shows why other workflows are not
 * launchable, and styles only with tq-* classes (CSP).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const HUB = join(__dirname, '../../src/frontend/command-hub');
const APP = readFileSync(join(HUB, 'app.js'), 'utf8');
const CSS = readFileSync(join(HUB, 'styles.css'), 'utf8');

const start = APP.indexOf('// ─── Testing & QA: Run Tests (VTID-04643)');
const end = APP.indexOf('function renderTestingE2eView() {', start);
const CODE = APP.slice(start, end);

describe('VTID-04643 Run Tests tab', () => {
  it('exists and is routed', () => {
    expect(start).toBeGreaterThan(0);
    expect(APP).toContain("tab === 'run-tests') {\n        container.appendChild(renderTestingRunTestsView());");
  });

  it('reads the launch list and recent launches from the gateway', () => {
    expect(CODE).toContain("'/api/v1/testing/launchable'");
    expect(CODE).toContain("'/api/v1/testing/launches'");
    expect(CODE).not.toMatch(/'[A-Z0-9-]+\.ya?ml'/); // no workflow file names typed into the browser
  });

  it('launches only through the gateway route, with the reason and projects', () => {
    expect(CODE).toContain("tqFetchJson('/api/v1/testing/launch', {");
    expect(CODE).toMatch(/JSON\.stringify\(\{ repo: item\.repo, workflow: item\.file, reason: form\.reason, projects: form\.projects \}\)/);
    expect(CODE).not.toMatch(/api\.github\.com|\/dispatches/);
  });

  it('shows why other workflows are not launchable', () => {
    expect(CODE).toContain('Not launchable from here (');
    expect(CODE).toContain('w.reason');
  });

  it('never styles inline and never writes innerHTML (CSP, escaping)', () => {
    expect(CODE).not.toMatch(/\.style\b|style=|innerHTML/);
    for (const cls of ['tq-launch-grid', 'tq-launch-card', 'tq-projects', 'tq-reason', 'tq-details']) expect(CSS).toContain(`.${cls}`);
  });
});
