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
  validateContinuationCandidate,
  KNOWN_CONTINUATION_KINDS,
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

    // ── Code-review finding P2: runtime guard against `as any`-bypassed
    //    inputs. A malformed candidate that names kind='none_with_reason'
    //    but omits or empties suppressReason must NOT pass the guard —
    //    otherwise renderers can trust a missing value.
    it('returns false when kind="none_with_reason" but suppressReason is missing', () => {
      const malformed = {
        id: 'mal-1',
        surface: 'orb_wake',
        kind: 'none_with_reason',
        priority: 0,
        userFacingLine: '',
        cta: { type: 'noop' },
        evidence: [],
        dedupeKey: 'dk',
        privacyMode: 'safe_to_speak',
        // suppressReason intentionally missing
      } as unknown as AssistantContinuation;
      expect(isNoneWithReason(malformed)).toBe(false);
    });

    it('returns false when kind="none_with_reason" but suppressReason is empty/whitespace', () => {
      const malformed = {
        id: 'mal-2',
        surface: 'orb_wake',
        kind: 'none_with_reason',
        priority: 0,
        userFacingLine: '',
        cta: { type: 'noop' },
        evidence: [],
        dedupeKey: 'dk',
        privacyMode: 'safe_to_speak',
        suppressReason: '   ',
      } as unknown as AssistantContinuation;
      expect(isNoneWithReason(malformed)).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Code-review finding P1: runtime validator for provider-returned
// candidates. The validator is the defense against providers that
// bypass the discriminated-union compile-time check (e.g. via `as any`).
// ──────────────────────────────────────────────────────────────────────

describe('B0d.1 — validateContinuationCandidate (P1 fix)', () => {
  it('accepts a well-formed none_with_reason candidate', () => {
    const c = makeNoneWithReason({
      surface: 'orb_wake',
      reason: 'sensitive_context',
      dedupeKey: 'dk',
    });
    expect(validateContinuationCandidate(c)).toEqual({ ok: true });
  });

  it('accepts a well-formed non-suppression candidate', () => {
    const c: AssistantContinuation = {
      id: 'wb-1',
      surface: 'orb_wake',
      kind: 'wake_brief',
      priority: 50,
      userFacingLine: 'Welcome back.',
      cta: { type: 'explain' },
      evidence: [],
      dedupeKey: 'wb',
      privacyMode: 'safe_to_speak',
    };
    expect(validateContinuationCandidate(c)).toEqual({ ok: true });
  });

  it('rejects null / non-object inputs', () => {
    expect(validateContinuationCandidate(null).ok).toBe(false);
    expect(validateContinuationCandidate(undefined).ok).toBe(false);
    expect(validateContinuationCandidate('string').ok).toBe(false);
    expect(validateContinuationCandidate(42).ok).toBe(false);
    const r = validateContinuationCandidate(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invariant_violation: candidate_not_an_object/);
  });

  it('rejects an unknown kind', () => {
    const r = validateContinuationCandidate({ kind: 'made_up_kind' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invariant_violation: unknown_continuation_kind/);
  });

  it('rejects kind="none_with_reason" missing suppressReason', () => {
    const r = validateContinuationCandidate({
      kind: 'none_with_reason',
      id: 'x',
      surface: 'orb_wake',
      priority: 0,
      userFacingLine: '',
      cta: { type: 'noop' },
      evidence: [],
      dedupeKey: 'dk',
      privacyMode: 'safe_to_speak',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(
        /invariant_violation: none_with_reason_requires_suppressReason/,
      );
    }
  });

  it('rejects kind="none_with_reason" with empty/whitespace suppressReason', () => {
    const r = validateContinuationCandidate({
      kind: 'none_with_reason',
      suppressReason: '   ',
      id: 'x',
      surface: 'orb_wake',
      priority: 0,
      userFacingLine: '',
      cta: { type: 'noop' },
      evidence: [],
      dedupeKey: 'dk',
      privacyMode: 'safe_to_speak',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(
        /invariant_violation: none_with_reason_requires_suppressReason/,
      );
    }
  });

  it('rejects a real kind that carries suppressReason', () => {
    const r = validateContinuationCandidate({
      kind: 'wake_brief',
      suppressReason: 'should not be here',
      id: 'wb',
      surface: 'orb_wake',
      priority: 50,
      userFacingLine: 'Hi.',
      cta: { type: 'explain' },
      evidence: [],
      dedupeKey: 'wb',
      privacyMode: 'safe_to_speak',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(
        /invariant_violation: non_none_kind_must_not_carry_suppressReason/,
      );
    }
  });

  it('KNOWN_CONTINUATION_KINDS covers all 11 kinds', () => {
    expect(KNOWN_CONTINUATION_KINDS.size).toBe(11);
    expect(KNOWN_CONTINUATION_KINDS.has('none_with_reason')).toBe(true);
    expect(KNOWN_CONTINUATION_KINDS.has('wake_brief')).toBe(true);
    expect(KNOWN_CONTINUATION_KINDS.has('match_journey_next_move')).toBe(true);
  });
});
