/**
 * A6 — SessionContext shape + read-only invariants.
 *
 * Verifies the typed seam that A6.2+ per-handler PRs will consume:
 *   - SessionContext fields are exactly the documented set (no extras)
 *   - buildSessionContext defensively copies + freezes inputs
 *   - mutation attempts via TypeScript-erased paths fail at runtime
 *     (Object.freeze enforces, even when handler bypasses readonly types)
 *
 * This test does NOT yet validate any per-handler behavior — A6.2 will
 * migrate handlers one domain at a time and add per-handler tests.
 */

import {
  buildSessionContext,
  SessionContext,
  SessionLike,
} from '../../../../src/orb/live/session/session-context';

function makeFakeSession(): SessionLike {
  return {
    sessionId: 'live-test-001',
    thread_id: 'thread-test-001',
    identity: {
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      role: 'community',
      vitana_id: '@alex3700',
    } as any,
    lang: 'de',
    current_route: '/health',
    recentRoutes: ['/diary', '/health', '/wallet'],
    turn_count: 3,
    createdAt: new Date('2026-05-11T14:00:00.000Z'),
    isReconnectStart: false,
  };
}

describe('A6 — SessionContext seam', () => {
  describe('buildSessionContext output shape', () => {
    it('produces all 12 declared keys with no extras', () => {
      const ctx = buildSessionContext(makeFakeSession());
      const expectedKeys: Array<keyof SessionContext> = [
        'sessionId',
        'threadId',
        'identity',
        'activeRole',
        'lang',
        'vitanaId',
        'clientContext',
        'currentRoute',
        'recentRoutes',
        'turnCount',
        'createdAt',
        'isReconnect',
      ];
      expect(Object.keys(ctx).sort()).toEqual([...expectedKeys].sort());
    });

    it('propagates identity verbatim (read-only copy, not reference)', () => {
      const session = makeFakeSession();
      const ctx = buildSessionContext(session);
      expect(ctx.identity?.user_id).toBe('user-1');
      expect(ctx.identity?.tenant_id).toBe('tenant-1');
      // Verify it's a copy, not the same reference (mutation safety).
      expect(ctx.identity).not.toBe(session.identity);
    });

    it('derives activeRole + vitanaId from identity', () => {
      const ctx = buildSessionContext(makeFakeSession());
      expect(ctx.activeRole).toBe('community');
      expect(ctx.vitanaId).toBe('@alex3700');
    });

    it('coerces createdAt Date → ISO string', () => {
      const ctx = buildSessionContext(makeFakeSession());
      expect(ctx.createdAt).toBe('2026-05-11T14:00:00.000Z');
    });

    it('handles anonymous sessions (identity: null → activeRole: null, vitanaId: null)', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-anon',
        identity: null,
        createdAt: new Date('2026-05-11T14:00:00.000Z'),
      });
      expect(ctx.identity).toBeNull();
      expect(ctx.activeRole).toBeNull();
      expect(ctx.vitanaId).toBeNull();
    });

    it('defaults lang to "en" when unset', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-no-lang',
        createdAt: new Date('2026-05-11T14:00:00.000Z'),
      });
      expect(ctx.lang).toBe('en');
    });

    it('returns frozen recentRoutes copy (no mutation of source possible)', () => {
      const session = makeFakeSession();
      const ctx = buildSessionContext(session);
      expect(Object.isFrozen(ctx.recentRoutes)).toBe(true);
      // Mutation attempts throw in strict mode (Jest uses strict mode).
      expect(() => {
        (ctx.recentRoutes as string[]).push('/should-fail');
      }).toThrow();
    });
  });

  describe('read-only invariants (runtime enforced via Object.freeze)', () => {
    it('top-level SessionContext is frozen', () => {
      const ctx = buildSessionContext(makeFakeSession());
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(() => {
        (ctx as any).sessionId = 'mutated';
      }).toThrow();
    });

    it('identity object is frozen', () => {
      const ctx = buildSessionContext(makeFakeSession());
      expect(Object.isFrozen(ctx.identity)).toBe(true);
      expect(() => {
        (ctx.identity as any).user_id = 'mutated';
      }).toThrow();
    });

    it('mutating the source session does NOT affect the context (snapshot semantics)', () => {
      const session = makeFakeSession();
      const ctx = buildSessionContext(session);
      // Mutate the source after building the context.
      (session.recentRoutes as string[]).push('/post-build-route');
      session.current_route = '/post-build-current';
      // Context shows the snapshot at build time, not the live source.
      expect(ctx.recentRoutes).toEqual(['/diary', '/health', '/wallet']);
      expect(ctx.currentRoute).toBe('/health');
    });
  });

  describe('A6.2 regression: recent_routes field-name fix', () => {
    // A6.1 read `session.recentRoutes` (camelCase), which silently
    // returned `[]` because GeminiLiveSession's real field is
    // `recent_routes` (snake_case). A6.2 fixed this. These tests lock
    // the fix.

    it('reads from session.recent_routes (snake_case — the real field)', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-test',
        recent_routes: ['/health', '/diary', '/wallet'],
        createdAt: new Date(),
      });
      expect(ctx.recentRoutes).toEqual(['/health', '/diary', '/wallet']);
    });

    it('falls back to session.recentRoutes (camelCase alias) when recent_routes is absent', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-test',
        recentRoutes: ['/diary'],
        createdAt: new Date(),
      });
      expect(ctx.recentRoutes).toEqual(['/diary']);
    });

    it('prefers recent_routes when both are present (real field wins)', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-test',
        recent_routes: ['/from-real-field'],
        recentRoutes: ['/from-alias'],
        createdAt: new Date(),
      });
      expect(ctx.recentRoutes).toEqual(['/from-real-field']);
    });
  });

  describe('boundary defaults', () => {
    it('clientContext undefined → undefined (not coerced to empty object)', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-no-cc',
        createdAt: new Date(),
      });
      expect(ctx.clientContext).toBeUndefined();
    });

    it('recentRoutes missing → frozen empty array', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-no-routes',
        createdAt: new Date(),
      });
      expect(ctx.recentRoutes).toEqual([]);
      expect(Object.isFrozen(ctx.recentRoutes)).toBe(true);
    });

    it('turn_count missing → 0', () => {
      const ctx = buildSessionContext({
        sessionId: 'live-no-turns',
        createdAt: new Date(),
      });
      expect(ctx.turnCount).toBe(0);
    });
  });
});
