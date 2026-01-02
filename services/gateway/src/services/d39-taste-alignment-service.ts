/**
 * VTID-01133: Taste, Aesthetic & Lifestyle Alignment Service (D39)
 *
 * Deep Context Intelligence - Aligns recommendations with user's taste,
 * aesthetic preferences, and lifestyle identity.
 *
 * D39 ensures suggestions *feel like "me" to the user*, increasing resonance,
 * trust, and long-term engagement.
 *
 * Core Question: "Does this fit who I am and how I like to live?"
 *
 * Position in Intelligence Stack:
 *   D20-D38 Context → D39 Taste Alignment → Final Recommendations
 *
 * Behavioral Rules (Non-Negotiable):
 *   - Respect identity signals immediately
 *   - NO aesthetic judgment
 *   - Never imply "better" lifestyles
 *   - Treat taste as personal, not hierarchical
 *   - Allow user to redefine taste at any time
 */

import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';
import {
  TasteProfile,
  LifestyleProfile,
  TasteAlignmentBundle,
  AlignedAction,
  AlignmentBreakdown,
  AlignmentTag,
  ActionToScore,
  TasteSignal,
  TasteAlignmentEventPayload,
  SimplicityPreference,
  PremiumOrientation,
  AestheticStyle,
  ToneAffinity,
  RoutineStyle,
  SocialOrientation,
  ConvenienceBias,
  ExperienceType,
  NoveltyTolerance,
  TASTE_DIMENSION_METADATA,
  LIFESTYLE_DIMENSION_METADATA
} from '../types/taste-alignment';

// =============================================================================
// VTID-01133: Constants
// =============================================================================

export const VTID = 'VTID-01133';

/**
 * Alignment thresholds per spec section 3
 */
export const ALIGNMENT_THRESHOLDS = {
  EXCLUDE_THRESHOLD: 0.3,       // Actions below this are excluded
  REFRAME_THRESHOLD: 0.5,       // Actions below this get reframing suggestions
  GOOD_FIT_THRESHOLD: 0.7,      // Actions above this are considered good fit
  CONFIDENCE_MIN_SCORING: 20,   // Min confidence to apply scoring adjustments
  SPARSE_DATA_THRESHOLD: 30,    // Below this, default to neutral options
  EXPLORATION_BOOST: 0.1        // Boost for "safe outside comfort zone" options
};

/**
 * Weights for alignment scoring
 */
export const SCORING_WEIGHTS = {
  // Taste weights
  simplicity: 0.25,
  premium: 0.25,
  aesthetic: 0.25,
  tone: 0.25,
  // Lifestyle weights
  routine: 0.20,
  social: 0.25,
  convenience: 0.20,
  experience: 0.15,
  novelty: 0.20
};

/**
 * Default neutral profiles
 */
export const DEFAULT_TASTE_PROFILE: TasteProfile = {
  simplicity_preference: 'balanced',
  premium_orientation: 'quality_balanced',
  aesthetic_style: 'neutral',
  tone_affinity: 'neutral',
  confidence: 0
};

export const DEFAULT_LIFESTYLE_PROFILE: LifestyleProfile = {
  routine_style: 'hybrid',
  social_orientation: 'adaptive',
  convenience_bias: 'balanced',
  experience_type: 'blended',
  novelty_tolerance: 'moderate',
  confidence: 0
};

// =============================================================================
// VTID-01133: OASIS Event Helper
// =============================================================================

/**
 * Emit a taste alignment OASIS event
 */
export async function emitTasteAlignmentEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Partial<TasteAlignmentEventPayload>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as CicdEventType,
      source: 'd39-taste-alignment-service',
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
// VTID-01133: Taste Scoring Functions
// =============================================================================

/**
 * Calculate simplicity alignment score
 */
function scoreSimplicityAlignment(
  userPref: SimplicityPreference,
  actionComplexity: 'simple' | 'moderate' | 'complex' | undefined
): number {
  if (!actionComplexity) return 0.5; // Neutral if unknown

  const scoreMap: Record<SimplicityPreference, Record<string, number>> = {
    minimalist: { simple: 1.0, moderate: 0.6, complex: 0.2 },
    balanced: { simple: 0.7, moderate: 1.0, complex: 0.7 },
    comprehensive: { simple: 0.4, moderate: 0.7, complex: 1.0 }
  };

  return scoreMap[userPref][actionComplexity] ?? 0.5;
}

/**
 * Calculate premium orientation alignment score
 */
function scorePremiumAlignment(
  userPref: PremiumOrientation,
  priceTier: 'budget' | 'mid' | 'premium' | 'luxury' | undefined
): number {
  if (!priceTier) return 0.5;

  const scoreMap: Record<PremiumOrientation, Record<string, number>> = {
    value_focused: { budget: 1.0, mid: 0.8, premium: 0.4, luxury: 0.2 },
    quality_balanced: { budget: 0.6, mid: 1.0, premium: 0.8, luxury: 0.5 },
    premium_oriented: { budget: 0.2, mid: 0.5, premium: 1.0, luxury: 0.9 }
  };

  return scoreMap[userPref][priceTier] ?? 0.5;
}

/**
 * Calculate aesthetic style alignment score
 */
function scoreAestheticAlignment(
  userPref: AestheticStyle,
  actionAesthetic: AestheticStyle | undefined
): number {
  if (!actionAesthetic || userPref === 'neutral') return 0.5;
  if (actionAesthetic === 'neutral') return 0.5;

  // Perfect match
  if (userPref === actionAesthetic) return 1.0;

  // Compatible combinations
  const compatibilityMap: Record<AestheticStyle, AestheticStyle[]> = {
    modern: ['functional', 'eclectic'],
    classic: ['natural', 'functional'],
    eclectic: ['modern', 'natural'],
    natural: ['classic', 'functional'],
    functional: ['modern', 'classic', 'natural'],
    neutral: []
  };

  if (compatibilityMap[userPref]?.includes(actionAesthetic)) {
    return 0.7;
  }

  return 0.3;
}

/**
 * Calculate tone affinity alignment score
 */
function scoreToneAlignment(
  userPref: ToneAffinity,
  actionTone: ToneAffinity | undefined
): number {
  if (!actionTone || userPref === 'neutral') return 0.5;
  if (actionTone === 'neutral') return 0.5;

  if (userPref === actionTone) return 1.0;

  // Compatible tones
  const compatibilityMap: Record<ToneAffinity, ToneAffinity[]> = {
    technical: ['professional', 'minimalist'],
    expressive: ['casual'],
    casual: ['expressive'],
    professional: ['technical', 'minimalist'],
    minimalist: ['technical', 'professional'],
    neutral: []
  };

  if (compatibilityMap[userPref]?.includes(actionTone)) {
    return 0.7;
  }

  return 0.3;
}

// =============================================================================
// VTID-01133: Lifestyle Scoring Functions
// =============================================================================

/**
 * Calculate routine style alignment score
 */
function scoreRoutineAlignment(
  userPref: RoutineStyle,
  timingFlexibility: 'fixed' | 'flexible' | undefined
): number {
  if (!timingFlexibility) return 0.5;

  const scoreMap: Record<RoutineStyle, Record<string, number>> = {
    structured: { fixed: 1.0, flexible: 0.4 },
    flexible: { fixed: 0.4, flexible: 1.0 },
    hybrid: { fixed: 0.7, flexible: 0.7 }
  };

  return scoreMap[userPref][timingFlexibility] ?? 0.5;
}

/**
 * Calculate social orientation alignment score
 */
function scoreSocialAlignment(
  userPref: SocialOrientation,
  socialSetting: 'solo' | 'small_group' | 'large_group' | undefined
): number {
  if (!socialSetting || userPref === 'adaptive') return 0.5;

  const scoreMap: Record<SocialOrientation, Record<string, number>> = {
    solo_focused: { solo: 1.0, small_group: 0.5, large_group: 0.2 },
    small_groups: { solo: 0.5, small_group: 1.0, large_group: 0.5 },
    social_oriented: { solo: 0.3, small_group: 0.7, large_group: 1.0 },
    adaptive: { solo: 0.5, small_group: 0.5, large_group: 0.5 }
  };

  return scoreMap[userPref][socialSetting] ?? 0.5;
}

/**
 * Calculate convenience bias alignment score
 */
function scoreConvenienceAlignment(
  userPref: ConvenienceBias,
  convenienceLevel: 'low' | 'medium' | 'high' | undefined
): number {
  if (!convenienceLevel) return 0.5;

  const scoreMap: Record<ConvenienceBias, Record<string, number>> = {
    convenience_first: { low: 0.2, medium: 0.6, high: 1.0 },
    balanced: { low: 0.5, medium: 1.0, high: 0.7 },
    intentional_living: { low: 0.8, medium: 0.7, high: 0.4 }
  };

  return scoreMap[userPref][convenienceLevel] ?? 0.5;
}

/**
 * Calculate experience type alignment score
 */
function scoreExperienceAlignment(
  userPref: ExperienceType,
  experienceMode: 'digital' | 'physical' | 'hybrid' | undefined
): number {
  if (!experienceMode || userPref === 'blended') return 0.5;

  const scoreMap: Record<ExperienceType, Record<string, number>> = {
    digital_native: { digital: 1.0, hybrid: 0.7, physical: 0.3 },
    physical_focused: { digital: 0.3, hybrid: 0.6, physical: 1.0 },
    blended: { digital: 0.6, hybrid: 1.0, physical: 0.6 }
  };

  return scoreMap[userPref][experienceMode] ?? 0.5;
}

/**
 * Calculate novelty tolerance alignment score
 */
function scoreNoveltyAlignment(
  userPref: NoveltyTolerance,
  noveltyLevel: 'familiar' | 'moderate' | 'novel' | undefined
): number {
  if (!noveltyLevel) return 0.5;

  const scoreMap: Record<NoveltyTolerance, Record<string, number>> = {
    conservative: { familiar: 1.0, moderate: 0.6, novel: 0.2 },
    moderate: { familiar: 0.6, moderate: 1.0, novel: 0.6 },
    explorer: { familiar: 0.4, moderate: 0.7, novel: 1.0 }
  };

  return scoreMap[userPref][noveltyLevel] ?? 0.5;
}

// =============================================================================
// VTID-01133: Core Alignment Engine
// =============================================================================

/**
 * Calculate complete alignment score for an action
 */
export function calculateAlignmentScore(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile,
  action: ActionToScore,
  includeBreakdown: boolean = false
): { score: number; breakdown?: AlignmentBreakdown } {
  const attrs = action.attributes;

  // Taste scoring
  const simplicityScore = scoreSimplicityAlignment(
    tasteProfile.simplicity_preference,
    attrs.complexity
  );
  const premiumScore = scorePremiumAlignment(
    tasteProfile.premium_orientation,
    attrs.price_tier
  );
  const aestheticScore = scoreAestheticAlignment(
    tasteProfile.aesthetic_style,
    attrs.aesthetic
  );
  const toneScore = scoreToneAlignment(
    tasteProfile.tone_affinity,
    attrs.tone
  );

  // Lifestyle scoring
  const routineScore = scoreRoutineAlignment(
    lifestyleProfile.routine_style,
    attrs.timing_flexibility
  );
  const socialScore = scoreSocialAlignment(
    lifestyleProfile.social_orientation,
    attrs.social_setting
  );
  const convenienceScore = scoreConvenienceAlignment(
    lifestyleProfile.convenience_bias,
    attrs.convenience_level
  );
  const experienceScore = scoreExperienceAlignment(
    lifestyleProfile.experience_type,
    attrs.experience_mode
  );
  const noveltyScore = scoreNoveltyAlignment(
    lifestyleProfile.novelty_tolerance,
    attrs.novelty_level
  );

  // Calculate weighted taste score
  const tasteScore =
    simplicityScore * SCORING_WEIGHTS.simplicity +
    premiumScore * SCORING_WEIGHTS.premium +
    aestheticScore * SCORING_WEIGHTS.aesthetic +
    toneScore * SCORING_WEIGHTS.tone;

  // Calculate weighted lifestyle score
  const lifestyleScore =
    routineScore * SCORING_WEIGHTS.routine +
    socialScore * SCORING_WEIGHTS.social +
    convenienceScore * SCORING_WEIGHTS.convenience +
    experienceScore * SCORING_WEIGHTS.experience +
    noveltyScore * SCORING_WEIGHTS.novelty;

  // Combined score (50% taste, 50% lifestyle)
  const combinedScore = (tasteScore + lifestyleScore) / 2;

  // Apply confidence weighting (sparse data leads to more neutral scores)
  const confidenceWeight = Math.min(
    (tasteProfile.confidence + lifestyleProfile.confidence) / 200,
    1
  );
  const adjustedScore = 0.5 + (combinedScore - 0.5) * confidenceWeight;

  const result: { score: number; breakdown?: AlignmentBreakdown } = {
    score: Math.round(adjustedScore * 1000) / 1000
  };

  if (includeBreakdown) {
    result.breakdown = {
      taste_score: Math.round(tasteScore * 1000) / 1000,
      lifestyle_score: Math.round(lifestyleScore * 1000) / 1000,
      taste_factors: [
        { factor: 'simplicity', contribution: simplicityScore, reason: `${tasteProfile.simplicity_preference} vs ${attrs.complexity || 'unknown'}` },
        { factor: 'premium', contribution: premiumScore, reason: `${tasteProfile.premium_orientation} vs ${attrs.price_tier || 'unknown'}` },
        { factor: 'aesthetic', contribution: aestheticScore, reason: `${tasteProfile.aesthetic_style} vs ${attrs.aesthetic || 'unknown'}` },
        { factor: 'tone', contribution: toneScore, reason: `${tasteProfile.tone_affinity} vs ${attrs.tone || 'unknown'}` }
      ],
      lifestyle_factors: [
        { factor: 'routine', contribution: routineScore, reason: `${lifestyleProfile.routine_style} vs ${attrs.timing_flexibility || 'unknown'}` },
        { factor: 'social', contribution: socialScore, reason: `${lifestyleProfile.social_orientation} vs ${attrs.social_setting || 'unknown'}` },
        { factor: 'convenience', contribution: convenienceScore, reason: `${lifestyleProfile.convenience_bias} vs ${attrs.convenience_level || 'unknown'}` },
        { factor: 'experience', contribution: experienceScore, reason: `${lifestyleProfile.experience_type} vs ${attrs.experience_mode || 'unknown'}` },
        { factor: 'novelty', contribution: noveltyScore, reason: `${lifestyleProfile.novelty_tolerance} vs ${attrs.novelty_level || 'unknown'}` }
      ]
    };
  }

  return result;
}

/**
 * Generate alignment tags for an action based on profile match
 */
export function generateAlignmentTags(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile,
  alignmentScore: number
): AlignmentTag[] {
  const tags: AlignmentTag[] = [];

  if (alignmentScore < ALIGNMENT_THRESHOLDS.GOOD_FIT_THRESHOLD) {
    return tags; // Only tag good fits
  }

  // Taste-based tags
  if (tasteProfile.simplicity_preference === 'minimalist') {
    tags.push('minimalist_fit');
  }
  if (tasteProfile.premium_orientation === 'premium_oriented') {
    tags.push('premium_fit');
  }
  if (tasteProfile.aesthetic_style === 'classic') {
    tags.push('classic_style');
  }
  if (tasteProfile.aesthetic_style === 'modern') {
    tags.push('modern_fit');
  }

  // Lifestyle-based tags
  if (lifestyleProfile.convenience_bias === 'convenience_first') {
    tags.push('convenience_first');
  }
  if (lifestyleProfile.novelty_tolerance === 'explorer') {
    tags.push('exploratory_ok');
  }
  if (lifestyleProfile.social_orientation === 'solo_focused') {
    tags.push('solo_appropriate');
  }
  if (lifestyleProfile.social_orientation === 'social_oriented') {
    tags.push('social_appropriate');
  }
  if (lifestyleProfile.routine_style === 'structured') {
    tags.push('routine_compatible');
  }
  if (lifestyleProfile.routine_style === 'flexible') {
    tags.push('flexible_fit');
  }

  return tags;
}

/**
 * Generate reframing suggestion for low-alignment actions
 */
export function generateReframingSuggestion(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile,
  action: ActionToScore,
  alignmentScore: number
): string | undefined {
  if (alignmentScore >= ALIGNMENT_THRESHOLDS.REFRAME_THRESHOLD) {
    return undefined;
  }

  const suggestions: string[] = [];
  const attrs = action.attributes;

  // Complexity mismatch
  if (attrs.complexity === 'complex' && tasteProfile.simplicity_preference === 'minimalist') {
    suggestions.push('Consider a simpler version');
  }
  if (attrs.complexity === 'simple' && tasteProfile.simplicity_preference === 'comprehensive') {
    suggestions.push('A more detailed option is available');
  }

  // Price tier mismatch
  if ((attrs.price_tier === 'premium' || attrs.price_tier === 'luxury') &&
      tasteProfile.premium_orientation === 'value_focused') {
    suggestions.push('More affordable alternatives exist');
  }
  if (attrs.price_tier === 'budget' && tasteProfile.premium_orientation === 'premium_oriented') {
    suggestions.push('Premium options are available');
  }

  // Social setting mismatch
  if (attrs.social_setting === 'large_group' && lifestyleProfile.social_orientation === 'solo_focused') {
    suggestions.push('Solo option available');
  }
  if (attrs.social_setting === 'solo' && lifestyleProfile.social_orientation === 'social_oriented') {
    suggestions.push('Group option available');
  }

  // Convenience mismatch
  if (attrs.convenience_level === 'low' && lifestyleProfile.convenience_bias === 'convenience_first') {
    suggestions.push('More convenient option available');
  }

  return suggestions.length > 0 ? suggestions.join('; ') : 'Alternative options may be a better fit';
}

/**
 * Score multiple actions and optionally filter/exclude low-alignment ones
 */
export function scoreActions(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile,
  actions: ActionToScore[],
  options: {
    includeBreakdown?: boolean;
    minAlignmentThreshold?: number;
    excludeLowAlignment?: boolean;
  } = {}
): AlignedAction[] {
  const {
    includeBreakdown = false,
    minAlignmentThreshold = ALIGNMENT_THRESHOLDS.EXCLUDE_THRESHOLD,
    excludeLowAlignment = false
  } = options;

  // Check if we have sparse data - if so, be more lenient
  const isSparseData =
    tasteProfile.confidence < ALIGNMENT_THRESHOLDS.SPARSE_DATA_THRESHOLD ||
    lifestyleProfile.confidence < ALIGNMENT_THRESHOLDS.SPARSE_DATA_THRESHOLD;

  const alignedActions: AlignedAction[] = [];

  for (const action of actions) {
    const { score, breakdown } = calculateAlignmentScore(
      tasteProfile,
      lifestyleProfile,
      action,
      includeBreakdown
    );

    // Calculate lifestyle fit (0-1)
    const lifestyleFit = breakdown?.lifestyle_score ?? score;

    // Calculate confidence (based on profile confidence and available attributes)
    const attributeCount = Object.values(action.attributes).filter(v => v !== undefined).length;
    const maxAttributes = 10;
    const attributeConfidence = (attributeCount / maxAttributes) * 100;
    const confidence = Math.round(
      (tasteProfile.confidence + lifestyleProfile.confidence + attributeConfidence) / 3
    );

    // Generate tags for good fits
    const tags = generateAlignmentTags(tasteProfile, lifestyleProfile, score);

    // Check if should be excluded
    const shouldExclude = !isSparseData && excludeLowAlignment && score < minAlignmentThreshold;

    // Generate reframing for low scores
    const reframingSuggestion = generateReframingSuggestion(
      tasteProfile,
      lifestyleProfile,
      action,
      score
    );

    const alignedAction: AlignedAction = {
      action_id: action.id,
      action_type: action.type,
      action_data: action.attributes,
      alignment_score: score,
      lifestyle_fit: Math.round(lifestyleFit * 1000) / 1000,
      confidence,
      tags,
      breakdown: includeBreakdown ? breakdown : undefined,
      reframing_suggestion: reframingSuggestion,
      excluded: shouldExclude,
      exclusion_reason: shouldExclude
        ? `Alignment score ${score} below threshold ${minAlignmentThreshold}`
        : undefined
    };

    alignedActions.push(alignedAction);
  }

  // Sort by alignment score descending
  alignedActions.sort((a, b) => b.alignment_score - a.alignment_score);

  return alignedActions;
}

// =============================================================================
// VTID-01133: Taste Inference Rules (Deterministic)
// =============================================================================

/**
 * Inference rule definition
 */
interface TasteInferenceRule {
  dimension: string;
  type: 'taste' | 'lifestyle';
  detect: (signals: InferenceInputSignals) => {
    match: boolean;
    value: string;
    confidence: number;
    evidence: string[];
  };
}

/**
 * Input signals for taste inference
 */
export interface InferenceInputSignals {
  // Language patterns
  message_lengths?: number[];
  message_tone_keywords?: string[];
  // Reaction patterns
  accepted_actions?: { attributes: Record<string, unknown> }[];
  rejected_actions?: { attributes: Record<string, unknown> }[];
  // Social patterns
  group_sizes?: number[];
  social_frequency?: number;
  // Timing patterns
  response_regularity?: number;
  preferred_hours?: number[];
  // General behavior
  exploration_rate?: number;
  change_frequency?: number;
}

/**
 * Deterministic inference rules for taste/lifestyle
 */
export const TASTE_INFERENCE_RULES: TasteInferenceRule[] = [
  // Simplicity preference inference
  {
    dimension: 'simplicity_preference',
    type: 'taste',
    detect: (signals) => {
      const avgLength = signals.message_lengths?.length > 0
        ? signals.message_lengths.reduce((a, b) => a + b, 0) / signals.message_lengths.length
        : null;

      if (avgLength === null) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      if (avgLength < 50) {
        return {
          match: true,
          value: 'minimalist',
          confidence: Math.min(60, signals.message_lengths.length * 5),
          evidence: ['short_message_pattern']
        };
      }
      if (avgLength > 200) {
        return {
          match: true,
          value: 'comprehensive',
          confidence: Math.min(60, signals.message_lengths.length * 5),
          evidence: ['detailed_message_pattern']
        };
      }
      return { match: false, value: '', confidence: 0, evidence: [] };
    }
  },
  // Tone affinity inference
  {
    dimension: 'tone_affinity',
    type: 'taste',
    detect: (signals) => {
      if (!signals.message_tone_keywords || signals.message_tone_keywords.length < 10) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      const technicalKeywords = ['data', 'metrics', 'analysis', 'optimize', 'efficiency'];
      const expressiveKeywords = ['feel', 'love', 'amazing', 'wonderful', 'excited'];
      const casualKeywords = ['hey', 'yeah', 'cool', 'sure', 'thanks'];

      const technicalCount = signals.message_tone_keywords.filter(k =>
        technicalKeywords.some(tk => k.toLowerCase().includes(tk))
      ).length;
      const expressiveCount = signals.message_tone_keywords.filter(k =>
        expressiveKeywords.some(ek => k.toLowerCase().includes(ek))
      ).length;
      const casualCount = signals.message_tone_keywords.filter(k =>
        casualKeywords.some(ck => k.toLowerCase().includes(ck))
      ).length;

      const max = Math.max(technicalCount, expressiveCount, casualCount);
      if (max < 3) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      if (max === technicalCount) {
        return { match: true, value: 'technical', confidence: Math.min(55, max * 10), evidence: ['technical_language_pattern'] };
      }
      if (max === expressiveCount) {
        return { match: true, value: 'expressive', confidence: Math.min(55, max * 10), evidence: ['expressive_language_pattern'] };
      }
      return { match: true, value: 'casual', confidence: Math.min(55, max * 10), evidence: ['casual_language_pattern'] };
    }
  },
  // Social orientation inference
  {
    dimension: 'social_orientation',
    type: 'lifestyle',
    detect: (signals) => {
      if (!signals.group_sizes || signals.group_sizes.length < 3) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      const avgGroupSize = signals.group_sizes.reduce((a, b) => a + b, 0) / signals.group_sizes.length;

      if (avgGroupSize <= 1.5) {
        return {
          match: true,
          value: 'solo_focused',
          confidence: Math.min(60, signals.group_sizes.length * 8),
          evidence: ['solo_activity_pattern']
        };
      }
      if (avgGroupSize <= 4) {
        return {
          match: true,
          value: 'small_groups',
          confidence: Math.min(60, signals.group_sizes.length * 8),
          evidence: ['small_group_pattern']
        };
      }
      if (avgGroupSize > 6) {
        return {
          match: true,
          value: 'social_oriented',
          confidence: Math.min(60, signals.group_sizes.length * 8),
          evidence: ['large_group_pattern']
        };
      }
      return { match: false, value: '', confidence: 0, evidence: [] };
    }
  },
  // Novelty tolerance inference
  {
    dimension: 'novelty_tolerance',
    type: 'lifestyle',
    detect: (signals) => {
      if (signals.exploration_rate === undefined) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      if (signals.exploration_rate < 0.2) {
        return {
          match: true,
          value: 'conservative',
          confidence: 50,
          evidence: ['low_exploration_rate']
        };
      }
      if (signals.exploration_rate > 0.6) {
        return {
          match: true,
          value: 'explorer',
          confidence: 50,
          evidence: ['high_exploration_rate']
        };
      }
      return { match: false, value: '', confidence: 0, evidence: [] };
    }
  },
  // Routine style inference
  {
    dimension: 'routine_style',
    type: 'lifestyle',
    detect: (signals) => {
      if (signals.response_regularity === undefined) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      // response_regularity: 0 = very irregular, 1 = very regular
      if (signals.response_regularity > 0.7) {
        return {
          match: true,
          value: 'structured',
          confidence: Math.round(signals.response_regularity * 60),
          evidence: ['regular_timing_pattern']
        };
      }
      if (signals.response_regularity < 0.3) {
        return {
          match: true,
          value: 'flexible',
          confidence: Math.round((1 - signals.response_regularity) * 60),
          evidence: ['irregular_timing_pattern']
        };
      }
      return { match: false, value: '', confidence: 0, evidence: [] };
    }
  },
  // Premium orientation inference from reactions
  {
    dimension: 'premium_orientation',
    type: 'taste',
    detect: (signals) => {
      const accepted = signals.accepted_actions ?? [];
      const rejected = signals.rejected_actions ?? [];

      if (accepted.length + rejected.length < 5) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      const premiumAccepted = accepted.filter(a =>
        a.attributes.price_tier === 'premium' || a.attributes.price_tier === 'luxury'
      ).length;
      const budgetAccepted = accepted.filter(a =>
        a.attributes.price_tier === 'budget'
      ).length;
      const premiumRejected = rejected.filter(a =>
        a.attributes.price_tier === 'premium' || a.attributes.price_tier === 'luxury'
      ).length;
      const budgetRejected = rejected.filter(a =>
        a.attributes.price_tier === 'budget'
      ).length;

      const premiumPreference = (premiumAccepted - premiumRejected) - (budgetAccepted - budgetRejected);

      if (premiumPreference > 2) {
        return {
          match: true,
          value: 'premium_oriented',
          confidence: Math.min(65, 40 + premiumPreference * 5),
          evidence: ['premium_acceptance_pattern']
        };
      }
      if (premiumPreference < -2) {
        return {
          match: true,
          value: 'value_focused',
          confidence: Math.min(65, 40 + Math.abs(premiumPreference) * 5),
          evidence: ['value_preference_pattern']
        };
      }
      return { match: false, value: '', confidence: 0, evidence: [] };
    }
  },
  // Convenience bias inference from reactions
  {
    dimension: 'convenience_bias',
    type: 'lifestyle',
    detect: (signals) => {
      const accepted = signals.accepted_actions ?? [];
      const rejected = signals.rejected_actions ?? [];

      if (accepted.length + rejected.length < 5) {
        return { match: false, value: '', confidence: 0, evidence: [] };
      }

      const highConvenienceAccepted = accepted.filter(a =>
        a.attributes.convenience_level === 'high'
      ).length;
      const lowConvenienceAccepted = accepted.filter(a =>
        a.attributes.convenience_level === 'low'
      ).length;

      const conveniencePreference = highConvenienceAccepted - lowConvenienceAccepted;

      if (conveniencePreference > 2) {
        return {
          match: true,
          value: 'convenience_first',
          confidence: Math.min(60, 35 + conveniencePreference * 5),
          evidence: ['high_convenience_acceptance']
        };
      }
      if (conveniencePreference < -2) {
        return {
          match: true,
          value: 'intentional_living',
          confidence: Math.min(60, 35 + Math.abs(conveniencePreference) * 5),
          evidence: ['low_convenience_acceptance']
        };
      }
      return { match: false, value: '', confidence: 0, evidence: [] };
    }
  }
];

/**
 * Run inference rules and return inferred signals
 */
export function runTasteInferenceRules(signals: InferenceInputSignals): TasteSignal[] {
  const inferredSignals: TasteSignal[] = [];

  for (const rule of TASTE_INFERENCE_RULES) {
    const result = rule.detect(signals);
    if (result.match && result.confidence > 0) {
      inferredSignals.push({
        source: 'behavior_pattern',
        signal_type: rule.type,
        dimension: rule.dimension,
        inferred_value: result.value,
        confidence: Math.min(result.confidence, 85), // Cap at 85 per spec
        evidence: result.evidence.join(', '),
        observed_at: new Date().toISOString()
      });
    }
  }

  return inferredSignals;
}

// =============================================================================
// VTID-01133: Profile Completeness & Sparse Data Handling
// =============================================================================

/**
 * Calculate profile completeness percentage
 */
export function calculateProfileCompleteness(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile
): number {
  let completeness = 0;

  // Taste dimensions (40% weight)
  if (tasteProfile.simplicity_preference !== 'balanced') completeness += 10;
  if (tasteProfile.premium_orientation !== 'quality_balanced') completeness += 10;
  if (tasteProfile.aesthetic_style !== 'neutral') completeness += 10;
  if (tasteProfile.tone_affinity !== 'neutral') completeness += 10;

  // Lifestyle dimensions (60% weight)
  if (lifestyleProfile.routine_style !== 'hybrid') completeness += 12;
  if (lifestyleProfile.social_orientation !== 'adaptive') completeness += 12;
  if (lifestyleProfile.convenience_bias !== 'balanced') completeness += 12;
  if (lifestyleProfile.experience_type !== 'blended') completeness += 12;
  if (lifestyleProfile.novelty_tolerance !== 'moderate') completeness += 12;

  return completeness;
}

/**
 * Check if data is sparse and should use more neutral scoring
 */
export function isSparseData(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile
): boolean {
  const combinedConfidence = (tasteProfile.confidence + lifestyleProfile.confidence) / 2;
  const completeness = calculateProfileCompleteness(tasteProfile, lifestyleProfile);

  return combinedConfidence < ALIGNMENT_THRESHOLDS.SPARSE_DATA_THRESHOLD ||
         completeness < 20;
}

/**
 * Build complete alignment bundle
 */
export function buildAlignmentBundle(
  tasteProfile: TasteProfile,
  lifestyleProfile: LifestyleProfile
): TasteAlignmentBundle {
  const combinedConfidence = Math.round(
    (tasteProfile.confidence + lifestyleProfile.confidence) / 2
  );
  const profileCompleteness = calculateProfileCompleteness(tasteProfile, lifestyleProfile);
  const sparseData = isSparseData(tasteProfile, lifestyleProfile);

  return {
    taste_profile: tasteProfile,
    lifestyle_profile: lifestyleProfile,
    combined_confidence: combinedConfidence,
    profile_completeness: profileCompleteness,
    sparse_data: sparseData,
    computed_at: new Date().toISOString()
  };
}

// =============================================================================
// VTID-01133: Export Default
// =============================================================================

export default {
  VTID,
  ALIGNMENT_THRESHOLDS,
  SCORING_WEIGHTS,
  DEFAULT_TASTE_PROFILE,
  DEFAULT_LIFESTYLE_PROFILE,
  TASTE_INFERENCE_RULES,
  emitTasteAlignmentEvent,
  calculateAlignmentScore,
  generateAlignmentTags,
  generateReframingSuggestion,
  scoreActions,
  runTasteInferenceRules,
  calculateProfileCompleteness,
  isSparseData,
  buildAlignmentBundle
};
