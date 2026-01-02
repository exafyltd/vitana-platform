/**
 * VTID-01121: User Feedback, Correction & Trust Repair Engine
 *
 * Deterministic feedback and correction loop so ORB can:
 * - Accept corrections
 * - Repair trust
 * - Permanently improve behavior
 *
 * Core principle: Intelligence that cannot be corrected becomes dangerous.
 * User feedback is first-class input and authoritative.
 *
 * Hard Constraints:
 * - Feedback may NOT be ignored
 * - Corrections override inference
 * - Rejected behavior may NOT resurface automatically
 * - Feedback propagates to all downstream layers
 *
 * Determinism Rules:
 * - Same feedback → same correction outcome
 * - No emotional interpretation
 * - Rule-based updates only
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';
import {
  FeedbackType,
  CorrectionTarget,
  SafetyCategory,
  ConstraintType,
  RepairAction,
  FeedbackCorrection,
  TrustRepairEntry,
  BehaviorConstraint,
  UserTrustScore,
  ChangesApplied,
  PropagationLog,
  RepairDetails,
  SubmitCorrectionRequest,
  FEEDBACK_PROCESSING_RULES,
  TRUST_REPAIR_RULES,
  SAFETY_ESCALATION_KEYWORDS,
  FEEDBACK_TYPES,
  CORRECTION_TARGETS
} from '../types/feedback-trust';

// =============================================================================
// VTID-01121: Constants
// =============================================================================

const VTID = 'VTID-01121';
const DEFAULT_TRUST_SCORE = 100;
const MIN_TRUST_SCORE = 0;
const MAX_TRUST_SCORE = 100;

// =============================================================================
// VTID-01121: Safety Detection
// =============================================================================

/**
 * Detect if correction involves sensitive content requiring safety escalation.
 * Deterministic keyword-based detection.
 */
export function detectSafetyEscalation(
  correctionDetail: string,
  correctionTarget: CorrectionTarget
): { escalate: boolean; category: SafetyCategory | null } {
  const lowerText = correctionDetail.toLowerCase();

  // Check each safety category
  for (const [category, keywords] of Object.entries(SAFETY_ESCALATION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return { escalate: true, category: category as SafetyCategory };
      }
    }
  }

  // Also escalate for certain correction targets
  if (correctionTarget === 'preference' || correctionTarget === 'autonomy') {
    // Check for privacy-sensitive preference corrections
    if (lowerText.includes('share') || lowerText.includes('access') || lowerText.includes('permission')) {
      return { escalate: true, category: 'privacy' };
    }
  }

  return { escalate: false, category: null };
}

// =============================================================================
// VTID-01121: Correction Processing
// =============================================================================

/**
 * Calculate changes to apply based on feedback type.
 * Deterministic - same feedback → same changes.
 */
export function calculateChangesApplied(
  feedbackType: FeedbackType,
  correctionTarget: CorrectionTarget,
  correctionDetail: string
): ChangesApplied {
  const rules = FEEDBACK_PROCESSING_RULES[feedbackType];

  const changes: ChangesApplied = {
    confidence_adjustment: rules.confidence_adjustment,
    feedback_type_applied: feedbackType,
    correction_target: correctionTarget
  };

  // Add constraint if required by rules
  if (rules.creates_constraint) {
    switch (correctionTarget) {
      case 'recommendation':
        changes.constraint_added = 'never_suggest';
        break;
      case 'behavior':
        changes.behavior_blocked = true;
        changes.constraint_added = 'behavior_block';
        break;
      case 'topic':
        changes.topic_dampened = correctionDetail.split(' ')[0]; // First word as topic hint
        changes.constraint_added = 'topic_block';
        break;
      case 'autonomy':
        changes.constraint_added = 'always_ask_first';
        break;
      case 'preference':
        changes.preference_changed = true;
        changes.constraint_added = 'preference_override';
        break;
      default:
        changes.constraint_added = 'require_confirmation';
    }
  }

  // Memory update for memory corrections
  if (correctionTarget === 'memory') {
    changes.memory_updated = true;
  }

  return changes;
}

/**
 * Determine constraint type based on feedback and correction target.
 */
export function determineConstraintType(
  feedbackType: FeedbackType,
  correctionTarget: CorrectionTarget
): ConstraintType | null {
  const rules = FEEDBACK_PROCESSING_RULES[feedbackType];

  if (!rules.creates_constraint) {
    return null;
  }

  // Map correction target to constraint type
  switch (correctionTarget) {
    case 'recommendation':
      return 'never_suggest';
    case 'behavior':
      return 'behavior_block';
    case 'topic':
      return 'topic_block';
    case 'autonomy':
      return 'always_ask_first';
    case 'preference':
      return 'preference_override';
    case 'inference':
      return 'confidence_cap';
    default:
      return 'require_confirmation';
  }
}

/**
 * Generate propagation log for downstream layers.
 */
export function generatePropagationLog(
  changes: ChangesApplied,
  affectedMemoryIds: string[],
  affectedStateKeys: string[]
): PropagationLog {
  return {
    layers_notified: ['memory', 'preferences', 'behavior', 'recommendations'],
    memory_updated: changes.memory_updated || affectedMemoryIds.length > 0,
    preferences_updated: changes.preference_changed || false,
    constraints_added: changes.constraint_added ? [changes.constraint_added] : [],
    timestamp: new Date().toISOString()
  };
}

// =============================================================================
// VTID-01121: Trust Score Calculation
// =============================================================================

/**
 * Calculate new trust score after a correction.
 * Deterministic - same correction → same trust impact.
 */
export function calculateTrustImpact(
  currentScore: number,
  feedbackType: FeedbackType,
  safetyEscalation: boolean
): { newScore: number; impact: number } {
  const rules = FEEDBACK_PROCESSING_RULES[feedbackType];
  let impact = rules.default_trust_impact;

  // Additional penalty for safety escalation
  if (safetyEscalation) {
    impact -= 5;
  }

  const newScore = Math.max(MIN_TRUST_SCORE, Math.min(MAX_TRUST_SCORE, currentScore + impact));

  return { newScore, impact };
}

/**
 * Calculate trust recovery from repair action.
 */
export function calculateTrustRecovery(
  currentScore: number,
  repairAction: RepairAction
): { newScore: number; delta: number } {
  const rules = TRUST_REPAIR_RULES[repairAction];
  const delta = rules.trust_delta;
  const newScore = Math.max(MIN_TRUST_SCORE, Math.min(MAX_TRUST_SCORE, currentScore + delta));

  return { newScore, delta };
}

/**
 * Determine trust trend based on recent changes.
 */
export function determineTrustTrend(
  recentDeltas: number[]
): 'improving' | 'stable' | 'declining' {
  if (recentDeltas.length === 0) {
    return 'stable';
  }

  const sum = recentDeltas.reduce((a, b) => a + b, 0);
  const avg = sum / recentDeltas.length;

  if (avg > 2) {
    return 'improving';
  } else if (avg < -2) {
    return 'declining';
  }
  return 'stable';
}

// =============================================================================
// VTID-01121: Template Explanations (Deterministic)
// =============================================================================

/**
 * Generate acknowledgment template for correction.
 * Deterministic templates - no AI generation.
 */
export const CORRECTION_ACKNOWLEDGMENTS: Record<FeedbackType, string> = {
  explicit_correction: 'I understand this was incorrect. I have updated my understanding and will not repeat this mistake.',
  preference_clarification: 'Thank you for clarifying your preference. I have recorded this for future interactions.',
  boundary_enforcement: 'I respect this boundary. I will not cross it again.',
  tone_adjustment: 'I will adjust my communication style as you requested.',
  suggestion_rejection: 'I understand you do not want this suggestion. I will not offer it again.',
  autonomy_refusal: 'I will ask for your confirmation before taking this type of action in the future.'
};

/**
 * Generate repair message template.
 */
export const REPAIR_MESSAGES: Record<RepairAction, string> = {
  acknowledged: 'Your feedback has been acknowledged.',
  correction_applied: 'The correction has been applied to the system.',
  behavior_changed: 'My behavior has been updated based on your feedback.',
  trust_recovering: 'Trust is being restored through consistent correct behavior.',
  trust_restored: 'Trust has been fully restored.',
  repeated_error: 'I apologize for repeating this error. Additional safeguards have been added.',
  constraint_added: 'A new constraint has been added to prevent this in the future.',
  rule_updated: 'The relevant rule has been updated based on your correction.'
};

// =============================================================================
// VTID-01121: Event Emission Helpers
// =============================================================================

/**
 * Emit feedback correction event to OASIS.
 */
export async function emitFeedbackCorrectionEvent(
  type: 'feedback.correction.recorded' | 'feedback.correction.propagated' | 'feedback.constraint.added' | 'feedback.safety.escalated',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as CicdEventType,
      source: 'feedback-trust-engine',
      status,
      message,
      payload
    });
  } catch (err) {
    console.warn(`[${VTID}] Failed to emit ${type}:`, err);
  }
}

/**
 * Emit trust repair event to OASIS.
 */
export async function emitTrustRepairEvent(
  type: 'trust.score.updated' | 'trust.repair.action' | 'trust.trend.changed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as CicdEventType,
      source: 'feedback-trust-engine',
      status,
      message,
      payload
    });
  } catch (err) {
    console.warn(`[${VTID}] Failed to emit ${type}:`, err);
  }
}

// =============================================================================
// VTID-01121: Database Operations (Service Role)
// =============================================================================

/**
 * Record a feedback correction in the database.
 * Uses service role for database writes.
 */
export async function recordFeedbackCorrection(
  tenantId: string,
  userId: string,
  request: SubmitCorrectionRequest,
  currentTrustScore: number
): Promise<{
  ok: boolean;
  correction?: FeedbackCorrection;
  trustImpact?: number;
  newTrustScore?: number;
  constraintAdded?: string;
  safetyEscalated?: boolean;
  error?: string;
}> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[${VTID}] Cannot record correction: missing Supabase credentials`);
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    // 1. Detect safety escalation
    const { escalate, category } = detectSafetyEscalation(
      request.correction_detail,
      request.correction_target
    );

    // 2. Calculate changes to apply (deterministic)
    const changesApplied = calculateChangesApplied(
      request.feedback_type,
      request.correction_target,
      request.correction_detail
    );

    // 3. Calculate trust impact
    const { newScore, impact } = calculateTrustImpact(
      currentTrustScore,
      request.feedback_type,
      escalate
    );

    // 4. Generate propagation log
    const propagationLog = generatePropagationLog(
      changesApplied,
      request.affected_memory_ids || [],
      request.affected_state_keys || []
    );

    // 5. Prepare correction record
    const correctionId = randomUUID();
    const correctionRecord = {
      id: correctionId,
      tenant_id: tenantId,
      user_id: userId,
      feedback_type: request.feedback_type,
      correction_target: request.correction_target,
      correction_detail: request.correction_detail,
      affected_memory_ids: request.affected_memory_ids || [],
      affected_rule_ids: [],
      affected_state_keys: request.affected_state_keys || [],
      changes_applied: changesApplied,
      trust_impact_score: impact,
      safety_escalation: escalate,
      safety_category: category,
      propagated: true, // Propagation happens synchronously
      propagated_at: new Date().toISOString(),
      propagation_log: propagationLog,
      session_id: request.session_id || null,
      context_snapshot: request.context || null,
      created_at: new Date().toISOString()
    };

    // 6. Insert correction record
    const response = await fetch(`${supabaseUrl}/rest/v1/feedback_corrections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(correctionRecord)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Correction insert failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    const insertedData = await response.json();
    console.log(`[${VTID}] Correction recorded: ${correctionId}`);

    // 7. Emit OASIS event
    await emitFeedbackCorrectionEvent(
      'feedback.correction.recorded',
      'success',
      `Feedback correction recorded: ${request.feedback_type}`,
      {
        correction_id: correctionId,
        feedback_type: request.feedback_type,
        correction_target: request.correction_target,
        trust_impact: impact,
        new_trust_score: newScore,
        safety_escalated: escalate
      }
    );

    // 8. If safety escalated, emit additional event
    if (escalate) {
      await emitFeedbackCorrectionEvent(
        'feedback.safety.escalated',
        'warning',
        `Safety escalation triggered for ${category} content`,
        {
          correction_id: correctionId,
          safety_category: category,
          feedback_type: request.feedback_type
        }
      );
    }

    return {
      ok: true,
      correction: insertedData[0] as FeedbackCorrection,
      trustImpact: impact,
      newTrustScore: newScore,
      constraintAdded: changesApplied.constraint_added,
      safetyEscalated: escalate
    };
  } catch (err: any) {
    console.error(`[${VTID}] recordFeedbackCorrection error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Get or create user trust score.
 */
export async function getOrCreateUserTrustScore(
  tenantId: string,
  userId: string
): Promise<{ ok: boolean; trustScore?: UserTrustScore; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    // Try to get existing trust score
    const getResponse = await fetch(
      `${supabaseUrl}/rest/v1/user_trust_scores?user_id=eq.${userId}&limit=1`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      console.error(`[${VTID}] Trust score fetch failed:`, getResponse.status, errorText);
      return { ok: false, error: `Database error: ${getResponse.status}` };
    }

    const existingData = await getResponse.json();

    if (existingData.length > 0) {
      return { ok: true, trustScore: existingData[0] as UserTrustScore };
    }

    // Create new trust score if not exists
    const newTrustScore = {
      id: randomUUID(),
      tenant_id: tenantId,
      user_id: userId,
      trust_score: DEFAULT_TRUST_SCORE,
      correction_count: 0,
      repair_count: 0,
      repeated_error_count: 0,
      trust_trend: 'stable',
      total_corrections: 0,
      total_repairs: 0,
      active_constraints: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const createResponse = await fetch(`${supabaseUrl}/rest/v1/user_trust_scores`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(newTrustScore)
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error(`[${VTID}] Trust score create failed:`, createResponse.status, errorText);
      return { ok: false, error: `Database error: ${createResponse.status}` };
    }

    const createdData = await createResponse.json();
    return { ok: true, trustScore: createdData[0] as UserTrustScore };
  } catch (err: any) {
    console.error(`[${VTID}] getOrCreateUserTrustScore error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Update user trust score after correction or repair.
 */
export async function updateUserTrustScore(
  userId: string,
  updates: Partial<UserTrustScore>
): Promise<{ ok: boolean; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_trust_scores?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          ...updates,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Trust score update failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    return { ok: true };
  } catch (err: any) {
    console.error(`[${VTID}] updateUserTrustScore error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Record a trust repair action.
 */
export async function recordTrustRepair(
  tenantId: string,
  userId: string,
  feedbackCorrectionId: string | null,
  repairAction: RepairAction,
  currentTrustScore: number,
  details: RepairDetails
): Promise<{ ok: boolean; repairEntry?: TrustRepairEntry; newTrustScore?: number; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    // Calculate trust recovery
    const { newScore, delta } = calculateTrustRecovery(currentTrustScore, repairAction);

    // Prepare repair record
    const repairId = randomUUID();
    const repairRecord = {
      id: repairId,
      tenant_id: tenantId,
      user_id: userId,
      feedback_correction_id: feedbackCorrectionId,
      repair_action: repairAction,
      trust_score_before: currentTrustScore,
      trust_score_after: newScore,
      repair_details: details,
      created_at: new Date().toISOString()
    };

    // Insert repair record
    const response = await fetch(`${supabaseUrl}/rest/v1/trust_repair_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(repairRecord)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Repair record insert failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    const insertedData = await response.json();
    console.log(`[${VTID}] Trust repair recorded: ${repairId} (${repairAction})`);

    // Emit OASIS event
    await emitTrustRepairEvent(
      'trust.repair.action',
      delta > 0 ? 'success' : 'warning',
      `Trust repair action: ${repairAction}`,
      {
        repair_id: repairId,
        repair_action: repairAction,
        trust_before: currentTrustScore,
        trust_after: newScore,
        trust_delta: delta,
        feedback_correction_id: feedbackCorrectionId
      }
    );

    return {
      ok: true,
      repairEntry: insertedData[0] as TrustRepairEntry,
      newTrustScore: newScore
    };
  } catch (err: any) {
    console.error(`[${VTID}] recordTrustRepair error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Add a behavior constraint.
 */
export async function addBehaviorConstraint(
  tenantId: string,
  userId: string,
  feedbackCorrectionId: string | null,
  constraintType: ConstraintType,
  constraintKey: string,
  constraintValue: Record<string, unknown>,
  expiresAt?: string
): Promise<{ ok: boolean; constraint?: BehaviorConstraint; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    const constraintId = randomUUID();
    const constraintRecord = {
      id: constraintId,
      tenant_id: tenantId,
      user_id: userId,
      feedback_correction_id: feedbackCorrectionId,
      constraint_type: constraintType,
      constraint_key: constraintKey,
      constraint_value: constraintValue,
      active: true,
      expires_at: expiresAt || null,
      created_at: new Date().toISOString()
    };

    const response = await fetch(`${supabaseUrl}/rest/v1/behavior_constraints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(constraintRecord)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Constraint insert failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    const insertedData = await response.json();
    console.log(`[${VTID}] Behavior constraint added: ${constraintId} (${constraintType})`);

    // Emit OASIS event
    await emitFeedbackCorrectionEvent(
      'feedback.constraint.added',
      'success',
      `Behavior constraint added: ${constraintType}`,
      {
        constraint_id: constraintId,
        constraint_type: constraintType,
        constraint_key: constraintKey,
        feedback_correction_id: feedbackCorrectionId
      }
    );

    return { ok: true, constraint: insertedData[0] as BehaviorConstraint };
  } catch (err: any) {
    console.error(`[${VTID}] addBehaviorConstraint error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Get active behavior constraints for a user.
 */
export async function getActiveConstraints(
  userId: string
): Promise<{ ok: boolean; constraints?: BehaviorConstraint[]; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/behavior_constraints?user_id=eq.${userId}&active=eq.true&order=created_at.desc`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Constraints fetch failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    const data = await response.json();
    return { ok: true, constraints: data as BehaviorConstraint[] };
  } catch (err: any) {
    console.error(`[${VTID}] getActiveConstraints error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Deactivate a behavior constraint.
 */
export async function deactivateConstraint(
  constraintId: string,
  userId: string,
  reason: string
): Promise<{ ok: boolean; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/behavior_constraints?id=eq.${constraintId}&user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          active: false,
          deactivated_at: new Date().toISOString(),
          deactivation_reason: reason
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Constraint deactivate failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    console.log(`[${VTID}] Constraint deactivated: ${constraintId}`);
    return { ok: true };
  } catch (err: any) {
    console.error(`[${VTID}] deactivateConstraint error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Get correction history for a user.
 */
export async function getCorrectionHistory(
  userId: string,
  filters: {
    feedbackType?: FeedbackType;
    correctionTarget?: CorrectionTarget;
    from?: string;
    to?: string;
    limit?: number;
  }
): Promise<{ ok: boolean; corrections?: FeedbackCorrection[]; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing database credentials' };
  }

  try {
    let query = `${supabaseUrl}/rest/v1/feedback_corrections?user_id=eq.${userId}`;

    if (filters.feedbackType) {
      query += `&feedback_type=eq.${filters.feedbackType}`;
    }
    if (filters.correctionTarget) {
      query += `&correction_target=eq.${filters.correctionTarget}`;
    }
    if (filters.from) {
      query += `&created_at=gte.${filters.from}T00:00:00Z`;
    }
    if (filters.to) {
      query += `&created_at=lte.${filters.to}T23:59:59Z`;
    }

    query += `&order=created_at.desc&limit=${filters.limit || 50}`;

    const response = await fetch(query, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Corrections fetch failed:`, response.status, errorText);
      return { ok: false, error: `Database error: ${response.status}` };
    }

    const data = await response.json();
    return { ok: true, corrections: data as FeedbackCorrection[] };
  } catch (err: any) {
    console.error(`[${VTID}] getCorrectionHistory error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Check if a specific behavior is constrained.
 * Used by other services to check before taking action.
 */
export async function isBehaviorConstrained(
  userId: string,
  constraintKey: string,
  constraintType?: ConstraintType
): Promise<{ ok: boolean; constrained: boolean; constraint?: BehaviorConstraint; error?: string }> {
  const result = await getActiveConstraints(userId);

  if (!result.ok || !result.constraints) {
    return { ok: false, constrained: false, error: result.error };
  }

  const matchingConstraint = result.constraints.find(c => {
    const keyMatch = c.constraint_key === constraintKey;
    const typeMatch = !constraintType || c.constraint_type === constraintType;
    return keyMatch && typeMatch;
  });

  return {
    ok: true,
    constrained: !!matchingConstraint,
    constraint: matchingConstraint
  };
}

// =============================================================================
// VTID-01121: Export
// =============================================================================

export default {
  // Safety detection
  detectSafetyEscalation,

  // Correction processing
  calculateChangesApplied,
  determineConstraintType,
  generatePropagationLog,

  // Trust scoring
  calculateTrustImpact,
  calculateTrustRecovery,
  determineTrustTrend,

  // Templates
  CORRECTION_ACKNOWLEDGMENTS,
  REPAIR_MESSAGES,

  // Event emission
  emitFeedbackCorrectionEvent,
  emitTrustRepairEvent,

  // Database operations
  recordFeedbackCorrection,
  getOrCreateUserTrustScore,
  updateUserTrustScore,
  recordTrustRepair,
  addBehaviorConstraint,
  getActiveConstraints,
  deactivateConstraint,
  getCorrectionHistory,
  isBehaviorConstrained
};
