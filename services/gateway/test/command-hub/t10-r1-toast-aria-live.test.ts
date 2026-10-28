/**
 * VTID-04088 (T10, accessibility region 1 of 4): the toast notification
 * container is announced to screen readers.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts) — this suite
 * pins the change by source text.
 *
 * Before this VTID, `renderToastContainer()` had no `aria-live`/`role`
 * attribute at all (0 occurrences of either anywhere in app.js). A toast
 * is pushed purely via a state mutation + re-render — a sighted user sees
 * it, a screen-reader user gets nothing, because nothing in the DOM change
 * is marked as a live region.
 *
 * Scope note: the audit that produced this region also flagged two
 * color-only status-dot candidates (`heartbeat-status-dot`,
 * `deploy-status-dot`) — both were checked and found to already sit next
 * to a text label (`statusText`/`depStatusEl` render the same status as
 * text), so no change was needed there; this region is toast-only.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

/** Slice the body of a top-level `function <name>() { ... }` declaration. */
function functionBody(src: string, name: string): string {
  const match = src.match(new RegExp('function\\s+' + name + '\\(\\)\\s*\\{[\\s\\S]*?\\n\\}'));
  if (!match) throw new Error(`function ${name}() not found in source`);
  return match[0];
}

describe('T10 region 1: toast container is a live region', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('renderToastContainer() sets role="status" and aria-live="polite" on the container', () => {
    const body = functionBody(appJs, 'renderToastContainer');
    expect(body).toMatch(/setAttribute\(\s*['"]role['"]\s*,\s*['"]status['"]\s*\)/);
    expect(body).toMatch(/setAttribute\(\s*['"]aria-live['"]\s*,\s*['"]polite['"]\s*\)/);
  });

  it('the live-region attributes are set on the container itself, before any toast is appended', () => {
    const body = functionBody(appJs, 'renderToastContainer');
    const liveIndex = body.indexOf("setAttribute('aria-live'");
    const forEachIndex = body.indexOf('state.toasts.forEach');
    expect(liveIndex).toBeGreaterThan(-1);
    expect(forEachIndex).toBeGreaterThan(-1);
    expect(liveIndex).toBeLessThan(forEachIndex);
  });

  it('uses "polite", not "assertive" — an error toast must not interrupt', () => {
    const body = functionBody(appJs, 'renderToastContainer');
    expect(body).not.toMatch(/aria-live['"]\s*,\s*['"]assertive/);
  });
});
