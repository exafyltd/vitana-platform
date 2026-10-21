/**
 * VTID-01130: D36 Financial Sensitivity, Monetization Readiness & Value Perception Engine
 *
 * Type definitions for the monetization intelligence layer.
 * Ensures monetization is context-appropriate, socially safe, and aligned with user value perception.
 *
 * Core Question: "Is this the right moment to suggest something paid — and in what form?"
 *
 * Hard Constraints (Non-Negotiable):
 *   - Never lead with price — always lead with value
 *   - Never stack multiple paid suggestions
 *   - No monetization when emotional vulnerability is detected
 *   - Explicit user "no" blocks monetization immediately
 *   - Zero social pressure allowed
 */

// =============================================================================
// Financial Sensitivity Types
// =============================================================================

/**
 * Financial sensitivity level inferred from user behavior.
 * Inferred WITHOUT explicit income data.
 *
 * Signals:
 * - Past reactions to paid suggestions
 * - Preference for free vs paid options
 * - Hesitation or deferral patterns
 * - Language cues ("budget", "later", "expensive")
 */
export const FINANCIAL_SENSITIVITY_LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
export type FinancialSensitivity = typeof FINANCIAL_SENSITIVITY_LEVELS[number];

/**
 * Financial sensitivity inference result
 */
export interface FinancialSensitivityInference {
  level: FinancialSensitivity;
  confidence: number; // 0-100
  signals_detected: FinancialSignal[];
  last_updated: string; // ISO timestamp
}

/**
 * Individual financial signal detected from user behavior
 */
export interface FinancialSignal {
  signal_type: FinancialSignalType;
  indicator: 'positive' | 'negative' | 'neutral';
  weight: number; // 0-100, importance of this signal
  detected_at: string; // ISO timestamp
  context?: string; // Optional context about what triggered this signal
}

/**
 * Types of financial signals that can be detected
 */
export const FINANCIAL_SIGNAL_TYPES = [
  'paid_suggestion_accepted',      // User accepted a paid recommendation
  'paid_suggestion_rejected',      // User rejected a paid recommendation
  'paid_suggestion_deferred',      // User said "later" or "maybe"
  'free_alternative_preference',   // User specifically asked for free options
  'budget_language_detected',      // User mentioned budget, cost, expensive, etc.
  'price_inquiry',                 // User asked about pricing
  'value_question',                // User asked about value/benefits
  'payment_completed',             // User completed a payment
  'payment_abandoned',             // User started but abandoned payment
  'subscription_interest',         // User showed interest in subscription
  'one_time_preference',           // User prefers one-time purchases
] as const;

export type FinancialSignalType = typeof FINANCIAL_SIGNAL_TYPES[number];

// =============================================================================
// Monetization Readiness Types
// =============================================================================

/**
 * Monetization readiness score and breakdown.
 *
 * Based on:
 * - Trust level (D29)
 * - Availability & readiness (D33 when available)
 * - Emotional tone (D28)
 * - Perceived urgency or value
 * - Historical conversion comfort
 */
export interface MonetizationReadiness {
  score: number; // 0.0 - 1.0
  confidence: number; // 0-100
  components: MonetizationReadinessComponents;
  blockers: MonetizationBlocker[];
  computed_at: string; // ISO timestamp
}

/**
 * Individual components that contribute to readiness score
 */
export interface MonetizationReadinessComponents {
  trust_component: number; // 0.0 - 1.0 (from D29)
  availability_component: number; // 0.0 - 1.0 (from D33 or default)
  emotional_component: number; // 0.0 - 1.0 (from D28)
  urgency_component: number; // 0.0 - 1.0
  history_component: number; // 0.0 - 1.0
}

/**
 * Component weights for readiness calculation
 */
export const READINESS_WEIGHTS = {
  trust: 0.30,
  availability: 0.15,
  emotional: 0.25,
  urgency: 0.10,
  history: 0.20,
} as const;

/**
 * Blockers that prevent monetization
 */
export interface MonetizationBlocker {
  blocker_type: MonetizationBlockerType;
  severity: 'hard' | 'soft'; // hard = absolute block, soft = reduces score
  reason: string;
  expires_at?: string; // ISO timestamp when blocker expires (if temporary)
}

/**
 * Types of monetization blockers
 */
export const MONETIZATION_BLOCKER_TYPES = [
  'explicit_refusal',           // User said "no" to monetization
  'emotional_vulnerability',    // D28 detected distress/vulnerability
  'low_trust',                  // D29 trust score too low
  'recent_rejection',           // User rejected paid suggestion recently
  'social_pressure_detected',   // Context suggests social pressure
  'cooldown_active',            // Auto-cooldown from over-eagerness
  'availability_low',           // User not in position to commit
  'session_limit_reached',      // Too many monetization attempts this session
] as const;

export type MonetizationBlockerType = typeof MONETIZATION_BLOCKER_TYPES[number];

// =============================================================================
// Value Perception Types
// =============================================================================

/**
 * How the user perceives value — distinct from price sensitivity.
 *
 * Types:
 * - outcome-oriented: Results matter most
 * - experience-oriented: Comfort, enjoyment matter
 * - efficiency-oriented: Time saved matters
 * - cost-sensitive: Price is primary concern
 */
export interface ValuePerceptionProfile {
  outcome_focus: number; // 0-100
  experience_focus: number; // 0-100
  efficiency_focus: number; // 0-100
  price_sensitivity: number; // 0-100
  primary_driver: ValueDriver;
  confidence: number; // 0-100
  last_updated: string; // ISO timestamp
}

/**
 * Primary value driver (highest score from profile)
 */
export const VALUE_DRIVERS = ['outcome', 'experience', 'efficiency', 'price'] as const;
export type ValueDriver = typeof VALUE_DRIVERS[number];

/**
 * Value signal detected from user behavior
 */
export interface ValueSignal {
  signal_type: ValueSignalType;
  driver: ValueDriver;
  strength: number; // 0-100
  detected_at: string;
  context?: string;
}

/**
 * Types of value signals
 */
export const VALUE_SIGNAL_TYPES = [
  'asked_about_results',         // "Will this actually work?"
  'asked_about_experience',      // "What's it like?"
  'asked_about_time',            // "How long will this take?"
  'asked_about_price',           // "How much does it cost?"
  'mentioned_past_outcome',      // Referenced past results
  'mentioned_enjoyment',         // Emphasized enjoyment/comfort
  'mentioned_time_saved',        // Emphasized time efficiency
  'compared_prices',             // Compared pricing options
] as const;

export type ValueSignalType = typeof VALUE_SIGNAL_TYPES[number];

// =============================================================================
// Monetization Envelope Types
// =============================================================================

/**
 * Monetization Envelope: Defines what kind of value exchange is allowed now.
 * This is the CANONICAL output used by Commerce, Services, Bookings, and Autopilot.
 */
export interface MonetizationEnvelope {
  allow_paid: boolean;
  allowed_types: MonetizationType[];
  framing_style: FramingStyle;
  confidence: number; // 0-100
  tags: MonetizationTag[];
  valid_until: string; // ISO timestamp — envelope expires
  reason?: string; // Explanation for current state
}

/**
 * Types of paid actions that can be suggested
 */
export const MONETIZATION_TYPES = [
  'product',       // Physical or digital product
  'service',       // One-time service
  'session',       // Bookable session (coaching, consultation, etc.)
  'subscription',  // Recurring subscription
  'upgrade',       // Upgrade from current tier
  'donation',      // Voluntary contribution
] as const;

export type MonetizationType = typeof MONETIZATION_TYPES[number];

/**
 * How to frame monetization suggestions
 */
export const FRAMING_STYLES = [
  'value_first',          // Lead with value, mention price only if asked
  'comparison',           // Show value vs. alternatives
  'social_proof',         // Highlight others' success
  'outcome_focused',      // Emphasize results
  'experience_focused',   // Emphasize the experience
  'efficiency_focused',   // Emphasize time/effort saved
  'price_transparent',    // Be upfront about cost (for price-sensitive users)
] as const;

export type FramingStyle = typeof FRAMING_STYLES[number];

/**
 * Monetization tags for downstream consumers
 */
export const MONETIZATION_TAGS = [
  'free_only',            // Only free options allowed
  'soft_paid_ok',         // Soft mention of paid options OK
  'value_first_explain',  // Must explain value before any mention of paid
  'no_monetization_now',  // Block all monetization for now
  'cooldown_active',      // In cooldown period
  'user_initiated_ok',    // Only respond to user-initiated interest
] as const;

export type MonetizationTag = typeof MONETIZATION_TAGS[number];

// =============================================================================
// Monetization Gating Rules
// =============================================================================

/**
 * Gating check result
 */
export interface GatingCheckResult {
  passed: boolean;
  checks: GatingCheck[];
  blocking_check?: GatingCheck;
  computed_at: string;
}

/**
 * Individual gating check
 */
export interface GatingCheck {
  check_type: GatingCheckType;
  passed: boolean;
  threshold?: number;
  actual_value?: number;
  reason?: string;
}

/**
 * Types of gating checks
 */
export const GATING_CHECK_TYPES = [
  'readiness_threshold',       // readiness_score ≥ threshold
  'trust_positive',            // trust context is positive
  'situation_allows',          // situation & availability allow commitment
  'no_social_pressure',        // social pressure = zero
  'free_alternative_exists',   // free or lighter alternative exists (or explicitly declined)
  'no_emotional_vulnerability', // no D28 vulnerability signals
  'no_explicit_refusal',       // user hasn't said "no"
  'cooldown_clear',            // not in cooldown period
] as const;

export type GatingCheckType = typeof GATING_CHECK_TYPES[number];

// =============================================================================
// Monetization History Types
// =============================================================================

/**
 * Monetization attempt record
 */
export interface MonetizationAttempt {
  id: string;
  attempt_type: MonetizationType;
  outcome: MonetizationOutcome;
  readiness_score_at_attempt: number;
  envelope_at_attempt: MonetizationEnvelope;
  user_response?: string;
  session_id?: string;
  created_at: string;
}

/**
 * Outcome of a monetization attempt
 */
export const MONETIZATION_OUTCOMES = [
  'accepted',          // User accepted/purchased
  'rejected',          // User explicitly rejected
  'deferred',          // User said "later"
  'ignored',           // User didn't respond
  'converted_free',    // User chose free alternative
  'abandoned',         // User started but abandoned
] as const;

export type MonetizationOutcome = typeof MONETIZATION_OUTCOMES[number];

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Request to compute monetization context
 */
export interface ComputeMonetizationContextRequest {
  session_id?: string;
  current_message?: string;
  intent?: string;
  product_type?: MonetizationType;
}

/**
 * Response from compute monetization context
 */
export interface ComputeMonetizationContextResponse {
  ok: boolean;
  error?: string;
  message?: string;
  financial_sensitivity?: FinancialSensitivityInference;
  readiness?: MonetizationReadiness;
  value_profile?: ValuePerceptionProfile;
  envelope?: MonetizationEnvelope;
  gating?: GatingCheckResult;
}

/**
 * Request to record a monetization signal
 */
export interface RecordSignalRequest {
  signal_type: FinancialSignalType | ValueSignalType;
  indicator?: 'positive' | 'negative' | 'neutral';
  context?: string;
  session_id?: string;
}

/**
 * Response from recording a signal
 */
export interface RecordSignalResponse {
  ok: boolean;
  error?: string;
  signal_id?: string;
  updated_sensitivity?: FinancialSensitivity;
  updated_readiness_score?: number;
}

/**
 * Request to record a monetization attempt outcome
 */
export interface RecordAttemptRequest {
  attempt_type: MonetizationType;
  outcome: MonetizationOutcome;
  user_response?: string;
  session_id?: string;
}

/**
 * Response from recording an attempt
 */
export interface RecordAttemptResponse {
  ok: boolean;
  error?: string;
  attempt_id?: string;
  cooldown_triggered?: boolean;
  cooldown_until?: string;
}

/**
 * Get monetization envelope request
 */
export interface GetEnvelopeRequest {
  session_id?: string;
  product_type?: MonetizationType;
  force_recompute?: boolean;
}

/**
 * Get monetization envelope response
 */
export interface GetEnvelopeResponse {
  ok: boolean;
  error?: string;
  envelope?: MonetizationEnvelope;
  cached?: boolean;
  expires_at?: string;
}

/**
 * Get monetization history response
 */
export interface GetHistoryResponse {
  ok: boolean;
  error?: string;
  attempts?: MonetizationAttempt[];
  total_count?: number;
  acceptance_rate?: number;
}

// =============================================================================
// ORB Integration Types
// =============================================================================

/**
 * Simplified monetization context for ORB prompt injection
 */
export interface OrbMonetizationContext {
  allow_paid: boolean;
  sensitivity: FinancialSensitivity;
  readiness_score: number;
  primary_value_driver: ValueDriver;
  framing_hint: FramingStyle;
  tags: MonetizationTag[];
  free_alternative_required: boolean;
  disclaimer: string;
}

/**
 * Convert full context to ORB-ready format
 */
export function toOrbMonetizationContext(
  sensitivity: FinancialSensitivityInference,
  readiness: MonetizationReadiness,
  valueProfile: ValuePerceptionProfile,
  envelope: MonetizationEnvelope
): OrbMonetizationContext {
  return {
    allow_paid: envelope.allow_paid,
    sensitivity: sensitivity.level,
    readiness_score: readiness.score,
    primary_value_driver: valueProfile.primary_driver,
    framing_hint: envelope.framing_style,
    tags: envelope.tags,
    free_alternative_required: !envelope.allow_paid || envelope.tags.includes('free_only'),
    disclaimer: 'Monetization context is probabilistic. Always prioritize user comfort over conversion.'
  };
}

/**
 * Format monetization context for ORB system prompt injection
 */
export function formatMonetizationContextForPrompt(ctx: OrbMonetizationContext): string {
  const lines: string[] = [
    '## Monetization Context (D36)',
    `[${ctx.disclaimer}]`,
    ''
  ];

  if (!ctx.allow_paid) {
    lines.push('⛔ PAID SUGGESTIONS BLOCKED');
    lines.push(`- Reason: ${ctx.tags.join(', ')}`);
    lines.push('- Offer only free alternatives');
    return lines.join('\n');
  }

  lines.push(`- Sensitivity: ${ctx.sensitivity}`);
  lines.push(`- Readiness: ${Math.round(ctx.readiness_score * 100)}%`);
  lines.push(`- Value Driver: ${ctx.primary_value_driver}`);
  lines.push(`- Framing: ${ctx.framing_hint}`);

  if (ctx.free_alternative_required) {
    lines.push('');
    lines.push('⚠️ FREE ALTERNATIVE REQUIRED: Always offer a free option alongside any paid suggestion');
  }

  lines.push('');
  lines.push('### Behavioral Rules');
  lines.push('- Never lead with price');
  lines.push('- Always lead with value');
  lines.push('- No stacking multiple paid suggestions');
  lines.push('- Respect any hesitation immediately');

  return lines.join('\n');
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default readiness threshold for allowing paid suggestions
 */
export const DEFAULT_READINESS_THRESHOLD = 0.6;

/**
 * Cooldown duration after rejection (in minutes)
 */
export const REJECTION_COOLDOWN_MINUTES = 30;

/**
 * Maximum monetization attempts per session
 */
export const MAX_ATTEMPTS_PER_SESSION = 2;

/**
 * Envelope validity duration (in minutes)
 */
export const ENVELOPE_VALIDITY_MINUTES = 15;

/**
 * Financial sensitivity keywords for detection
 */
export const FINANCIAL_SENSITIVITY_KEYWORDS = {
  high_sensitivity: [
    'budget', 'expensive', 'afford', 'cost', 'cheap', 'free',
    'too much', 'can\'t pay', 'don\'t have', 'tight budget',
    'saving', 'economical', 'price'
  ],
  deferral: [
    'later', 'maybe', 'not now', 'think about it', 'consider',
    'let me check', 'need to see', 'not sure yet'
  ],
  value_seeking: [
    'worth it', 'value', 'benefit', 'what do i get', 'included',
    'features', 'guarantee', 'refund'
  ]
} as const;

/**
 * Emotional states that block monetization (from D28)
 */
export const BLOCKING_EMOTIONAL_STATES = [
  'stressed',
  'frustrated',
  'anxious'
] as const;
