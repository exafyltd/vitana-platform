/**
 * VTID-04264: Dev Autopilot kill-switch button on Command Hub.
 *
 * The gateway already had a fully-working GET /config / POST
 * /config/kill-switch pair (services/gateway/src/routes/dev-autopilot.ts) —
 * the Command Hub Dev Autopilot panel just never gave an operator a way to
 * flip it. The status strip rendered `cfg.kill_switch` as a read-only chip
 * (`renderDevAutopilotView`), so arming/disarming the switch required a
 * direct DB write.
 *
 * This is a static source-check test, matching the established pattern for
 * app.js elsewhere in this suite (a plain IIFE bundle with no module export
 * surface, so assertions read the shipped source text directly rather than
 * importing/executing it) — see vtid-04259-session-timeout.test.ts for the
 * precedent.
 *
 * The Dev Autopilot on-ramp attempted this exact task via the Operator
 * Console first (autopilot_run_task) and exhausted its 120-turn agent cap
 * purely navigating the 2.6MB app.js file without making an edit — this
 * fix was implemented directly by a Claude Code session per the standing
 * "when Operator fails, Claude Code takes over" instruction.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../src/frontend/command-hub/index.html');

describe('VTID-04264: Dev Autopilot kill-switch button', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('renders a kill-switch toggle button in the Dev Autopilot header', () => {
    expect(src).toMatch(/killSwitchBtn\.textContent = killSwitchArmed \? 'Disarm kill switch' : 'Arm kill switch'/);
  });

  it('derives the armed state from the existing GET /config response, not a new fetch', () => {
    expect(src).toMatch(
      /var killSwitchArmed = !!\(state\.devAutopilot\.config && state\.devAutopilot\.config\.kill_switch\)/
    );
  });

  it('calls the existing POST /api/v1/dev-autopilot/config/kill-switch route with { armed }', () => {
    expect(src).toMatch(/fetch\('\/api\/v1\/dev-autopilot\/config\/kill-switch', \{/);
    expect(src).toMatch(/body: JSON\.stringify\(\{ armed: nextArmed \}\)/);
  });

  it('sends the same auth headers every other admin-gated Command Hub call uses (buildContextHeaders)', () => {
    const idx = src.indexOf("fetch('/api/v1/dev-autopilot/config/kill-switch'");
    expect(idx).toBeGreaterThan(-1);
    const nearby = src.slice(idx, idx + 400);
    expect(nearby).toContain("buildContextHeaders({ 'Content-Type': 'application/json' })");
  });

  it('confirms before ARMING (a real, disruptive action) but not before disarming', () => {
    expect(src).toMatch(
      /if \(nextArmed && !confirm\('This will ARM the Dev Autopilot kill switch and block new executions\. Continue\?'\)\) return;/
    );
  });

  it('re-fetches Dev Autopilot state after a successful toggle so the button and the read-only chip stay in sync', () => {
    const idx = src.indexOf("fetch('/api/v1/dev-autopilot/config/kill-switch'");
    expect(idx).toBeGreaterThan(-1);
    const nearby = src.slice(idx, idx + 700);
    expect(nearby).toContain('state.devAutopilot.fetched = false');
    expect(nearby).toContain('fetchDevAutopilotState()');
  });

  it('surfaces a failed toggle via showToast rather than failing silently', () => {
    const idx = src.indexOf("fetch('/api/v1/dev-autopilot/config/kill-switch'");
    expect(idx).toBeGreaterThan(-1);
    const nearby = src.slice(idx, idx + 900);
    expect(nearby).toMatch(/showToast\('Kill switch error: /);
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    // "at or after", not exact-match — VTID-04028/VTID-04031/VTID-04074's
    // own lesson: a later sibling PR legitimately re-bumping this marker
    // must not break this assertion.
    expect(appVersion >= '20260922-vtid-04264-kill-switch-button').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
