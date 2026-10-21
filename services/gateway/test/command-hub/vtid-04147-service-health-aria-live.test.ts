/**
 * VTID-04147 — the Command Hub Service Health panel's status region is an
 * `aria-live="polite"` region, so a screen-reader user is told when the
 * panel's health status changes on its own.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/t10-r1-toast-aria-live.test.ts and
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts) — this suite pins
 * the change by source text.
 *
 * Before this VTID, the Service Health block of `renderOverviewSystemView()`
 * rebuilt its header row — `.overview-panel-title-row`, carrying the
 * "Service Health" title, the "N/M healthy" count badge and the
 * "(refreshing…)" tag — from scratch on every poll, with no live region
 * anywhere. That count changes on a 30s poll with no user action and no focus
 * move (`fetchServiceHealth(true)` → `renderApp()`), so a sighted user sees
 * it change and a screen-reader user is told nothing.
 *
 * Reading taken: the request says the STATUS REGION of the panel, so the
 * attribute goes on the panel's own status row (`healthHeaderEl`) rather than
 * on the whole `.overview-health-grid` panel — a live region wrapping all ~55
 * service chips would re-announce the entire service list on every poll. The
 * assertions below pin both halves of that reading: the attribute is on the
 * status row, and it was deliberately NOT put on the outer panel.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

const appJs = readFileSync(APP_JS_PATH, 'utf8');

/**
 * The Service Health status region inside renderOverviewSystemView(): from the
 * status row's construction up to the panel's empty-state branch. Sliced by
 * literal markers rather than by a whole-function regex because the function
 * is thousands of lines long and contains many nested blocks.
 */
function serviceHealthBlock(): string {
  const start = appJs.indexOf("var healthHeaderEl = document.createElement('div');");
  expect(start).toBeGreaterThan(-1);
  const end = appJs.indexOf('if (sortedHealth.length === 0) {', start);
  expect(end).toBeGreaterThan(start);
  // The row must actually live in the overview renderer, not somewhere else.
  const rendererViewStart = appJs.lastIndexOf('function renderOverviewSystemView() {', start);
  expect(rendererViewStart).toBeGreaterThan(-1);
  return appJs.slice(start, end);
}

describe('VTID-04147: the Service Health panel status row is a polite live region', () => {
  it('sets aria-live="polite" on the panel status row element', () => {
    expect(serviceHealthBlock()).toContain("healthHeaderEl.setAttribute('aria-live', 'polite');");
  });

  it('targets the service-health status row, not some other element', () => {
    const block = serviceHealthBlock();
    // The element carrying the attribute is the same one built as the panel's
    // title/status row, and that row is what renders the health status.
    expect(block).toContain("var healthHeaderEl = document.createElement('div');");
    expect(block).toContain("healthHeaderEl.className = 'overview-panel-title-row';");
    expect(block).toMatch(/healthHeaderEl\.innerHTML = '<span class="overview-panel-title">Service Health<\/span>'/);
    expect(block).toContain("healthyCount + '/' + sortedHealth.length + ' healthy");
    expect(block).toContain('healthPanel.appendChild(healthHeaderEl);');
  });

  it('sets the attribute on the row before its status content is written', () => {
    const block = serviceHealthBlock();
    const liveIndex = block.indexOf("healthHeaderEl.setAttribute('aria-live', 'polite');");
    const classIndex = block.indexOf("healthHeaderEl.className = 'overview-panel-title-row';");
    const innerHtmlIndex = block.indexOf('healthHeaderEl.innerHTML =');
    expect(classIndex).toBeGreaterThan(-1);
    expect(liveIndex).toBeGreaterThan(classIndex);
    expect(innerHtmlIndex).toBeGreaterThan(liveIndex);
  });

  it('uses "polite", not "assertive" — a health-count change must not interrupt', () => {
    const block = serviceHealthBlock();
    expect(block).not.toMatch(/aria-live['"]\s*,\s*['"]assertive/);
  });

  it('leaves the ~55-chip grid itself without a live region (no re-announce storm)', () => {
    // Only one live region in this section, and it is the status row.
    const block = serviceHealthBlock();
    expect(block.match(/setAttribute\(\s*['"]aria-live['"]/g) || []).toHaveLength(1);
    expect(appJs).not.toContain("healthPanel.setAttribute('aria-live'");
  });
});

describe('VTID-04147: the change ships with a cache-bust', () => {
  it('bumps styles.css and app.js together, past the previous marker', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    const stylesVersion = (html.match(/styles\.css\?v=([^"]+)"/) || [])[1] || '';
    const appVersion = (html.match(/app\.js\?v=([^"]+)"/) || [])[1] || '';
    expect(appVersion).toBe(stylesVersion);
    expect(appVersion > '20260919-vtid-04110-live-transcript-no-flicker').toBe(true);
  });
});
