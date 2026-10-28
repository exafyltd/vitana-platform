/**
 * VTID-04267: Dev Autopilot spend surfaced in the Command Hub UI.
 *
 * Part of the Command Hub Autopilot supervisor-visibility task list named
 * in VTID-04262's CHANGE LOG row. The Dev Autopilot panel's status strip
 * has always shown a "Budget: —/N today" chip — but that field is the
 * daily APPROVAL-COUNT budget (dev_autopilot_config.daily_budget), not
 * dollars, and the approved-count half was never fetched either (a
 * permanent "—"). No real spend figure existed anywhere in the UI, even
 * though the per-run cost has been recorded since VTID-04017
 * (dev_autopilot_outcomes.metadata.agent_runs[]).
 *
 * The backend aggregation (summarizeSpendToday) is covered by
 * services/gateway/test/services/dev-autopilot-outcomes.test.ts and the
 * GET /spend route by services/gateway/test/routes/dev-autopilot.test.ts.
 * This file pins the FRONTEND half: the panel actually fetching and
 * rendering the real figure.
 *
 * Static source-check test, matching the established pattern for app.js
 * elsewhere in this suite (a plain IIFE bundle with no module export
 * surface).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../src/frontend/command-hub/index.html');

describe('VTID-04267: Dev Autopilot spend surfacing', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('fetchDevAutopilotState fetches GET /api/v1/dev-autopilot/spend alongside the other panel data', () => {
    const start = src.indexOf('function fetchDevAutopilotState() {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction renderDevAutopilotView', start);
    const body = src.slice(start, end === -1 ? start + 2000 : end);
    expect(body).toContain("fetch('/api/v1/dev-autopilot/spend'");
    expect(body).toContain('state.devAutopilot.spend =');
  });

  it('a failed/errored spend fetch degrades to null, never throwing or blocking the rest of the panel', () => {
    const start = src.indexOf('function fetchDevAutopilotState() {');
    const end = src.indexOf('\nfunction renderDevAutopilotView', start);
    const body = src.slice(start, end === -1 ? start + 2000 : end);
    // The spend fetch has its own .catch fallback, same shape as its siblings.
    const spendFetchIdx = body.indexOf("fetch('/api/v1/dev-autopilot/spend'");
    const spendFetchLine = body.slice(spendFetchIdx, spendFetchIdx + 200);
    expect(spendFetchLine).toContain('.catch(function ()');
  });

  it('renders a real "Spend today" chip using the fetched figure, not a hardcoded dash', () => {
    const idx = src.indexOf("{ label: 'Spend today',");
    expect(idx).toBeGreaterThan(-1);
    const line = src.slice(idx, idx + 400);
    expect(line).toContain('spend.spend_usd_today');
    expect(line).toContain('spend.runs_today');
    // Falls back to an honest dash when the fetch hasn't resolved yet —
    // never fabricates a number.
    expect(line).toContain("'—'");
  });

  it('the Spend chip discloses the same list-price/estimate caveat the Operator Console turn-cost badge already uses', () => {
    const idx = src.indexOf("{ label: 'Spend today',");
    const line = src.slice(idx, idx + 400);
    expect(line).toContain('TURN_COST_ESTIMATE_NOTE');
  });

  it('the pre-existing (still fake) Budget chip is untouched by this change', () => {
    expect(src).toContain("{ label: 'Budget', value: '—/' + (cfg.daily_budget || '—') + ' today', color: '#eab308' }");
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260922-vtid-04267-dev-autopilot-spend').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
