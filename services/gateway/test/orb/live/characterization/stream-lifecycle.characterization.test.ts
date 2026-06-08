/**
 * Originally A0.3 — characterization for transport lifecycle cleanup.
 * Updated 2026-05-13 (A8.2 / VTID-02961): `cleanupWsSession` body was
 * lifted from `routes/orb-live.ts` into
 * `orb/live/session/live-session-controller.ts`. Cleanup parity
 * assertions now read from BOTH files:
 *   - SSE-handler block in orb-live.ts (req.on('close')) — unchanged.
 *   - WebSocket setup + cleanup-interval-call-site in orb-live.ts.
 *   - `cleanupWsSession` body in the controller module.
 *
 * Runtime-level cleanup behavior is also covered by
 * `test/orb/live/session/live-session-controller.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');
const CONTROLLER_PATH = path.resolve(
  __dirname,
  '../../../../src/orb/live/session/live-session-controller.ts',
);

let sseHandlerBody: string;
let wsCleanupSection: string;
let controllerSrc: string;

beforeAll(() => {
  const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  controllerSrc = fs.readFileSync(CONTROLLER_PATH, 'utf8');

  // Slice the SSE handler block.
  const sseStart = source.indexOf("router.get('/live/stream'");
  const sseStop = source.indexOf("router.post('/live/stream/send'");
  expect(sseStart).toBeGreaterThan(0);
  expect(sseStop).toBeGreaterThan(sseStart);
  sseHandlerBody = source.slice(sseStart, sseStop);

  // Wide section from the WebSocket setup to end-of-file. A8.2 moved the
  // cleanup body to the controller; the call sites + interval scheduling
  // remain in this slice.
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

  describe('WebSocket: connection lifecycle (cleanup body lives in controller)', () => {
    it('controller removes sessions from wsClientSessions on cleanup', () => {
      // A8.2: assertion follows the body into the controller module.
      // Leak guard: if cleanup doesn't .delete from the map, the periodic
      // sweep iterates over zombies indefinitely and memory grows.
      expect(controllerSrc).toMatch(/wsClientSessions\.delete\s*\(/);
    });

    it('controller clears intervals on cleanup (upstream ping + silence keepalive)', () => {
      expect(controllerSrc).toMatch(/clearInterval\s*\(/);
    });

    it('controller attempts to close the upstream websocket on cleanup', () => {
      expect(controllerSrc).toMatch(/upstreamWs[\s\S]{0,80}?\.close\s*\(/);
    });

    it('controller attempts to close the client websocket on cleanup (if still OPEN)', () => {
      expect(controllerSrc).toMatch(/clientWs\.close\s*\(/);
    });

    it('orb-live.ts runs a periodic timeout sweep over the WS session map (interval-only; body in controller)', () => {
      // A8.2 left the setInterval schedule in orb-live.ts (in
      // initializeOrbWebSocket) and lifted the per-session iteration
      // helper to the controller. The setInterval must remain — without
      // it, ghost sessions accumulate.
      expect(wsCleanupSection).toMatch(/setInterval\s*\(/);
      expect(wsCleanupSection).toMatch(/wsClientSessions\.entries\s*\(\s*\)/);
    });

    it('uses a session timeout constant (not an inline magic number)', () => {
      expect(wsCleanupSection).toMatch(/SESSION_TIMEOUT_MS/);
    });
  });

  describe('cleanup symmetry across transports', () => {
    it('both SSE and WS cleanup paths exist (parity; WS body now in controller)', () => {
      // The two transports must each have their own cleanup story.
      // SSE close handler stays inline; WS cleanup body moved to the
      // controller in A8.2.
      expect(sseHandlerBody).toMatch(/req\.on\(\s*['"`]close['"`]/);
      expect(controllerSrc).toMatch(/wsClientSessions\.delete/);
    });
  });
});
