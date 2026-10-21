/**
 * VTID-01119: User Preference & Constraint Modeling Types
 *
 * Type definitions for the User Preference & Constraint Modeling Engine.
 * Part of D27 Core Intelligence - captures how the user wants intelligence to behave.
 *
 * Personalization without constraints becomes manipulation.
 * Constraints make intelligence respectful.
 */

import { z } from 'zod';

// =============================================================================
// VTID-01119: Preference Categories (Canonical)
// =============================================================================

/**
 * Canonical preference categories per spec section 3
 */
export const PreferenceCategory = z.enum([
  'health',        // Diet, intensity, sensitivity
  'communication', // Short, detailed, proactive
  'social',        // Introvert/extrovert, contact limits
  'economic',      // Spend/earn sensitivity
  'autonomy',      // Ask vs act
  'privacy'        // Privacy sensitivity
]);
export type PreferenceCategory = z.infer<typeof PreferenceCategory>;

/**
 * Preference source - how the preference was obtained
 */
export const PreferenceSource = z.enum([
  'explicit',      // Directly set by user
  'onboarding',    // Set during onboarding
  'settings',      // Set via settings UI
  'conversation',  // Extracted from conversation
  'inferred'       // Inferred from behavior
]);
export type PreferenceSource = z.infer<typeof PreferenceSource>;

/**
 * Preference scope - where the preference applies
 */
export const PreferenceScope = z.enum([
  'global',   // Applies everywhere
  'domain',   // Applies to specific domain (e.g., health, community)
  'context'   // Applies to specific context (e.g., morning routine)
]);
export type PreferenceScope = z.infer<typeof PreferenceScope>;

/**
 * Priority level for preferences
 */
export const PreferencePriority = z.enum(['low', 'medium', 'high']);
export type PreferencePriority = z.infer<typeof PreferencePriority>;

// =============================================================================
// VTID-01119: Constraint Types (Hard Boundaries)
// =============================================================================

/**
 * Constraint types per spec section 4
 */
export const ConstraintType = z.enum([
  'topic_avoid',      // Topics to never surface
  'domain_downrank',  // Domains to de-prioritize
  'timing',           // Time-based restrictions
  'role_limit',       // Role-specific limits
  'contact_limit',    // Contact frequency limits
  'content_filter',   // Content type filters
  'safety'            // Safety-related constraints
]);
export type ConstraintType = z.infer<typeof ConstraintType>;

/**
 * Constraint severity
 */
export const ConstraintSeverity = z.enum([
  'hard', // Must enforce - no exceptions
  'soft'  // Nice to have - can be overridden
]);
export type ConstraintSeverity = z.infer<typeof ConstraintSeverity>;

// =============================================================================
// VTID-01119: Preference Schemas
// =============================================================================

/**
 * Explicit preference (user-set)
 */
export const ExplicitPreferenceSchema = z.object({
  id: z.string().uuid(),
  category: PreferenceCategory,
  key: z.string().min(1).max(100),
  value: z.unknown(), // JSONB - can be any type
  priority: z.number().int().min(0).max(2).default(1),
  source: PreferenceSource,
  scope: PreferenceScope.default('global'),
  scope_domain: z.string().nullable().optional(),
  confidence: z.number().int().min(0).max(100).default(100),
  last_confirmed_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type ExplicitPreference = z.infer<typeof ExplicitPreferenceSchema>;

/**
 * Inferred preference (from behavior/signals)
 */
export const InferredPreferenceSchema = z.object({
  id: z.string().uuid(),
  category: PreferenceCategory,
  key: z.string().min(1).max(100),
  value: z.unknown(),
  confidence: z.number().int().min(0).max(85), // Capped at 85 per spec
  evidence_count: z.number().int().min(0).default(0),
  evidence: z.array(z.object({
    type: z.string(),
    value: z.unknown().optional(),
    reason: z.string().optional(),
    at: z.string().datetime().optional()
  })).default([]),
  scope: PreferenceScope.default('global'),
  scope_domain: z.string().nullable().optional(),
  inferred_at: z.string().datetime(),
  last_reinforced_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type InferredPreference = z.infer<typeof InferredPreferenceSchema>;

/**
 * User constraint (hard boundary)
 */
export const UserConstraintSchema = z.object({
  id: z.string().uuid(),
  type: ConstraintType,
  key: z.string().min(1).max(100),
  value: z.unknown(),
  severity: ConstraintSeverity.default('hard'),
  reason: z.string().nullable().optional(),
  source: PreferenceSource,
  active: z.boolean().default(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type UserConstraint = z.infer<typeof UserConstraintSchema>;

// =============================================================================
// VTID-01119: Preference Bundle (Canonical Representation)
// =============================================================================

/**
 * Preference bundle per spec section 5
 */
export const PreferenceBundleSchema = z.object({
  preferences: z.array(ExplicitPreferenceSchema).default([]),
  inferences: z.array(InferredPreferenceSchema).default([]),
  constraints: z.array(UserConstraintSchema).default([]),
  confidence_level: z.number().int().min(0).max(100).default(0),
  preference_count: z.number().int().min(0).default(0),
  inference_count: z.number().int().min(0).default(0),
  constraint_count: z.number().int().min(0).default(0),
  generated_at: z.string().datetime()
});
export type PreferenceBundle = z.infer<typeof PreferenceBundleSchema>;

// =============================================================================
// VTID-01119: API Request/Response Schemas
// =============================================================================

/**
 * Set preference request
 */
export const SetPreferenceRequestSchema = z.object({
  category: PreferenceCategory,
  key: z.string().min(1).max(100),
  value: z.unknown(),
  priority: z.number().int().min(0).max(2).optional().default(1),
  scope: PreferenceScope.optional().default('global'),
  scope_domain: z.string().nullable().optional()
});
export type SetPreferenceRequest = z.infer<typeof SetPreferenceRequestSchema>;

/**
 * Delete preference request
 */
export const DeletePreferenceRequestSchema = z.object({
  category: PreferenceCategory,
  key: z.string().min(1).max(100),
  scope: PreferenceScope.optional().default('global'),
  scope_domain: z.string().nullable().optional()
});
export type DeletePreferenceRequest = z.infer<typeof DeletePreferenceRequestSchema>;

/**
 * Set constraint request
 */
export const SetConstraintRequestSchema = z.object({
  type: ConstraintType,
  key: z.string().min(1).max(100),
  value: z.unknown(),
  severity: ConstraintSeverity.optional().default('hard'),
  reason: z.string().nullable().optional()
});
export type SetConstraintRequest = z.infer<typeof SetConstraintRequestSchema>;

/**
 * Delete constraint request
 */
export const DeleteConstraintRequestSchema = z.object({
  type: ConstraintType,
  key: z.string().min(1).max(100)
});
export type DeleteConstraintRequest = z.infer<typeof DeleteConstraintRequestSchema>;

/**
 * Confirm preference request
 */
export const ConfirmPreferenceRequestSchema = z.object({
  preference_id: z.string().uuid()
});
export type ConfirmPreferenceRequest = z.infer<typeof ConfirmPreferenceRequestSchema>;

/**
 * Reinforce inference request
 */
export const ReinforceInferenceRequestSchema = z.object({
  inference_id: z.string().uuid(),
  evidence: z.string().optional()
});
export type ReinforceInferenceRequest = z.infer<typeof ReinforceInferenceRequestSchema>;

/**
 * Downgrade inference request
 */
export const DowngradeInferenceRequestSchema = z.object({
  inference_id: z.string().uuid(),
  reason: z.string().optional()
});
export type DowngradeInferenceRequest = z.infer<typeof DowngradeInferenceRequestSchema>;

/**
 * Get audit request
 */
export const GetAuditRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  target_type: z.enum(['preference', 'inference', 'constraint', 'bundle']).optional()
});
export type GetAuditRequest = z.infer<typeof GetAuditRequestSchema>;

// =============================================================================
// VTID-01119: API Response Types
// =============================================================================

/**
 * Standard API response
 */
export interface PreferenceApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Set preference response
 */
export interface SetPreferenceResponse {
  ok: boolean;
  id?: string;
  category?: PreferenceCategory;
  key?: string;
  action?: 'preference_created' | 'preference_updated';
  error?: string;
}

/**
 * Delete preference response
 */
export interface DeletePreferenceResponse {
  ok: boolean;
  deleted?: boolean;
  id?: string;
  error?: string;
}

/**
 * Set constraint response
 */
export interface SetConstraintResponse {
  ok: boolean;
  id?: string;
  type?: ConstraintType;
  key?: string;
  action?: 'constraint_created' | 'constraint_updated';
  error?: string;
}

/**
 * Delete constraint response
 */
export interface DeleteConstraintResponse {
  ok: boolean;
  deleted?: boolean;
  id?: string;
  error?: string;
}

/**
 * Preference bundle response
 */
export interface PreferenceBundleResponse {
  ok: boolean;
  preferences?: ExplicitPreference[];
  inferences?: InferredPreference[];
  constraints?: UserConstraint[];
  confidence_level?: number;
  preference_count?: number;
  inference_count?: number;
  constraint_count?: number;
  generated_at?: string;
  error?: string;
}

/**
 * Confirm preference response
 */
export interface ConfirmPreferenceResponse {
  ok: boolean;
  id?: string;
  confirmed_at?: string;
  error?: string;
}

/**
 * Reinforce inference response
 */
export interface ReinforceInferenceResponse {
  ok: boolean;
  id?: string;
  old_confidence?: number;
  new_confidence?: number;
  delta?: number;
  error?: string;
}

/**
 * Downgrade inference response
 */
export interface DowngradeInferenceResponse {
  ok: boolean;
  id?: string;
  old_confidence?: number;
  new_confidence?: number;
  delta?: number;
  deleted?: boolean;
  reason?: string;
  error?: string;
}

/**
 * Audit entry
 */
export interface PreferenceAuditEntry {
  id: string;
  action: string;
  target_type: 'preference' | 'inference' | 'constraint' | 'bundle';
  target_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason_code: string | null;
  confidence_delta: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Audit response
 */
export interface PreferenceAuditResponse {
  ok: boolean;
  audit?: PreferenceAuditEntry[];
  pagination?: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
  error?: string;
}

// =============================================================================
// VTID-01119: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for preference modeling
 */
export const PREFERENCE_MODELING_EVENT_TYPES = [
  'preference.set',
  'preference.deleted',
  'preference.confirmed',
  'inference.created',
  'inference.reinforced',
  'inference.downgraded',
  'constraint.set',
  'constraint.deleted',
  'bundle.computed'
] as const;

export type PreferenceModelingEventType = typeof PREFERENCE_MODELING_EVENT_TYPES[number];

/**
 * OASIS event payload for preference modeling
 */
export interface PreferenceModelingEventPayload {
  vtid: string;
  tenant_id: string;
  user_id: string;
  action: PreferenceModelingEventType;
  target_type: 'preference' | 'inference' | 'constraint' | 'bundle';
  target_id?: string;
  category?: PreferenceCategory;
  key?: string;
  confidence_delta?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01119: Category Metadata
// =============================================================================

/**
 * Category metadata for UI display
 */
export const PREFERENCE_CATEGORY_METADATA: Record<PreferenceCategory, {
  label: string;
  description: string;
  icon: string;
}> = {
  health: {
    label: 'Health Preferences',
    description: 'Diet, intensity, sensitivity, medical constraints',
    icon: 'heart'
  },
  communication: {
    label: 'Communication Style',
    description: 'Short vs detailed, proactive vs reactive, tone preferences',
    icon: 'message-circle'
  },
  social: {
    label: 'Social Boundaries',
    description: 'Introvert/extrovert, contact limits, group size preferences',
    icon: 'users'
  },
  economic: {
    label: 'Economic Behavior',
    description: 'Spend/earn sensitivity, price range preferences',
    icon: 'dollar-sign'
  },
  autonomy: {
    label: 'Autonomy Tolerance',
    description: 'Ask vs act, automation level, decision delegation',
    icon: 'zap'
  },
  privacy: {
    label: 'Privacy Sensitivity',
    description: 'Data sharing, visibility, third-party access controls',
    icon: 'shield'
  }
};

/**
 * Constraint type metadata for UI display
 */
export const CONSTRAINT_TYPE_METADATA: Record<ConstraintType, {
  label: string;
  description: string;
}> = {
  topic_avoid: {
    label: 'Topics to Avoid',
    description: 'Topics that should never be surfaced or discussed'
  },
  domain_downrank: {
    label: 'Domain Down-ranking',
    description: 'Domains to de-prioritize in recommendations'
  },
  timing: {
    label: 'Timing Restrictions',
    description: 'Time-based restrictions like quiet hours'
  },
  role_limit: {
    label: 'Role Limits',
    description: 'Role-specific limitations and boundaries'
  },
  contact_limit: {
    label: 'Contact Limits',
    description: 'Frequency limits for contacts and notifications'
  },
  content_filter: {
    label: 'Content Filters',
    description: 'Filters for specific types of content'
  },
  safety: {
    label: 'Safety Constraints',
    description: 'Safety-related hard boundaries'
  }
};
