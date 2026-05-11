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
  KNOWN_CONTINUATION_SURFACES,
  KNOWN_PRIVACY_MODES,
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

  it('KNOWN_CONTINUATION_SURFACES covers all 4 surfaces', () => {
    expect(KNOWN_CONTINUATION_SURFACES.size).toBe(4);
    expect(KNOWN_CONTINUATION_SURFACES.has('orb_wake')).toBe(true);
    expect(KNOWN_CONTINUATION_SURFACES.has('orb_turn_end')).toBe(true);
    expect(KNOWN_CONTINUATION_SURFACES.has('text_turn_end')).toBe(true);
    expect(KNOWN_CONTINUATION_SURFACES.has('home')).toBe(true);
  });

  it('KNOWN_PRIVACY_MODES covers all 3 modes', () => {
    expect(KNOWN_PRIVACY_MODES.size).toBe(3);
    expect(KNOWN_PRIVACY_MODES.has('safe_to_speak')).toBe(true);
    expect(KNOWN_PRIVACY_MODES.has('use_silently')).toBe(true);
    expect(KNOWN_PRIVACY_MODES.has('suppress_sensitive')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Code-review finding P1 (round 2): the validator must enforce the FULL
// AssistantContinuation shape, not only the suppressReason invariant.
// A provider returning `{ kind: 'wake_brief' } as any` must NOT pass.
// ──────────────────────────────────────────────────────────────────────

describe('B0d.1 — validateContinuationCandidate: full-shape enforcement (P1 round 2)', () => {
  function validNonNoneCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'wb-1',
      surface: 'orb_wake',
      kind: 'wake_brief',
      priority: 50,
      userFacingLine: 'Welcome back.',
      cta: { type: 'explain' },
      evidence: [],
      dedupeKey: 'wb-1',
      privacyMode: 'safe_to_speak',
      ...overrides,
    };
  }

  it('accepts a fully-specified non-none candidate', () => {
    expect(validateContinuationCandidate(validNonNoneCandidate())).toEqual({
      ok: true,
    });
  });

  // User-requested test: known kind + missing required fields → reject.
  it('rejects known non-none kind with missing required fields', () => {
    // Only kind is set; every other required field is missing.
    const r = validateContinuationCandidate({ kind: 'wake_brief' });
    expect(r.ok).toBe(false);
  });

  describe('rejects missing required fields one by one', () => {
    const requiredFields = [
      'id',
      'surface',
      'priority',
      'userFacingLine',
      'cta',
      'evidence',
      'dedupeKey',
      'privacyMode',
    ];
    it.each(requiredFields)('rejects when %s is missing', (field) => {
      const candidate = validNonNoneCandidate();
      delete candidate[field];
      const r = validateContinuationCandidate(candidate);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^invariant_violation:/);
    });
  });

  describe('rejects invalid field types', () => {
    it('rejects empty id', () => {
      const r = validateContinuationCandidate(validNonNoneCandidate({ id: '' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: id/);
    });

    it('rejects whitespace-only id', () => {
      const r = validateContinuationCandidate(validNonNoneCandidate({ id: '   ' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: id/);
    });

    it('rejects non-number priority', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ priority: 'high' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: priority/);
    });

    it('rejects non-finite priority (NaN, Infinity)', () => {
      const rNan = validateContinuationCandidate(
        validNonNoneCandidate({ priority: Number.NaN }),
      );
      expect(rNan.ok).toBe(false);
      const rInf = validateContinuationCandidate(
        validNonNoneCandidate({ priority: Number.POSITIVE_INFINITY }),
      );
      expect(rInf.ok).toBe(false);
    });

    it('accepts priority=0 (legitimate for none_with_reason)', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ priority: 0 }),
      );
      expect(r).toEqual({ ok: true });
    });

    it('rejects non-string userFacingLine', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ userFacingLine: 42 }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: userFacingLine/);
    });

    it('accepts empty userFacingLine (none_with_reason carries empty)', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ userFacingLine: '' }),
      );
      expect(r).toEqual({ ok: true });
    });

    it('rejects empty dedupeKey', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ dedupeKey: '' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: dedupeKey/);
    });

    it('rejects unknown surface', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ surface: 'made_up_surface' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/unknown_continuation_surface/);
    });

    it('rejects unknown privacyMode', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ privacyMode: 'totally_invented' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/unknown_privacy_mode/);
    });
  });

  describe('cta validation', () => {
    it('rejects non-object cta', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ cta: 'explain' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: cta/);
    });

    it('rejects unknown cta type', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ cta: { type: 'twirl' } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/unknown_cta_type/);
    });

    it('rejects cta type="navigate" without a route', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ cta: { type: 'navigate' } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/cta_navigate_requires_route/);
    });

    it('accepts cta type="navigate" with a valid route', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({
          cta: { type: 'navigate', route: '/matches/123' },
        }),
      );
      expect(r).toEqual({ ok: true });
    });

    it('rejects cta type="run_tool" without a toolName', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ cta: { type: 'run_tool' } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/cta_run_tool_requires_toolName/);
    });

    it('accepts cta type="run_tool" with a valid toolName', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({
          cta: { type: 'run_tool', toolName: 'save_diary_entry' },
        }),
      );
      expect(r).toEqual({ ok: true });
    });
  });

  describe('evidence validation', () => {
    it('rejects non-array evidence', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ evidence: 'foo' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/evidence_must_be_array/);
    });

    it('accepts an empty evidence array', () => {
      expect(
        validateContinuationCandidate(validNonNoneCandidate({ evidence: [] })),
      ).toEqual({ ok: true });
    });

    it('rejects evidence entries missing kind or detail', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ evidence: [{ kind: 'demo' }] }), // detail missing
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/evidence_entry_invalid \(index 0\)/);
    });

    it('reports the index of the first malformed entry', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({
          evidence: [
            { kind: 'a', detail: 'ok' },
            { kind: 'b', detail: 'ok' },
            { kind: 'c' }, // bad
          ],
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/evidence_entry_invalid \(index 2\)/);
    });
  });

  describe('expiresAt optional field', () => {
    it('accepts missing expiresAt', () => {
      expect(
        validateContinuationCandidate(validNonNoneCandidate()),
      ).toEqual({ ok: true });
    });

    it('accepts a string expiresAt', () => {
      expect(
        validateContinuationCandidate(
          validNonNoneCandidate({ expiresAt: '2026-05-12T00:00:00Z' }),
        ),
      ).toEqual({ ok: true });
    });

    it('rejects a non-string expiresAt', () => {
      const r = validateContinuationCandidate(
        validNonNoneCandidate({ expiresAt: 1234567890 }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/missing_or_invalid_field: expiresAt/);
    });
  });
});
