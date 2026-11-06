/**
 * live-room-edit-cohost / gateway-cohost — edit rules (services/live-cohosts.ts).
 * Locked fields while live or in the lobby; the session and listing payloads.
 */
import { lockedFieldsRequested, buildSessionEditPatch } from '../src/services/live-cohosts';

const START = '2026-12-01T18:00:00.000Z';

describe('lockedFieldsRequested', () => {
  it('refuses start and duration while live', () => {
    expect(lockedFieldsRequested({ starts_at: START, duration_minutes: 30 }, 'live')).toEqual(['starts_at', 'duration_minutes']);
  });
  it('refuses start while in the lobby', () => {
    expect(lockedFieldsRequested({ starts_at: START }, 'lobby')).toEqual(['starts_at']);
  });
  it('allows any change while scheduled', () => {
    expect(lockedFieldsRequested({ starts_at: START, duration_minutes: 30 }, 'scheduled')).toEqual([]);
  });
  it('a title change is never locked', () => {
    expect(lockedFieldsRequested({ session_title: 'New' }, 'live')).toEqual([]);
  });
});

describe('buildSessionEditPatch', () => {
  it('writes only the keys the body sends', () => {
    const p = buildSessionEditPatch({ session_title: 'Brunch' }, { starts_at: START, ends_at: null });
    expect(p.session).toEqual({ session_title: 'Brunch' });
    expect(p.listing).toEqual({ title: 'Brunch' });
  });
  it('recomputes ends_at from the new start and the kept duration', () => {
    const current = { starts_at: START, ends_at: '2026-12-01T19:00:00.000Z' };
    const p = buildSessionEditPatch({ starts_at: '2026-12-02T10:00:00.000Z' }, current);
    expect(p.session).toEqual({ starts_at: '2026-12-02T10:00:00.000Z', ends_at: '2026-12-02T11:00:00.000Z' });
    expect(p.listing).toEqual({ scheduled_for: '2026-12-02T10:00:00.000Z', duration_minutes: 60 });
  });
  it('uses a new duration with the current start', () => {
    const p = buildSessionEditPatch({ duration_minutes: 90 }, { starts_at: START, ends_at: null });
    expect(p.session.ends_at).toBe('2026-12-01T19:30:00.000Z');
  });
  it('carries co-hosts to the listing only', () => {
    const p = buildSessionEditPatch({ co_hosts: ['u1'] }, { starts_at: START, ends_at: null });
    expect(p.session).toEqual({});
    expect(p.listing).toEqual({ co_hosts: ['u1'] });
  });
});
