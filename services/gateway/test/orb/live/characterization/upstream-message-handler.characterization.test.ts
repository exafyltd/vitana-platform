/**
 * A8.3a.1 (VTID-02965): structural characterization for the upstream Live
 * message-handler closure.
 *
 * Purpose: lock the seam created when the anonymous `ws.on('message', ...)`
 * arrow inside `connectToLiveAPI` was named `handleUpstreamLiveMessage`.
 * This is the entry point that A8.3a.2 moves to
 * `orb/live/session/upstream-message-handler.ts` and A8.3b swaps from
 * `connectToLiveAPI`'s callback pattern to `VertexLiveClient`'s typed-event
 * pattern.
 *
 * Why structural rather than runtime: the function closes over
 * `setupComplete`, `connectionTimeout`, `resolve` / `reject`, and the
 * `onAudioResponse` / `onTextResponse` / `onError` / `onTurnComplete` /
 * `onInterrupted` callbacks defined inside `connectToLiveAPI`. Runtime
 * tests against the function require also reproducing that closure, which
 * is exactly the surface A8.3a.2 + A8.3b refactor. Until then, the
 * structural lock is the right boundary.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let source: string;
let functionBody: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

  // Slice the named function body. The function declaration sits inside
  // the `new Promise((resolve, reject) => { ... })` body of
  // `connectToLiveAPI`, terminated by the `ws.on('message', ...)`
  // registration line.
  const fnStart = source.indexOf('function handleUpstreamLiveMessage');
  expect(fnStart).toBeGreaterThan(0);

  // The function is followed by `ws.on('message', handleUpstreamLiveMessage)`
  // — slice up to that registration.
  const registration = source.indexOf("ws.on('message', handleUpstreamLiveMessage)", fnStart);
  expect(registration).toBeGreaterThan(fnStart);

  functionBody = source.slice(fnStart, registration);
});

describe('A8.3a.1: handleUpstreamLiveMessage named function', () => {
  it('is declared as a named function (not an anonymous arrow)', () => {
    expect(functionBody).toMatch(
      /function\s+handleUpstreamLiveMessage\s*\(\s*data\s*:\s*WebSocket\.Data\s*\)/,
    );
  });

  it('is registered via ws.on("message", handleUpstreamLiveMessage)', () => {
    expect(source).toMatch(
      /ws\.on\(\s*['"`]message['"`]\s*,\s*handleUpstreamLiveMessage\s*\)/,
    );
  });

  it('does NOT register an anonymous arrow as the message handler', () => {
    // Anti-regression: a future drift back to inline anon arrow would
    // erase the seam A8.3a.2 / A8.3b consume.
    expect(source).not.toMatch(
      /ws\.on\(\s*['"`]message['"`]\s*,\s*\(\s*data\s*:\s*WebSocket\.Data\s*\)\s*=>/,
    );
  });

  it('still handles every event the closure dispatched (setup_complete, server_content, tool_call, interruption, turn_complete, transcripts)', () => {
    // These are the upstream-event paths the function MUST keep dispatching.
    expect(functionBody).toMatch(/setup_complete\b/);
    expect(functionBody).toMatch(/server_content\b/);
    expect(functionBody).toMatch(/tool_call\b/);
    expect(functionBody).toMatch(/interrupted\b/);
    expect(functionBody).toMatch(/turn_complete\b/);
    expect(functionBody).toMatch(/input_transcription\b/);
    expect(functionBody).toMatch(/output_transcription\b/);
  });

  it('still invokes the connectToLiveAPI callbacks (closure preservation)', () => {
    // The function closes over onAudioResponse / onTextResponse / onError /
    // onTurnComplete / onInterrupted. Removing any of these calls would
    // break the legacy connectToLiveAPI consumer.
    expect(functionBody).toMatch(/\bonAudioResponse\s*\(/);
    expect(functionBody).toMatch(/\bonInterrupted\s*\?\.\s*\(/);
    expect(functionBody).toMatch(/\bonTurnComplete\s*\?\.\s*\(/);
    // setup_complete path mutates the outer `setupComplete` let-binding.
    expect(functionBody).toMatch(/\bsetupComplete\s*=\s*true/);
  });

  it('uses writeSseEvent for SSE output (A9.2 wire helper), not inline res.write', () => {
    // Anti-regression: a future drift back to inline
    // `session.sseResponse.write(\`data: ${JSON.stringify(...)}\n\n\`)`
    // would re-fragment the wire-format ownership we just consolidated.
    expect(functionBody).not.toMatch(/session\.sseResponse\.write\s*\(/);
    expect(functionBody).toMatch(/writeSseEvent\s*\(\s*session\.sseResponse\s*,/);
  });

  it('orb-live.ts imports writeSseEvent from the A9.2 transport helper', () => {
    expect(source).toMatch(
      /from\s*['"`][^'"`]*\/orb\/live\/transport\/sse-handler['"`]/,
    );
    expect(source).toMatch(/\bwriteSseEvent\b/);
  });
});
