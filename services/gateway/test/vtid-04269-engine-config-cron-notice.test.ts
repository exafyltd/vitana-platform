/**
 * VTID-04269: Engine Configuration CRON tables — static-data notice.
 *
 * Part of the Command Hub Autopilot supervisor-visibility task list named
 * in VTID-04262's CHANGE LOG row. The Autopilot "Engine Configuration" tab
 * (renderAutopilotEngineView) rendered a "Cloud Scheduler CRON Jobs" table
 * whose 10 rows are hardcoded in app.js, copied from
 * scripts/setup-cloud-scheduler.sh — verified byte-for-byte matching
 * (schedule + timezone) against that script's own job list. No gateway
 * route or DB table backs it with a live query.
 *
 * Investigated whether a reliable live source could be wired up instead
 * (per this task's own brief: wire up a live source if one exists, else
 * add an honest static-data banner). None exists: GCP Cloud Scheduler has
 * no listing API reachable from this gateway, and per CLAUDE.md §1 / the
 * VTID-03676 CHANGE LOG row, GCP billing on the project this script
 * targets by default (`lovable-vitana-vers1`) was disabled 2026-08-16 —
 * only the `push-dispatch` job has a confirmed AWS EventBridge
 * replacement, so whether these 10 AP-* jobs are still actually firing is
 * unconfirmed. This mirrors the exact defect shape VTID-04064 already
 * fixed elsewhere in this file (buildGcpStaticViewDisabledNotice) — same
 * remedy, applied here as an inline notice rather than replacing the
 * whole view, since the schedule data still has reference value as
 * documentation even though it can no longer be trusted as live status.
 *
 * Static source-check test, matching the established pattern for app.js
 * elsewhere in this suite (a plain IIFE bundle with no module export
 * surface).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const STYLES_CSS_PATH = join(__dirname, '../src/frontend/command-hub/styles.css');
const INDEX_HTML_PATH = join(__dirname, '../src/frontend/command-hub/index.html');

describe('VTID-04269: Engine Configuration CRON Jobs table gets an honest static-data notice', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('renders a static-data notice inside the CRON Jobs card, before the table is built', () => {
    const noticeIdx = src.indexOf("cronStaticNotice.className = 'autopilot-static-cron-notice'");
    expect(noticeIdx).toBeGreaterThan(-1);
    const tableVarIdx = src.indexOf('var cronJobs = [');
    expect(tableVarIdx).toBeGreaterThan(noticeIdx);
  });

  it('the notice discloses that this is static data, not a live query, and names the source script', () => {
    const idx = src.indexOf("cronStaticNotice.textContent = '");
    expect(idx).toBeGreaterThan(-1);
    const line = src.slice(idx, idx + 400);
    expect(line).toContain('scripts/setup-cloud-scheduler.sh');
    expect(line).toContain('not a live query');
  });

  it('the notice discloses the GCP billing/migration status, not just a generic disclaimer', () => {
    const idx = src.indexOf("cronStaticNotice.textContent = '");
    const line = src.slice(idx, idx + 400);
    expect(line).toContain('GCP Cloud Scheduler billing was disabled');
    expect(line).toContain('unconfirmed');
  });

  it('uses a CSS class, not inline .style.cssText, for the new notice element', () => {
    const idx = src.indexOf('var cronStaticNotice = document.createElement');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    expect(block).not.toContain('.style.cssText');
    expect(block).toContain("className = 'autopilot-static-cron-notice'");
  });

  it('the CRON job data itself is untouched — this is a notice ADDED, not a data rewrite', () => {
    expect(src).toContain("{ id: 'AP-0101', name: 'Daily Match Delivery', schedule: '0 8 * * *', tz: 'Europe/Berlin' }");
    expect(src).toContain("{ id: 'AP-0604', name: 'Wellness Check-In', schedule: '0 10 * * 3', tz: 'Europe/Berlin' }");
  });

  it('.autopilot-static-cron-notice is defined in styles.css', () => {
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    expect(css).toMatch(/\.autopilot-static-cron-notice\s*\{/);
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260922-vtid-04269-cron-static-notice').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
