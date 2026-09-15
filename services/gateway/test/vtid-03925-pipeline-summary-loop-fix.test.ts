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

describe('VTID-03925: fetchPipelineSummary() cannot loop forever on a persistent failure', () => {
  it('sets state.overviewPipelineSummary.fetched = true unconditionally in the finally block', () => {
    const body = functionBody(SOURCE, 'async function fetchPipelineSummary() {');
    const financeIdx = body.lastIndexOf('} finally {');
    expect(financeIdx).toBeGreaterThan(-1);
    const financeBlock = body.slice(financeIdx);
    expect(financeBlock).toContain('state.overviewPipelineSummary.fetched = true;');
  });

  it('the try block no longer sets fetched = true itself (single source of truth: finally)', () => {
    const body = functionBody(SOURCE, 'async function fetchPipelineSummary() {');
    const tryIdx = body.indexOf('try {');
    const catchIdx = body.indexOf('} catch (error) {');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    const tryBlock = body.slice(tryIdx, catchIdx);
    expect(tryBlock).not.toContain('state.overviewPipelineSummary.fetched = true;');
  });

  it('attaches the bearer token via buildContextHeaders(), matching sibling fetchers', () => {
    const body = functionBody(SOURCE, 'async function fetchPipelineSummary() {');
    expect(body).toContain('buildContextHeaders(');
    expect(body).toContain("fetchWT('/api/v1/autopilot/pipeline/summary', { headers: headers }, 12000)");
  });

  it('a successful response still populates the snapshot and clears any prior error', () => {
    const body = functionBody(SOURCE, 'async function fetchPipelineSummary() {');
    expect(body).toContain('state.overviewPipelineSummary.snapshot = data;');
    expect(body).toContain('state.overviewPipelineSummary.error = null;');
  });

  it('a failure is still logged and recorded, not silently swallowed', () => {
    const body = functionBody(SOURCE, 'async function fetchPipelineSummary() {');
    expect(body).toContain("console.error('[Pipeline] Failed to fetch summary:', error);");
    expect(body).toContain('state.overviewPipelineSummary.error = error.message;');
  });
});

describe('VTID-03925: renderOverviewSystemView() guard this fix protects against', () => {
  it('still only calls fetchPipelineSummary() when not already fetched/loading (guard unchanged)', () => {
    const idx = SOURCE.indexOf('function renderOverviewSystemView() {');
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 1500);
    expect(nearby).toContain('if (!state.overviewPipelineSummary.fetched && !state.overviewPipelineSummary.loading) {');
  });
});

describe('VTID-03925: downstream consumers stay null-safe with a permanently-null snapshot', () => {
  it('renderOverviewSystemView\'s metrics grid null-guards every summary field it reads', () => {
    const idx = SOURCE.indexOf('var summary = state.overviewPipelineSummary.snapshot;');
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 4500);
    expect(nearby).toContain('summary && summary.funnel');
    expect(nearby).toContain('summary && summary.workers_active !== undefined');
    expect(nearby).toContain('summary && summary.success_rate !== undefined');
  });

  it('renderVtidAttentionSection() null-guards the attention_queue array and returns null when empty', () => {
    const idx = SOURCE.indexOf('function renderVtidAttentionSection() {');
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 400);
    expect(nearby).toContain('var summary = state.overviewPipelineSummary.snapshot;');
    expect(nearby).toContain('summary && Array.isArray(summary.attention_queue)');
    expect(nearby).toContain('if (queue.length === 0) return null;');
  });
});
