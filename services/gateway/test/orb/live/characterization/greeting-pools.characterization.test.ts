/**
 * A0.2 — Characterization test for greeting-pools.ts.
 *
 * Purpose: lock the per-language pool of short-gap reconnect greetings and
 * the invariants of the picker. These greetings are what the user hears
 * when they reopen the orb after a few seconds or minutes — pool drift
 * directly changes the user's perception of "Vitana sounds different
 * today".
 *
 * The picker uses Math.random() so its output is non-deterministic. We
 * snapshot the *pool* (deterministic) and assert *invariants* of the
 * picker without locking specific output.
 *
 * Will move when: A4 extracts greeting policy into
 * orb/live/instruction/greeting-policy.ts. The pools themselves stay in
 * orb/instruction/greeting-pools.ts; only the choice logic moves.
 */

import {
  SHORT_GAP_GREETING_PHRASES,
  pickShortGapGreetings,
} from '../../../../src/orb/instruction/greeting-pools';

describe('A0.2 characterization: greeting pools', () => {
  describe('SHORT_GAP_GREETING_PHRASES (frozen pool)', () => {
    it('snapshots the entire pool table', () => {
      // Locking this is the contract — A4's greeting-policy extraction must
      // not silently drop or rename a language pool.
      expect(SHORT_GAP_GREETING_PHRASES).toMatchSnapshot();
    });

    it('declares the languages the orb officially supports for short-gap greetings', () => {
      expect(Object.keys(SHORT_GAP_GREETING_PHRASES).sort()).toEqual(
        ['ar', 'de', 'en', 'es', 'fr', 'ru', 'sr', 'zh'].sort()
      );
    });

    it.each(Object.keys(SHORT_GAP_GREETING_PHRASES))(
      'pool for "%s" has at least 8 phrases (variety floor)',
      (lang) => {
        const pool = SHORT_GAP_GREETING_PHRASES[lang];
        expect(Array.isArray(pool)).toBe(true);
        expect(pool.length).toBeGreaterThanOrEqual(8);
      }
    );

    it.each(Object.keys(SHORT_GAP_GREETING_PHRASES))(
      'pool for "%s" has no empty / whitespace-only phrases',
      (lang) => {
        for (const phrase of SHORT_GAP_GREETING_PHRASES[lang]) {
          expect(typeof phrase).toBe('string');
          expect(phrase.trim().length).toBeGreaterThan(0);
        }
      }
    );

    it.each(Object.keys(SHORT_GAP_GREETING_PHRASES))(
      'pool for "%s" has no duplicate phrases',
      (lang) => {
        const pool = SHORT_GAP_GREETING_PHRASES[lang];
        expect(new Set(pool).size).toBe(pool.length);
      }
    );
  });

  describe('pickShortGapGreetings (invariants)', () => {
    it('returns at most `count` items', () => {
      for (let count = 0; count <= 20; count++) {
        const picked = pickShortGapGreetings('en', count);
        expect(picked.length).toBeLessThanOrEqual(count);
      }
    });

    it('caps `count` at the size of the pool (never returns more than the pool has)', () => {
      const enPool = SHORT_GAP_GREETING_PHRASES.en;
      // Ask for 100; expect to get back at most enPool.length.
      const picked = pickShortGapGreetings('en', 100);
      expect(picked.length).toBe(enPool.length);
    });

    it('every returned phrase is a member of the requested language pool', () => {
      const enSet = new Set(SHORT_GAP_GREETING_PHRASES.en);
      // Run several times because of randomness — a single run could
      // accidentally produce a valid result; multiple runs make a buggy
      // implementation surface.
      for (let i = 0; i < 25; i++) {
        const picked = pickShortGapGreetings('en', 5);
        for (const phrase of picked) {
          expect(enSet.has(phrase)).toBe(true);
        }
      }
    });

    it('falls back to "en" pool for an unknown language', () => {
      const enSet = new Set(SHORT_GAP_GREETING_PHRASES.en);
      const picked = pickShortGapGreetings('xx-not-real', 5);
      // When the pool doesn't exist, the function uses the en pool.
      // Every returned phrase must be from en (and thus in the en set).
      for (const phrase of picked) {
        expect(enSet.has(phrase)).toBe(true);
      }
      expect(picked.length).toBeLessThanOrEqual(5);
    });

    it('does not mutate the underlying pool', () => {
      const before = SHORT_GAP_GREETING_PHRASES.en.slice();
      // Many picks should not disturb the source array's order or contents.
      for (let i = 0; i < 50; i++) {
        pickShortGapGreetings('en', 5);
      }
      expect(SHORT_GAP_GREETING_PHRASES.en).toEqual(before);
    });

    it('returns deterministic-shape output: an array of strings', () => {
      const picked = pickShortGapGreetings('de', 3);
      expect(Array.isArray(picked)).toBe(true);
      for (const phrase of picked) {
        expect(typeof phrase).toBe('string');
      }
    });

    it('returns empty array when count is 0', () => {
      expect(pickShortGapGreetings('en', 0)).toEqual([]);
    });
  });
});
