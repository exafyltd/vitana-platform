/**
 * VTID-04148: the execution status pill on the Autopilot Live view is
 * announced to screen readers.
 *
 * The Autopilot Live view (`renderAutopilotLiveView()`, Command Hub →
 * Autopilot → Live) renders one row per active dev-autopilot execution, and
 * the only text carrying that execution's state is the coloured status pill
 * (`pill.textContent = exec.status` — queued/cooling → running → ci →
 * merging → deploying → verifying → completed/failed/cancelled). The view
 * refreshes by re-rendering from `state.autopilot.live.devAutopilotExecutions`
 * (a 10s poll plus user-triggered renders), so a state transition is a plain
 * DOM text swap that a screen reader would otherwise never announce on its
 * own.
 *
 * This adds `aria-live="polite"` on the pill itself — following the same
 * region convention VTID-04088 established for the toast container
 * (test/command-hub/t10-r1-toast-aria-live.test.ts): 'polite', not
 * 'assertive', so a state change never cuts off what the user is already
 * being told.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js — this
 * suite pins the change by source text.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');

/** Slice a top-level `function <name>(...)` declaration up to the next one. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start === -1) throw new Error(`function ${name}() not found in app.js`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf('\nfunction ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('VTID-04148: Autopilot Live execution status pills are live regions', () => {
  const body = fnBody(APP_JS, 'renderAutopilotLiveView');

  it('the status pill sets aria-live="polite"', () => {
    expect(body).toMatch(/pill\.setAttribute\(\s*['"]aria-live['"]\s*,\s*['"]polite['"]\s*\)/);
  });

  it('the attribute is on the pill that carries the execution status text', () => {
    // `pill.textContent = exec.status` is the state text a screen reader must
    // hear change; the aria-live attribute belongs on that same element.
    const textIdx = body.indexOf('pill.textContent = exec.status;');
    const liveIdx = body.indexOf("pill.setAttribute('aria-live', 'polite');");
    expect(textIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(textIdx);
  });

  it('the live region is armed before the pill is mounted, so the first rendered status is announced too', () => {
    const liveIdx = body.indexOf("pill.setAttribute('aria-live', 'polite');");
    const appendIdx = body.indexOf('card.appendChild(pill);');
    expect(liveIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeLessThan(appendIdx);
  });

  it('uses "polite", not "assertive" — a status transition must not interrupt', () => {
    const liveIdx = body.indexOf("pill.setAttribute('aria-live', 'polite');");
    const block = body.slice(liveIdx);
    expect(block).not.toMatch(/aria-live['"]\s*,\s*['"]assertive/);
  });

  it('ships the cache-bust for app.js and styles.css together, and the ownership-guard allowlist', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260920-vtid-04148-autopilot-live-status-aria-live').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    const guardJs = readFileSync(
      join(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'),
      'utf8',
    );
    expect(guardJs).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04148/);
  });
});
