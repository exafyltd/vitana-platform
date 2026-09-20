/**
 * VTID-04152 — the OASIS Events list fetch can no longer hang indefinitely.
 *
 * app.js is a plain script with no module exports (Command Hub frontend), so
 * this is a source-text regression guard rather than an import-based unit test
 * — the same pattern as vtid-03925-pipeline-summary-loop-fix.test.ts and
 * vtid-03917-overview-poll-no-full-rerender.test.ts.
 *
 * `fetchOasisEvents()` was the one network call in that function with no
 * AbortController/timeout wrapper at all, while every sibling probe in the same
 * file goes through `fetchWT()` (the fetch-with-timeout helper defined just
 * above fetchOverviewDashboard, default 8 s, which every other polling/probe
 * call site already uses).
 *
 * Why that mattered: a connection that never settles (half-open socket, proxy
 * that accepts and then answers nothing) left `await fetch(...)` pending
 * forever, so the function's own `finally` never ran and
 * `state.oasisEvents.loading` stayed `true` for the life of the tab. The
 * `if (state.oasisEvents.loading) return;` guard at the top of
 * fetchOasisEvents() then silently dropped every subsequent call — the
 * screen-entry auto-fetch, the SPEC-01 global refresh, and Load More — while
 * renderOasisEventsView() kept rendering "Loading OASIS events..." with the
 * Load More button disabled. A permanent, unrecoverable spinner produced by a
 * single dead connection.
 *
 * Fix: the call site now goes through the file's existing fetchWT() helper, so
 * a hang aborts at the 8 s default and surfaces as an ordinary, retryable fetch
 * error in the existing catch/finally path.
 */

import * as fs from 'fs';
import * as path from 'path';

const COMMAND_HUB = path.resolve(__dirname, '../src/frontend/command-hub');
const SOURCE = fs.readFileSync(path.join(COMMAND_HUB, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(COMMAND_HUB, 'index.html'), 'utf8');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

describe('VTID-04152: fetchOasisEvents() fetches through the bounded-timeout helper', () => {
  it('issues the OASIS events request via fetchWT(), not a bare fetch()', () => {
    const body = functionBody(SOURCE, 'async function fetchOasisEvents(');
    expect(body).toContain("await fetchWT('/api/v1/oasis/events?' + queryParams)");
    // The unwrapped call this VTID removed must not come back.
    expect(body).not.toContain("await fetch('/api/v1/oasis/events?' + queryParams)");
  });

  it('the same request has no other bare fetch() left in the function', () => {
    const body = functionBody(SOURCE, 'async function fetchOasisEvents(');
    expect(body).not.toMatch(/[\s=(]fetch\(/);
  });

  it('fetchWT() is still the AbortController-timeout helper this now depends on', () => {
    const body = functionBody(SOURCE, 'function fetchWT(url, opts, timeoutMs) {');
    expect(body).toContain('new AbortController()');
    expect(body).toContain('setTimeout(function () { ctrl.abort(); }, ms);');
    expect(body).toContain('var ms = timeoutMs || 8000;');
    // The timer must be cleared on both settle paths, not leaked.
    expect(body).toContain('.finally(function () { clearTimeout(tid); })');
  });

  it('a timed-out fetch still lands in the existing error/finally path (retryable, not stuck)', () => {
    const body = functionBody(SOURCE, 'async function fetchOasisEvents(');
    // An abort rejects the awaited promise, so the catch records it ...
    expect(body).toContain("state.oasisEvents.error = error.message;");
    expect(body).toContain("console.error('[VTID-0600] Failed to fetch OASIS events:', error);");
    // ... and the finally always clears the loading flag that gates every
    // later fetch, which is what turns a hang into a recoverable state.
    const finallyIdx = body.lastIndexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(body.slice(finallyIdx)).toContain('state.oasisEvents.loading = false;');
  });

  it('the loading guard the permanent hang used to deadlock is still in place', () => {
    const body = functionBody(SOURCE, 'async function fetchOasisEvents(');
    const guardIdx = body.indexOf('if (state.oasisEvents.loading) return;');
    const fetchIdx = body.indexOf('await fetchWT(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(guardIdx);
  });
});

describe('VTID-04152: the fix ships with the Command Hub cache-bust bump', () => {
  it('bumps app.js and styles.css together in index.html', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260920-vtid-04152-oasis-fetch-timeout').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
  });
});
