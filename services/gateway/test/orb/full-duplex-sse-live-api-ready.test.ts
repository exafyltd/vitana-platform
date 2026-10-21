/**
 * VTID-03706 follow-up — the SSE `live_api_ready` handshake must carry
 * `full_duplex`, the same way the WS `session_started` handshake does.
 *
 * Reported live: on staging, with ORB_FULL_DUPLEX_ENABLED=true and the
 * widget on its default SSE transport, the mic never stayed open during
 * playback and the .vtorb-mic-live class never appeared. Traced to this
 * exact gap — `session.sseResponse.write(...)` for `live_api_ready` never
 * included the field the client reads it from, so `_s.fullDuplex` stayed
 * at its false default for every SSE session regardless of the server
 * flag. The server-side gate in live-session-controller.ts was already
 * applying full duplex correctly to inbound frames; the client just never
 * knew to keep sending them during playback.
 *
 * `orb-live.ts` is a large stateful route module unsuited to unit-testing
 * the whole live-session flow, so this pins the SSE payload construction
 * by source, matching this repo's established characterization-test
 * pattern for that file (see nova-premature-close-retry.test.ts and
 * siblings).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORB_LIVE_PATH = join(__dirname, '../../src/routes/orb-live.ts');
const source = readFileSync(ORB_LIVE_PATH, 'utf8');

describe('VTID-03706 follow-up: SSE live_api_ready carries full_duplex', () => {
  it('includes full_duplex: isFullDuplexEnabled() in the live_api_ready SSE payload', () => {
    const idx = source.indexOf("type: 'live_api_ready'");
    expect(idx).toBeGreaterThan(-1);

    // The payload object closes at the first `})}\n\n` after the type field —
    // scope the check to that object literal, not the whole file, so this
    // can't accidentally pass because `isFullDuplexEnabled()` is merely
    // called somewhere else in this 16k+ line file.
    const closeIdx = source.indexOf('})}', idx);
    expect(closeIdx).toBeGreaterThan(idx);
    const payload = source.slice(idx, closeIdx);

    expect(payload).toContain('full_duplex: isFullDuplexEnabled()');
  });
});
