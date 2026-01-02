/**
 * VTID-01119: User Preference & Constraint Modeling Service
 *
 * D27 Core Intelligence - Deterministic Preference & Constraint Modeling Engine
 *
 * Captures how the user wants intelligence to behave, not just what they ask.
 * Personalization without constraints becomes manipulation.
 * Constraints make intelligence respectful.
 *
 * Core Principles (per spec):
 * - Explicit user input overrides inference
 * - Corrections downgrade confidence
 * - Repeated confirmations increase stability
 * - Inferred preferences never reach max confidence (capped at 85)
 * - Constraints ALWAYS override preferences
 * - Same signals -> same preference state (deterministic)
 * - No creative inference at this layer
 * - Updates are rule-based
 *
 * Position in Intelligence Stack:
 *   Memory + State -> D27 Preferences & Constraints -> D28+ Intelligence
 */

import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';
import {
  PreferenceCategory,
  ConstraintType,
  PreferenceBundle,
  ExplicitPreference,
  InferredPreference,
  UserConstraint,
  PreferenceAuditEntry,
  PreferenceModelingEventPayload,
  PREFERENCE_CATEGORY_METADATA,
  CONSTRAINT_TYPE_METADATA
} from '../types/user-preferences';

// =============================================================================
// VTID-01119: Constants
// =============================================================================

export const VTID = 'VTID-01119';

/**
 * Confidence thresholds for preference handling
 */
export const CONFIDENCE_THRESHOLDS = {
  EXPLICIT_DEFAULT: 100,     // Explicit preferences start at max confidence
  INFERENCE_MAX: 85,         // Inferred preferences cap at 85 per spec
  INFERENCE_DEFAULT: 50,     // Default confidence for new inferences
  REINFORCEMENT_DELTA: 5,    // How much reinforcement increases confidence
  CORRECTION_DELTA: -20,     // How much correction decreases confidence
  DELETE_THRESHOLD: 0        // Delete inference if confidence drops to 0
};

/**
 * Priority weights for preference resolution
 */
export const PRIORITY_WEIGHTS = {
  low: 0,
  medium: 1,
  high: 2
};

// =============================================================================
// VTID-01119: OASIS Event Helpers
// =============================================================================

/**
 * Emit a preference modeling OASIS event
 */
export async function emitPreferenceEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Partial<PreferenceModelingEventPayload>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as CicdEventType,
      source: 'user-preference-modeling-service',
      status,
      message,
      payload: {
        ...payload,
        vtid: VTID
      }
    });
  } catch (err) {
    console.warn(`[${VTID}] Failed to emit ${type}:`, err);
  }
}

// =============================================================================
// VTID-01119: Deterministic Inference Rules
// =============================================================================

/**
 * Inference rule definition
 */
export interface InferenceRule {
  category: PreferenceCategory;
  key: string;
  detect: (signals: InferenceSignals) => { match: boolean; value: unknown; confidence: number; evidence: string[] };
}

/**
 * Signals used for preference inference
 */
export interface InferenceSignals {
  // Health signals
  health_scores?: {
    score_physical?: number;
    score_mental?: number;
    score_nutritional?: number;
    score_social?: number;
    score_environmental?: number;
  };
  // Communication patterns
  message_lengths?: number[];
  response_times?: number[];
  // Social patterns
  group_sizes?: number[];
  contact_frequency?: number;
  // Economic patterns
  price_range?: { min: number; max: number };
  spend_frequency?: number;
  // Autonomy patterns
  approval_rate?: number;
  action_requests?: number;
  // Privacy patterns
  data_sharing_choices?: boolean[];
}

/**
 * Deterministic inference rules - no creative inference per spec
 */
export const INFERENCE_RULES: InferenceRule[] = [
  // Health category inferences
  {
    category: 'health',
    key: 'activity_intensity',
    detect: (signals) => {
      if (!signals.health_scores?.score_physical) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      const physical = signals.health_scores.score_physical;
      let value: 'low' | 'moderate' | 'high' = 'moderate';
      if (physical < 40) value = 'low';
      else if (physical > 70) value = 'high';
      return {
        match: true,
        value,
        confidence: Math.min(Math.round(physical * 0.8), 85),
        evidence: ['health_physical_score']
      };
    }
  },
  {
    category: 'health',
    key: 'stress_sensitivity',
    detect: (signals) => {
      if (!signals.health_scores?.score_mental) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      const mental = signals.health_scores.score_mental;
      const value = mental < 50 ? 'high' : mental < 70 ? 'moderate' : 'low';
      return {
        match: true,
        value,
        confidence: Math.min(85 - mental, 85),
        evidence: ['health_mental_score']
      };
    }
  },
  // Communication category inferences
  {
    category: 'communication',
    key: 'preferred_length',
    detect: (signals) => {
      if (!signals.message_lengths || signals.message_lengths.length < 5) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      const avg = signals.message_lengths.reduce((a, b) => a + b, 0) / signals.message_lengths.length;
      let value: 'short' | 'medium' | 'detailed' = 'medium';
      if (avg < 50) value = 'short';
      else if (avg > 200) value = 'detailed';
      return {
        match: true,
        value,
        confidence: Math.min(50 + signals.message_lengths.length * 2, 85),
        evidence: [`${signals.message_lengths.length}_message_samples`]
      };
    }
  },
  // Social category inferences
  {
    category: 'social',
    key: 'group_size_preference',
    detect: (signals) => {
      if (!signals.group_sizes || signals.group_sizes.length < 3) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      const avg = signals.group_sizes.reduce((a, b) => a + b, 0) / signals.group_sizes.length;
      let value: 'one_on_one' | 'small_group' | 'large_group' = 'small_group';
      if (avg <= 2) value = 'one_on_one';
      else if (avg > 10) value = 'large_group';
      return {
        match: true,
        value,
        confidence: Math.min(40 + signals.group_sizes.length * 5, 85),
        evidence: [`${signals.group_sizes.length}_group_interactions`]
      };
    }
  },
  {
    category: 'social',
    key: 'introvert_extrovert',
    detect: (signals) => {
      if (!signals.health_scores?.score_social) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      const social = signals.health_scores.score_social;
      const value = social < 40 ? 'introvert' : social > 70 ? 'extrovert' : 'ambivert';
      return {
        match: true,
        value,
        confidence: Math.min(Math.abs(social - 50) + 30, 85),
        evidence: ['health_social_score']
      };
    }
  },
  // Autonomy category inferences
  {
    category: 'autonomy',
    key: 'action_preference',
    detect: (signals) => {
      if (signals.approval_rate === undefined || signals.action_requests === undefined) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      if (signals.action_requests < 5) {
        return { match: false, value: null, confidence: 0, evidence: [] };
      }
      const value = signals.approval_rate > 0.8 ? 'act' : 'ask';
      return {
        match: true,
        value,
        confidence: Math.min(50 + Math.round(signals.action_requests * 2), 85),
        evidence: [`${signals.action_requests}_actions`, `${Math.round(signals.approval_rate * 100)}%_approval`]
      };
    }
  }
];

// =============================================================================
// VTID-01119: Core Service Functions
// =============================================================================

/**
 * Run inference rules against signals and return inferred preferences
 * Deterministic: Same signals -> same preference state
 */
export function runInferenceRules(signals: InferenceSignals): Array<{
  category: PreferenceCategory;
  key: string;
  value: unknown;
  confidence: number;
  evidence: string[];
}> {
  const inferences: Array<{
    category: PreferenceCategory;
    key: string;
    value: unknown;
    confidence: number;
    evidence: string[];
  }> = [];

  for (const rule of INFERENCE_RULES) {
    const result = rule.detect(signals);
    if (result.match && result.confidence > 0) {
      inferences.push({
        category: rule.category,
        key: rule.key,
        value: result.value,
        confidence: Math.min(result.confidence, CONFIDENCE_THRESHOLDS.INFERENCE_MAX),
        evidence: result.evidence
      });
    }
  }

  return inferences;
}

/**
 * Resolve effective preferences by merging explicit and inferred
 * Explicit always overrides inferred per spec section 6
 */
export function resolveEffectivePreferences(
  explicit: ExplicitPreference[],
  inferred: InferredPreference[]
): Array<{
  category: PreferenceCategory;
  key: string;
  value: unknown;
  confidence: number;
  source: 'explicit' | 'inferred';
  priority: number;
}> {
  const effectiveMap = new Map<string, {
    category: PreferenceCategory;
    key: string;
    value: unknown;
    confidence: number;
    source: 'explicit' | 'inferred';
    priority: number;
  }>();

  // First, add all inferred preferences
  for (const inf of inferred) {
    const mapKey = `${inf.category}:${inf.key}`;
    effectiveMap.set(mapKey, {
      category: inf.category as PreferenceCategory,
      key: inf.key,
      value: inf.value,
      confidence: inf.confidence,
      source: 'inferred',
      priority: 0
    });
  }

  // Then, override with explicit preferences (explicit always wins)
  for (const exp of explicit) {
    const mapKey = `${exp.category}:${exp.key}`;
    effectiveMap.set(mapKey, {
      category: exp.category as PreferenceCategory,
      key: exp.key,
      value: exp.value,
      confidence: exp.confidence,
      source: 'explicit',
      priority: exp.priority
    });
  }

  return Array.from(effectiveMap.values()).sort((a, b) => {
    // Sort by priority desc, then confidence desc
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.confidence - a.confidence;
  });
}

/**
 * Check if an action/recommendation violates any constraints
 * Constraints ALWAYS override preferences per spec section 7
 */
export function checkConstraintViolations(
  action: {
    type: string;
    domain?: string;
    topics?: string[];
    time?: Date;
    role?: string;
  },
  constraints: UserConstraint[]
): Array<{
  constraint_id: string;
  type: ConstraintType;
  key: string;
  reason: string;
  severity: 'hard' | 'soft';
}> {
  const violations: Array<{
    constraint_id: string;
    type: ConstraintType;
    key: string;
    reason: string;
    severity: 'hard' | 'soft';
  }> = [];

  for (const constraint of constraints) {
    if (!constraint.active) continue;

    const constraintValue = constraint.value as Record<string, unknown>;

    switch (constraint.type) {
      case 'topic_avoid':
        if (action.topics) {
          const avoidTopics = Array.isArray(constraintValue.topics)
            ? constraintValue.topics
            : [constraintValue.topic];
          const matchedTopic = action.topics.find(t =>
            avoidTopics.some((avoid: string) =>
              t.toLowerCase().includes(avoid.toLowerCase())
            )
          );
          if (matchedTopic) {
            violations.push({
              constraint_id: constraint.id,
              type: constraint.type,
              key: constraint.key,
              reason: `Topic "${matchedTopic}" is in avoid list`,
              severity: constraint.severity as 'hard' | 'soft'
            });
          }
        }
        break;

      case 'domain_downrank':
        if (action.domain) {
          const downrankDomains = Array.isArray(constraintValue.domains)
            ? constraintValue.domains
            : [constraintValue.domain];
          if (downrankDomains.includes(action.domain)) {
            violations.push({
              constraint_id: constraint.id,
              type: constraint.type,
              key: constraint.key,
              reason: `Domain "${action.domain}" is down-ranked`,
              severity: constraint.severity as 'hard' | 'soft'
            });
          }
        }
        break;

      case 'timing':
        if (action.time && constraintValue.quiet_hours) {
          const quietHours = constraintValue.quiet_hours as { from: string; to: string };
          const actionHour = action.time.getHours();
          const [fromHour] = quietHours.from.split(':').map(Number);
          const [toHour] = quietHours.to.split(':').map(Number);

          // Handle overnight quiet hours (e.g., 22:00 to 07:00)
          const isInQuietHours = fromHour > toHour
            ? actionHour >= fromHour || actionHour < toHour
            : actionHour >= fromHour && actionHour < toHour;

          if (isInQuietHours) {
            violations.push({
              constraint_id: constraint.id,
              type: constraint.type,
              key: constraint.key,
              reason: `Action scheduled during quiet hours (${quietHours.from} - ${quietHours.to})`,
              severity: constraint.severity as 'hard' | 'soft'
            });
          }
        }
        break;

      case 'role_limit':
        if (action.role) {
          const allowedRoles = Array.isArray(constraintValue.roles)
            ? constraintValue.roles
            : [constraintValue.role];
          if (!allowedRoles.includes(action.role)) {
            violations.push({
              constraint_id: constraint.id,
              type: constraint.type,
              key: constraint.key,
              reason: `Role "${action.role}" is not in allowed list`,
              severity: constraint.severity as 'hard' | 'soft'
            });
          }
        }
        break;

      // Add more constraint type handlers as needed
    }
  }

  return violations;
}

/**
 * Check if an action is allowed given constraints
 * Returns false if any hard constraint is violated
 */
export function isActionAllowed(
  action: {
    type: string;
    domain?: string;
    topics?: string[];
    time?: Date;
    role?: string;
  },
  constraints: UserConstraint[]
): { allowed: boolean; violations: Array<{ constraint_id: string; reason: string }> } {
  const violations = checkConstraintViolations(action, constraints);

  // Filter to only hard violations
  const hardViolations = violations.filter(v => v.severity === 'hard');

  return {
    allowed: hardViolations.length === 0,
    violations: violations.map(v => ({
      constraint_id: v.constraint_id,
      reason: v.reason
    }))
  };
}

/**
 * Calculate overall confidence level for a preference bundle
 */
export function calculateBundleConfidence(
  preferences: ExplicitPreference[],
  inferences: InferredPreference[]
): number {
  const allConfidences = [
    ...preferences.map(p => p.confidence),
    ...inferences.map(i => i.confidence)
  ];

  if (allConfidences.length === 0) return 0;

  const avg = allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length;
  return Math.round(avg);
}

/**
 * Build a complete preference bundle for a user
 */
export function buildPreferenceBundle(
  preferences: ExplicitPreference[],
  inferences: InferredPreference[],
  constraints: UserConstraint[]
): PreferenceBundle {
  const activeConstraints = constraints.filter(c => c.active);
  const confidenceLevel = calculateBundleConfidence(preferences, inferences);

  // Find most recent confirmation
  const confirmations = preferences
    .filter(p => p.last_confirmed_at)
    .map(p => new Date(p.last_confirmed_at!).getTime());
  const lastConfirmedAt = confirmations.length > 0
    ? new Date(Math.max(...confirmations)).toISOString()
    : undefined;

  return {
    preferences,
    inferences,
    constraints: activeConstraints,
    confidence_level: confidenceLevel,
    preference_count: preferences.length,
    inference_count: inferences.length,
    constraint_count: activeConstraints.length,
    generated_at: new Date().toISOString()
  };
}

/**
 * Get preference value by category and key
 * Checks explicit first, then inferred
 */
export function getPreferenceValue(
  category: PreferenceCategory,
  key: string,
  preferences: ExplicitPreference[],
  inferences: InferredPreference[]
): { value: unknown; source: 'explicit' | 'inferred' | 'none'; confidence: number } | null {
  // Check explicit first (always takes precedence)
  const explicit = preferences.find(p => p.category === category && p.key === key);
  if (explicit) {
    return {
      value: explicit.value,
      source: 'explicit',
      confidence: explicit.confidence
    };
  }

  // Check inferred
  const inferred = inferences.find(i => i.category === category && i.key === key);
  if (inferred) {
    return {
      value: inferred.value,
      source: 'inferred',
      confidence: inferred.confidence
    };
  }

  return null;
}

/**
 * Format a preference for display
 */
export function formatPreferenceForDisplay(
  category: PreferenceCategory,
  key: string,
  value: unknown
): string {
  const categoryMeta = PREFERENCE_CATEGORY_METADATA[category];
  const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `${categoryMeta.label} > ${key}: ${valueStr}`;
}

/**
 * Format a constraint for display
 */
export function formatConstraintForDisplay(
  type: ConstraintType,
  key: string,
  value: unknown
): string {
  const typeMeta = CONSTRAINT_TYPE_METADATA[type];
  const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `${typeMeta.label} > ${key}: ${valueStr}`;
}

// =============================================================================
// VTID-01119: Export Default
// =============================================================================

export default {
  VTID,
  CONFIDENCE_THRESHOLDS,
  PRIORITY_WEIGHTS,
  INFERENCE_RULES,
  emitPreferenceEvent,
  runInferenceRules,
  resolveEffectivePreferences,
  checkConstraintViolations,
  isActionAllowed,
  calculateBundleConfidence,
  buildPreferenceBundle,
  getPreferenceValue,
  formatPreferenceForDisplay,
  formatConstraintForDisplay
};
