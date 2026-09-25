/**
 * VTID-04520 — the app confirms what a navigation did; the server believes it.
 */
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import {
  applyNavResult, handleNavResultMessage, recordPendingNavAck, sanitizeNavResult, takeNavFailureNote, NavAckSession,
} from '../../src/navigation/nav-ack';

const pending = (session: NavAckSession, screen_id = 'MEMORY.DIARY', route = '/memory/diary', entry_kind = 'route') =>
  recordPendingNavAck(session, { screen_id, route, entry_kind });

describe('sanitizeNavResult', () => {
  it('accepts only nav_result frames and bounds every field', () => {
    expect(sanitizeNavResult({ type: 'audio' })).toBeNull();
    expect(sanitizeNavResult(null)).toBeNull();
    const m = sanitizeNavResult({ type: 'nav_result', screen_id: 'X'.repeat(500), status: 'bogus', entry_kind: 'weird' })!;
    expect(m.screen_id).toHaveLength(80);
    expect(m.status).toBe('unknown');
    expect(m.entry_kind).toBe('route');
  });
});

describe('applyNavResult', () => {
  it('moves the route only when the screen opened', () => {
    const s: NavAckSession = { current_route: '/home', recent_routes: [] };
    pending(s);
    const out = applyNavResult(s, sanitizeNavResult({ type: 'nav_result', screen_id: 'MEMORY.DIARY', route: '/memory/diary?tab=x', status: 'opened' })!, Date.now());
    expect(out).toMatchObject({ applied: true, route_changed: true });
    expect(s.current_route).toBe('/memory/diary');
    expect(s.recent_routes).toEqual(['/home']);
    expect(s.pendingNavAck).toBeNull();
  });

  it('keeps the route and records the failure when the app refused', () => {
    const s: NavAckSession = { current_route: '/home' };
    pending(s);
    applyNavResult(s, sanitizeNavResult({ type: 'nav_result', screen_id: 'MEMORY.DIARY', status: 'refused', reason: 'desktop only' })!);
    expect(s.current_route).toBe('/home');
    expect(s.lastNavFailure).toMatchObject({ screen_id: 'MEMORY.DIARY', status: 'refused', reason: 'desktop only' });
  });

  it('believes a host that does not report yet, as before', () => {
    const s: NavAckSession = { current_route: '/home' };
    pending(s);
    applyNavResult(s, sanitizeNavResult({ type: 'nav_result', screen_id: 'MEMORY.DIARY', route: '/memory/diary' })!);
    expect(s.current_route).toBe('/memory/diary');
    expect(s.lastNavFailure).toBeFalsy();
  });

  it('does not move the page for an overlay', () => {
    const s: NavAckSession = { current_route: '/home' };
    pending(s, 'LIFE_COMPASS.OVERLAY', '/home?open=life_compass', 'overlay');
    const out = applyNavResult(s, sanitizeNavResult({ type: 'nav_result', screen_id: 'LIFE_COMPASS.OVERLAY', status: 'opened', entry_kind: 'overlay' })!);
    expect(out.route_changed).toBe(false);
    expect(s.current_route).toBe('/home');
  });

  it('ignores a result for a directive it is not waiting on', () => {
    const s: NavAckSession = { current_route: '/home' };
    pending(s);
    const out = applyNavResult(s, sanitizeNavResult({ type: 'nav_result', screen_id: 'WALLET.OVERVIEW', route: '/wallet', status: 'opened' })!);
    expect(out.applied).toBe(false);
    expect(s.current_route).toBe('/home');
    expect(s.pendingNavAck).not.toBeNull();
  });
});

describe('takeNavFailureNote', () => {
  it('tells the next tool result once, and only while fresh', () => {
    const s: NavAckSession = { lastNavFailure: { screen_id: 'MEMORY.DIARY', status: 'not_found', reason: null, at: 1000 } };
    expect(takeNavFailureNote(s, 2000)).toMatch(/^NOTE: .*MEMORY\.DIARY.*could not find/);
    expect(takeNavFailureNote(s, 2000)).toBeNull();
    s.lastNavFailure = { screen_id: 'X', status: 'error', reason: null, at: 0 };
    expect(takeNavFailureNote(s, 10 * 60_000)).toBeNull();
  });
});

describe('handleNavResultMessage', () => {
  it('records the outcome as orb.navigator.acknowledged', async () => {
    const s: NavAckSession = { sessionId: 's1', current_route: '/home' };
    pending(s);
    expect(handleNavResultMessage(s, { type: 'nav_result', screen_id: 'MEMORY.DIARY', route: '/memory/diary', status: 'opened' })?.applied).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // the event is emitted after a lazy import
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'orb.navigator.acknowledged',
      payload: expect.objectContaining({ session_id: 's1', status: 'opened', route_changed: true }),
    }));
    expect(handleNavResultMessage(s, { type: 'context_update' })).toBeNull();
  });
});
