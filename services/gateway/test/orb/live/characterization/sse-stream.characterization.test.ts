/**
 * A0.3 — Characterization test for the /live/stream SSE transport contract.
 *
 * Purpose: lock the SSE wire format the orb client depends on, before
 * step A9 splits transport into orb/live/transport/sse-handler.ts.
 *
 * Approach: structural over orb-live.ts source. The handler is too coupled
 * with Express + Vertex Live API + audio streaming to runtime-mock cleanly
 * in a tests-only PR. Per the plan's strict rule, A0 freezes the unchanged
 * file; runtime transport tests come in A9.
 *
 * Scope: assertions are made against the SSE-handler block only (sliced
 * from `router.get('/live/stream'` to the next route registration), not
 * file-wide grep, so unrelated SSE writes elsewhere in orb-live.ts can't
 * accidentally satisfy them.
 *
 * Will be replaced/augmented by A9 with a runtime test against
 * orb/live/transport/sse-handler.ts.
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

describe('A0.3 characterization: /live/stream SSE transport contract', () => {
  describe('response headers (SSE handshake)', () => {
    // The orb-widget polls the stream and expects an EventSource-shaped
    // connection. These three headers are the contract.
    it('sets Content-Type: text/event-stream', () => {
      expect(handlerBody).toMatch(
        /res\.setHeader\(\s*['"`]Content-Type['"`]\s*,\s*['"`]text\/event-stream['"`]\s*\)/
      );
    });

    it('sets Cache-Control: no-cache', () => {
      expect(handlerBody).toMatch(
        /res\.setHeader\(\s*['"`]Cache-Control['"`]\s*,\s*['"`]no-cache['"`]\s*\)/
      );
    });

    it('sets Connection: keep-alive', () => {
      expect(handlerBody).toMatch(
        /res\.setHeader\(\s*['"`]Connection['"`]\s*,\s*['"`]keep-alive['"`]\s*\)/
      );
    });
  });

  describe('SSE wire framing', () => {
    // Every event the SSE handler emits must use `data: ${json}\n\n` —
    // EventSource only parses that exact format. Any drift breaks the
    // browser's parsing.
    //
    // Approach: locate every `res.write(` call site in the handler. Look
    // at the chars immediately after the opening paren — they must begin
    // with a string/template literal whose first content is `data: `. We
    // do NOT try to capture the full multi-line template body (some are
    // 10+ lines with nested ${...} expressions); we only assert the
    // prefix anchor, which is the SSE-framing contract.
    it('every res.write in this handler starts with the "data: " SSE prefix', () => {
      const writeRe = /res\.write\s*\(\s*/g;
      const startPositions: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(handlerBody)) !== null) {
        startPositions.push(m.index + m[0].length);
      }
      expect(startPositions.length).toBeGreaterThan(0);

      for (const pos of startPositions) {
        const window = handlerBody.slice(pos, pos + 40);
        if (!/^[`'"]\s*data:\s/.test(window)) {
          throw new Error(
            `Non-SSE res.write inside /live/stream handler — every event must start with 'data: ' (SSE wire prefix).\nWindow: ${JSON.stringify(window)}`
          );
        }
      }
    });

    it('every SSE event payload terminates with \\n\\n (or its escaped form)', () => {
      // EventSource requires the double-newline terminator to dispatch the
      // event. Coarse contract: at least one terminator per res.write
      // call in the handler. Parsing each multi-line template's tail
      // exactly is fragile across formatter changes; this is the cheaper
      // anchor that still flags a missing terminator.
      const writeCount = (handlerBody.match(/res\.write\s*\(/g) ?? []).length;
      expect(writeCount).toBeGreaterThan(0);

      const literalTerminators = (handlerBody.match(/\n\n/g) ?? []).length;
      const escapedTerminators = (handlerBody.match(/\\n\\n/g) ?? []).length;
      expect(literalTerminators + escapedTerminators).toBeGreaterThanOrEqual(writeCount);
    });
  });

  describe('initial "ready" event payload', () => {
    // VTID-INSTANT-FEEDBACK: the client transitions UI and plays the
    // activation chime as soon as it receives this event. The four meta
    // fields below are read by the widget; dropping any of them breaks
    // chime timing or audio init.
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

  describe('heartbeat event', () => {
    // The client uses heartbeat events to detect connection death. Without
    // them, an idle session looks alive even when the upstream Live API
    // socket has dropped. The framing must match the wire-framing rule
    // above so EventSource fires its message handler.
    it('emits a heartbeat event with a timestamp', () => {
      expect(handlerBody).toMatch(/type\s*:\s*['"`]heartbeat['"`]/);
      // Timestamp surface — currently `ts: Date.now()`, but lock only the
      // field name so a future ISO-string switch wouldn't false-fail.
      expect(handlerBody).toMatch(/\bts\s*:/);
    });
  });

  describe('session id parameter', () => {
    it('reads session_id from query string', () => {
      expect(handlerBody).toMatch(/req\.query\.session_id/);
    });

    it('rejects request with 400 when session_id is missing', () => {
      // The handler returns res.status(400) when sessionId is falsy.
      // Lock the response shape — the orb-widget treats a 4xx differently
      // from a transport disconnect, and "session_id required" is the
      // contract.
      expect(handlerBody).toMatch(/status\(\s*400\s*\)/);
      expect(handlerBody).toMatch(/session_id\s+required/);
    });
  });
});
