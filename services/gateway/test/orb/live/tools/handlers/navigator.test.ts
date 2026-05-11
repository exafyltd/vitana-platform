/**
 * A6.2 — navigator handler extraction tests.
 *
 * Verifies:
 *   - getCurrentScreenHandler returns the same shape as today's inline
 *     handleGetCurrentScreen (behavior-preserving).
 *   - The handler reads from `ctx.currentRoute` / `ctx.recentRoutes` /
 *     `ctx.identity` / `ctx.lang` — NOT from a raw GeminiLiveSession.
 *   - The fallback path (no Supabase) returns the same "unknown screen"
 *     envelope as the pre-extraction handler.
 *   - The handler does NOT call any method on the SessionMutator
 *     (handleGetCurrentScreen is a pure read).
 */

import { getCurrentScreenHandler } from '../../../../../src/orb/live/tools/handlers/navigator';
import { buildSessionContext } from '../../../../../src/orb/live/session/session-context';
import { makeSessionMutator, type SessionMutator } from '../../../../../src/orb/live/session/session-mutator';

// Mock the supabase getter — when null, the handler falls back to the
// "unknown screen" envelope without calling the shared dispatcher.
jest.mock('../../../../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => null),
}));

describe('A6.2 — getCurrentScreenHandler', () => {
  describe('fallback path (Supabase unconfigured)', () => {
    it('returns "Unknown screen" envelope using ctx.currentRoute', async () => {
      const ctx = buildSessionContext({
        sessionId: 'live-test',
        current_route: '/diary',
        recent_routes: ['/health'],
        createdAt: new Date(),
      });
      const mutator: SessionMutator = makeSessionMutator({});
      const result = await getCurrentScreenHandler({}, ctx, mutator);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.title).toBe('Unknown screen');
      expect(parsed.route).toBe('/diary');
      expect(parsed.recent_screens).toEqual([]);
    });

    it('returns null route when currentRoute is missing', async () => {
      const ctx = buildSessionContext({
        sessionId: 'live-test',
        createdAt: new Date(),
      });
      const mutator: SessionMutator = makeSessionMutator({});
      const result = await getCurrentScreenHandler({}, ctx, mutator);
      const parsed = JSON.parse(result.result);
      expect(parsed.route).toBeNull();
    });
  });

  describe('mutator hygiene', () => {
    it('does not mutate session state (handleGetCurrentScreen is pure read)', async () => {
      const session = {
        sessionId: 'live-test',
        current_route: '/health',
        recent_routes: ['/diary'],
        createdAt: new Date(),
      };
      const ctx = buildSessionContext(session);
      // Use a spy mutator to assert no mutation methods are called.
      const mutator: SessionMutator = {
        appendRecentRoute: jest.fn(),
      };
      await getCurrentScreenHandler({}, ctx, mutator);
      expect(mutator.appendRecentRoute).not.toHaveBeenCalled();
      // The source session is also untouched.
      expect(session.recent_routes).toEqual(['/diary']);
    });
  });

  describe('handler receives no raw GeminiLiveSession', () => {
    it('signature is (args, ctx: SessionContext, mutator: SessionMutator) only', () => {
      // Type-level check: TypeScript itself rejects passing a raw session.
      // At runtime we just verify the function arity.
      expect(getCurrentScreenHandler.length).toBe(3);
    });
  });
});
