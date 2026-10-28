/**
 * A8.1 (orb-live-refactor / VTID-02959): tests for the session controller
 * shell — `orb/live/session/live-session-registry.ts`.
 *
 * A8.1 is intentionally minimal: lift the 3 Map declarations into the new
 * module, leave every other ownership concern (start/stop/cleanup/dispatch)
 * in `routes/orb-live.ts` for A8.2 + A8.3. These tests lock the contract:
 *
 *   1. The registry exports the 3 Maps with the legacy names.
 *   2. Each Map is a real `Map` (the cleanup interval + ownership iteration
 *      in orb-live.ts depend on `Map.entries()` / `Map.delete()`).
 *   3. The Maps are SINGLETONS — orb-live.ts and any future consumer
 *      (A8.2 controller methods) MUST observe the same identity.
 *   4. orb-live.ts no longer declares the Maps locally (anti-regression on
 *      a future `const liveSessions = new Map(...)` slipping back in).
 *   5. orb-live.ts imports the Maps from the registry module.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  sessions,
  liveSessions,
  wsClientSessions,
} from '../../../../src/orb/live/session/live-session-registry';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

describe('A8.1: live-session-registry exports', () => {
  it('exports `sessions` as a Map', () => {
    expect(sessions).toBeInstanceOf(Map);
  });

  it('exports `liveSessions` as a Map', () => {
    expect(liveSessions).toBeInstanceOf(Map);
  });

  it('exports `wsClientSessions` as a Map', () => {
    expect(wsClientSessions).toBeInstanceOf(Map);
  });

  it('Maps are singletons — re-importing returns the same instance', async () => {
    const reimport = await import(
      '../../../../src/orb/live/session/live-session-registry'
    );
    expect(reimport.sessions).toBe(sessions);
    expect(reimport.liveSessions).toBe(liveSessions);
    expect(reimport.wsClientSessions).toBe(wsClientSessions);
  });

  it('Maps support the operations orb-live.ts performs (get / set / delete / entries)', () => {
    // We don't put real session shapes here — just verify the Map API
    // surface the legacy code depends on.
    const probe = { sessionId: 'a8.1-probe' } as any;
    sessions.set('a8.1-probe', probe);
    expect(sessions.get('a8.1-probe')).toBe(probe);
    expect(Array.from(sessions.entries())).toContainEqual(['a8.1-probe', probe]);
    sessions.delete('a8.1-probe');
    expect(sessions.has('a8.1-probe')).toBe(false);
  });
});

describe('A8.1 anti-regression: orb-live.ts is a consumer, not a declarer', () => {
  let source: string;
  beforeAll(() => {
    source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  });

  it('imports the Maps from the session registry', () => {
    expect(source).toMatch(
      /from\s*['"`][^'"`]*\/orb\/live\/session\/live-session-registry['"`]/,
    );
    expect(source).toMatch(/\bsessions\b/);
    expect(source).toMatch(/\bliveSessions\b/);
    expect(source).toMatch(/\bwsClientSessions\b/);
  });

  it('does NOT declare `sessions = new Map<` locally', () => {
    expect(source).not.toMatch(/^\s*(const|let|var)\s+sessions\s*=\s*new\s+Map\s*</m);
  });

  it('does NOT declare `liveSessions = new Map<` locally', () => {
    expect(source).not.toMatch(/^\s*(const|let|var)\s+liveSessions\s*=\s*new\s+Map\s*</m);
  });

  it('does NOT declare `wsClientSessions = new Map<` locally', () => {
    expect(source).not.toMatch(/^\s*(const|let|var)\s+wsClientSessions\s*=\s*new\s+Map\s*</m);
  });

  it('exports the OrbLiveSession / GeminiLiveSession / WsClientSession interfaces (so the registry can type-import them)', () => {
    expect(source).toMatch(/export\s+interface\s+OrbLiveSession\b/);
    expect(source).toMatch(/export\s+interface\s+GeminiLiveSession\b/);
    expect(source).toMatch(/export\s+interface\s+WsClientSession\b/);
  });
});
