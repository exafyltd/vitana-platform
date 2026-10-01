/**
 * VTID-04512 — the per-IP WebSocket slot leaked when a socket closed while
 * the gateway was still verifying its token.
 *
 * `handleWebSocketConnection` incremented the per-IP counter, awaited token
 * verification and the tenant lookup, and only then attached its `close`
 * handler. A socket that closed during those awaits (the widget's 8 s start
 * timeout, the user closing the ORB, a dropped prewarm socket) never gave its
 * slot back. After MAX_CONNECTIONS_PER_IP (5) leaks, every WebSocket from
 * that IP was refused with 4029 and the ORB sat on "connecting" before the
 * tab latched onto the SSE fallback (staging, 2026-09-24 16:02–16:04).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
const start = src.indexOf('async function handleWebSocketConnection(');
const end = src.indexOf('\n}\n', start);
const body = src.slice(start, end);

describe('VTID-04512 — WS connection slot is released however the socket ends', () => {
  it('AC-1: the release handlers are attached before the first await', () => {
    const inc = body.indexOf('incrementConnection(clientIP);');
    const onceClose = body.indexOf("ws.once('close', releaseConnection);");
    const onceError = body.indexOf("ws.once('error', releaseConnection);");
    const firstAwait = body.indexOf('await ');
    expect(inc).toBeGreaterThan(-1);
    expect(onceClose).toBeGreaterThan(inc);
    expect(onceError).toBeGreaterThan(inc);
    expect(firstAwait).toBeGreaterThan(onceClose);
    expect(firstAwait).toBeGreaterThan(onceError);
  });

  it('AC-2: the release is idempotent (close and error both fire it)', () => {
    expect(body).toMatch(/if \(connectionReleased\) return;\s*connectionReleased = true;\s*decrementConnection\(clientIP\);/);
  });

  it('AC-3: no handler in the connection decrements the counter directly any more', () => {
    expect(body.match(/decrementConnection\(clientIP\)/g)).toHaveLength(1);
  });
});
