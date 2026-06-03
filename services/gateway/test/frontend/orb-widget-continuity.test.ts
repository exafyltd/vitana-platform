import * as fs from 'fs';
import * as path from 'path';

// DEV-COMHU-0503 — ORB Recovery 2+3: static checks that the widget persists
// short-lived continuity on close and clears it on reset. Mirrors the
// static-analysis style of the other orb-widget frontend tests.

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('orb-widget close/reopen continuity (DEV-COMHU-0503)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('_hide persists continuity (reason hide, 15 min) before teardown', () => {
    const body = extractFunctionBody(source, 'function _hide()');
    expect(body).toMatch(/_persistContinuity\('hide', 15\)/);
    // The persist call must come BEFORE _sessionStop tears media down.
    expect(body.indexOf("_persistContinuity('hide', 15)")).toBeLessThan(body.indexOf('_sessionStop()'));
  });

  it('_persistContinuity POSTs conversation_id + transcript to the continuity endpoint', () => {
    const body = extractFunctionBody(source, 'function _persistContinuity(reason, ttlMinutes)');
    expect(body).toMatch(/\/api\/v1\/orb\/session\/continuity/);
    expect(body).toMatch(/conversation_id/);
    expect(body).toMatch(/transcript_history/);
    expect(body).toMatch(/keepalive: true/);
    // Authenticated only — no token, no durable continuity.
    expect(body).toMatch(/if \(!_cfg\.token\) return;/);
  });

  it('_reset clears continuity AND in-memory identity-bound state', () => {
    const body = extractFunctionBody(source, 'function _reset()');
    expect(body).toMatch(/_clearContinuity\(\)/);
    expect(body).toMatch(/_s\._transcriptHistory = \[\]/);
    expect(body).toMatch(/_s\.conversationId = null/);
  });

  it('_reset suppresses the _hide persist so DELETE is not raced by a POST (review fix)', () => {
    const body = extractFunctionBody(source, 'function _reset()');
    expect(body).toMatch(/_s\._suppressContinuityPersist = true/);
    expect(body).toMatch(/_s\._suppressContinuityPersist = false/);
    // Match statements (leading whitespace), not the words inside comments:
    // suppression set → _hide() call → _clearContinuity() DELETE, in that order.
    const iSuppress = body.indexOf('_s._suppressContinuityPersist = true');
    const iHide = body.search(/\n\s*_hide\(\);/);
    const iClear = body.search(/\n\s*_clearContinuity\(\);/);
    expect(iSuppress).toBeLessThan(iHide);
    expect(iHide).toBeLessThan(iClear);
  });

  it('_persistContinuity honors the suppression flag (review fix)', () => {
    const body = extractFunctionBody(source, 'function _persistContinuity(reason, ttlMinutes)');
    expect(body).toMatch(/if \(_s\._suppressContinuityPersist\) return;/);
  });

  it('_sessionStart hydrates persisted continuity on a fresh reopen (review fix)', () => {
    const body = extractFunctionBody(source, 'async function _sessionStart()');
    expect(body).toMatch(/\/api\/v1\/orb\/session\/continuity/);
    expect(body).toMatch(/method: 'GET'/);
    expect(body).toMatch(/_s\.conversationId = c\.conversation_id/);
  });

  it('exposes reset on the public API', () => {
    expect(source).toMatch(/reset: _reset/);
  });
});
