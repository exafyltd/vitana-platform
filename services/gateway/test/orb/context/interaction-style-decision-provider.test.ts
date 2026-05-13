/**
 * VTID-02962 (B6) — interaction-style-decision-provider adapter tests.
 *
 * Wall: the adapter MUST distill to decision-grade enums and drop:
 *   - raw `last_updated_at` ISO timestamp
 *   - operator-only `source_health` envelope
 *   - any free-text or psychological summary
 *
 * Kept: bucketed enums + warnings.
 *
 * NEVER carries medical interpretation, mental-health inference,
 * diagnostic-feeling personality labels, or free-text psychological
 * summaries.
 */

import {
  computeDecisionWarnings,
  distillInteractionStyleForDecision,
} from '../../../src/orb/context/providers/interaction-style-decision-provider';
import {
  bucketConfidence,
  compileInteractionStyleContext,
} from '../../../src/services/interaction-style/compile-interaction-style-context';
import type { InteractionStyleContext } from '../../../src/services/interaction-style/types';

function makeContext(over: Partial<InteractionStyleContext> = {}): InteractionStyleContext {
  return {
    preferred_response_style: 'unknown',
    interaction_pace: 'unknown',
    tone_preference: 'unknown',
    explanation_depth_hint: 'normal',
    confidence_bucket: 'unknown',
    last_updated_at: null,
    source_health: {
      user_assistant_state: { ok: true },
    },
    ...over,
  };
}

describe('B6 — distillInteractionStyleForDecision', () => {
  describe('forbidden raw fields are NOT surfaced', () => {
    it('drops last_updated_at and source_health envelope from output', () => {
      const out = distillInteractionStyleForDecision({
        interactionStyle: makeContext({
          preferred_response_style: 'concise',
          interaction_pace: 'normal',
          tone_preference: 'direct',
          explanation_depth_hint: 'minimal',
          confidence_bucket: 'high',
          last_updated_at: '2026-05-13T10:00:00Z',
        }),
      });
      expect((out as any).last_updated_at).toBeUndefined();
      expect((out as any).source_health).toBeUndefined();
    });

    it('top-level shape is exactly the decision-grade keys', () => {
      const out = distillInteractionStyleForDecision({
        interactionStyle: makeContext({
          preferred_response_style: 'balanced',
          interaction_pace: 'normal',
          tone_preference: 'warm',
          explanation_depth_hint: 'normal',
          confidence_bucket: 'medium',
        }),
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual([
        'confidence_bucket',
        'explanation_depth_hint',
        'interaction_pace',
        'preferred_response_style',
        'tone_preference',
        'warnings',
      ]);
    });
  });

  describe('enum pass-through', () => {
    it('preserves the compiler-assigned enums verbatim', () => {
      const ctx = makeContext({
        preferred_response_style: 'detailed',
        interaction_pace: 'slow',
        tone_preference: 'coaching',
        explanation_depth_hint: 'expanded',
        confidence_bucket: 'high',
      });
      const out = distillInteractionStyleForDecision({ interactionStyle: ctx });
      expect(out.preferred_response_style).toBe('detailed');
      expect(out.interaction_pace).toBe('slow');
      expect(out.tone_preference).toBe('coaching');
      expect(out.explanation_depth_hint).toBe('expanded');
      expect(out.confidence_bucket).toBe('high');
    });
  });

  describe('computeDecisionWarnings', () => {
    it('emits no_recorded_preferences when every preference is unknown', () => {
      expect(computeDecisionWarnings(makeContext({})))
        .toContain('no_recorded_preferences');
    });

    it('does NOT emit no_recorded_preferences when one preference is set', () => {
      const ws = computeDecisionWarnings(makeContext({
        preferred_response_style: 'concise',
        confidence_bucket: 'medium',
      }));
      expect(ws).not.toContain('no_recorded_preferences');
    });

    it('emits low_signal_confidence when confidence is low', () => {
      expect(computeDecisionWarnings(makeContext({
        preferred_response_style: 'balanced',
        confidence_bucket: 'low',
      }))).toContain('low_signal_confidence');
    });

    it('emits low_signal_confidence when confidence is unknown', () => {
      expect(computeDecisionWarnings(makeContext({
        preferred_response_style: 'balanced',
        confidence_bucket: 'unknown',
      }))).toContain('low_signal_confidence');
    });

    it('does NOT emit low_signal_confidence when confidence is high', () => {
      expect(computeDecisionWarnings(makeContext({
        preferred_response_style: 'concise',
        interaction_pace: 'normal',
        tone_preference: 'warm',
        confidence_bucket: 'high',
      }))).not.toContain('low_signal_confidence');
    });

    it('warnings are enum-only (no free-text leaks)', () => {
      const out = distillInteractionStyleForDecision({
        interactionStyle: makeContext({}),
      });
      for (const w of out.warnings) {
        expect(['no_recorded_preferences', 'low_signal_confidence']).toContain(w);
      }
    });
  });
});

describe('B6 — compileInteractionStyleContext', () => {
  it('returns all-unknown shape when fetch returns no row (steady state)', () => {
    const out = compileInteractionStyleContext({
      fetchResult: { ok: true, row: null },
    });
    expect(out.preferred_response_style).toBe('unknown');
    expect(out.interaction_pace).toBe('unknown');
    expect(out.tone_preference).toBe('unknown');
    expect(out.explanation_depth_hint).toBe('normal');
    expect(out.confidence_bucket).toBe('unknown');
    expect(out.last_updated_at).toBeNull();
    expect(out.source_health.user_assistant_state.ok).toBe(true);
  });

  it('returns degraded health when fetch fails', () => {
    const out = compileInteractionStyleContext({
      fetchResult: { ok: false, row: null, reason: 'supabase_unconfigured' },
    });
    expect(out.source_health.user_assistant_state.ok).toBe(false);
    expect(out.source_health.user_assistant_state.reason).toBe('supabase_unconfigured');
    expect(out.confidence_bucket).toBe('unknown');
  });

  it('reads enum fields from row.value verbatim when present', () => {
    const out = compileInteractionStyleContext({
      fetchResult: {
        ok: true,
        row: {
          value: {
            response_style: 'concise',
            pace: 'fast',
            tone: 'direct',
            explanation_depth: 'minimal',
            confidence: 0.92,
          },
          confidence: 0.92,
          updated_at: '2026-05-13T10:00:00Z',
          last_seen_at: '2026-05-13T10:00:00Z',
        },
      },
    });
    expect(out.preferred_response_style).toBe('concise');
    expect(out.interaction_pace).toBe('fast');
    expect(out.tone_preference).toBe('direct');
    expect(out.explanation_depth_hint).toBe('minimal');
    expect(out.confidence_bucket).toBe('high');
    expect(out.last_updated_at).toBe('2026-05-13T10:00:00Z');
  });

  it('coerces unknown enum values to unknown (defensive)', () => {
    const out = compileInteractionStyleContext({
      fetchResult: {
        ok: true,
        row: {
          value: {
            // Cast bypasses TS — proves runtime defensiveness.
            response_style: 'rambling' as any,
            pace: 'glacial' as any,
            tone: 'anxious' as any,
            explanation_depth: 'novel' as any,
          },
          confidence: 0.7,
          updated_at: '2026-05-13T10:00:00Z',
          last_seen_at: '2026-05-13T10:00:00Z',
        },
      },
    });
    expect(out.preferred_response_style).toBe('unknown');
    expect(out.interaction_pace).toBe('unknown');
    expect(out.tone_preference).toBe('unknown');
    expect(out.explanation_depth_hint).toBe('normal');
    expect(out.confidence_bucket).toBe('medium');
  });

  it('falls back to row-level confidence when value.confidence is missing', () => {
    const out = compileInteractionStyleContext({
      fetchResult: {
        ok: true,
        row: {
          value: {
            response_style: 'balanced',
          },
          confidence: 0.45,
          updated_at: null,
          last_seen_at: null,
        },
      },
    });
    expect(out.confidence_bucket).toBe('low');
  });
});

describe('B6 — bucketConfidence', () => {
  it.each<[unknown, ReturnType<typeof bucketConfidence>]>([
    [null,         'unknown'],
    [undefined,    'unknown'],
    [Number.NaN,   'unknown'],
    [-0.1,         'unknown'],
    [0,            'low'],
    [0.3,          'low'],
    [0.49,         'low'],
    [0.5,          'medium'],
    [0.79,         'medium'],
    [0.8,          'high'],
    [1,            'high'],
  ])('bucketConfidence(%p) === %p', (raw, expected) => {
    expect(bucketConfidence(raw as any)).toBe(expected);
  });
});

describe('B6 — wall: no diagnostic / medical labels in shape', () => {
  // The decision shape must not allow strings that read like mental-
  // health diagnoses. We assert by scanning the shipped TS source of
  // the types module.
  it('DecisionInteractionStyle warning enum has no diagnostic terms', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const typesSrc = readFileSync(
      join(__dirname, '../../../src/orb/context/types.ts'),
      'utf8',
    );
    const enumMatch = typesSrc.match(/export type InteractionStyleWarning\s*=([\s\S]*?);/);
    expect(enumMatch).toBeTruthy();
    const enumBody = enumMatch![1];
    const banned = [
      'diagnos', 'symptom', 'disease', 'illness', 'treatment',
      'prescription', 'medication', 'clinical', 'anxious', 'depress',
      'avoidant', 'narcissist', 'borderline', 'bipolar', 'mania',
      'trauma', 'addict',
    ];
    for (const word of banned) {
      expect(enumBody.toLowerCase()).not.toContain(word);
    }
  });
});
