/**
 * Originally A0.3 — structural characterization for `initializeOrbWebSocket`
 * in `routes/orb-live.ts`. Replaced 2026-05-13 (A9.1 / VTID-02957) when the
 * WSS attach + connection/error dispatch was lifted into
 * `orb/live/transport/websocket-handler.ts`.
 *
 * Now: structural check that orb-live.ts is a thin delegator over the new
 * transport module + the per-session registry remains a Map (the cleanup
 * interval depends on Map iteration semantics).
 *
 * Runtime assertions on the transport behavior live in
 * `test/orb/live/transport/websocket-handler.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let setupBody: string;
let source: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

  const setupStart = source.indexOf('export function initializeOrbWebSocket');
  expect(setupStart).toBeGreaterThan(0);
  const afterStart = source.slice(setupStart + 1);
  const nextExport = afterStart.search(/\nexport\s+(function|const|class)\s/);
  setupBody = nextExport >= 0
    ? source.slice(setupStart, setupStart + 1 + nextExport)
    : source.slice(setupStart);
});

describe('A9.1 characterization: initializeOrbWebSocket delegates to the transport module', () => {
  it('is exported (so the gateway entrypoint can wire it)', () => {
    expect(setupBody).toMatch(/^export\s+function\s+initializeOrbWebSocket/);
  });

  it('accepts an HttpServer parameter (Express HTTP server instance)', () => {
    expect(setupBody).toMatch(/initializeOrbWebSocket\s*\(\s*server\s*:\s*HttpServer\s*\)/);
  });

  it('delegates WSS setup to mountOrbWebSocketTransport', () => {
    // The body must call mountOrbWebSocketTransport — that is the seam.
    expect(setupBody).toMatch(/mountOrbWebSocketTransport\s*\(\s*server\s*,/);
  });

  it('passes a handleConnection wrapper that forwards to handleWebSocketConnection', () => {
    expect(setupBody).toMatch(
      /handleConnection\s*:\s*\([^)]*\)\s*=>\s*handleWebSocketConnection\s*\(/,
    );
  });

  it('passes an onServerError hook for server-level WebSocket errors', () => {
    expect(setupBody).toMatch(/onServerError\s*:/);
  });

  it('does NOT inline `new WebSocketServer(`, `wss.on(`, or a literal mount path', () => {
    // Anti-regression: the legacy inline impl is what A9.1 lifted out.
    // If a future refactor re-inlines it here, this test fails loudly.
    expect(setupBody).not.toMatch(/new\s+WebSocketServer\s*\(/);
    expect(setupBody).not.toMatch(/wss\.on\(/);
    expect(setupBody).not.toMatch(/['"`]\/api\/v1\/orb\/live\/ws['"`]/);
  });
});

describe('A8.1 update: per-session registry now lives in orb/live/session/live-session-registry.ts', () => {
  it('orb-live.ts imports wsClientSessions from the registry module (not a local declaration)', () => {
    expect(source).toMatch(
      /from\s*['"`][^'"`]*\/orb\/live\/session\/live-session-registry['"`]/,
    );
    expect(source).toMatch(/\bwsClientSessions\b/);
  });

  it('orb-live.ts no longer declares wsClientSessions = new Map(...) locally', () => {
    expect(source).not.toMatch(
      /^\s*(const|let|var)\s+wsClientSessions\s*=\s*new\s+Map\s*</m,
    );
  });
});

describe('A9.1 characterization: import wiring', () => {
  it('imports mountOrbWebSocketTransport from the transport module', () => {
    const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
    expect(source).toMatch(
      /import\s*\{\s*mountOrbWebSocketTransport\s*\}\s*from\s*['"`][^'"`]*\/orb\/live\/transport\/websocket-handler['"`]/,
    );
  });
});
