/**
 * VTID-01122: Safety-Aware Reasoning Guardrails Types
 *
 * Defines the type system for deterministic safety guardrails that constrain
 * ORB's reasoning, recommendations, and actions BEFORE output is generated.
 *
 * Core Principle: Intelligence must be powerful — but never unsafe.
 */

// =============================================================================
// GUARDRAIL DOMAINS
// =============================================================================

/**
 * Canonical safety guardrail domains.
 * Each domain has its own allow/restrict/block rules.
 */
export type SafetyDomain =
  | 'medical'        // Medical / Health
  | 'mental'         // Mental & Emotional
  | 'financial'      // Financial / Economic
  | 'social'         // Social & Relationship
  | 'legal'          // Legal / Compliance
  | 'system';        // System / Governance

/**
 * All canonical safety domains as an array for iteration.
 */
export const SAFETY_DOMAINS: SafetyDomain[] = [
  'medical',
  'mental',
  'financial',
  'social',
  'legal',
  'system'
];

// =============================================================================
// GUARDRAIL ACTIONS
// =============================================================================

/**
 * Possible guardrail outcomes.
 * These are deterministic and logged.
 */
export type GuardrailAction =
  | 'allow'     // Normal reasoning - no restrictions
  | 'restrict'  // Provide high-level guidance only
  | 'redirect'  // Ask clarifying or safety questions
  | 'block';    // Refuse and explain boundary

/**
 * Guardrail action priority (lower = more restrictive).
 * Block takes precedence over all other actions.
 */
export const GUARDRAIL_ACTION_PRIORITY: Record<GuardrailAction, number> = {
  block: 0,
  redirect: 1,
  restrict: 2,
  allow: 3
};

// =============================================================================
// INPUT BUNDLES (References to D21, D22, D24, D28)
// =============================================================================

/**
 * Intent Bundle (D21 reference).
 * Represents the user's parsed intent.
 */
export interface IntentBundle {
  intent_id: string;
  raw_input: string;
  primary_intent: string;
  secondary_intents?: string[];
  extracted_entities: Record<string, unknown>;
  intent_category?: string;
  is_question: boolean;
  is_request: boolean;
  is_command: boolean;
  extracted_at: string;
}

/**
 * Routing Bundle (D22 reference).
 * Represents the routing decision for the request.
 */
export interface RoutingBundle {
  routing_id: string;
  intent_id: string;
  recommended_route: string;
  alternative_routes: Array<{
    route: string;
    confidence: number;
  }>;
  requires_context: boolean;
  requires_memory: boolean;
  requires_external_data: boolean;
  routed_at: string;
}

/**
 * Confidence Score (D24 reference).
 * Represents confidence in a decision or classification.
 */
export interface ConfidenceScore {
  score_id: string;
  target_type: 'intent' | 'domain' | 'action' | 'response';
  target_id: string;
  score: number; // 0.0 - 1.0
  uncertainty_band: {
    lower: number;
    upper: number;
  };
  calibration_method: 'lexical' | 'semantic' | 'ensemble' | 'heuristic';
  factors: Array<{
    name: string;
    weight: number;
    value: number;
  }>;
  scored_at: string;
}

/**
 * Emotional Signal (D28 reference).
 * Represents detected emotional state and communication patterns.
 */
export interface EmotionalSignal {
  signal_id: string;
  detected_emotions: Array<{
    emotion: string;
    intensity: number; // 0.0 - 1.0
  }>;
  primary_emotion?: string;
  sentiment_score: number; // -1.0 to 1.0
  communication_style: 'formal' | 'casual' | 'urgent' | 'distressed' | 'neutral';
  stress_indicators: boolean;
  vulnerability_indicators: boolean;
  detected_at: string;
}

/**
 * User role for access control.
 */
export type UserRole = 'patient' | 'professional' | 'admin' | 'system';

/**
 * Autonomy intent flags.
 */
export interface AutonomyIntent {
  autonomy_requested: boolean;
  autonomy_level: 'none' | 'suggest' | 'act_with_confirmation' | 'act_autonomously';
  action_type?: string;
  scope?: string[];
}

// =============================================================================
// GUARDRAIL EVALUATION
// =============================================================================

/**
 * Complete input for guardrail evaluation.
 * All inputs MUST be provided for deterministic evaluation.
 */
export interface GuardrailInput {
  intent_bundle: IntentBundle;
  routing_bundle: RoutingBundle;
  confidence_scores: ConfidenceScore[];
  emotional_signals: EmotionalSignal;
  user_role: UserRole;
  autonomy_intent: AutonomyIntent;
  tenant_id: string;
  session_id: string;
  request_id: string;
}

/**
 * Result of domain-specific guardrail check.
 */
export interface DomainGuardrailResult {
  domain: SafetyDomain;
  action: GuardrailAction;
  triggered_rules: string[];
  explanation_code: string;
  explanation_text: string;
  confidence: number;
}

/**
 * Complete guardrail evaluation result.
 */
export interface GuardrailEvaluation {
  evaluation_id: string;
  request_id: string;
  session_id: string;
  tenant_id: string;

  // Final decision (most restrictive wins)
  final_action: GuardrailAction;
  primary_domain: SafetyDomain | null;

  // Per-domain results
  domain_results: DomainGuardrailResult[];

  // If blocked or restricted
  user_message?: string;
  alternatives?: string[];

  // Determinism verification
  input_hash: string;
  rule_version: string;

  // Timing
  evaluated_at: string;
  evaluation_duration_ms: number;
}

// =============================================================================
// GUARDRAIL RULES
// =============================================================================

/**
 * A single guardrail rule definition.
 */
export interface GuardrailRule {
  rule_id: string;
  domain: SafetyDomain;
  action: GuardrailAction;
  priority: number; // Lower = higher priority

  // Conditions (all must match for rule to trigger)
  conditions: GuardrailCondition[];

  // Output
  explanation_code: string;
  explanation_template: string;
  user_message_template?: string;
  alternatives_template?: string[];

  // Metadata
  created_at: string;
  version: string;
  is_active: boolean;
}

/**
 * A condition for rule matching.
 */
export interface GuardrailCondition {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'matches' | 'in' | 'not_in';
  value: unknown;
  case_sensitive?: boolean;
}

/**
 * Rule evaluation context for tracing.
 */
export interface RuleEvaluationTrace {
  rule_id: string;
  matched: boolean;
  conditions_evaluated: Array<{
    field: string;
    operator: string;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }>;
  evaluation_time_ms: number;
}

// =============================================================================
// OASIS EVENT TYPES
// =============================================================================

/**
 * Safety guardrail event types for OASIS logging.
 */
export type SafetyGuardrailEventType =
  | 'safety.guardrail.evaluated'
  | 'safety.guardrail.allowed'
  | 'safety.guardrail.restricted'
  | 'safety.guardrail.redirected'
  | 'safety.guardrail.blocked'
  | 'safety.guardrail.rule.triggered'
  | 'safety.guardrail.autonomy.denied';

/**
 * Safety guardrail OASIS event payload.
 */
export interface SafetyGuardrailEventPayload {
  evaluation_id: string;
  request_id: string;
  session_id: string;
  tenant_id: string;
  final_action: GuardrailAction;
  primary_domain: SafetyDomain | null;
  triggered_rules: string[];
  input_hash: string;
  rule_version: string;
  evaluation_duration_ms: number;
  user_role: UserRole;
  autonomy_denied?: boolean;
  // Sensitive fields omitted for privacy
}

// =============================================================================
// USER COMMUNICATION
// =============================================================================

/**
 * User-facing safety message configuration.
 */
export interface SafetyUserMessage {
  domain: SafetyDomain;
  action: GuardrailAction;
  title: string;
  message: string;
  tone: 'calm' | 'supportive' | 'informative';
  includes_why: boolean;
  alternatives?: string[];
}

// =============================================================================
// HARD CONSTRAINTS (Immutable)
// =============================================================================

/**
 * Hard constraints that cannot be overridden.
 * These are the "never bypass" rules.
 */
export const HARD_CONSTRAINTS = {
  // No guardrail bypass - ever
  NO_BYPASS: true,

  // No "best guess" in restricted domains
  NO_GUESS_IN_RESTRICTED: true,

  // No autonomy under block or restrict
  NO_AUTONOMY_UNDER_BLOCK: true,
  NO_AUTONOMY_UNDER_RESTRICT: true,

  // Safety decisions precede response generation
  SAFETY_BEFORE_RESPONSE: true,

  // Determinism: same inputs = same decision
  DETERMINISTIC_DECISIONS: true,

  // Rules take precedence over preferences
  RULES_OVER_PREFERENCES: true
} as const;

/**
 * Type for hard constraint keys.
 */
export type HardConstraintKey = keyof typeof HARD_CONSTRAINTS;
