/**
 * A0.3 — Characterization test for transport lifecycle cleanup.
 *
 * Purpose: lock the cleanup contract for both transports — every stream
 * that holds resources must release them when the client disconnects.
 * Without these handlers, an orb session that drops mid-call leaks the
 * upstream Live API socket + the audio context.
 *
 * Scope: assertions are made against the SSE-handler block AND the
 * WebSocket cleanup function in isolation, so unrelated handlers can't
 * accidentally satisfy them.
 *
 * Will be replaced/augmented by A9 with a runtime test against the
 * extracted transport modules + a lifecycle integration test.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let sseHandlerBody: string;
let wsCleanupSection: string;

beforeAll(() => {
  const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

  // Slice the SSE handler block.
  const sseStart = source.indexOf("router.get('/live/stream'");
  const sseStop = source.indexOf("router.post('/live/stream/send'");
  expect(sseStart).toBeGreaterThan(0);
  expect(sseStop).toBeGreaterThan(sseStart);
  sseHandlerBody = source.slice(sseStart, sseStop);

  // Slice a wider section starting at the WebSocket setup function
  // through the file end. The cleanup logic lives in helpers below
  // initializeOrbWebSocket (cleanupWsSession, the connection close handler,
  // and the periodic timeout sweep).
  const wsStart = source.indexOf('export function initializeOrbWebSocket');
  expect(wsStart).toBeGreaterThan(0);
  wsCleanupSection = source.slice(wsStart);
});

describe('A0.3 characterization: transport lifecycle cleanup', () => {
  describe('SSE: client-disconnect cleanup', () => {
    it("registers a req.on('close', ...) handler", () => {
      // EventSource on the browser side fires onclose (or just stops
      // pinging) when the user closes the tab. Without req.on('close')
      // the server-side res object stays open forever.
      expect(sseHandlerBody).toMatch(/req\.on\(\s*['"`]close['"`]\s*,/);
    });
  });

  describe('WebSocket: connection lifecycle', () => {
    it('removes sessions from wsClientSessions on cleanup', () => {
      // Leak guard: if cleanup doesn't .delete from the map, the periodic
      // sweep iterates over zombies indefinitely and memory grows.
      expect(wsCleanupSection).toMatch(/wsClientSessions\.delete\s*\(/);
    });

    it('clears intervals on cleanup (upstream ping + silence keepalive)', () => {
      // Two intervals run per session (upstream Vertex Live ping +
      // silence keepalive). Both must be cleared on disconnect.
      expect(wsCleanupSection).toMatch(/clearInterval\s*\(/);
    });

    it('attempts to close the upstream websocket on cleanup', () => {
      // The upstream Vertex Live socket is the real resource. Forgetting
      // to close it leaks both bandwidth and Vertex billing time.
      expect(wsCleanupSection).toMatch(/upstreamWs[\s\S]{0,80}?\.close\s*\(/);
    });

    it('attempts to close the client websocket on cleanup (if still OPEN)', () => {
      // Symmetric to the upstream close — the client side must be told
      // explicitly so its onclose handler fires with the expected code.
      expect(wsCleanupSection).toMatch(/clientWs\.close\s*\(/);
    });

    it('runs a periodic timeout sweep over wsClientSessions', () => {
      // The sweep is what catches sessions whose close events never
      // arrived (network drop, mobile background, etc.). It must
      // remain — without it, ghost sessions accumulate.
      expect(wsCleanupSection).toMatch(/setInterval\s*\(/);
      expect(wsCleanupSection).toMatch(/wsClientSessions\.entries\s*\(\s*\)/);
    });

    it('uses a session timeout constant (not an inline magic number)', () => {
      // SESSION_TIMEOUT_MS is the canonical name. A refactor that inlines
      // a literal here would lose the single source of truth.
      expect(wsCleanupSection).toMatch(/SESSION_TIMEOUT_MS/);
    });
  });

  describe('cleanup symmetry across transports', () => {
    it('both SSE and WS cleanup paths exist (parity)', () => {
      // The two transports must each have their own cleanup story.
      // Catching this mismatch early — if one path silently goes away
      // during refactor — is the whole point of this test.
      expect(sseHandlerBody).toMatch(/req\.on\(\s*['"`]close['"`]/);
      expect(wsCleanupSection).toMatch(/wsClientSessions\.delete/);
    });
  });
});
