/**
 * VTID-01140: D46 Anticipatory Guidance & Pre-emptive Coaching Layer
 *
 * Type definitions for the Anticipatory Guidance system that translates
 * predictive windows (D45) into gentle, pre-emptive guidance that helps
 * the user prepare *before* a risk or opportunity window occurs.
 *
 * D46 answers: "What would help right now, given what's likely coming?"
 *
 * Core Philosophy:
 *   - Memory-first: Leverage existing memory/context
 *   - User consent respected implicitly (guidance only, no enforcement)
 *   - No behavioral enforcement: Suggestions only
 *   - No medical or psychological claims
 *   - Explainability required: Clear lineage signal → window → guidance
 *   - Tone: supportive, non-directive
 *   - All outputs logged to OASIS
 *
 * Hard Constraints:
 *   - No notifications logic (handled by downstream)
 *   - No scheduling (handled by downstream)
 *   - No habit enforcement
 *   - No personalization beyond existing memory
 *
 * Determinism Rules:
 *   - Same predictive windows → same guidance candidates
 *   - Same guidance rules → same output structure
 *   - Rule-based filtering, no generative inference
 */

import { z } from 'zod';

// =============================================================================
// VTID-01140: D44 Signal Types (Expected Input from D44)
// These types define what D46 expects to receive from D44 Pattern Detection
// =============================================================================

/**
 * Signal domains that D44 can detect patterns in
 */
export const SignalDomain = z.enum([
  'health',
  'behavior',
  'social',
  'cognitive',
  'routine',
  'emotional',
  'financial'
]);
export type SignalDomain = z.infer<typeof SignalDomain>;

/**
 * A detected pattern signal from D44
 */
export const PatternSignalSchema = z.object({
  signal_id: z.string().uuid(),
  domain: SignalDomain,
  pattern_type: z.string(), // e.g., 'stress_spike', 'sleep_deficit', 'social_withdrawal'
  intensity: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  trend: z.enum(['increasing', 'decreasing', 'stable', 'volatile']),
  detected_at: z.string().datetime(),
  decay_at: z.string().datetime(),
  evidence_summary: z.string(),
  metadata: z.record(z.unknown()).optional()
});
export type PatternSignal = z.infer<typeof PatternSignalSchema>;

/**
 * Bundle of signals from D44
 */
export const D44SignalBundleSchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  signals: z.array(PatternSignalSchema),
  cognitive_load: z.number().min(0).max(100), // Current cognitive load level
  cognitive_load_trend: z.enum(['increasing', 'decreasing', 'stable']),
  computed_at: z.string().datetime()
});
export type D44SignalBundle = z.infer<typeof D44SignalBundleSchema>;

// =============================================================================
// VTID-01140: D45 Predictive Window Types (Expected Input from D45)
// These types define what D46 expects to receive from D45 Predictive Windows
// =============================================================================

/**
 * Types of predictive windows
 */
export const WindowType = z.enum([
  'risk',        // Risk of negative outcome
  'opportunity', // Opportunity for positive outcome
  'transition',  // Life or context transition
  'recovery',    // Recovery or restoration window
  'peak',        // Peak performance or capacity window
  'low'          // Low capacity or vulnerability window
]);
export type WindowType = z.infer<typeof WindowType>;

/**
 * A predictive window from D45
 */
export const PredictiveWindowSchema = z.object({
  window_id: z.string().uuid(),
  type: WindowType,
  domain: SignalDomain,
  title: z.string().max(100),
  description: z.string().max(500),
  confidence: z.number().min(0).max(100),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime().optional(),
  duration_hours: z.number().min(0).optional(),
  contributing_signals: z.array(z.string().uuid()), // References to D44 signal IDs
  impact_level: z.enum(['low', 'medium', 'high']),
  predicted_at: z.string().datetime(),
  metadata: z.record(z.unknown()).optional()
});
export type PredictiveWindow = z.infer<typeof PredictiveWindowSchema>;

/**
 * Bundle of predictive windows from D45
 */
export const D45WindowBundleSchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  windows: z.array(PredictiveWindowSchema),
  forecast_horizon_hours: z.number().default(72),
  computed_at: z.string().datetime()
});
export type D45WindowBundle = z.infer<typeof D45WindowBundleSchema>;

// =============================================================================
// VTID-01140: Guidance Mode Types (STRICT)
// =============================================================================

/**
 * Guidance modes - exactly one per guidance item
 * No other modes allowed.
 */
export const GuidanceMode = z.enum([
  'awareness',     // Surface observation only
  'reflection',    // Ask a gentle question
  'preparation',   // Suggest a light, optional step
  'reinforcement'  // Amplify positive momentum
]);
export type GuidanceMode = z.infer<typeof GuidanceMode>;

/**
 * Metadata for each guidance mode
 */
export const GUIDANCE_MODE_METADATA: Record<GuidanceMode, {
  label: string;
  description: string;
  example: string;
}> = {
  awareness: {
    label: 'Awareness',
    description: 'Surface observation only',
    example: 'You\'ve been working intensely this week...'
  },
  reflection: {
    label: 'Reflection',
    description: 'Ask a gentle question',
    example: 'What might help you feel more prepared for tomorrow?'
  },
  preparation: {
    label: 'Preparation',
    description: 'Suggest a light, optional step',
    example: 'You might consider setting out your running shoes tonight...'
  },
  reinforcement: {
    label: 'Reinforcement',
    description: 'Amplify positive momentum',
    example: 'Your consistent morning routine seems to be helping...'
  }
};

// =============================================================================
// VTID-01140: Timing Hints
// =============================================================================

/**
 * When to surface the guidance
 */
export const TimingHint = z.enum([
  'now',          // Surface immediately
  'next_24h',     // Surface within next 24 hours
  'before_window' // Surface before the predicted window begins
]);
export type TimingHint = z.infer<typeof TimingHint>;

// =============================================================================
// VTID-01140: Guidance Output Structure (STRICT)
// =============================================================================

/**
 * Generated guidance item - STRICT output structure per spec
 */
export const GuidanceItemSchema = z.object({
  guidance_id: z.string().uuid(),
  source_window_id: z.string().uuid(),
  guidance_mode: GuidanceMode,
  domain: SignalDomain,
  confidence: z.number().min(0).max(100),
  timing_hint: TimingHint,
  guidance_text: z.string().min(1).max(500), // Plain language, optional phrasing
  why_this_matters: z.string().min(1).max(300), // Short explanation
  dismissible: z.boolean().default(true)
});
export type GuidanceItem = z.infer<typeof GuidanceItemSchema>;

/**
 * Extended guidance record for storage
 */
export const GuidanceRecordSchema = GuidanceItemSchema.extend({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),

  // Lineage tracking
  originating_signal_ids: z.array(z.string().uuid()),
  user_preferences_snapshot: z.record(z.unknown()).optional(),

  // State
  status: z.enum(['pending', 'surfaced', 'engaged', 'dismissed', 'expired']),
  surfaced_at: z.string().datetime().nullable().optional(),
  engaged_at: z.string().datetime().nullable().optional(),
  dismissed_at: z.string().datetime().nullable().optional(),

  // Generation metadata
  generation_rules_version: z.string(),
  relevance_score: z.number().min(0).max(100),

  // Audit
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type GuidanceRecord = z.infer<typeof GuidanceRecordSchema>;

// =============================================================================
// VTID-01140: Guidance Generation Rules (STRICT)
// =============================================================================

/**
 * Thresholds for guidance generation
 */
export const GUIDANCE_THRESHOLDS = {
  // Minimum window confidence to generate guidance
  MIN_WINDOW_CONFIDENCE: 70,

  // Minimum relevance score to surface guidance
  MIN_RELEVANCE_SCORE: 75,

  // Cooldown period - no similar guidance within this many days
  COOLDOWN_DAYS: 14,

  // Maximum cognitive load to surface guidance
  // If user cognitive load is marked as 'high' (>70), don't generate guidance
  MAX_COGNITIVE_LOAD: 70,

  // Maximum guidance items to generate per window bundle
  MAX_GUIDANCE_PER_BUNDLE: 5,

  // Maximum guidance items to surface per day
  MAX_GUIDANCE_PER_DAY: 3
} as const;

/**
 * Guidance generation eligibility check result
 */
export const EligibilityCheckResultSchema = z.object({
  eligible: z.boolean(),
  reason: z.string(),
  checks: z.object({
    window_confidence_met: z.boolean(),
    relevance_score_met: z.boolean(),
    cooldown_passed: z.boolean(),
    cognitive_load_acceptable: z.boolean()
  })
});
export type EligibilityCheckResult = z.infer<typeof EligibilityCheckResultSchema>;

// =============================================================================
// VTID-01140: Language & Framing Rules
// =============================================================================

/**
 * Forbidden words/phrases that should not appear in guidance text
 */
export const FORBIDDEN_PHRASES = [
  'must',
  'should',
  'have to',
  'need to',
  'required',
  'mandatory',
  'immediately',
  'urgent',
  'critical',
  'dangerous',
  'warning',
  'alert'
] as const;

/**
 * Suggested optional phrasing patterns
 */
export const OPTIONAL_PHRASING_PATTERNS = [
  'you might consider',
  'one option could be',
  'it may be helpful to',
  'you could',
  'perhaps',
  'when you\'re ready',
  'if it feels right',
  'some find it helpful to',
  'an approach that works for some is'
] as const;

/**
 * Language validation result
 */
export const LanguageValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({
    type: z.enum(['forbidden_phrase', 'missing_optional_phrasing', 'too_direct', 'alarmist']),
    phrase: z.string().optional(),
    suggestion: z.string().optional()
  }))
});
export type LanguageValidationResult = z.infer<typeof LanguageValidationResultSchema>;

// =============================================================================
// VTID-01140: User Context & Preferences (for guidance relevance)
// =============================================================================

/**
 * User preferences relevant to guidance
 */
export const GuidancePreferencesSchema = z.object({
  preferred_tone: z.enum(['brief', 'conversational', 'detailed']).default('conversational'),
  preferred_timing: z.enum(['proactive', 'just_in_time', 'ask_first']).default('proactive'),
  enabled_domains: z.array(SignalDomain).default(['health', 'behavior', 'social', 'cognitive', 'routine']),
  sensitivity_level: z.enum(['low', 'medium', 'high']).default('medium'),
  max_daily_guidance: z.number().min(0).max(10).default(3)
});
export type GuidancePreferences = z.infer<typeof GuidancePreferencesSchema>;

/**
 * Past guidance interaction for determining relevance and cooldown
 */
export const GuidanceInteractionSchema = z.object({
  guidance_id: z.string().uuid(),
  domain: SignalDomain,
  mode: GuidanceMode,
  pattern_type: z.string(),
  interaction: z.enum(['surfaced', 'engaged', 'dismissed']),
  interacted_at: z.string().datetime()
});
export type GuidanceInteraction = z.infer<typeof GuidanceInteractionSchema>;

/**
 * User context for guidance generation
 */
export const UserGuidanceContextSchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  preferences: GuidancePreferencesSchema,
  recent_interactions: z.array(GuidanceInteractionSchema),
  current_cognitive_load: z.number().min(0).max(100),
  guidance_today_count: z.number().min(0)
});
export type UserGuidanceContext = z.infer<typeof UserGuidanceContextSchema>;

// =============================================================================
// VTID-01140: API Request/Response Types
// =============================================================================

/**
 * Generate guidance request
 */
export const GenerateGuidanceRequestSchema = z.object({
  signal_bundle: D44SignalBundleSchema,
  window_bundle: D45WindowBundleSchema,
  user_context: UserGuidanceContextSchema.optional(),
  max_items: z.number().min(1).max(10).default(5)
});
export type GenerateGuidanceRequest = z.infer<typeof GenerateGuidanceRequestSchema>;

/**
 * Generate guidance response
 */
export interface GenerateGuidanceResponse {
  ok: boolean;
  guidance_items?: GuidanceItem[];
  skipped_windows?: Array<{
    window_id: string;
    reason: string;
  }>;
  generation_summary?: {
    windows_evaluated: number;
    guidance_generated: number;
    windows_skipped: number;
    cognitive_load_at_generation: number;
  };
  error?: string;
}

/**
 * Get guidance history request
 */
export const GetGuidanceHistoryRequestSchema = z.object({
  domains: z.array(SignalDomain).optional(),
  status: z.array(z.enum(['pending', 'surfaced', 'engaged', 'dismissed', 'expired'])).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().min(1).max(100).default(20)
});
export type GetGuidanceHistoryRequest = z.infer<typeof GetGuidanceHistoryRequestSchema>;

/**
 * Get guidance history response
 */
export interface GetGuidanceHistoryResponse {
  ok: boolean;
  guidance?: GuidanceRecord[];
  count?: number;
  error?: string;
}

/**
 * Record guidance interaction request
 */
export const RecordGuidanceInteractionRequestSchema = z.object({
  guidance_id: z.string().uuid(),
  interaction: z.enum(['surfaced', 'engaged', 'dismissed']),
  feedback: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional()
});
export type RecordGuidanceInteractionRequest = z.infer<typeof RecordGuidanceInteractionRequestSchema>;

/**
 * Record guidance interaction response
 */
export interface RecordGuidanceInteractionResponse {
  ok: boolean;
  guidance_id?: string;
  new_status?: string;
  error?: string;
}

// =============================================================================
// VTID-01140: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for anticipatory guidance
 */
export const ANTICIPATORY_GUIDANCE_EVENT_TYPES = [
  'guidance.generated',
  'guidance.surfaced',
  'guidance.engaged',
  'guidance.dismissed',
  'guidance.expired',
  'guidance.eligibility.failed',
  'guidance.language.invalid'
] as const;

export type AnticipatoryGuidanceEventType = typeof ANTICIPATORY_GUIDANCE_EVENT_TYPES[number];

/**
 * OASIS event payload for anticipatory guidance
 */
export interface AnticipatoryGuidanceEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  guidance_id?: string;
  source_window_id?: string;
  guidance_mode?: GuidanceMode;
  domain?: SignalDomain;
  confidence?: number;
  eligibility_result?: EligibilityCheckResult;
  language_validation?: LanguageValidationResult;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01140: Guidance Templates
// =============================================================================

/**
 * Template for generating guidance text based on mode and domain
 */
export interface GuidanceTemplate {
  mode: GuidanceMode;
  domain: SignalDomain;
  window_type: WindowType;
  text_template: string;
  why_template: string;
}

/**
 * Template registry key
 */
export function getTemplateKey(mode: GuidanceMode, domain: SignalDomain, windowType: WindowType): string {
  return `${mode}:${domain}:${windowType}`;
}

