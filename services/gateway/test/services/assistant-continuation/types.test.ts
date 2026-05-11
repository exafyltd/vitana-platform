/**
 * VTID-02913 (B0d.1) — types.ts unit tests.
 *
 * Covers the contract-level invariants that the rest of the slice depends on:
 *   - `makeNoneWithReason` builds a continuation with the right shape.
 *   - The reason field is required (empty / whitespace rejected).
 *   - `isNoneWithReason` is a true type guard.
 *   - `none_with_reason` is a real `kind` value, not a sentinel — both
 *     types and runtime treat it like any other kind.
 */

import {
  makeNoneWithReason,
  isNoneWithReason,
  type AssistantContinuation,
} from '../../../src/services/assistant-continuation/types';

describe('B0d.1 — types: none_with_reason as first-class', () => {
  describe('makeNoneWithReason', () => {
    it('builds a continuation with kind="none_with_reason"', () => {
      const c = makeNoneWithReason({
        surface: 'orb_wake',
        reason: 'no_candidate_available',
        dedupeKey: 'dk-1',
      });
      expect(c.kind).toBe('none_with_reason');
      expect(c.suppressReason).toBe('no_candidate_available');
      expect(c.surface).toBe('orb_wake');
      expect(c.dedupeKey).toBe('dk-1');
    });

    it('renders the standard suppressed shape (empty line, noop CTA, empty evidence)', () => {
      const c = makeNoneWithReason({
        surface: 'orb_turn_end',
        reason: 'voice_pause_active',
        dedupeKey: 'dk-2',
      });
      expect(c.userFacingLine).toBe('');
      expect(c.cta).toEqual({ type: 'noop' });
      expect(c.evidence).toEqual([]);
      expect(c.priority).toBe(0);
      expect(c.privacyMode).toBe('safe_to_speak');
    });

    it('defaults the id to a deterministic value based on dedupeKey', () => {
      const c = makeNoneWithReason({
        surface: 'home',
        reason: 'daily_cap_exceeded',
        dedupeKey: 'dk-3',
      });
      expect(c.id).toBe('none-dk-3');
    });

    it('accepts an explicit id override', () => {
      const c = makeNoneWithReason({
        surface: 'home',
        reason: 'whatever',
        dedupeKey: 'dk-4',
        id: 'explicit-id',
      });
      expect(c.id).toBe('explicit-id');
    });

    it('rejects an empty reason', () => {
      expect(() =>
        makeNoneWithReason({
          surface: 'orb_wake',
          reason: '',
          dedupeKey: 'dk-5',
        }),
      ).toThrow(/reason is required/);
    });

    it('rejects a whitespace-only reason', () => {
      expect(() =>
        makeNoneWithReason({
          surface: 'orb_wake',
          reason: '   ',
          dedupeKey: 'dk-6',
        }),
      ).toThrow(/reason is required/);
    });
  });

  describe('isNoneWithReason type guard', () => {
    it('returns true for a suppressed continuation', () => {
      const c = makeNoneWithReason({
        surface: 'orb_wake',
        reason: 'x',
        dedupeKey: 'dk',
      });
      expect(isNoneWithReason(c)).toBe(true);
    });

    it('returns false for a real continuation', () => {
      const c: AssistantContinuation = {
        id: 'real-1',
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority: 100,
        userFacingLine: 'Hello!',
        cta: { type: 'explain' },
        evidence: [{ kind: 'demo', detail: 'first-session user' }],
        dedupeKey: 'wb-1',
        privacyMode: 'safe_to_speak',
      };
      expect(isNoneWithReason(c)).toBe(false);
    });
  });
});
