/**
 * VTID-01121: Trust Repair Service
 *
 * Service layer for ORB to interact with the feedback and trust repair system.
 * Provides deterministic logic for handling corrections and repairing trust.
 *
 * Usage:
 * - ORB calls this service when it detects a correction or needs to check constraints
 * - The service applies deterministic rules and propagates changes
 * - Trust repair happens when ORB acknowledges mistakes and changes behavior
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  FeedbackType,
  AffectedComponent,
  TrustComponent,
  ConstraintType,
  TrustScore,
  BehaviorConstraint,
  UserCorrection,
  PropagationRecord,
  TRUST_DELTAS,
  TRUST_RECOVERY_DELTA,
  MAX_RECOVERED_TRUST,
  MIN_TRUST,
  DEFAULT_TRUST,
  getTrustLevel,
  shouldRestrictBehavior,
  needsImmediateAttention,
  containsMedicalContent,
  containsEmotionalContent,
} from '../types/feedback-correction';

// =============================================================================
// Types
// =============================================================================

export interface CorrectionDetectionResult {
  isCorrection: boolean;
  feedbackType: FeedbackType | null;
  affectedComponent: AffectedComponent;
  confidence: number;  // 0-100
  detectedKeywords: string[];
}

export interface TrustContext {
  scores: TrustScore[];
  constraints: BehaviorConstraint[];
  recentCorrections: UserCorrection[];
  overallTrust: number;
  requiresRestriction: boolean;
  needsAttention: boolean;
}

export interface CorrectionResponse {
  acknowledged: boolean;
  correctionApplied: string;
  trustImpact: number;
  behaviorChange: string;
}

// =============================================================================
// Correction Detection Keywords
// =============================================================================

const EXPLICIT_CORRECTION_KEYWORDS = [
  "that's wrong", "that is wrong", "you're wrong", "you are wrong",
  "not correct", "incorrect", "no that's not", "no, that's not",
  "actually,", "actually no", "no actually", "wrong",
  "that's not right", "that is not right", "not what i said",
  "i didn't say", "i never said", "misunderstood", "you misheard",
];

const PREFERENCE_KEYWORDS = [
  "i prefer", "i'd rather", "i would rather", "i like",
  "i don't like", "i'd prefer", "my preference is", "instead of",
  "can you", "could you", "please don't", "please do",
];

const BOUNDARY_KEYWORDS = [
  "don't", "do not", "never", "stop", "enough",
  "i don't want", "i do not want", "please stop",
  "that's too much", "that is too much", "leave me alone",
  "not interested", "i said no", "respect my",
];

const TONE_KEYWORDS = [
  "too formal", "too casual", "more professional", "more friendly",
  "less", "more", "tone", "way you speak", "how you talk",
  "sound like", "come across as", "be more", "be less",
];

const REJECTION_KEYWORDS = [
  "no thanks", "no thank you", "not interested",
  "i'll pass", "skip", "ignore", "don't suggest",
  "stop suggesting", "don't recommend", "stop recommending",
];

const AUTONOMY_KEYWORDS = [
  "ask me first", "don't do that automatically",
  "let me decide", "i want to choose", "don't assume",
  "check with me", "confirm with me", "wait for me",
  "don't act without", "i didn't ask you to",
];

// =============================================================================
// TrustRepairService Class
// =============================================================================

export class TrustRepairService {
  private supabase: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Create a service instance with user auth context
   */
  static createWithUserToken(userToken: string): TrustRepairService {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      },
    });

    const service = new TrustRepairService(supabaseUrl, supabaseAnonKey);
    service.supabase = supabase;
    return service;
  }

  /**
   * Detect if a user message contains a correction.
   * Uses keyword matching for deterministic detection.
   */
  detectCorrection(userMessage: string): CorrectionDetectionResult {
    const message = userMessage.toLowerCase().trim();
    const detectedKeywords: string[] = [];
    let feedbackType: FeedbackType | null = null;
    let confidence = 0;

    // Check each category of keywords
    const checks: Array<{
      keywords: string[];
      type: FeedbackType;
      baseConfidence: number;
    }> = [
      { keywords: EXPLICIT_CORRECTION_KEYWORDS, type: 'explicit_correction', baseConfidence: 90 },
      { keywords: BOUNDARY_KEYWORDS, type: 'boundary_enforcement', baseConfidence: 85 },
      { keywords: AUTONOMY_KEYWORDS, type: 'autonomy_refusal', baseConfidence: 80 },
      { keywords: REJECTION_KEYWORDS, type: 'suggestion_rejection', baseConfidence: 75 },
      { keywords: TONE_KEYWORDS, type: 'tone_adjustment', baseConfidence: 70 },
      { keywords: PREFERENCE_KEYWORDS, type: 'preference_clarification', baseConfidence: 65 },
    ];

    for (const check of checks) {
      for (const keyword of check.keywords) {
        if (message.includes(keyword)) {
          detectedKeywords.push(keyword);
          if (!feedbackType || check.baseConfidence > confidence) {
            feedbackType = check.type;
            confidence = check.baseConfidence;
          }
        }
      }
    }

    // Boost confidence if multiple keywords detected
    if (detectedKeywords.length > 1) {
      confidence = Math.min(100, confidence + (detectedKeywords.length - 1) * 5);
    }

    // Determine affected component
    let affectedComponent: AffectedComponent = 'general';
    if (containsMedicalContent(message)) {
      affectedComponent = 'health';
    } else if (containsEmotionalContent(message)) {
      affectedComponent = 'relationships';
    } else if (feedbackType === 'tone_adjustment') {
      affectedComponent = 'tone';
    } else if (feedbackType === 'autonomy_refusal') {
      affectedComponent = 'autonomy';
    } else if (feedbackType === 'suggestion_rejection') {
      affectedComponent = 'suggestions';
    } else if (feedbackType === 'preference_clarification') {
      affectedComponent = 'preferences';
    }

    return {
      isCorrection: feedbackType !== null && confidence >= 60,
      feedbackType,
      affectedComponent,
      confidence,
      detectedKeywords,
    };
  }

  /**
   * Record a correction and apply deterministic updates.
   */
  async recordCorrection(
    feedbackType: FeedbackType,
    content: string,
    affectedComponent: AffectedComponent,
    context: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<{
    ok: boolean;
    correctionId?: string;
    trustImpact?: number;
    propagations?: PropagationRecord[];
    error?: string;
  }> {
    try {
      const { data, error } = await this.supabase.rpc('record_user_correction', {
        p_payload: {
          feedback_type: feedbackType,
          content,
          context,
          affected_component: affectedComponent,
          session_id: sessionId || null,
          source: 'orb',
        },
      });

      if (error) {
        console.error('[VTID-01121] TrustRepairService.recordCorrection error:', error.message);
        return { ok: false, error: error.message };
      }

      if (!data || data.ok === false) {
        return { ok: false, error: data?.error || 'UNKNOWN_ERROR' };
      }

      // Emit event for observability
      await emitOasisEvent({
        vtid: 'VTID-01121',
        type: 'feedback.correction.recorded' as any,
        source: 'trust-repair-service',
        status: 'success',
        message: `Correction recorded via TrustRepairService: ${feedbackType}`,
        payload: {
          correction_id: data.correction_id,
          feedback_type: feedbackType,
          affected_component: affectedComponent,
          trust_impact: data.trust_impact,
        },
      }).catch(() => {});

      return {
        ok: true,
        correctionId: data.correction_id,
        trustImpact: data.trust_impact,
        propagations: data.propagations,
      };
    } catch (err: any) {
      console.error('[VTID-01121] TrustRepairService.recordCorrection exception:', err.message);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Get the current trust context for ORB decision-making.
   */
  async getTrustContext(): Promise<TrustContext | null> {
    try {
      // Fetch trust scores
      const { data: trustData, error: trustError } = await this.supabase.rpc('get_trust_scores');

      if (trustError || !trustData?.ok) {
        console.error('[VTID-01121] Failed to get trust scores:', trustError?.message);
        return null;
      }

      // Fetch constraints
      const { data: constraintData, error: constraintError } = await this.supabase.rpc('get_behavior_constraints', {
        p_constraint_type: null,
      });

      if (constraintError || !constraintData?.ok) {
        console.error('[VTID-01121] Failed to get constraints:', constraintError?.message);
        return null;
      }

      // Fetch recent corrections (last 24 hours)
      const { data: historyData, error: historyError } = await this.supabase.rpc('get_correction_history', {
        p_limit: 10,
        p_offset: 0,
        p_feedback_type: null,
      });

      if (historyError || !historyData?.ok) {
        console.error('[VTID-01121] Failed to get correction history:', historyError?.message);
        return null;
      }

      const scores: TrustScore[] = trustData.scores || [];
      const constraints: BehaviorConstraint[] = constraintData.constraints || [];
      const recentCorrections: UserCorrection[] = historyData.corrections || [];

      // Find overall trust score
      const overallScore = scores.find(s => s.component === 'overall');
      const overallTrust = overallScore?.score ?? DEFAULT_TRUST;

      // Check if any component requires restriction
      const requiresRestriction = scores.some(s => shouldRestrictBehavior(s));
      const needsAttention = scores.some(s => needsImmediateAttention(s));

      return {
        scores,
        constraints,
        recentCorrections,
        overallTrust,
        requiresRestriction,
        needsAttention,
      };
    } catch (err: any) {
      console.error('[VTID-01121] TrustRepairService.getTrustContext exception:', err.message);
      return null;
    }
  }

  /**
   * Check if a specific behavior is constrained.
   */
  async isConstrained(constraintType: ConstraintType, constraintKey: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabase.rpc('check_behavior_constraint', {
        p_constraint_type: constraintType,
        p_constraint_key: constraintKey,
      });

      if (error || !data?.ok) {
        console.error('[VTID-01121] isConstrained check failed:', error?.message);
        return false;  // Fail open for safety
      }

      return data.is_constrained === true;
    } catch (err: any) {
      console.error('[VTID-01121] isConstrained exception:', err.message);
      return false;
    }
  }

  /**
   * Repair trust after ORB acknowledges mistake.
   * Called when ORB takes corrective action and wants to recover trust.
   */
  async repairTrust(
    component: TrustComponent,
    repairAction: string,
    correctionId?: string
  ): Promise<{
    ok: boolean;
    oldScore?: number;
    newScore?: number;
    error?: string;
  }> {
    try {
      const { data, error } = await this.supabase.rpc('repair_trust', {
        p_payload: {
          component,
          correction_id: correctionId || null,
          repair_action: repairAction,
        },
      });

      if (error) {
        console.error('[VTID-01121] repair_trust error:', error.message);
        return { ok: false, error: error.message };
      }

      if (!data || data.ok === false) {
        return { ok: false, error: data?.error || 'UNKNOWN_ERROR' };
      }

      return {
        ok: true,
        oldScore: data.old_score,
        newScore: data.new_score,
      };
    } catch (err: any) {
      console.error('[VTID-01121] repairTrust exception:', err.message);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Generate an appropriate acknowledgment response for a correction.
   * This provides templates for ORB to use when responding to corrections.
   */
  generateAcknowledgment(
    feedbackType: FeedbackType,
    content: string,
    trustContext: TrustContext
  ): CorrectionResponse {
    const trustImpact = TRUST_DELTAS[feedbackType];

    // Template-based responses (no LLM, deterministic)
    const acknowledgments: Record<FeedbackType, string> = {
      explicit_correction: "I understand I got that wrong. I've noted your correction and will avoid this mistake.",
      preference_clarification: "Thanks for clarifying. I've updated my understanding of your preferences.",
      boundary_enforcement: "I hear you and will respect that boundary. It won't happen again.",
      tone_adjustment: "I'll adjust how I communicate with you. Thanks for letting me know.",
      suggestion_rejection: "Understood, I won't suggest that again.",
      autonomy_refusal: "Got it. I'll ask before taking that kind of action in the future.",
    };

    const behaviorChanges: Record<FeedbackType, string> = {
      explicit_correction: 'Memory and inference downgraded for affected topic',
      preference_clarification: 'Preference recorded and will influence future responses',
      boundary_enforcement: 'Hard constraint created, behavior will not resurface',
      tone_adjustment: 'Tone preferences updated for future interactions',
      suggestion_rejection: 'Suggestion type blocked for future recommendations',
      autonomy_refusal: 'Autonomy scope reduced, will seek confirmation',
    };

    // If trust is low, add extra acknowledgment
    let acknowledgment = acknowledgments[feedbackType];
    if (trustContext.overallTrust < 40) {
      acknowledgment += " I understand I need to do better.";
    }

    return {
      acknowledged: true,
      correctionApplied: acknowledgment,
      trustImpact,
      behaviorChange: behaviorChanges[feedbackType],
    };
  }

  /**
   * Get trust level recommendation for a component.
   * Used by ORB to determine how cautiously to behave.
   */
  getTrustRecommendation(trustScore: TrustScore): {
    level: string;
    shouldRestrict: boolean;
    recommendation: string;
  } {
    const level = getTrustLevel(trustScore.score);
    const shouldRestrict = shouldRestrictBehavior(trustScore);

    const recommendations: Record<string, string> = {
      critical: 'Minimal autonomy. Always ask for confirmation. Avoid suggestions.',
      low: 'Limited autonomy. Prefer asking over acting. Conservative suggestions only.',
      medium: 'Normal operation with extra caution. Validate before significant actions.',
      high: 'Normal operation. Standard confirmation for important actions.',
      full: 'Full operation. User trusts system judgement.',
    };

    return {
      level,
      shouldRestrict,
      recommendation: recommendations[level],
    };
  }
}

// =============================================================================
// Helper Functions for ORB Integration
// =============================================================================

/**
 * Quick correction detection without service instantiation.
 * Useful for lightweight checks in ORB message processing.
 */
export function quickDetectCorrection(message: string): {
  isCorrection: boolean;
  type: FeedbackType | null;
} {
  const service = new TrustRepairService('', '');
  const result = service.detectCorrection(message);
  return {
    isCorrection: result.isCorrection,
    type: result.feedbackType,
  };
}

/**
 * Calculate expected trust delta for a feedback type.
 */
export function getExpectedTrustDelta(feedbackType: FeedbackType): number {
  return TRUST_DELTAS[feedbackType];
}

/**
 * Check if trust score indicates restricted operation.
 */
export function shouldOperateRestricted(score: number): boolean {
  return score < 40;
}

/**
 * Get trust band label for score.
 */
export function getTrustBand(score: number): string {
  if (score < 20) return 'Critical';
  if (score < 40) return 'Low';
  if (score < 60) return 'Medium';
  if (score < 80) return 'High';
  return 'Full';
}
