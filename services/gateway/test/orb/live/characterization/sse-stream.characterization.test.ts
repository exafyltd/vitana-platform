/**
 * Originally A0.3 — structural characterization for the `/live/stream` SSE
 * handler in `routes/orb-live.ts`. Replaced 2026-05-13 (A9.2 / VTID-02958)
 * when the SSE upgrade headers, event encoding, and heartbeat were lifted
 * into `orb/live/transport/sse-handler.ts`.
 *
 * Now: structural check that orb-live.ts is a thin delegator over the new
 * SSE transport helpers + the wire-format invariants the orb-widget
 * depends on (event names + payload fields) still live in the handler.
 *
 * Runtime assertions on the transport behavior live in
 * `test/orb/live/transport/sse-handler.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let handlerBody: string;

beforeAll(() => {
  const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  // Slice the SSE handler block. The next route registration is the
  // natural terminator — `router.post('/live/stream/send'`.
  const startIdx = source.indexOf("router.get('/live/stream'");
  const stopIdx = source.indexOf("router.post('/live/stream/send'");
  expect(startIdx).toBeGreaterThan(0);
  expect(stopIdx).toBeGreaterThan(startIdx);
  handlerBody = source.slice(startIdx, stopIdx);
});

describe('A9.2 characterization: /live/stream delegates SSE setup to the transport module', () => {
  it('calls attachSseHeaders(res) for the SSE upgrade', () => {
    // A9.2: 4-header upgrade + flushHeaders lifted to sse-handler.ts.
    expect(handlerBody).toMatch(/\battachSseHeaders\s*\(\s*res\s*\)/);
  });

  it('does NOT inline raw res.setHeader calls for the SSE headers', () => {
    // Anti-regression: the legacy inline pattern is what A9.2 lifted out.
    expect(handlerBody).not.toMatch(
      /res\.setHeader\(\s*['"`]Content-Type['"`]\s*,\s*['"`]text\/event-stream['"`]\s*\)/,
    );
    expect(handlerBody).not.toMatch(
      /res\.setHeader\(\s*['"`]Cache-Control['"`]\s*,\s*['"`]no-cache['"`]\s*\)/,
    );
    expect(handlerBody).not.toMatch(
      /res\.setHeader\(\s*['"`]Connection['"`]\s*,\s*['"`]keep-alive['"`]\s*\)/,
    );
    // X-Accel-Buffering was the 4th legacy inline header.
    expect(handlerBody).not.toMatch(
      /res\.setHeader\(\s*['"`]X-Accel-Buffering['"`]\s*,/,
    );
  });

  it('starts the heartbeat through startSseHeartbeat (NOT setInterval)', () => {
    expect(handlerBody).toMatch(/\bstartSseHeartbeat\s*\(\s*res\s*\)/);
    // Anti-regression: no inline setInterval inside this handler.
    expect(handlerBody).not.toMatch(/setInterval\s*\(/);
  });

  it('writes the ready event through writeSseEvent (NOT raw res.write)', () => {
    expect(handlerBody).toMatch(/\bwriteSseEvent\s*\(\s*res\s*,/);
  });
});

describe('A9.2 characterization: ready event payload contract (unchanged)', () => {
  // The orb-widget reads these exact field names from the first SSE event.
  // The fields are now passed as an object literal into writeSseEvent —
  // the field names themselves remain the contract.
  it('emits an event with type: "ready"', () => {
    expect(handlerBody).toMatch(/type\s*:\s*['"`]ready['"`]/);
  });

  it('includes session_id in the ready payload', () => {
    expect(handlerBody).toMatch(/session_id\s*:/);
  });

  it('includes live_api_connected boolean in the ready payload', () => {
    expect(handlerBody).toMatch(/live_api_connected\s*:/);
  });

  it('includes meta.model in the ready payload', () => {
    expect(handlerBody).toMatch(/\bmodel\s*:/);
  });

  it('includes meta.lang in the ready payload', () => {
    expect(handlerBody).toMatch(/\blang\s*:/);
  });

  it('includes meta.voice in the ready payload', () => {
    expect(handlerBody).toMatch(/\bvoice\s*:/);
  });

  it('declares audio_out_rate (server → client TTS sample rate)', () => {
    expect(handlerBody).toMatch(/audio_out_rate\s*:\s*\d+/);
  });

  it('declares audio_in_rate (client → server mic sample rate)', () => {
    expect(handlerBody).toMatch(/audio_in_rate\s*:\s*\d+/);
  });
});

describe('A9.2 characterization: session id parameter (unchanged)', () => {
  it('reads session_id from query string', () => {
    expect(handlerBody).toMatch(/req\.query\.session_id/);
  });

  it('rejects request with 400 when session_id is missing', () => {
    expect(handlerBody).toMatch(/status\(\s*400\s*\)/);
    expect(handlerBody).toMatch(/session_id\s+required/);
  });
});

describe('A9.2 characterization: import wiring', () => {
  it('imports the SSE helpers from the transport module', () => {
    const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
    expect(source).toMatch(
      /from\s*['"`][^'"`]*\/orb\/live\/transport\/sse-handler['"`]/,
    );
    expect(source).toMatch(/\battachSseHeaders\b/);
    expect(source).toMatch(/\bwriteSseEvent\b/);
    expect(source).toMatch(/\bstartSseHeartbeat\b/);
  });
});
