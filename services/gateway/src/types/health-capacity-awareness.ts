/**
 * VTID-01122: Health State, Energy & Capacity Awareness Types (D37)
 *
 * Type definitions for the Health State, Energy & Capacity Awareness Engine.
 * Understands the user's current physical and mental capacity to act —
 * without diagnosing, medicalizing, or overreaching.
 *
 * Hard Constraints (from spec):
 *   - NEVER diagnose or label conditions
 *   - NEVER push intensity upward when energy is low
 *   - Respect self-reported fatigue immediately
 *   - Health inference must always be reversible
 *   - Err on the side of rest and safety
 */

import { z } from 'zod';

// =============================================================================
// Energy State Enums
// =============================================================================

/**
 * Energy state levels (non-diagnostic)
 */
export const EnergyState = z.enum([
  'low',       // User appears fatigued, minimal capacity
  'moderate',  // Normal capacity, can handle regular tasks
  'high',      // Elevated capacity, growth/exploration possible
  'unknown'    // Insufficient signals to infer state
]);
export type EnergyState = z.infer<typeof EnergyState>;

/**
 * Capacity dimension types
 */
export const CapacityDimension = z.enum([
  'physical',   // Movement, attendance, physical effort
  'cognitive',  // Decision-making, planning, problem-solving
  'emotional'   // Social load, novelty tolerance, emotional processing
]);
export type CapacityDimension = z.infer<typeof CapacityDimension>;

/**
 * Action intensity levels
 */
export const IntensityLevel = z.enum([
  'restorative', // Minimal effort, recovery-focused
  'light',       // Low effort, gentle activities
  'moderate',    // Normal effort, regular activities
  'high'         // Growth-oriented, demanding activities
]);
export type IntensityLevel = z.infer<typeof IntensityLevel>;

/**
 * Health context tags for downstream flows
 */
export const HealthContextTag = z.enum([
  'low_energy_mode',     // User is in low energy state
  'restorative_only',    // Only restorative actions should be suggested
  'light_activity_ok',   // Light activities are appropriate
  'moderate_ok',         // Moderate activities are appropriate
  'high_capacity_ok'     // High intensity activities are appropriate
]);
export type HealthContextTag = z.infer<typeof HealthContextTag>;

// =============================================================================
// Capacity Envelope
// =============================================================================

/**
 * Single capacity dimension score
 */
export const CapacityScoreSchema = z.object({
  dimension: CapacityDimension,
  score: z.number().int().min(0).max(100), // 0-100 capacity level
  confidence: z.number().int().min(0).max(100), // 0-100 confidence
  decay_at: z.string().datetime() // ISO timestamp when this score expires
});
export type CapacityScore = z.infer<typeof CapacityScoreSchema>;

/**
 * Capacity envelope - full capacity state across all dimensions
 */
export const CapacityEnvelopeSchema = z.object({
  physical: z.number().int().min(0).max(100),
  cognitive: z.number().int().min(0).max(100),
  emotional: z.number().int().min(0).max(100),
  overall: z.number().int().min(0).max(100), // Min of all dimensions
  confidence: z.number().int().min(0).max(100),
  limiting_dimension: CapacityDimension.nullable() // Which dimension is lowest
});
export type CapacityEnvelope = z.infer<typeof CapacityEnvelopeSchema>;

// =============================================================================
// Energy Signal Sources
// =============================================================================

/**
 * Signal source types - where energy inference comes from
 */
export const SignalSourceType = z.enum([
  'circadian',        // Time of day / circadian patterns
  'interaction',      // Recent interaction patterns
  'self_reported',    // User explicitly stated energy level
  'preference',       // Prior health preferences
  'wearable',         // Optional wearable summaries
  'longevity',        // D26 longevity signals
  'emotional',        // D28 emotional/cognitive signals
  'situational'       // D32 situational awareness
]);
export type SignalSourceType = z.infer<typeof SignalSourceType>;

/**
 * Individual energy signal from a source
 */
export const EnergySignalSchema = z.object({
  source: SignalSourceType,
  state: EnergyState,
  score: z.number().int().min(0).max(100), // 0-100 energy level
  confidence: z.number().int().min(0).max(100), // 0-100 confidence
  evidence: z.string().optional(), // Description of what triggered this signal
  decay_at: z.string().datetime()
});
export type EnergySignal = z.infer<typeof EnergySignalSchema>;

// =============================================================================
// Health-Aligned Actions
// =============================================================================

/**
 * Capacity fit assessment for an action
 */
export const CapacityFit = z.enum([
  'excellent',   // Well within capacity
  'good',        // Comfortable match
  'marginal',    // At the edge of capacity
  'exceeds',     // Beyond current capacity
  'unknown'      // Cannot assess
]);
export type CapacityFit = z.infer<typeof CapacityFit>;

/**
 * Health-aligned action with intensity and capacity fit
 */
export const HealthAlignedActionSchema = z.object({
  action: z.string(), // Action identifier or description
  action_type: z.string().optional(), // Type of action (activity, social, learning, etc.)
  intensity: IntensityLevel,
  capacity_fit: CapacityFit,
  confidence: z.number().int().min(0).max(100),
  reason: z.string().optional(), // Why this action was recommended/filtered
  recommended: z.boolean() // Whether this action is recommended given current capacity
});
export type HealthAlignedAction = z.infer<typeof HealthAlignedActionSchema>;

// =============================================================================
// Capacity State Bundle (Canonical Output)
// =============================================================================

/**
 * Complete capacity state bundle - canonical output of D37
 */
export const CapacityStateBundleSchema = z.object({
  // Core state
  energy_state: EnergyState,
  energy_score: z.number().int().min(0).max(100),
  capacity_envelope: CapacityEnvelopeSchema,

  // Context tags for downstream flows
  context_tags: z.array(HealthContextTag),

  // Recommended intensity range
  min_intensity: IntensityLevel,
  max_intensity: IntensityLevel,

  // Individual signals that contributed
  signals: z.array(EnergySignalSchema),

  // Metadata
  confidence: z.number().int().min(0).max(100),
  decay_at: z.string().datetime(),
  generated_at: z.string().datetime(),

  // Always present disclaimer
  disclaimer: z.string()
});
export type CapacityStateBundle = z.infer<typeof CapacityStateBundleSchema>;

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Compute capacity state request
 */
export const ComputeCapacityRequestSchema = z.object({
  // Optional context from recent interaction
  message: z.string().optional(),
  session_id: z.string().uuid().optional(),

  // Optional self-reported state
  self_reported_energy: EnergyState.optional(),
  self_reported_note: z.string().optional(),

  // Include wearable data if available
  include_wearables: z.boolean().optional().default(false)
});
export type ComputeCapacityRequest = z.infer<typeof ComputeCapacityRequestSchema>;

/**
 * Override capacity state request (user correction)
 */
export const OverrideCapacityRequestSchema = z.object({
  energy_state: EnergyState,
  note: z.string().optional(),
  duration_minutes: z.number().int().min(5).max(480).optional().default(60)
});
export type OverrideCapacityRequest = z.infer<typeof OverrideCapacityRequestSchema>;

/**
 * Filter actions by capacity request
 */
export const FilterActionsRequestSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    action_type: z.string().optional(),
    intensity: IntensityLevel
  })),
  respect_capacity: z.boolean().optional().default(true)
});
export type FilterActionsRequest = z.infer<typeof FilterActionsRequestSchema>;

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Standard API response wrapper
 */
export interface CapacityApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Compute capacity response
 */
export interface ComputeCapacityResponse {
  ok: boolean;
  error?: string;
  message?: string;
  capacity_state?: CapacityStateBundle;
  evidence?: CapacityEvidence;
}

/**
 * Override capacity response
 */
export interface OverrideCapacityResponse {
  ok: boolean;
  error?: string;
  message?: string;
  override_id?: string;
  previous_state?: EnergyState;
  new_state?: EnergyState;
  expires_at?: string;
}

/**
 * Get current capacity response
 */
export interface GetCapacityResponse {
  ok: boolean;
  error?: string;
  message?: string;
  capacity_state?: CapacityStateBundle;
  has_override?: boolean;
  override_expires_at?: string;
}

/**
 * Filter actions response
 */
export interface FilterActionsResponse {
  ok: boolean;
  error?: string;
  message?: string;
  filtered_actions?: HealthAlignedAction[];
  capacity_state?: CapacityStateBundle;
  blocked_count?: number;
  recommended_count?: number;
}

// =============================================================================
// Evidence & Traceability (D59 Support)
// =============================================================================

/**
 * Signal evidence detail
 */
export interface SignalEvidenceDetail {
  source: SignalSourceType;
  type: 'time_context' | 'interaction_pattern' | 'self_report' | 'preference' |
        'wearable_summary' | 'longevity_signal' | 'emotional_signal';
  value?: unknown;
  description: string;
  matched_rules?: string[];
}

/**
 * Circadian evidence
 */
export interface CircadianEvidence {
  current_hour: number;
  time_of_day: 'early_morning' | 'morning' | 'midday' | 'afternoon' |
               'evening' | 'late_night';
  is_typical_low_energy_time: boolean;
  user_circadian_preference?: 'morning_person' | 'night_owl' | 'neutral';
}

/**
 * Interaction pattern evidence
 */
export interface InteractionPatternEvidence {
  avg_response_length_chars?: number;
  response_delay_seconds?: number;
  interaction_count_last_hour?: number;
  is_short_replies?: boolean;
  is_delayed_responses?: boolean;
}

/**
 * Complete evidence trail for explainability
 */
export interface CapacityEvidence {
  circadian: CircadianEvidence;
  interaction_patterns: InteractionPatternEvidence;
  self_reported_signals: SignalEvidenceDetail[];
  longevity_state?: {
    sleep_quality?: number;
    stress_level?: number;
    activity_level?: number;
    source: string;
  };
  emotional_state?: {
    primary_state?: string;
    cognitive_load?: string;
    source: string;
  };
  rules_applied: string[];
}

// =============================================================================
// ORB Integration Types
// =============================================================================

/**
 * Simplified capacity context for ORB system prompt injection
 */
export interface OrbCapacityContext {
  // Energy state
  energy_state: EnergyState;
  energy_score: number;

  // Capacity envelope summary
  physical_capacity: number;
  cognitive_capacity: number;
  emotional_capacity: number;
  limiting_factor?: CapacityDimension;

  // Context tags
  context_tags: HealthContextTag[];

  // Modulation hints for ORB
  intensity_hint: 'restorative' | 'light' | 'moderate' | 'high';
  commitment_hint: 'avoid_new' | 'minimize' | 'normal' | 'open_to_growth';
  social_hint: 'alone_time' | 'minimal' | 'normal' | 'social_ok';

  // Always present
  disclaimer: string;
}

/**
 * Convert CapacityStateBundle to OrbCapacityContext
 */
export function toOrbCapacityContext(bundle: CapacityStateBundle): OrbCapacityContext {
  // Determine intensity hint from max intensity
  let intensityHint: OrbCapacityContext['intensity_hint'] = 'moderate';
  switch (bundle.max_intensity) {
    case 'restorative':
      intensityHint = 'restorative';
      break;
    case 'light':
      intensityHint = 'light';
      break;
    case 'moderate':
      intensityHint = 'moderate';
      break;
    case 'high':
      intensityHint = 'high';
      break;
  }

  // Determine commitment hint based on energy and cognitive capacity
  let commitmentHint: OrbCapacityContext['commitment_hint'] = 'normal';
  if (bundle.energy_state === 'low' || bundle.capacity_envelope.cognitive < 30) {
    commitmentHint = 'avoid_new';
  } else if (bundle.energy_state === 'moderate' && bundle.capacity_envelope.cognitive < 50) {
    commitmentHint = 'minimize';
  } else if (bundle.energy_state === 'high' && bundle.capacity_envelope.cognitive >= 70) {
    commitmentHint = 'open_to_growth';
  }

  // Determine social hint based on emotional capacity
  let socialHint: OrbCapacityContext['social_hint'] = 'normal';
  if (bundle.capacity_envelope.emotional < 30) {
    socialHint = 'alone_time';
  } else if (bundle.capacity_envelope.emotional < 50) {
    socialHint = 'minimal';
  } else if (bundle.capacity_envelope.emotional >= 70) {
    socialHint = 'social_ok';
  }

  return {
    energy_state: bundle.energy_state,
    energy_score: bundle.energy_score,
    physical_capacity: bundle.capacity_envelope.physical,
    cognitive_capacity: bundle.capacity_envelope.cognitive,
    emotional_capacity: bundle.capacity_envelope.emotional,
    limiting_factor: bundle.capacity_envelope.limiting_dimension ?? undefined,
    context_tags: bundle.context_tags,
    intensity_hint: intensityHint,
    commitment_hint: commitmentHint,
    social_hint: socialHint,
    disclaimer: bundle.disclaimer
  };
}

/**
 * Format OrbCapacityContext for system prompt injection
 */
export function formatCapacityContextForPrompt(ctx: OrbCapacityContext): string {
  const lines: string[] = [
    '## Current User Capacity (D37 Health Awareness)',
    `[${ctx.disclaimer}]`,
    ''
  ];

  // Energy state
  lines.push(`- Energy: ${ctx.energy_state} (score: ${ctx.energy_score}%)`);

  // Capacity envelope
  lines.push(`- Physical capacity: ${ctx.physical_capacity}%`);
  lines.push(`- Cognitive capacity: ${ctx.cognitive_capacity}%`);
  lines.push(`- Emotional capacity: ${ctx.emotional_capacity}%`);

  if (ctx.limiting_factor) {
    lines.push(`- Limiting factor: ${ctx.limiting_factor}`);
  }

  // Context tags
  if (ctx.context_tags.length > 0) {
    lines.push(`- Status: ${ctx.context_tags.join(', ')}`);
  }

  lines.push('');
  lines.push('### Response Modulation');
  lines.push(`- Intensity: Suggest ${ctx.intensity_hint} activities only`);
  lines.push(`- Commitments: ${ctx.commitment_hint.replace('_', ' ')}`);
  lines.push(`- Social: ${ctx.social_hint.replace('_', ' ')}`);

  // Behavioral rules
  lines.push('');
  lines.push('### Behavioral Rules');
  if (ctx.energy_state === 'low') {
    lines.push('- DO NOT suggest high-energy activities');
    lines.push('- Prioritize rest and recovery');
    lines.push('- Avoid stacking commitments');
  } else if (ctx.energy_state === 'moderate') {
    lines.push('- Light to moderate activities are OK');
    lines.push('- Ask before suggesting demanding tasks');
  } else if (ctx.energy_state === 'high') {
    lines.push('- Growth and exploration activities are OK');
    lines.push('- User can handle new commitments');
  }

  return lines.join('\n');
}

// =============================================================================
// Database Record Types
// =============================================================================

/**
 * Capacity state record from database
 */
export interface CapacityStateRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id?: string;
  energy_state: EnergyState;
  energy_score: number;
  capacity_envelope: CapacityEnvelope;
  context_tags: HealthContextTag[];
  signals: EnergySignal[];
  evidence: CapacityEvidence;
  is_override: boolean;
  override_note?: string;
  confidence: number;
  decay_at: string;
  created_at: string;
}

/**
 * Capacity override record from database
 */
export interface CapacityOverrideRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  energy_state: EnergyState;
  note?: string;
  previous_state?: EnergyState;
  expires_at: string;
  created_at: string;
}

// =============================================================================
// OASIS Event Types
// =============================================================================

/**
 * OASIS event types for capacity awareness
 */
export const CAPACITY_AWARENESS_EVENT_TYPES = [
  'd37.capacity.computed',
  'd37.capacity.compute.failed',
  'd37.capacity.overridden',
  'd37.actions.filtered',
  'd37.low_energy.detected',
  'd37.recovery.detected'
] as const;

export type CapacityAwarenessEventType = typeof CAPACITY_AWARENESS_EVENT_TYPES[number];

/**
 * OASIS event payload for capacity awareness
 */
export interface CapacityAwarenessEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  session_id?: string;
  energy_state?: EnergyState;
  energy_score?: number;
  context_tags?: HealthContextTag[];
  is_override?: boolean;
  duration_ms?: number;
  signal_count?: number;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default decay time for capacity signals (in minutes)
 */
export const DEFAULT_CAPACITY_DECAY_MINUTES = 30;

/**
 * Default confidence for capacity inference
 */
export const DEFAULT_CAPACITY_CONFIDENCE = 60;

/**
 * Minimum confidence to apply capacity filtering
 */
export const MIN_CONFIDENCE_FOR_FILTERING = 40;

/**
 * Non-clinical disclaimer (always present)
 */
export const CAPACITY_DISCLAIMER =
  'These are probabilistic observations about energy and capacity, ' +
  'not medical or clinical assessments. User corrections override all inferences.';
