/**
 * VTID-04614: Autopilot Live "Why executions failed" list shows count_24h / last_seen_at meta.
 *
 * These are source-level checks (no browser DOM needed) that verify:
 *  1. The new CSS class `ap-live-reason-meta` exists in styles.css.
 *  2. app.js contains the guard `r.count_24h != null && r.last_seen_at != null`.
 *  3. app.js uses `ap-live-reason-meta` as the className for the meta span.
 *  4. app.js uses `autopilotSupervisorAgo` for the last_seen_at value.
 *  5. Both asset links in index.html carry the bumped ?v=20260926-vtid-04614 string.
 *  6. When the fields are absent the original single-text path still exists
 *     (the main span still sets textContent to `r.count + … + r.reason`).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../src/frontend/command-hub');

const appJs     = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('VTID-04614 — Autopilot Live failure-reason meta display', () => {
  it('styles.css defines .ap-live-reason-meta', () => {
    expect(stylesCss).toContain('.ap-live-reason-meta');
  });

  it('styles.css .ap-live-reason-meta has no inline style attribute (uses class, not inline)', () => {
    // The rule must be a proper CSS class block, not an inline style= attribute
    const idx = stylesCss.indexOf('.ap-live-reason-meta');
    expect(idx).toBeGreaterThan(-1);
    // The block must open with '{'
    const blockStart = stylesCss.indexOf('{', idx);
    expect(blockStart).toBeGreaterThan(idx);
  });

  it('app.js guards the meta span on count_24h != null && last_seen_at != null', () => {
    expect(appJs).toContain('r.count_24h != null && r.last_seen_at != null');
  });

  it('app.js assigns className ap-live-reason-meta to the meta span', () => {
    expect(appJs).toContain("meta.className = 'ap-live-reason-meta'");
  });

  it('app.js calls autopilotSupervisorAgo with r.last_seen_at for the meta span', () => {
    expect(appJs).toContain('autopilotSupervisorAgo(r.last_seen_at)');
  });

  it('app.js meta span uses textContent (not innerHTML)', () => {
    // Confirm the meta span sets textContent, not innerHTML
    expect(appJs).toContain('meta.textContent =');
    // And innerHTML must not be used for the meta span (search near the guard)
    const guardIdx = appJs.indexOf('r.count_24h != null && r.last_seen_at != null');
    const snippet = appJs.slice(guardIdx, guardIdx + 400);
    expect(snippet).not.toContain('innerHTML');
  });

  it('app.js still has the main span with r.count × r.reason textContent (fallback path intact)', () => {
    // The source file stores the multiplication sign as the \u00D7 escape sequence (literal text).
    // We match the surrounding tokens to avoid the TS compile-time unicode expansion issue.
    expect(appJs).toContain("main.textContent = r.count + '\\u00D7  ' + r.reason");
  });

  it('index.html styles.css link has bumped ?v=20260926-vtid-04614', () => {
    expect(indexHtml).toContain('styles.css?v=20260926-vtid-04614');
  });

  it('index.html app.js script has bumped ?v=20260926-vtid-04614', () => {
    expect(indexHtml).toContain('app.js?v=20260926-vtid-04614');
  });

  it('index.html does not still carry the old vtid-04560 version on styles.css or app.js', () => {
    // The two main assets must be updated; other assets (orb-widget, intelligence-panels, etc.) are untouched
    expect(indexHtml).not.toContain('styles.css?v=20261013-vtid-04560');
    expect(indexHtml).not.toContain('app.js?v=20261013-vtid-04560');
  });
});
