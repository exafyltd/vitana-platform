/**
 * VTID-01121: User Feedback, Correction & Trust Repair Engine
 *
 * Type definitions for the deterministic feedback and correction loop.
 * Core principle: Intelligence that cannot be corrected becomes dangerous.
 * All feedback is first-class input and authoritative.
 */

import { z } from 'zod';

// =============================================================================
// VTID-01121: Feedback Types
// =============================================================================

/**
 * Supported feedback types that the engine MUST handle.
 * All feedback is first-class input.
 */
export const FEEDBACK_TYPES = [
  'explicit_correction',      // "that's wrong"
  'preference_clarification', // clarifying preferences
  'boundary_enforcement',     // setting boundaries
  'tone_adjustment',          // tone adjustment requests
  'suggestion_rejection',     // rejection of suggestions
  'autonomy_refusal'          // refusal of autonomy
] as const;

export type FeedbackType = typeof FEEDBACK_TYPES[number];

/**
 * Correction targets - what is being corrected
 */
export const CORRECTION_TARGETS = [
  'memory',         // Correcting stored memory
  'preference',     // Correcting inferred preference
  'behavior',       // Correcting behavior pattern
  'recommendation', // Correcting recommendation logic
  'inference',      // Correcting inference/assumption
  'topic',          // Correcting topic classification
  'tone',           // Correcting tone/communication style
  'autonomy'        // Correcting autonomy level
] as const;

export type CorrectionTarget = typeof CORRECTION_TARGETS[number];

/**
 * Safety categories for escalation
 */
export const SAFETY_CATEGORIES = [
  'medical',     // Medical/health-related correction
  'emotional',   // Emotionally sensitive correction
  'sensitive',   // Other sensitive content
  'privacy'      // Privacy-related correction
] as const;

export type SafetyCategory = typeof SAFETY_CATEGORIES[number];

// =============================================================================
// VTID-01121: Request Schemas
// =============================================================================

/**
 * Submit feedback correction request schema
 */
export const SubmitCorrectionRequestSchema = z.object({
  feedback_type: z.enum(FEEDBACK_TYPES),
  correction_target: z.enum(CORRECTION_TARGETS),
  correction_detail: z.string().min(1).max(2000),
  affected_memory_ids: z.array(z.string().uuid()).optional(),
  affected_state_keys: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  context: z.record(z.unknown()).optional()
});

export type SubmitCorrectionRequest = z.infer<typeof SubmitCorrectionRequestSchema>;

/**
 * Get corrections history query schema
 */
export const GetCorrectionsQuerySchema = z.object({
  feedback_type: z.enum(FEEDBACK_TYPES).optional(),
  correction_target: z.enum(CORRECTION_TARGETS).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export type GetCorrectionsQuery = z.infer<typeof GetCorrectionsQuerySchema>;

/**
 * Add behavior constraint request schema
 */
export const AddConstraintRequestSchema = z.object({
  constraint_type: z.enum([
    'never_suggest',
    'always_ask_first',
    'confidence_cap',
    'require_confirmation',
    'topic_block',
    'behavior_block',
    'preference_override'
  ] as const),
  constraint_key: z.string().min(1).max(255),
  constraint_value: z.record(z.unknown()).optional(),
  expires_at: z.string().datetime().optional()
});

export type AddConstraintRequest = z.infer<typeof AddConstraintRequestSchema>;

/**
 * Constraint types
 */
export const CONSTRAINT_TYPES = [
  'never_suggest',        // Never suggest this topic/action again
  'always_ask_first',     // Always ask before doing this
  'confidence_cap',       // Cap confidence on this topic
  'require_confirmation', // Require explicit confirmation
  'topic_block',          // Block entire topic
  'behavior_block',       // Block specific behavior pattern
  'preference_override'   // Override inferred preference
] as const;

export type ConstraintType = typeof CONSTRAINT_TYPES[number];

// =============================================================================
// VTID-01121: Core Interfaces
// =============================================================================

/**
 * Feedback correction record
 */
export interface FeedbackCorrection {
  id: string;
  tenant_id: string;
  user_id: string;
  feedback_type: FeedbackType;
  correction_target: CorrectionTarget;
  correction_detail: string;
  affected_memory_ids: string[];
  affected_rule_ids: string[];
  affected_state_keys: string[];
  changes_applied: ChangesApplied;
  trust_impact_score: number;
  safety_escalation: boolean;
  safety_category: SafetyCategory | null;
  propagated: boolean;
  propagated_at: string | null;
  propagation_log: PropagationLog | null;
  created_at: string;
  session_id: string | null;
  context_snapshot: Record<string, unknown> | null;
}

/**
 * Changes applied to the system
 */
export interface ChangesApplied {
  confidence_before?: number;
  confidence_after?: number;
  constraint_added?: string;
  memory_updated?: boolean;
  preference_changed?: boolean;
  behavior_blocked?: boolean;
  topic_dampened?: string;
  rule_modified?: string;
  [key: string]: unknown;
}

/**
 * Propagation log for downstream layers
 */
export interface PropagationLog {
  layers_notified: string[];
  memory_updated: boolean;
  preferences_updated: boolean;
  constraints_added: string[];
  timestamp: string;
}

/**
 * Trust repair action types
 */
export const REPAIR_ACTIONS = [
  'acknowledged',        // ORB acknowledged the mistake
  'correction_applied',  // Correction was applied to system
  'behavior_changed',    // Behavior demonstrably changed
  'trust_recovering',    // Trust score increasing
  'trust_restored',      // Trust fully restored
  'repeated_error',      // Same error occurred again (negative)
  'constraint_added',    // New constraint added to prevent recurrence
  'rule_updated'         // Existing rule was updated
] as const;

export type RepairAction = typeof REPAIR_ACTIONS[number];

/**
 * Trust repair log entry
 */
export interface TrustRepairEntry {
  id: string;
  tenant_id: string;
  user_id: string;
  feedback_correction_id: string | null;
  repair_action: RepairAction;
  trust_score_before: number;
  trust_score_after: number;
  trust_delta: number;
  repair_details: RepairDetails;
  created_at: string;
}

/**
 * Details of trust repair action
 */
export interface RepairDetails {
  acknowledgment?: string;
  constraint?: string;
  behavior_change?: string;
  prevention_measure?: string;
  [key: string]: unknown;
}

/**
 * Behavior constraint
 */
export interface BehaviorConstraint {
  id: string;
  tenant_id: string;
  user_id: string;
  feedback_correction_id: string | null;
  constraint_type: ConstraintType;
  constraint_key: string;
  constraint_value: Record<string, unknown>;
  active: boolean;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  created_at: string;
  expires_at: string | null;
}

/**
 * User trust score
 */
export interface UserTrustScore {
  id: string;
  tenant_id: string;
  user_id: string;
  trust_score: number;
  correction_count: number;
  repair_count: number;
  repeated_error_count: number;
  trust_trend: 'improving' | 'stable' | 'declining';
  last_correction_at: string | null;
  last_repair_at: string | null;
  total_corrections: number;
  total_repairs: number;
  active_constraints: number;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// VTID-01121: Response Interfaces
// =============================================================================

/**
 * Submit correction response
 */
export interface SubmitCorrectionResponse {
  ok: boolean;
  correction_id?: string;
  feedback_type?: FeedbackType;
  correction_target?: CorrectionTarget;
  changes_applied?: ChangesApplied;
  trust_impact?: number;
  constraints_added?: string[];
  safety_escalated?: boolean;
  error?: string;
  message?: string;
}

/**
 * Get corrections response
 */
export interface GetCorrectionsResponse {
  ok: boolean;
  corrections?: FeedbackCorrection[];
  count?: number;
  query?: GetCorrectionsQuery;
  error?: string;
}

/**
 * Trust score response
 */
export interface TrustScoreResponse {
  ok: boolean;
  trust_score?: UserTrustScore;
  recent_repairs?: TrustRepairEntry[];
  active_constraints_count?: number;
  error?: string;
}

/**
 * Constraints response
 */
export interface ConstraintsResponse {
  ok: boolean;
  constraints?: BehaviorConstraint[];
  count?: number;
  error?: string;
}

/**
 * Add constraint response
 */
export interface AddConstraintResponse {
  ok: boolean;
  constraint_id?: string;
  constraint_type?: ConstraintType;
  constraint_key?: string;
  error?: string;
}

/**
 * Remove constraint response
 */
export interface RemoveConstraintResponse {
  ok: boolean;
  constraint_id?: string;
  deactivated?: boolean;
  error?: string;
}

// =============================================================================
// VTID-01121: Processing Rules (Deterministic)
// =============================================================================

/**
 * Deterministic rules for processing feedback.
 * Same feedback → same correction outcome.
 * No emotional interpretation - rule-based updates only.
 */
export const FEEDBACK_PROCESSING_RULES: Record<FeedbackType, {
  default_trust_impact: number;
  requires_propagation: boolean;
  creates_constraint: boolean;
  confidence_adjustment: number;
}> = {
  explicit_correction: {
    default_trust_impact: -15,
    requires_propagation: true,
    creates_constraint: true,
    confidence_adjustment: -0.4
  },
  preference_clarification: {
    default_trust_impact: -5,
    requires_propagation: true,
    creates_constraint: false,
    confidence_adjustment: -0.2
  },
  boundary_enforcement: {
    default_trust_impact: -10,
    requires_propagation: true,
    creates_constraint: true,
    confidence_adjustment: -0.5
  },
  tone_adjustment: {
    default_trust_impact: -3,
    requires_propagation: true,
    creates_constraint: false,
    confidence_adjustment: -0.1
  },
  suggestion_rejection: {
    default_trust_impact: -8,
    requires_propagation: true,
    creates_constraint: true,
    confidence_adjustment: -0.3
  },
  autonomy_refusal: {
    default_trust_impact: -12,
    requires_propagation: true,
    creates_constraint: true,
    confidence_adjustment: -0.6
  }
};

/**
 * Trust repair rules (deterministic)
 */
export const TRUST_REPAIR_RULES: Record<RepairAction, {
  trust_delta: number;
  requires_confirmation: boolean;
}> = {
  acknowledged: { trust_delta: 2, requires_confirmation: false },
  correction_applied: { trust_delta: 5, requires_confirmation: false },
  behavior_changed: { trust_delta: 10, requires_confirmation: true },
  trust_recovering: { trust_delta: 3, requires_confirmation: false },
  trust_restored: { trust_delta: 15, requires_confirmation: true },
  repeated_error: { trust_delta: -20, requires_confirmation: false },
  constraint_added: { trust_delta: 5, requires_confirmation: false },
  rule_updated: { trust_delta: 5, requires_confirmation: false }
};

/**
 * Safety escalation keywords for automatic detection
 */
export const SAFETY_ESCALATION_KEYWORDS: Record<SafetyCategory, string[]> = {
  medical: ['medication', 'medicine', 'doctor', 'hospital', 'health', 'diagnosis', 'treatment', 'symptom', 'prescription'],
  emotional: ['anxiety', 'depression', 'stress', 'trauma', 'grief', 'fear', 'panic', 'crisis'],
  sensitive: ['personal', 'private', 'confidential', 'secret', 'family'],
  privacy: ['data', 'share', 'access', 'permission', 'consent', 'tracking']
};

export default {
  FEEDBACK_TYPES,
  CORRECTION_TARGETS,
  SAFETY_CATEGORIES,
  CONSTRAINT_TYPES,
  REPAIR_ACTIONS,
  FEEDBACK_PROCESSING_RULES,
  TRUST_REPAIR_RULES,
  SAFETY_ESCALATION_KEYWORDS,
  SubmitCorrectionRequestSchema,
  GetCorrectionsQuerySchema,
  AddConstraintRequestSchema
};
