/**
 * VTID-02962 (B6) — compileInteractionStyleContext.
 *
 * Pure function over an optional `InteractionStyleSignalRow`. Produces
 * the distilled `InteractionStyleContext` the Command Hub preview
 * consumes (and the decision adapter narrows further).
 *
 * Distillation policy:
 *   - Each enum field is read from `row.value.*`. Missing → 'unknown',
 *     except `explanation_depth` which defaults to 'normal' so the
 *     renderer always reads a usable value.
 *   - `confidence` is bucketed via two thresholds (low <0.5, medium
 *     <0.8, high otherwise). The compiler prefers `value.confidence`
 *     when present, else the row-level `confidence` column, else
 *     'unknown'.
 *   - When the row is absent (user has no recorded preference yet)
 *     the compiler returns an all-'unknown' shape with
 *     `last_updated_at: null` and `source_health.user_assistant_state.ok = true`
 *     — that's the steady-state default, NOT a failure.
 *
 * No IO. No mutation. No clock side-effects (the row arrives with
 * `updated_at` already pre-formatted by the fetcher).
 */

import type {
  InteractionExplanationDepth,
  InteractionPace,
  InteractionStyleConfidenceBucket,
  PreferredResponseStyle,
  TonePreference,
} from '../../orb/context/types';
import type {
  InteractionStyleContext,
  InteractionStyleSignalRow,
} from './types';

export interface CompileInteractionStyleContextInputs {
  fetchResult: {
    ok: boolean;
    /** Null when no row exists; that's not a failure. */
    row: InteractionStyleSignalRow | null;
    reason?: string;
  };
}

/** Confidence thresholds — bucketed at compile time, never exported in shape. */
const CONFIDENCE_MEDIUM_THRESHOLD = 0.5;
const CONFIDENCE_HIGH_THRESHOLD = 0.8;

const RESPONSE_STYLES: ReadonlySet<PreferredResponseStyle> = new Set([
  'concise',
  'balanced',
  'detailed',
  'unknown',
]);
const PACES: ReadonlySet<InteractionPace> = new Set([
  'slow',
  'normal',
  'fast',
  'unknown',
]);
const TONES: ReadonlySet<TonePreference> = new Set([
  'direct',
  'warm',
  'coaching',
  'neutral',
  'unknown',
]);
const DEPTHS: ReadonlySet<InteractionExplanationDepth> = new Set([
  'minimal',
  'normal',
  'expanded',
]);

export function compileInteractionStyleContext(
  input: CompileInteractionStyleContextInputs,
): InteractionStyleContext {
  const fetchOk = input.fetchResult.ok;
  const row = fetchOk ? input.fetchResult.row : null;

  if (!fetchOk) {
    return makeEmpty({
      ok: false,
      reason: input.fetchResult.reason ?? 'unknown_failure',
    });
  }

  if (!row) {
    return makeEmpty({ ok: true });
  }

  const value = row.value ?? {};

  const preferred_response_style = pickEnum(
    RESPONSE_STYLES,
    value.response_style,
    'unknown',
  ) as PreferredResponseStyle;

  const interaction_pace = pickEnum(
    PACES,
    value.pace,
    'unknown',
  ) as InteractionPace;

  const tone_preference = pickEnum(
    TONES,
    value.tone,
    'unknown',
  ) as TonePreference;

  const explanation_depth_hint = pickEnum(
    DEPTHS,
    value.explanation_depth,
    'normal',
  ) as InteractionExplanationDepth;

  const confidence_bucket = bucketConfidence(
    value.confidence ?? row.confidence,
  );

  return {
    preferred_response_style,
    interaction_pace,
    tone_preference,
    explanation_depth_hint,
    confidence_bucket,
    last_updated_at: row.updated_at ?? null,
    source_health: { user_assistant_state: { ok: true } },
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

function makeEmpty(
  health: { ok: boolean; reason?: string },
): InteractionStyleContext {
  return {
    preferred_response_style: 'unknown',
    interaction_pace: 'unknown',
    tone_preference: 'unknown',
    explanation_depth_hint: 'normal',
    confidence_bucket: 'unknown',
    last_updated_at: null,
    source_health: {
      user_assistant_state: health,
    },
  };
}

function pickEnum<T extends string>(
  allowed: ReadonlySet<T>,
  raw: T | undefined,
  fallback: T,
): T {
  if (raw === undefined || raw === null) return fallback;
  return allowed.has(raw) ? raw : fallback;
}

export function bucketConfidence(
  raw: number | null | undefined,
): InteractionStyleConfidenceBucket {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return 'unknown';
  if (raw < 0) return 'unknown';
  if (raw < CONFIDENCE_MEDIUM_THRESHOLD) return 'low';
  if (raw < CONFIDENCE_HIGH_THRESHOLD) return 'medium';
  return 'high';
}
