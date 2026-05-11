/**
 * A0.3 — Characterization test for the WebSocket transport setup.
 *
 * Purpose: lock the WebSocket initialization contract — registry, upgrade
 * path, connection + error handler registration — before step A9 splits
 * transport into orb/live/transport/websocket-handler.ts.
 *
 * Approach: structural over orb-live.ts, scoped to the
 * `initializeOrbWebSocket` function block only.
 *
 * Will be replaced/augmented by A9 with a runtime test against
 * orb/live/transport/websocket-handler.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let setupBody: string;
let registryDecl: string;

beforeAll(() => {
  const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

  // Slice the WebSocket setup function. It is the only `export function`
  // whose name begins with `initializeOrb`, so the next `export function`
  // (or end-of-file) is a safe terminator.
  const setupStart = source.indexOf('export function initializeOrbWebSocket');
  expect(setupStart).toBeGreaterThan(0);
  const afterStart = source.slice(setupStart + 1);
  const nextExport = afterStart.search(/\nexport\s+(function|const|class)\s/);
  setupBody = nextExport >= 0
    ? source.slice(setupStart, setupStart + 1 + nextExport)
    : source.slice(setupStart);

  // Find the registry declaration. It is module-level, not inside the
  // setup function, so we capture it separately.
  const registryStart = source.indexOf('wsClientSessions = new Map');
  expect(registryStart).toBeGreaterThan(0);
  // Take ~500 chars around the declaration as context.
  registryDecl = source.slice(Math.max(0, registryStart - 100), registryStart + 200);
});

describe('A0.3 characterization: WebSocket transport setup contract', () => {
  describe('initializeOrbWebSocket() function', () => {
    it('is exported (so the gateway entrypoint can wire it)', () => {
      // Already implied by the slice succeeding, but assert explicitly so
      // a refactor that drops the export breaks loudly.
      expect(setupBody).toMatch(/^export\s+function\s+initializeOrbWebSocket/);
    });

    it('accepts an HttpServer parameter (Express HTTP server instance)', () => {
      expect(setupBody).toMatch(/initializeOrbWebSocket\s*\(\s*server\s*:\s*HttpServer\s*\)/);
    });

    it('mounts the WebSocket server at /api/v1/orb/live/ws', () => {
      // The orb-widget reconnects to this exact path. Any change to the
      // path breaks every existing client.
      expect(setupBody).toMatch(
        /path\s*:\s*['"`]\/api\/v1\/orb\/live\/ws['"`]/
      );
    });

    it('attaches the WebSocketServer to the HTTP server (single-port, not separate)', () => {
      // `server: <param>` in the WebSocketServer options means it shares
      // the HTTP listener — no separate port, no separate listen() call.
      // A1+ refactor must preserve the same attachment model.
      expect(setupBody).toMatch(/new\s+WebSocketServer\s*\(\s*\{[\s\S]*?\bserver\b[\s\S]*?\}\s*\)/);
    });

    it("registers a 'connection' handler", () => {
      expect(setupBody).toMatch(/wss\.on\(\s*['"`]connection['"`]\s*,/);
    });

    it("registers an 'error' handler (server-level error, separate from per-connection errors)", () => {
      expect(setupBody).toMatch(/wss\.on\(\s*['"`]error['"`]\s*,/);
    });
  });

  describe('per-session registry', () => {
    it('declares wsClientSessions as a Map', () => {
      // The Map type matters — the cleanup interval iterates over it.
      // A switch to a different container (Set, plain object, WeakMap)
      // would silently break iteration semantics.
      expect(registryDecl).toMatch(/wsClientSessions\s*=\s*new\s+Map\s*</);
    });
  });

  describe('connection handler delegates to handleWebSocketConnection', () => {
    // The setup function should NOT inline the per-connection logic —
    // that lives in handleWebSocketConnection, which A9 will move.
    // Lock the delegation so an inline rewrite doesn't sneak in here.
    it('forwards the (ws, req) tuple to handleWebSocketConnection', () => {
      expect(setupBody).toMatch(/handleWebSocketConnection\s*\(\s*ws\s*,\s*req\s*\)/);
    });
  });
});
