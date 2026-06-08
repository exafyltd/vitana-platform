import {
  isReusableSession,
  pickReusableSession,
  type ReusableSessionLike,
} from '../../../../src/orb/live/session/session-reuse';

const NOW = 1_000_000_000;
const MAX_AGE = 30 * 60 * 1000; // session TTL backstop

function mk(over: Partial<ReusableSessionLike> = {}): ReusableSessionLike {
  return {
    sessionId: 's',
    active: true,
    turn_count: 0,
    createdAt: new Date(NOW - 3000),
    identity: { user_id: 'u1' },
    startResponseBody: { ok: true, session_id: 's' },
    ...over,
  };
}

describe('BOOTSTRAP-ORB-SESSION-CHURN reuse decision', () => {
  describe('isReusableSession', () => {
    it('reuses an active, zero-turn, initialized same-user session', () => {
      expect(isReusableSession(mk(), 'u1', NOW, MAX_AGE)).toBe(true);
    });

    it('does NOT reuse once a turn has happened (greeting/engagement started)', () => {
      expect(isReusableSession(mk({ turn_count: 1 }), 'u1', NOW, MAX_AGE)).toBe(false);
    });

    it('does NOT reuse an inactive session', () => {
      expect(isReusableSession(mk({ active: false }), 'u1', NOW, MAX_AGE)).toBe(false);
    });

    it('does NOT reuse another user\'s session', () => {
      expect(isReusableSession(mk({ identity: { user_id: 'other' } }), 'u1', NOW, MAX_AGE)).toBe(false);
    });

    it('does NOT reuse an anonymous (identity-less) session', () => {
      expect(isReusableSession(mk({ identity: null }), 'u1', NOW, MAX_AGE)).toBe(false);
    });

    it('does NOT reuse a half-built session (no startResponseBody yet)', () => {
      expect(isReusableSession(mk({ startResponseBody: undefined }), 'u1', NOW, MAX_AGE)).toBe(false);
    });

    it('does NOT reuse past the age backstop', () => {
      expect(isReusableSession(mk({ createdAt: new Date(NOW - (MAX_AGE + 1)) }), 'u1', NOW, MAX_AGE)).toBe(false);
    });

    it('reuses right up to the age backstop boundary', () => {
      expect(isReusableSession(mk({ createdAt: new Date(NOW - MAX_AGE) }), 'u1', NOW, MAX_AGE)).toBe(true);
    });
  });

  describe('pickReusableSession', () => {
    it('picks the most-recently-created reusable session', () => {
      const older = mk({ sessionId: 'old', createdAt: new Date(NOW - 10_000) });
      const newer = mk({ sessionId: 'new', createdAt: new Date(NOW - 2_000) });
      const turned = mk({ sessionId: 'turned', turn_count: 3, createdAt: new Date(NOW - 1_000) });
      expect(pickReusableSession([older, newer, turned], 'u1', NOW, MAX_AGE)?.sessionId).toBe('new');
    });

    it('returns null when nothing qualifies', () => {
      expect(pickReusableSession([mk({ active: false }), mk({ turn_count: 2 })], 'u1', NOW, MAX_AGE)).toBeNull();
    });

    it('ignores other users when selecting', () => {
      const mine = mk({ sessionId: 'mine', createdAt: new Date(NOW - 5_000) });
      const theirs = mk({ sessionId: 'theirs', identity: { user_id: 'u2' }, createdAt: new Date(NOW - 1_000) });
      expect(pickReusableSession([theirs, mine], 'u1', NOW, MAX_AGE)?.sessionId).toBe('mine');
    });
  });
});
