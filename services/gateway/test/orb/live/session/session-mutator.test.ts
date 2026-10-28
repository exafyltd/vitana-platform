/**
 * A6.2 — SessionMutator unit tests.
 *
 * Verifies the write-surface contract that future tool-domain handler
 * extractions (A6.3+) will rely on.
 */

import { makeSessionMutator, MutableSessionLike } from '../../../../src/orb/live/session/session-mutator';

describe('A6.2 — SessionMutator', () => {
  describe('appendRecentRoute', () => {
    it('appends a new path to the head of recent_routes', () => {
      const session: MutableSessionLike = { recent_routes: ['/health'] };
      const mutator = makeSessionMutator(session);
      mutator.appendRecentRoute('/diary');
      expect(session.recent_routes).toEqual(['/diary', '/health']);
    });

    it('dedupes — moving the path to the head if it already exists', () => {
      const session: MutableSessionLike = { recent_routes: ['/wallet', '/diary', '/health'] };
      const mutator = makeSessionMutator(session);
      mutator.appendRecentRoute('/diary');
      expect(session.recent_routes).toEqual(['/diary', '/wallet', '/health']);
    });

    it('caps the trail at 5 entries', () => {
      const session: MutableSessionLike = {
        recent_routes: ['/a', '/b', '/c', '/d', '/e'],
      };
      const mutator = makeSessionMutator(session);
      mutator.appendRecentRoute('/new');
      expect(session.recent_routes).toEqual(['/new', '/a', '/b', '/c', '/d']);
      expect(session.recent_routes?.length).toBe(5);
    });

    it('initializes recent_routes if missing on the session', () => {
      const session: MutableSessionLike = {};
      const mutator = makeSessionMutator(session);
      mutator.appendRecentRoute('/health');
      expect(session.recent_routes).toEqual(['/health']);
    });

    it('ignores empty path', () => {
      const session: MutableSessionLike = { recent_routes: ['/health'] };
      const mutator = makeSessionMutator(session);
      mutator.appendRecentRoute('');
      expect(session.recent_routes).toEqual(['/health']);
    });

    it('ignores non-string path', () => {
      const session: MutableSessionLike = { recent_routes: ['/health'] };
      const mutator = makeSessionMutator(session);
      mutator.appendRecentRoute(null as any);
      mutator.appendRecentRoute(undefined as any);
      mutator.appendRecentRoute(42 as any);
      expect(session.recent_routes).toEqual(['/health']);
    });
  });

  describe('mutator API surface', () => {
    it('only exposes write methods (no read accessors)', () => {
      const mutator = makeSessionMutator({});
      // Handlers must NOT be able to read session state through the mutator.
      // The mutator's only public methods are mutations.
      const keys = Object.keys(mutator).sort();
      expect(keys).toEqual(['appendRecentRoute']);
    });
  });
});
