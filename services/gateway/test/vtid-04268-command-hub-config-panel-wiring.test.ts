/**
 * VTID-04268 — Command Hub Autopilot supervisor visibility: the Dev
 * Autopilot "Advanced config" panel actually renders and can save.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness — matching this repo's established pattern (see
 * test/command-hub/vtid-04147-service-health-aria-live.test.ts) — this
 * suite pins the change by source text: the field allowlist mirrors the
 * server-side one, the panel is wired into renderDevAutopilotView(), the
 * save handler POSTs to /config/update, and no new inline `.style` usage
 * was introduced (CSP §36 — classes only, verified separately by the CI
 * CSP gate, but pinned here too so a future edit can't silently reintroduce
 * one without a test catching it).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const STYLES_CSS_PATH = join(__dirname, '../src/frontend/command-hub/styles.css');

const appJs = readFileSync(APP_JS_PATH, 'utf8');
const stylesCss = readFileSync(STYLES_CSS_PATH, 'utf8');

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const configPanelBlock = sliceBetween(
  appJs,
  'function renderDevAutopilotConfigPanel() {',
  'function renderDevAutopilotView() {',
);

const saveConfigBlock = sliceBetween(
  appJs,
  'function devAutopilotSaveConfig() {',
  'function renderDevAutopilotConfigPanel() {',
);

describe('VTID-04268: Dev Autopilot advanced config field allowlist', () => {
  const expectedFields = [
    'daily_budget',
    'cooldown_minutes',
    'concurrency_cap',
    'auto_archive_days',
    'reject_suppression_days',
    'eager_plan_top_k',
    'select_all_cap',
    'max_auto_fix_depth',
    'post_deploy_verification_window_minutes',
  ];

  it('declares exactly the nine safe numeric fields, matching the server-side allowlist', () => {
    for (const key of expectedFields) {
      expect(appJs).toContain(`key: '${key}'`);
    }
  });

  it('never declares allow_scope, deny_scope, or kill_switch as a config field', () => {
    const fieldsBlock = sliceBetween(
      appJs,
      'var DEV_AUTOPILOT_CONFIG_FIELDS = [',
      '];',
    );
    expect(fieldsBlock).not.toContain("key: 'allow_scope'");
    expect(fieldsBlock).not.toContain("key: 'deny_scope'");
    expect(fieldsBlock).not.toContain("key: 'kill_switch'");
  });
});

describe('VTID-04268: Dev Autopilot advanced config panel wiring', () => {
  it('renders the panel inside renderDevAutopilotView()', () => {
    expect(appJs).toContain('container.appendChild(renderDevAutopilotConfigPanel());');
  });

  it('POSTs the save to /api/v1/dev-autopilot/config/update', () => {
    expect(saveConfigBlock).toContain("fetch('/api/v1/dev-autopilot/config/update', { method: 'POST'");
  });

  it('re-fetches state after a successful save instead of trusting the local draft', () => {
    expect(saveConfigBlock).toContain('fetchDevAutopilotState();');
  });

  it('disables the save button and inputs while a save is in flight', () => {
    expect(configPanelBlock).toContain('input.disabled = !!state.devAutopilot.configSaving;');
    expect(configPanelBlock).toContain('saveBtn.disabled = !!state.devAutopilot.configSaving;');
  });

  it('uses CSS classes, not inline .style.cssText, for the panel elements (CSP §36)', () => {
    expect(configPanelBlock).not.toMatch(/\.style\b/);
    expect(saveConfigBlock).not.toMatch(/\.style\b/);
  });
});

describe('VTID-04268: styles.css carries the panel classes', () => {
  it('declares every class the panel assigns', () => {
    const classes = [
      '.dev-autopilot-config-panel',
      '.dev-autopilot-config-summary',
      '.dev-autopilot-config-body',
      '.dev-autopilot-config-field',
      '.dev-autopilot-config-input',
      '.dev-autopilot-config-error',
      '.dev-autopilot-config-actions',
    ];
    for (const cls of classes) {
      expect(stylesCss).toContain(cls);
    }
  });
});
