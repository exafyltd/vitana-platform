/**
 * VTID-01135: D41 - Ethical Boundaries, Personal Limits & Consent Sensitivity Engine
 *
 * Type definitions for the Deep Context Intelligence layer that ensures the system
 * NEVER crosses personal, ethical, or psychological boundaries.
 *
 * Core Principle: Even if something is relevant, it must be appropriate and permitted.
 *
 * This module formalizes:
 *   - Personal boundary modeling
 *   - Consent awareness & memory
 *   - Boundary enforcement layer
 *
 * Hard Constraints (Non-Negotiable):
 *   - Never infer sensitive traits without explicit consent
 *   - Never escalate intimacy or depth automatically
 *   - Silence is NOT consent
 *   - Emotional vulnerability suppresses monetization
 *   - Respect cultural and personal norms implicitly
 *   - Default to protection when uncertain
 *   - Boundaries override optimization goals
 */

import { z } from 'zod';

// =============================================================================
// VTID-01135: Personal Boundary Levels
// =============================================================================

/**
 * Privacy sensitivity levels
 * Higher values = more restrictive
 */
export const PrivacyLevel = z.enum([
  'open',          // 0-20: Comfortable sharing most information
  'moderate',      // 20-40: Selective about personal info
  'guarded',       // 40-60: Careful with sensitive topics
  'private',       // 60-80: Very selective, explicit consent required
  'strict'         // 80-100: Minimal information shared
]);
export type PrivacyLevel = z.infer<typeof PrivacyLevel>;

/**
 * Health topic sensitivity levels
 */
export const HealthSensitivity = z.enum([
  'open',          // Comfortable discussing health topics
  'moderate',      // General health OK, specific conditions sensitive
  'sensitive',     // Most health topics require care
  'restricted'     // Health topics generally avoided
]);
export type HealthSensitivity = z.infer<typeof HealthSensitivity>;

/**
 * Monetization tolerance levels
 */
export const MonetizationTolerance = z.enum([
  'open',          // Open to recommendations, promotions, upsells
  'moderate',      // Some recommendations OK, not pushy
  'limited',       // Only when explicitly relevant
  'minimal',       // Very rare, high-value only
  'none'           // No monetization suggestions ever
]);
export type MonetizationTolerance = z.infer<typeof MonetizationTolerance>;

/**
 * Social exposure tolerance levels
 */
export const SocialExposureLimit = z.enum([
  'open',          // Comfortable with social introductions, group activities
  'moderate',      // Some social exposure OK
  'limited',       // Small groups, familiar contexts only
  'minimal',       // Very selective social interactions
  'none'           // No social introductions or suggestions
]);
export type SocialExposureLimit = z.infer<typeof SocialExposureLimit>;

/**
 * Emotional safety levels
 */
export const EmotionalSafetyLevel = z.enum([
  'stable',        // Emotionally stable, can handle deeper topics
  'cautious',      // Some emotional sensitivity
  'vulnerable',    // Currently vulnerable, extra care needed
  'fragile'        // High emotional sensitivity, maximum protection
]);
export type EmotionalSafetyLevel = z.infer<typeof EmotionalSafetyLevel>;

// =============================================================================
// VTID-01135: Personal Boundaries Schema
// =============================================================================

/**
 * Personal boundary model - explicit and implicit boundaries
 * Per spec section 2.1
 */
export const PersonalBoundariesSchema = z.object({
  privacy_level: PrivacyLevel.default('moderate'),
  privacy_score: z.number().int().min(0).max(100).default(50),
  health_sensitivity: HealthSensitivity.default('moderate'),
  health_sensitivity_score: z.number().int().min(0).max(100).default(50),
  monetization_tolerance: MonetizationTolerance.default('moderate'),
  monetization_score: z.number().int().min(0).max(100).default(50),
  social_exposure_limit: SocialExposureLimit.default('moderate'),
  social_exposure_score: z.number().int().min(0).max(100).default(50),
  emotional_safety_level: EmotionalSafetyLevel.default('cautious'),
  emotional_safety_score: z.number().int().min(0).max(100).default(50),
  // Source tracking
  source: z.enum(['explicit', 'inferred', 'default']).default('default'),
  confidence: z.number().int().min(0).max(100).default(50),
  last_updated: z.string().datetime().optional()
});
export type PersonalBoundaries = z.infer<typeof PersonalBoundariesSchema>;

// =============================================================================
// VTID-01135: Consent Status Types
// =============================================================================

/**
 * Consent status values
 * Per spec section 2.2
 */
export const ConsentStatus = z.enum([
  'granted',           // Explicit opt-in
  'denied',            // Explicit opt-out
  'soft_refusal',      // "not now", "later", "maybe"
  'revoked',           // Previously granted, now revoked
  'expired',           // Time-limited consent expired
  'unknown'            // No signal (default to NOT consent)
]);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

/**
 * Consent topic categories
 */
export const ConsentTopic = z.enum([
  // Health-related
  'health_general',
  'health_mental',
  'health_physical',
  'health_medications',
  'health_conditions',
  // Financial
  'financial_general',
  'financial_spending',
  'financial_income',
  'financial_investments',
  // Social
  'social_introductions',
  'social_group_activities',
  'social_contact_sharing',
  // Personal
  'personal_relationships',
  'personal_family',
  'personal_work',
  'personal_goals',
  // Behavioral
  'proactive_nudges',
  'memory_surfacing',
  'monetization_suggestions',
  'autonomy_actions',
  // System
  'data_collection',
  'data_sharing',
  'third_party_access'
]);
export type ConsentTopic = z.infer<typeof ConsentTopic>;

/**
 * Consent state record
 * Tracks consent per topic with temporal awareness
 */
export const ConsentStateSchema = z.object({
  id: z.string().uuid(),
  topic: ConsentTopic,
  status: ConsentStatus,
  confidence: z.number().int().min(0).max(100).default(50),
  // Temporal tracking
  granted_at: z.string().datetime().nullable().optional(),
  denied_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  last_updated: z.string().datetime(),
  // Evidence tracking
  source: z.enum(['explicit', 'behavioral', 'inferred']).default('explicit'),
  source_reference: z.string().nullable().optional(), // e.g., message ID, setting change
  // Reversibility
  can_revert: z.boolean().default(true),
  revert_cooldown_hours: z.number().int().min(0).default(0)
});
export type ConsentState = z.infer<typeof ConsentStateSchema>;

/**
 * Consent bundle - all consent states for a user
 */
export const ConsentBundleSchema = z.object({
  consent_states: z.array(ConsentStateSchema).default([]),
  default_stance: z.enum(['permissive', 'neutral', 'protective']).default('protective'),
  consent_count: z.number().int().min(0).default(0),
  granted_count: z.number().int().min(0).default(0),
  denied_count: z.number().int().min(0).default(0),
  generated_at: z.string().datetime()
});
export type ConsentBundle = z.infer<typeof ConsentBundleSchema>;

// =============================================================================
// VTID-01135: Boundary Types
// =============================================================================

/**
 * Boundary type classification
 * Per spec section 2.2 tags
 */
export const BoundaryType = z.enum([
  'hard_boundary',      // Absolute - never cross
  'soft_boundary',      // Respect unless explicitly overridden
  'consent_required',   // Must ask before proceeding
  'topic_blocked',      // Topic is off-limits
  'safe_to_proceed'     // No boundary issues detected
]);
export type BoundaryType = z.infer<typeof BoundaryType>;

/**
 * Boundary domain - where boundaries apply
 */
export const BoundaryDomain = z.enum([
  'health',
  'social',
  'financial',
  'emotional',
  'privacy',
  'autonomy',
  'content',
  'system'
]);
export type BoundaryDomain = z.infer<typeof BoundaryDomain>;

// =============================================================================
// VTID-01135: Boundary Check Input/Output
// =============================================================================

/**
 * Input for boundary check
 * Used before any action is suggested or executed
 */
export const BoundaryCheckInputSchema = z.object({
  // What we want to do
  action_type: z.enum([
    'health_guidance',
    'social_introduction',
    'monetization',
    'proactive_nudge',
    'memory_surfacing',
    'autonomy_action',
    'content_delivery',
    'data_access'
  ]),
  action_details: z.record(z.unknown()).optional(),
  // Context from other modules
  intent_bundle: z.record(z.unknown()).optional(), // D21
  routing_bundle: z.record(z.unknown()).optional(), // D22
  emotional_signals: z.record(z.unknown()).optional(), // D28
  financial_signals: z.record(z.unknown()).optional(), // D36
  life_stage: z.string().optional(), // D40
  // Request context
  session_id: z.string().uuid().optional(),
  request_id: z.string().uuid().optional()
});
export type BoundaryCheckInput = z.infer<typeof BoundaryCheckInputSchema>;

/**
 * Safe action output
 * Per spec section 5.1
 */
export const SafeActionSchema = z.object({
  action: z.string(),
  allowed: z.boolean(),
  reason: z.string(),
  confidence: z.number().int().min(0).max(100),
  boundary_type: BoundaryType.optional(),
  alternatives: z.array(z.string()).optional()
});
export type SafeAction = z.infer<typeof SafeActionSchema>;

/**
 * Boundary check result
 */
export const BoundaryCheckResultSchema = z.object({
  check_id: z.string().uuid(),
  request_id: z.string().uuid().optional(),
  // Overall result
  allowed: z.boolean(),
  boundary_type: BoundaryType,
  primary_domain: BoundaryDomain.optional(),
  // Details
  safe_actions: z.array(SafeActionSchema).default([]),
  triggered_boundaries: z.array(z.string()).default([]),
  // User communication
  user_message: z.string().optional(),
  user_explanation: z.string().optional(), // Why not suggested (brief, respectful)
  // Metadata
  confidence: z.number().int().min(0).max(100),
  checked_at: z.string().datetime(),
  check_duration_ms: z.number().int().min(0)
});
export type BoundaryCheckResult = z.infer<typeof BoundaryCheckResultSchema>;

// =============================================================================
// VTID-01135: Boundary Enforcement Rules
// =============================================================================

/**
 * Boundary rule definition
 * Deterministic rules for boundary enforcement
 */
export const BoundaryRuleSchema = z.object({
  rule_id: z.string(),
  domain: BoundaryDomain,
  boundary_type: BoundaryType,
  priority: z.number().int().min(0).max(100).default(50),
  // Conditions (all must match)
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_contains', 'in', 'not_in']),
    value: z.unknown()
  })),
  // Output
  action: z.enum(['allow', 'restrict', 'block', 'require_consent']),
  explanation_code: z.string(),
  explanation_template: z.string(),
  user_message_template: z.string().optional(),
  // Metadata
  is_active: z.boolean().default(true),
  version: z.string().default('1.0.0'),
  created_at: z.string().datetime()
});
export type BoundaryRule = z.infer<typeof BoundaryRuleSchema>;

// =============================================================================
// VTID-01135: Vulnerability Detection
// =============================================================================

/**
 * Vulnerability indicators from various signals
 * Used to suppress monetization and escalation
 */
export const VulnerabilityIndicatorsSchema = z.object({
  emotional_vulnerability: z.boolean().default(false),
  emotional_vulnerability_score: z.number().int().min(0).max(100).default(0),
  financial_pressure: z.boolean().default(false),
  financial_pressure_score: z.number().int().min(0).max(100).default(0),
  social_isolation: z.boolean().default(false),
  social_isolation_score: z.number().int().min(0).max(100).default(0),
  health_crisis: z.boolean().default(false),
  health_crisis_score: z.number().int().min(0).max(100).default(0),
  // Aggregate
  overall_vulnerability: z.boolean().default(false),
  overall_vulnerability_score: z.number().int().min(0).max(100).default(0),
  // Suppressions
  suppress_monetization: z.boolean().default(false),
  suppress_social_introductions: z.boolean().default(false),
  suppress_proactive_nudges: z.boolean().default(false),
  suppress_autonomy: z.boolean().default(false),
  // Evidence
  detected_at: z.string().datetime().optional(),
  decay_at: z.string().datetime().optional()
});
export type VulnerabilityIndicators = z.infer<typeof VulnerabilityIndicatorsSchema>;

// =============================================================================
// VTID-01135: API Request/Response Schemas
// =============================================================================

/**
 * Set personal boundary request
 */
export const SetBoundaryRequestSchema = z.object({
  boundary_type: z.enum([
    'privacy_level',
    'health_sensitivity',
    'monetization_tolerance',
    'social_exposure_limit',
    'emotional_safety_level'
  ]),
  value: z.string(), // One of the enum values
  reason: z.string().optional()
});
export type SetBoundaryRequest = z.infer<typeof SetBoundaryRequestSchema>;

/**
 * Set consent request
 */
export const SetConsentRequestSchema = z.object({
  topic: ConsentTopic,
  status: ConsentStatus,
  expires_in_hours: z.number().int().min(0).optional(), // Optional expiry
  reason: z.string().optional()
});
export type SetConsentRequest = z.infer<typeof SetConsentRequestSchema>;

/**
 * Revoke consent request
 */
export const RevokeConsentRequestSchema = z.object({
  topic: ConsentTopic,
  reason: z.string().optional()
});
export type RevokeConsentRequest = z.infer<typeof RevokeConsentRequestSchema>;

/**
 * Check boundary request
 */
export const CheckBoundaryRequestSchema = BoundaryCheckInputSchema;
export type CheckBoundaryRequest = z.infer<typeof CheckBoundaryRequestSchema>;

/**
 * Filter actions request
 * Get boundary-safe actions from a set of proposed actions
 */
export const FilterActionsRequestSchema = z.object({
  proposed_actions: z.array(z.object({
    action: z.string(),
    action_type: z.string(),
    details: z.record(z.unknown()).optional()
  })),
  context: z.record(z.unknown()).optional()
});
export type FilterActionsRequest = z.infer<typeof FilterActionsRequestSchema>;

// =============================================================================
// VTID-01135: API Response Types
// =============================================================================

/**
 * Standard API response
 */
export interface BoundaryApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Get boundaries response
 */
export interface GetBoundariesResponse {
  ok: boolean;
  boundaries?: PersonalBoundaries;
  error?: string;
}

/**
 * Set boundary response
 */
export interface SetBoundaryResponse {
  ok: boolean;
  boundary_type?: string;
  old_value?: string;
  new_value?: string;
  action?: 'boundary_created' | 'boundary_updated';
  error?: string;
}

/**
 * Get consent response
 */
export interface GetConsentResponse {
  ok: boolean;
  consent_bundle?: ConsentBundle;
  error?: string;
}

/**
 * Set consent response
 */
export interface SetConsentResponse {
  ok: boolean;
  id?: string;
  topic?: ConsentTopic;
  status?: ConsentStatus;
  expires_at?: string;
  action?: 'consent_created' | 'consent_updated';
  error?: string;
}

/**
 * Revoke consent response
 */
export interface RevokeConsentResponse {
  ok: boolean;
  id?: string;
  topic?: ConsentTopic;
  previous_status?: ConsentStatus;
  error?: string;
}

/**
 * Check boundary response
 */
export interface CheckBoundaryResponse {
  ok: boolean;
  result?: BoundaryCheckResult;
  error?: string;
}

/**
 * Filter actions response
 */
export interface FilterActionsResponse {
  ok: boolean;
  safe_actions?: SafeAction[];
  filtered_count?: number;
  allowed_count?: number;
  blocked_count?: number;
  error?: string;
}

/**
 * Vulnerability check response
 */
export interface VulnerabilityCheckResponse {
  ok: boolean;
  indicators?: VulnerabilityIndicators;
  error?: string;
}

// =============================================================================
// VTID-01135: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for boundary consent engine
 */
export const BOUNDARY_CONSENT_EVENT_TYPES = [
  'd41.boundary.set',
  'd41.boundary.checked',
  'd41.consent.granted',
  'd41.consent.denied',
  'd41.consent.revoked',
  'd41.consent.expired',
  'd41.action.blocked',
  'd41.action.restricted',
  'd41.action.allowed',
  'd41.vulnerability.detected',
  'd41.vulnerability.cleared'
] as const;

export type BoundaryConsentEventType = typeof BOUNDARY_CONSENT_EVENT_TYPES[number];

/**
 * OASIS event payload for boundary consent
 */
export interface BoundaryConsentEventPayload {
  vtid: string;
  tenant_id: string;
  user_id: string;
  event_type: BoundaryConsentEventType;
  domain?: BoundaryDomain;
  boundary_type?: BoundaryType;
  consent_topic?: ConsentTopic;
  consent_status?: ConsentStatus;
  action_type?: string;
  allowed?: boolean;
  reason?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01135: ORB Context Integration
// =============================================================================

/**
 * Boundary context for ORB system prompt injection
 */
export interface OrbBoundaryContext {
  // Current boundary state
  privacy_level: PrivacyLevel;
  emotional_safety: EmotionalSafetyLevel;
  // Active suppressions
  suppress_monetization: boolean;
  suppress_social: boolean;
  suppress_proactive: boolean;
  // Consent summary
  blocked_topics: ConsentTopic[];
  requires_consent_topics: ConsentTopic[];
  // Guidance hints
  tone_hint: 'supportive' | 'neutral' | 'professional';
  depth_hint: 'surface' | 'moderate' | 'deep';
  proactivity_hint: 'reactive_only' | 'gentle' | 'proactive';
  // Disclaimer
  disclaimer: string;
}

/**
 * Convert boundary state to ORB context
 */
export function toOrbBoundaryContext(
  boundaries: PersonalBoundaries,
  consentBundle: ConsentBundle,
  vulnerability: VulnerabilityIndicators
): OrbBoundaryContext {
  const blockedTopics = consentBundle.consent_states
    .filter(c => c.status === 'denied' || c.status === 'revoked')
    .map(c => c.topic);

  const requiresConsentTopics = consentBundle.consent_states
    .filter(c => c.status === 'unknown' || c.status === 'soft_refusal')
    .map(c => c.topic);

  // Determine tone hint based on emotional safety
  let toneHint: 'supportive' | 'neutral' | 'professional' = 'neutral';
  if (boundaries.emotional_safety_level === 'fragile' || boundaries.emotional_safety_level === 'vulnerable') {
    toneHint = 'supportive';
  } else if (boundaries.privacy_level === 'strict' || boundaries.privacy_level === 'private') {
    toneHint = 'professional';
  }

  // Determine depth hint based on privacy
  let depthHint: 'surface' | 'moderate' | 'deep' = 'moderate';
  if (boundaries.privacy_level === 'strict' || boundaries.privacy_level === 'private') {
    depthHint = 'surface';
  } else if (boundaries.privacy_level === 'open') {
    depthHint = 'deep';
  }

  // Determine proactivity hint
  let proactivityHint: 'reactive_only' | 'gentle' | 'proactive' = 'gentle';
  if (vulnerability.suppress_proactive_nudges || boundaries.emotional_safety_level === 'fragile') {
    proactivityHint = 'reactive_only';
  } else if (boundaries.privacy_level === 'open' && boundaries.emotional_safety_level === 'stable') {
    proactivityHint = 'proactive';
  }

  return {
    privacy_level: boundaries.privacy_level,
    emotional_safety: boundaries.emotional_safety_level,
    suppress_monetization: vulnerability.suppress_monetization ||
      boundaries.monetization_tolerance === 'none',
    suppress_social: vulnerability.suppress_social_introductions ||
      boundaries.social_exposure_limit === 'none',
    suppress_proactive: vulnerability.suppress_proactive_nudges,
    blocked_topics: blockedTopics,
    requires_consent_topics: requiresConsentTopics,
    tone_hint: toneHint,
    depth_hint: depthHint,
    proactivity_hint: proactivityHint,
    disclaimer: 'Boundaries are advisory; user wellbeing takes precedence over engagement goals.'
  };
}

/**
 * Format boundary context for ORB system prompt
 */
export function formatBoundaryContextForPrompt(context: OrbBoundaryContext): string {
  const lines: string[] = [
    '[D41 Boundary & Consent Context]'
  ];

  // Privacy and emotional state
  lines.push(`Privacy Level: ${context.privacy_level}`);
  lines.push(`Emotional Safety: ${context.emotional_safety}`);

  // Active suppressions
  const suppressions: string[] = [];
  if (context.suppress_monetization) suppressions.push('monetization');
  if (context.suppress_social) suppressions.push('social introductions');
  if (context.suppress_proactive) suppressions.push('proactive nudges');
  if (suppressions.length > 0) {
    lines.push(`SUPPRESS: ${suppressions.join(', ')}`);
  }

  // Blocked topics
  if (context.blocked_topics.length > 0) {
    lines.push(`BLOCKED TOPICS: ${context.blocked_topics.join(', ')}`);
  }

  // Guidance
  lines.push(`Tone: ${context.tone_hint} | Depth: ${context.depth_hint} | Proactivity: ${context.proactivity_hint}`);

  // Disclaimer
  lines.push(`Note: ${context.disclaimer}`);

  return lines.join('\n');
}

// =============================================================================
// VTID-01135: Default Values & Constants
// =============================================================================

/**
 * Default personal boundaries
 */
export const DEFAULT_BOUNDARIES: PersonalBoundaries = {
  privacy_level: 'moderate',
  privacy_score: 50,
  health_sensitivity: 'moderate',
  health_sensitivity_score: 50,
  monetization_tolerance: 'moderate',
  monetization_score: 50,
  social_exposure_limit: 'moderate',
  social_exposure_score: 50,
  emotional_safety_level: 'cautious',
  emotional_safety_score: 50,
  source: 'default',
  confidence: 50
};

/**
 * Default consent status for unknown topics
 * Silence is NOT consent - default to protective
 */
export const DEFAULT_CONSENT_STATUS: ConsentStatus = 'unknown';

/**
 * Consent expiry defaults (in hours)
 */
export const CONSENT_EXPIRY_DEFAULTS = {
  granted: 8760,       // 1 year
  soft_refusal: 168,   // 1 week
  denied: null,        // No expiry (must be explicitly revoked)
  revoked: null        // No expiry
} as const;

/**
 * Vulnerability thresholds
 */
export const VULNERABILITY_THRESHOLDS = {
  EMOTIONAL_HIGH: 70,
  EMOTIONAL_MODERATE: 40,
  FINANCIAL_HIGH: 70,
  FINANCIAL_MODERATE: 40,
  SOCIAL_HIGH: 70,
  SOCIAL_MODERATE: 40,
  HEALTH_HIGH: 80,
  HEALTH_MODERATE: 50,
  OVERALL_HIGH: 60,
  OVERALL_MODERATE: 30
} as const;

/**
 * Boundary check timeout (ms)
 */
export const BOUNDARY_CHECK_TIMEOUT_MS = 500;

/**
 * Hard constraints (non-negotiable)
 */
export const D41_HARD_CONSTRAINTS = {
  // Never infer sensitive traits without explicit consent
  NO_SENSITIVE_INFERENCE: true,
  // Never escalate intimacy/depth automatically
  NO_AUTO_ESCALATION: true,
  // Silence is NOT consent
  SILENCE_NOT_CONSENT: true,
  // Emotional vulnerability suppresses monetization
  VULNERABILITY_SUPPRESSES_MONETIZATION: true,
  // Default to protection when uncertain
  DEFAULT_PROTECTIVE: true,
  // Boundaries override optimization goals
  BOUNDARIES_OVERRIDE_OPTIMIZATION: true,
  // Never argue with boundaries
  NEVER_ARGUE_BOUNDARIES: true,
  // Allow explicit boundary override by user
  ALLOW_USER_OVERRIDE: true
} as const;

export type D41HardConstraintKey = keyof typeof D41_HARD_CONSTRAINTS;
