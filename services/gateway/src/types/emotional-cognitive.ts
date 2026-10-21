/**
 * VTID-01120: Emotional & Cognitive Signal Types (D28)
 *
 * Type definitions for the Emotional & Cognitive Signal Interpretation Engine.
 * Signals are probabilistic behavioral observations, NOT clinical assessments.
 *
 * Hard Constraints (from spec):
 *   - NO medical or psychological diagnosis
 *   - NO permanent emotional labeling
 *   - NO autonomy escalation from signals alone
 *   - Signals only modulate tone, pacing, and depth
 */

// =============================================================================
// Signal State Enums
// =============================================================================

/**
 * Emotional states that can be detected (non-diagnostic)
 */
export type EmotionalState =
  | 'calm'
  | 'stressed'
  | 'frustrated'
  | 'motivated'
  | 'anxious'
  | 'neutral';

/**
 * Cognitive states that can be detected (non-diagnostic)
 */
export type CognitiveState =
  | 'focused'
  | 'overloaded'
  | 'fatigued'
  | 'engaged'
  | 'distracted'
  | 'neutral';

/**
 * Engagement levels (aggregated from multiple signals)
 */
export type EngagementLevel = 'high' | 'medium' | 'low';

// =============================================================================
// Signal Components
// =============================================================================

/**
 * Individual emotional state signal with score and confidence
 */
export interface EmotionalStateSignal {
  state: EmotionalState;
  score: number; // 0-100, intensity of the detected state
  confidence: number; // 0-100, how confident we are in this detection
  decay_at: string; // ISO timestamp when this signal expires
}

/**
 * Individual cognitive state signal with score and confidence
 */
export interface CognitiveStateSignal {
  state: CognitiveState;
  score: number; // 0-100, intensity of the detected state
  confidence: number; // 0-100, how confident we are in this detection
  decay_at: string; // ISO timestamp when this signal expires
}

/**
 * Binary signal with confidence (urgency, hesitation)
 */
export interface BinarySignal {
  detected: boolean;
  confidence: number; // 0-100
}

// =============================================================================
// Signal Bundle (Canonical Output)
// =============================================================================

/**
 * Complete signal bundle as defined in spec
 *
 * All signals include:
 * - confidence score
 * - decay timer
 * - non-clinical disclaimer
 */
export interface SignalBundle {
  emotional_states: EmotionalStateSignal[];
  cognitive_states: CognitiveStateSignal[];
  engagement_level: EngagementLevel;
  engagement_confidence: number;
  urgency: BinarySignal;
  hesitation: BinarySignal;
  decay_at: string;
  disclaimer: string; // Always present: "These signals are probabilistic behavioral observations, not clinical assessments."
}

// =============================================================================
// Signal Inputs
// =============================================================================

/**
 * Input parameters for signal computation
 *
 * Signals are inferred from:
 * 1. Language patterns (from message)
 * 2. Conversation pacing (response_time_seconds)
 * 3. Correction frequency (correction_count)
 * 4. Interaction length (interaction_count)
 * 5. Time-of-day context (derived from server time)
 * 6. Recent behavior (from D26 longevity state)
 */
export interface SignalComputeInput {
  message: string;
  session_id?: string;
  turn_id?: string;
  response_time_seconds?: number;
  correction_count?: number;
  interaction_count?: number;
}

// =============================================================================
// Evidence & Traceability
// =============================================================================

/**
 * Match detail from a rule evaluation
 */
export interface RuleMatchDetail {
  rule: string;
  type: 'keyword_match' | 'pattern_match' | 'time_context' | 'pacing_check' | 'correction_frequency' | 'longevity_state';
  matched_keywords?: string[];
  matched_patterns?: string[];
  description?: string;
  [key: string]: unknown;
}

/**
 * Time context evidence
 */
export interface TimeContextEvidence {
  current_hour: number;
  is_late_night: boolean;
  response_time_seconds?: number;
  correction_count: number;
  interaction_count: number;
  matched_rules?: RuleMatchDetail[];
}

/**
 * Longevity state evidence (from D26)
 */
export interface LongevityStateEvidence {
  sleep_quality?: number;
  stress_level?: number;
  social_score?: number;
  source: string;
  matched_rules?: RuleMatchDetail[];
}

/**
 * Evidence trail for explainability (D59 support)
 */
export interface SignalEvidence {
  language_patterns: RuleMatchDetail[];
  pacing_signals: RuleMatchDetail[];
  correction_signals: RuleMatchDetail[];
  time_context: TimeContextEvidence;
  longevity_state: LongevityStateEvidence;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Response from emotional_cognitive_compute RPC
 */
export interface SignalComputeResponse {
  ok: boolean;
  error?: string;
  message?: string;
  signal_bundle?: SignalBundle;
  evidence?: SignalEvidence;
  rules_applied?: string[];
  tenant_id?: string;
  user_id?: string;
  session_id?: string;
  turn_id?: string;
}

/**
 * Individual signal record from database
 */
export interface SignalRecord {
  id: string;
  session_id?: string;
  turn_id?: string;
  emotional_states: EmotionalStateSignal[];
  cognitive_states: CognitiveStateSignal[];
  engagement_level: EngagementLevel;
  engagement_confidence: number;
  urgency: BinarySignal;
  hesitation: BinarySignal;
  decay_at: string;
  created_at: string;
  disclaimer: string;
}

/**
 * Response from emotional_cognitive_get_current RPC
 */
export interface GetCurrentSignalsResponse {
  ok: boolean;
  error?: string;
  message?: string;
  signals?: SignalRecord[];
  count?: number;
  session_id?: string;
}

/**
 * Response from emotional_cognitive_override RPC
 */
export interface SignalOverrideResponse {
  ok: boolean;
  error?: string;
  message?: string;
  signal_id?: string;
  override?: Record<string, unknown>;
}

/**
 * Applied rule detail for explain endpoint
 */
export interface AppliedRule {
  rule_key: string;
  rule_version: number;
  domain: 'emotional' | 'cognitive' | 'engagement' | 'urgency' | 'hesitation';
  target_state: string;
  logic: Record<string, unknown>;
  weight: number;
  decay_minutes: number;
}

/**
 * Response from emotional_cognitive_explain RPC
 */
export interface SignalExplainResponse {
  ok: boolean;
  error?: string;
  message?: string;
  signal_id?: string;
  signal_bundle?: SignalBundle;
  evidence?: SignalEvidence;
  rules_applied?: AppliedRule[];
  rules_applied_keys?: string[];
  decay_at?: string;
  decayed?: boolean;
  created_at?: string;
  disclaimer?: string;
}

// =============================================================================
// ORB Integration Types
// =============================================================================

/**
 * Simplified signal summary for ORB context injection
 * Used by ORB Memory Bridge to modulate response tone/pacing/depth
 */
export interface OrbSignalContext {
  /** Primary emotional state (highest score) */
  primary_emotional_state?: EmotionalState;
  emotional_confidence?: number;

  /** Primary cognitive state (highest score) */
  primary_cognitive_state?: CognitiveState;
  cognitive_confidence?: number;

  /** Engagement level */
  engagement_level: EngagementLevel;

  /** Key flags */
  is_urgent: boolean;
  is_hesitant: boolean;

  /** Modulation hints for ORB */
  tone_hint: 'calming' | 'encouraging' | 'neutral' | 'patient';
  pacing_hint: 'slower' | 'normal' | 'match_energy';
  depth_hint: 'simplified' | 'normal' | 'detailed';

  /** Always present */
  disclaimer: string;
}

/**
 * Convert a SignalBundle to OrbSignalContext for context injection
 */
export function toOrbContext(bundle: SignalBundle): OrbSignalContext {
  // Find primary emotional state (highest score)
  const primaryEmotional = bundle.emotional_states.length > 0
    ? bundle.emotional_states.reduce((a, b) => a.score > b.score ? a : b)
    : null;

  // Find primary cognitive state (highest score)
  const primaryCognitive = bundle.cognitive_states.length > 0
    ? bundle.cognitive_states.reduce((a, b) => a.score > b.score ? a : b)
    : null;

  // Determine tone hint based on emotional state
  let toneHint: OrbSignalContext['tone_hint'] = 'neutral';
  if (primaryEmotional) {
    switch (primaryEmotional.state) {
      case 'stressed':
      case 'anxious':
        toneHint = 'calming';
        break;
      case 'frustrated':
        toneHint = 'patient';
        break;
      case 'motivated':
        toneHint = 'encouraging';
        break;
    }
  }

  // Determine pacing hint based on cognitive state
  let pacingHint: OrbSignalContext['pacing_hint'] = 'normal';
  if (primaryCognitive) {
    switch (primaryCognitive.state) {
      case 'overloaded':
      case 'fatigued':
        pacingHint = 'slower';
        break;
      case 'focused':
      case 'engaged':
        pacingHint = 'match_energy';
        break;
    }
  }

  // Determine depth hint
  let depthHint: OrbSignalContext['depth_hint'] = 'normal';
  if (primaryCognitive?.state === 'overloaded' || primaryCognitive?.state === 'fatigued') {
    depthHint = 'simplified';
  } else if (primaryCognitive?.state === 'focused' && bundle.engagement_level === 'high') {
    depthHint = 'detailed';
  }

  return {
    primary_emotional_state: primaryEmotional?.state,
    emotional_confidence: primaryEmotional?.confidence,
    primary_cognitive_state: primaryCognitive?.state,
    cognitive_confidence: primaryCognitive?.confidence,
    engagement_level: bundle.engagement_level,
    is_urgent: bundle.urgency.detected,
    is_hesitant: bundle.hesitation.detected,
    tone_hint: toneHint,
    pacing_hint: pacingHint,
    depth_hint: depthHint,
    disclaimer: bundle.disclaimer
  };
}

/**
 * Format OrbSignalContext for system prompt injection
 */
export function formatSignalContextForPrompt(ctx: OrbSignalContext): string {
  const lines: string[] = [
    '## Current User State (D28 Signals)',
    `[${ctx.disclaimer}]`,
    ''
  ];

  if (ctx.primary_emotional_state && ctx.emotional_confidence && ctx.emotional_confidence >= 50) {
    lines.push(`- Emotional: ${ctx.primary_emotional_state} (confidence: ${ctx.emotional_confidence}%)`);
  }

  if (ctx.primary_cognitive_state && ctx.cognitive_confidence && ctx.cognitive_confidence >= 50) {
    lines.push(`- Cognitive: ${ctx.primary_cognitive_state} (confidence: ${ctx.cognitive_confidence}%)`);
  }

  lines.push(`- Engagement: ${ctx.engagement_level}`);

  if (ctx.is_urgent) {
    lines.push('- URGENT: User has expressed time pressure');
  }

  if (ctx.is_hesitant) {
    lines.push('- User seems uncertain or hesitant');
  }

  lines.push('');
  lines.push('### Response Modulation');
  lines.push(`- Tone: ${ctx.tone_hint}`);
  lines.push(`- Pacing: ${ctx.pacing_hint}`);
  lines.push(`- Depth: ${ctx.depth_hint}`);

  return lines.join('\n');
}
