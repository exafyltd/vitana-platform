/**
 * VTID-04865: an upstream that finishes connecting after the member left is
 * closed, never attached. Production 2026-10-03: a Russian bridge session
 * held a Vertex Live connection for 60 minutes after its SSE stream closed
 * mid-connect.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  closeIfSessionGone,
  isSessionGone,
} from '../../../../src/orb/live/session/orphan-upstream-guard';

type S = { active?: boolean };

function upstream() {
  return { close: jest.fn() };
}

describe('VTID-04865 orphan upstream guard', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('keeps the upstream when the session is still the live one', () => {
    const s: S = { active: true };
    const reg = new Map<string, S>([['live-1', s]]);
    const ws = upstream();
    expect(closeIfSessionGone(ws, s, 'live-1', reg, 't')).toBe(false);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes the upstream when the SSE close handler already cleaned up (the production case)', () => {
    const s: S = { active: false };
    const reg = new Map<string, S>(); // liveSessions.delete(sessionId) already ran
    const ws = upstream();
    expect(closeIfSessionGone(ws, s, 'live-1', reg, 'sse_connect')).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(1000, 'client_disconnect');
  });

  it('treats a deactivated session as gone even while still registered', () => {
    const s: S = { active: false };
    expect(isSessionGone(s, 'live-1', new Map([['live-1', s]]))).toBe(true);
  });

  it('treats a session replaced under the same id as gone', () => {
    const old: S = { active: true };
    const reg = new Map<string, S>([['live-1', { active: true }]]);
    expect(isSessionGone(old, 'live-1', reg)).toBe(true);
  });

  it('survives an upstream whose close throws, and a null upstream', () => {
    const s: S = { active: false };
    const reg = new Map<string, S>();
    const ws = { close: jest.fn(() => { throw new Error('already closed'); }) };
    expect(closeIfSessionGone(ws, s, 'live-1', reg, 't')).toBe(true);
    expect(closeIfSessionGone(null, s, 'live-1', reg, 't')).toBe(true);
  });

  it('is wired at both places orb-live.ts attaches an upstream after an await', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/routes/orb-live.ts'),
      'utf8',
    );
    expect(src).toMatch(
      /liveApiPromise\.then\(\(ws\) => \{[\s\S]{0,200}closeIfSessionGone\(ws, session, sessionId, liveSessions, 'sse_connect'\)\) return;\s*session\.upstreamWs = ws;/,
    );
    expect(src).toMatch(
      /closeIfSessionGone\(newWs, session, session\.sessionId, liveSessions, 'transparent_reconnect'\)\) return false;\s*session\.upstreamWs = newWs;/,
    );
  });
});
