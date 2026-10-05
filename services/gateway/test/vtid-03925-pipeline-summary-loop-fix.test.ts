/**
 * VTID-03925 — Command Hub Overview: fetchPipelineSummary() no longer loops
 * forever on a persistent failure.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03917-overview-poll-no-full-rerender.test.ts.
 *
 * Reported live, with real browser console evidence, right after VTID-03917
 * shipped: the System Overview screen was STILL freezing — hundreds of
 * rapidly repeating `GET /api/v1/autopilot/pipeline/summary 401
 * (Unauthorized)` / `[Pipeline] Failed to fetch summary:` lines in the
 * console (691+ and climbing).
 *
 * Root cause: fetchPipelineSummary() set `state.overviewPipelineSummary.fetched
 * = true` ONLY inside the try block on success — unlike every sibling
 * fetcher in this file (fetchActionRequired, fetchServiceHealth, ...), which
 * set it unconditionally after the try/catch. Since the endpoint 401s for
 * every browser caller (it's gated by routes/autopilot.ts's
 * requireServiceToken — an internal GATEWAY_SERVICE_TOKEN secret, never a
 * user session token), `fetched` stayed false forever. `renderOverviewSystemView()`
 * re-triggers `fetchPipelineSummary()` on every render while `!fetched`, and
 * fetchPipelineSummary()'s own `isInitialLoad` branch calls `renderApp()` on
 * both entry and exit while `!fetched` — producing a tight, self-sustaining
 * fetch -> render -> fetch loop that pegged the browser.
 *
 * Fix: `fetched` is now set to `true` unconditionally in the `finally`
 * block, so a persistent failure is still "handled" (matching the
 * established sibling pattern) and the loop cannot occur, regardless of why
 * the fetch keeps failing. The user's bearer token is also attached for
 * consistency with sibling fetches, though this alone does not make the
 * 401 go away (a separate backend routing gap, not fixed here).
 *
 * VTID-04887 (Overview Phase 4): fetchPipelineSummary() and the Overview
 * panels it fed are deleted, and the backend gap is closed — the Command Hub
 * reads GET /api/v1/ops/pipeline-summary (requireAdminAuth, in-process
 * buildPipelineSummary()). This suite now pins that the looping fetcher stays
 * gone and that the Operator Dashboard and Runbook use the admin route with
 * the bearer token and cannot loop: their fetches run under
 * Promise.allSettled, which never rejects, so `fetched` is always set. The
 * third consumer, the Overview's Vitana Recommends panel, sets `fetched` in
 * `finally` (test/command-hub/vtid-04887-overview-cleanup.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

describe('VTID-03925 / VTID-04887: the looping Overview fetcher is gone', () => {
  it('no fetchPipelineSummary() definition or call remains', () => {
    expect(SOURCE).not.toMatch(/function\s+fetchPipelineSummary\s*\(/);
    expect(SOURCE).not.toMatch(/\bfetchPipelineSummary\(/);
    expect(SOURCE).not.toContain('state.overviewPipelineSummary');
  });

  it('no browser code calls the service-token route any more', () => {
    const code = SOURCE.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain("'/api/v1/autopilot/pipeline/summary'");
  });
});

describe('VTID-04887: the remaining pipeline-summary consumers', () => {
  for (const fn of ['fetchOperatorDashboard', 'fetchOperatorRunbook']) {
    it(`${fn}() reads the admin route with the bearer token`, () => {
      const body = functionBody(SOURCE, `async function ${fn}() {`);
      expect(body).toContain("fetch('/api/v1/ops/pipeline-summary', {");
      expect(body).toContain("headers: buildContextHeaders({ Accept: 'application/json' })");
    });

    it(`${fn}() cannot loop: allSettled never rejects, so fetched is always set`, () => {
      const body = functionBody(SOURCE, `async function ${fn}() {`);
      expect(body).toContain('var results = await Promise.allSettled([');
      expect(body).toMatch(/state\.operator(Dashboard|Runbook)\.fetched = true;/);
      expect(body).toContain('if (state.operator');
    });
  }
});
