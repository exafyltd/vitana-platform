/**
 * VTID-01121: User Feedback, Correction & Trust Repair Engine
 *
 * TypeScript types for the feedback and correction system.
 * Supports deterministic correction processing with trust repair.
 */

// =============================================================================
// Feedback Types
// =============================================================================

/**
 * Supported feedback types as per VTID-01121 spec.
 */
export const FEEDBACK_TYPES = [
  'explicit_correction',      // "that's wrong"
  'preference_clarification', // User clarifies preferences
  'boundary_enforcement',     // User sets hard boundaries
  'tone_adjustment',          // Adjust communication style
  'suggestion_rejection',     // User rejects suggestion
  'autonomy_refusal',         // User declines ORB autonomy
] as const;

export type FeedbackType = typeof FEEDBACK_TYPES[number];

/**
 * Affected components that can receive corrections.
 */
export const AFFECTED_COMPONENTS = [
  'general',
  'memory',
  'preferences',
  'behavior',
  'tone',
  'autonomy',
  'suggestions',
  'health',
  'relationships',
] as const;

export type AffectedComponent = typeof AFFECTED_COMPONENTS[number];

/**
 * Correction source - where the feedback originated.
 */
export const CORRECTION_SOURCES = ['orb', 'app', 'api', 'system'] as const;
export type CorrectionSource = typeof CORRECTION_SOURCES[number];

/**
 * Correction processing status.
 */
export const CORRECTION_STATUSES = ['pending', 'processing', 'applied', 'propagated', 'failed'] as const;
export type CorrectionStatus = typeof CORRECTION_STATUSES[number];

// =============================================================================
// Behavior Constraint Types
// =============================================================================

/**
 * Types of behavior constraints.
 */
export const CONSTRAINT_TYPES = [
  'blocked_behavior',
  'blocked_topic',
  'blocked_suggestion',
  'blocked_tone',
  'boundary',
] as const;

export type ConstraintType = typeof CONSTRAINT_TYPES[number];

/**
 * Behavior constraint record.
 */
export interface BehaviorConstraint {
  id: string;
  constraint_type: ConstraintType;
  constraint_key: string;
  description: string;
  strength: number;  // 0-100, 100 = hard block
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  source_correction_id?: string;
}

// =============================================================================
// Trust Score Types
// =============================================================================

/**
 * Components that have trust scores.
 */
export const TRUST_COMPONENTS = [
  'overall',
  'memory',
  'suggestions',
  'preferences',
  'autonomy',
  'tone',
  'health_advice',
  'relationships',
] as const;

export type TrustComponent = typeof TRUST_COMPONENTS[number];

/**
 * Trust score record.
 */
export interface TrustScore {
  component: TrustComponent;
  score: number;  // 0-100
  corrections_count: number;
  consecutive_corrections: number;
  last_correction_at: string | null;
  last_positive_at: string | null;
  recovery_actions_taken: number;
  updated_at: string;
}

/**
 * Trust level derived from score.
 */
export type TrustLevel = 'critical' | 'low' | 'medium' | 'high' | 'full';

/**
 * Get trust level from numeric score.
 */
export function getTrustLevel(score: number): TrustLevel {
  if (score < 20) return 'critical';
  if (score < 40) return 'low';
  if (score < 60) return 'medium';
  if (score < 80) return 'high';
  return 'full';
}

// =============================================================================
// Safety Flag Types
// =============================================================================

/**
 * Types of safety flags.
 */
export const SAFETY_FLAG_TYPES = [
  'medical_correction',
  'emotional_correction',
  'abuse_detected',
  'noise_detected',
  'escalation_required',
] as const;

export type SafetyFlagType = typeof SAFETY_FLAG_TYPES[number];

/**
 * Safety flag severity levels.
 */
export const SAFETY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SafetySeverity = typeof SAFETY_SEVERITIES[number];

/**
 * Safety flag record.
 */
export interface SafetyFlag {
  id: string;
  flag_type: SafetyFlagType;
  severity: SafetySeverity;
  description: string;
  is_resolved: boolean;
  resolution_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  source_correction_id?: string;
}

// =============================================================================
// User Correction Types
// =============================================================================

/**
 * Context for a user correction.
 */
export interface CorrectionContext {
  conversation_id?: string;
  session_id?: string;
  message_id?: string;
  orb_response?: string;
  user_message?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Processing result from a correction.
 */
export interface CorrectionProcessingResult {
  propagations: PropagationRecord[];
  trust_impact: number;
  safety_flagged: boolean;
}

/**
 * Full user correction record.
 */
export interface UserCorrection {
  id: string;
  feedback_type: FeedbackType;
  content: string;
  context: CorrectionContext;
  affected_component: AffectedComponent;
  affected_item_id?: string;
  affected_item_type?: string;
  status: CorrectionStatus;
  processing_result?: CorrectionProcessingResult;
  session_id?: string;
  source: CorrectionSource;
  created_at: string;
  processed_at?: string;
}

// =============================================================================
// Propagation Types
// =============================================================================

/**
 * Target layers for feedback propagation.
 */
export const PROPAGATION_LAYERS = [
  'memory',
  'preferences',
  'behavior_constraints',
  'trust_scores',
  'topic_profile',
  'relationship_edges',
] as const;

export type PropagationLayer = typeof PROPAGATION_LAYERS[number];

/**
 * Propagation actions.
 */
export const PROPAGATION_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'downgraded',
  'blocked',
  'flagged',
] as const;

export type PropagationAction = typeof PROPAGATION_ACTIONS[number];

/**
 * Record of a propagation event.
 */
export interface PropagationRecord {
  target_layer: PropagationLayer;
  target_item_id?: string;
  action: PropagationAction;
  details: Record<string, unknown>;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Request to record a user correction.
 */
export interface RecordCorrectionRequest {
  feedback_type: FeedbackType;
  content: string;
  context?: CorrectionContext;
  affected_component?: AffectedComponent;
  affected_item_id?: string;
  affected_item_type?: string;
  session_id?: string;
  source?: CorrectionSource;
}

/**
 * Response from recording a correction.
 */
export interface RecordCorrectionResponse {
  ok: boolean;
  correction_id?: string;
  feedback_type?: FeedbackType;
  affected_component?: AffectedComponent;
  trust_impact?: number;
  propagations?: PropagationRecord[];
  safety_flagged?: boolean;
  error?: string;
}

/**
 * Response from getting trust scores.
 */
export interface GetTrustScoresResponse {
  ok: boolean;
  scores?: TrustScore[];
  count?: number;
  error?: string;
}

/**
 * Response from getting behavior constraints.
 */
export interface GetConstraintsResponse {
  ok: boolean;
  constraints?: BehaviorConstraint[];
  count?: number;
  error?: string;
}

/**
 * Request to repair trust.
 */
export interface RepairTrustRequest {
  component: TrustComponent;
  correction_id?: string;
  repair_action: string;
}

/**
 * Response from trust repair.
 */
export interface RepairTrustResponse {
  ok: boolean;
  component?: TrustComponent;
  old_score?: number;
  new_score?: number;
  recovery_delta?: number;
  repair_action?: string;
  error?: string;
}

/**
 * Request to check a behavior constraint.
 */
export interface CheckConstraintRequest {
  constraint_type: ConstraintType;
  constraint_key: string;
}

/**
 * Response from constraint check.
 */
export interface CheckConstraintResponse {
  ok: boolean;
  is_constrained?: boolean;
  constraint_id?: string;
  constraint_type?: ConstraintType;
  constraint_key?: string;
  description?: string;
  strength?: number;
  expires_at?: string;
  error?: string;
}

/**
 * Query params for correction history.
 */
export interface CorrectionHistoryQuery {
  limit?: number;
  offset?: number;
  feedback_type?: FeedbackType;
}

/**
 * Response from correction history.
 */
export interface CorrectionHistoryResponse {
  ok: boolean;
  corrections?: UserCorrection[];
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
  error?: string;
}

// =============================================================================
// Deterministic Rules
// =============================================================================

/**
 * Trust delta values for each feedback type.
 * Same feedback → same correction outcome (deterministic).
 */
export const TRUST_DELTAS: Record<FeedbackType, number> = {
  explicit_correction: -15,
  preference_clarification: -5,
  boundary_enforcement: -10,
  tone_adjustment: -5,
  suggestion_rejection: -8,
  autonomy_refusal: -20,
};

/**
 * Recovery delta for trust repair actions.
 */
export const TRUST_RECOVERY_DELTA = 5;

/**
 * Maximum trust level after recovery (can't fully restore to 100).
 */
export const MAX_RECOVERED_TRUST = 80;

/**
 * Minimum trust level (floor).
 */
export const MIN_TRUST = 10;

/**
 * Default trust level for new components.
 */
export const DEFAULT_TRUST = 80;

// =============================================================================
// Trust Repair Logic Helpers
// =============================================================================

/**
 * Determine if trust level requires restricted behavior.
 */
export function shouldRestrictBehavior(trustScore: TrustScore): boolean {
  return trustScore.score < 40 || trustScore.consecutive_corrections >= 3;
}

/**
 * Determine if component needs immediate attention.
 */
export function needsImmediateAttention(trustScore: TrustScore): boolean {
  return trustScore.score < 20 || trustScore.consecutive_corrections >= 5;
}

/**
 * Calculate expected trust after a feedback event.
 */
export function calculateTrustAfterFeedback(
  currentScore: number,
  feedbackType: FeedbackType
): number {
  const delta = TRUST_DELTAS[feedbackType];
  return Math.max(MIN_TRUST, currentScore + delta);
}

/**
 * Calculate expected trust after a repair action.
 */
export function calculateTrustAfterRepair(currentScore: number): number {
  return Math.min(MAX_RECOVERED_TRUST, currentScore + TRUST_RECOVERY_DELTA);
}

// =============================================================================
// Feedback Classification Helpers
// =============================================================================

/**
 * Keywords that indicate medical/health-related content.
 */
export const MEDICAL_KEYWORDS = [
  'medical', 'medication', 'health', 'doctor', 'pain',
  'symptoms', 'treatment', 'diagnosis', 'prescription', 'illness',
];

/**
 * Keywords that indicate emotional content.
 */
export const EMOTIONAL_KEYWORDS = [
  'upset', 'angry', 'frustrated', 'hurt', 'emotional',
  'feelings', 'sad', 'anxious', 'worried', 'stressed',
];

/**
 * Check if content contains medical-related keywords.
 */
export function containsMedicalContent(content: string): boolean {
  const lower = content.toLowerCase();
  return MEDICAL_KEYWORDS.some(k => lower.includes(k));
}

/**
 * Check if content contains emotional keywords.
 */
export function containsEmotionalContent(content: string): boolean {
  const lower = content.toLowerCase();
  return EMOTIONAL_KEYWORDS.some(k => lower.includes(k));
}

/**
 * Determine if safety flag is needed based on content.
 */
export function determineSafetyFlag(
  content: string,
  affectedComponent: AffectedComponent
): { needed: boolean; type?: SafetyFlagType; severity?: SafetySeverity } {
  if (affectedComponent === 'health' || containsMedicalContent(content)) {
    return { needed: true, type: 'medical_correction', severity: 'high' };
  }
  if (containsEmotionalContent(content)) {
    return { needed: true, type: 'emotional_correction', severity: 'medium' };
  }
  return { needed: false };
}
