/**
 * VTID-01141: D47 Proactive Social & Community Alignment Engine Types
 *
 * Type definitions for anticipating social needs and alignment opportunities,
 * proactively surfacing relevant people, groups, events, or activities that
 * improve wellbeing, belonging, and long-term quality of life.
 *
 * D47 answers: "Who or what would be supportive or energizing right now?"
 *
 * Hard Constraints (GOVERNANCE):
 * - Memory-first approach
 * - Consent-by-design (suggestions only)
 * - No forced matchmaking
 * - No social graph exposure
 * - Explainability mandatory
 * - No cold-start hallucinations
 * - All outputs logged to OASIS
 *
 * Dependencies: D35 (Social Context), D87 (Relationships), D84 (Community)
 */

import { z } from 'zod';

// =============================================================================
// VTID-01141: Alignment Domain Types (Spec Section 3)
// =============================================================================

/**
 * Alignment domains - each suggestion belongs to one primary domain
 */
export const ALIGNMENT_DOMAINS = [
  'people',       // 1:1 connections
  'group',        // Groups / Communities
  'event',        // Events / Meetups
  'live_room',    // Live Rooms
  'service',      // Services / Professionals
  'activity'      // Activities / Rituals
] as const;

export type AlignmentDomain = typeof ALIGNMENT_DOMAINS[number];

/**
 * Suggested action types
 */
export const ALIGNMENT_ACTIONS = [
  'view',         // View details
  'connect',      // Initiate connection
  'save',         // Save for later
  'not_now'       // Dismiss temporarily
] as const;

export type AlignmentAction = typeof ALIGNMENT_ACTIONS[number];

/**
 * Suggestion status
 */
export const ALIGNMENT_STATUSES = [
  'pending',      // Not yet shown to user
  'shown',        // Shown to user
  'acted',        // User took suggested action
  'dismissed',    // User dismissed
  'expired'       // Time-based expiration
] as const;

export type AlignmentStatus = typeof ALIGNMENT_STATUSES[number];

// =============================================================================
// VTID-01141: Signal Types (Spec Section 4)
// =============================================================================

/**
 * Signal types for alignment matching
 */
export const SIGNAL_TYPES = [
  'interest',     // Shared hobbies/interests
  'value',        // Shared values
  'goal',         // Shared goals
  'preference',   // Compatible preferences
  'behavior'      // Historical positive interactions
] as const;

export type SignalType = typeof SIGNAL_TYPES[number];

/**
 * Shared alignment signal reference
 */
export interface AlignmentSignalRef {
  /** Signal type (interest, value, goal, preference, behavior) */
  type: SignalType;
  /** Reference key (e.g., 'interest:hiking', 'goal:longevity') */
  ref: string;
  /** Optional weight for this signal (0-2, default 1) */
  weight?: number;
}

/**
 * Alignment signal definition (from catalog)
 */
export interface AlignmentSignal {
  id: string;
  signal_key: string;
  signal_type: SignalType;
  display_name: string;
  description?: string;
  alignment_weight: number;
}

// =============================================================================
// VTID-01141: Matching Thresholds (Spec Section 4)
// =============================================================================

/**
 * Matching thresholds configuration
 */
export interface AlignmentThresholds {
  /** Minimum relevance score (0-100), default 75 */
  min_relevance: number;
  /** Minimum shared signals count, default 2 */
  min_shared_signals: number;
  /** Maximum suggestions per batch, default 5 */
  max_suggestions: number;
  /** Social energy threshold below which no suggestions are generated */
  min_social_energy: number;
}

/**
 * Default matching thresholds
 */
export const DEFAULT_ALIGNMENT_THRESHOLDS: AlignmentThresholds = {
  min_relevance: 75,
  min_shared_signals: 2,
  max_suggestions: 5,
  min_social_energy: 20
};

// =============================================================================
// VTID-01141: Suggestion Target (Privacy-Safe)
// =============================================================================

/**
 * Suggestion target (privacy-safe, no full social graph)
 */
export interface AlignmentTarget {
  /** Node ID from relationship graph */
  node_id: string;
  /** Display title */
  title: string;
  /** Target type (person, group, event, service, live_room) */
  type: string;
  /** Domain (community, health, business, lifestyle) */
  domain?: string;
  /** Public metadata only */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01141: Social Load Check
// =============================================================================

/**
 * Social load check result
 */
export interface SocialLoadCheck {
  /** User's current social energy (0-100) */
  social_energy: number;
  /** Whether user passed social load check */
  passed: boolean;
  /** Reason if check failed */
  reason?: string;
  /** Recommendations for timing */
  timing_notes?: string;
}

// =============================================================================
// VTID-01141: Alignment Suggestion (Spec Section 5 - Output Structure)
// =============================================================================

/**
 * Alignment suggestion output (STRICT format per spec)
 */
export interface AlignmentSuggestion {
  /** Unique suggestion ID */
  alignment_id: string;
  /** Primary alignment domain */
  alignment_domain: AlignmentDomain;
  /** Confidence score (0-100) */
  confidence: number;
  /** Contextual explanation (MANDATORY - explainability) */
  why_now: string;
  /** Shared alignment signals */
  shared_signals: AlignmentSignalRef[];
  /** Suggested user action */
  suggested_action: AlignmentAction;
  /** Whether user can dismiss */
  dismissible: boolean;
  /** Target information (privacy-safe) */
  target?: AlignmentTarget;
  /** Current status */
  status?: AlignmentStatus;
  /** Valid until timestamp */
  valid_until?: string;
  /** Created at timestamp */
  created_at?: string;
}

/**
 * Extended suggestion with internal metadata (for storage)
 */
export interface AlignmentSuggestionFull extends AlignmentSuggestion {
  tenant_id: string;
  user_id: string;
  target_node_id: string;
  relevance_score: number;
  predictive_window_id?: string;
  guidance_context_id?: string;
  memory_refs: AlignmentSignalRef[];
  contextual_timing?: string;
  social_load_check?: SocialLoadCheck;
  shown_at?: string;
  acted_at?: string;
  dismissed_at?: string;
  user_feedback?: Record<string, unknown>;
  updated_at: string;
}

// =============================================================================
// VTID-01141: Context Input (Spec Section 2)
// =============================================================================

/**
 * Predictive window reference (D45 - optional dependency)
 */
export interface PredictiveWindowRef {
  id: string;
  window_type: string;
  timeframe: string;
  predictions: Array<{
    type: string;
    probability: number;
    context: string;
  }>;
}

/**
 * Guidance context reference (D46 - optional dependency)
 */
export interface GuidanceContextRef {
  id: string;
  guidance_type: string;
  priority: number;
  message: string;
}

/**
 * Full context input for alignment generation
 */
export interface AlignmentContextInput {
  /** D45 predictive window (optional) */
  predictive_window?: PredictiveWindowRef;
  /** D46 guidance context (optional) */
  guidance_context?: GuidanceContextRef;
  /** Relationship memory references */
  memory_refs?: string[];
  /** Location context (optional) */
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  /** Time context (optional) */
  time_context?: {
    local_time: string;
    day_of_week: string;
    is_weekend: boolean;
  };
  /** Calendar availability (optional) */
  calendar_availability?: {
    busy_until?: string;
    next_free_slot?: string;
    is_free_now: boolean;
  };
}

// =============================================================================
// VTID-01141: API Request/Response Schemas
// =============================================================================

/**
 * Generate suggestions request
 */
export const GenerateSuggestionsRequestSchema = z.object({
  /** Maximum suggestions to generate */
  max_suggestions: z.number().int().min(1).max(20).optional().default(5),
  /** Filter by alignment domains */
  alignment_domains: z.array(z.enum(ALIGNMENT_DOMAINS)).optional(),
  /** Minimum relevance score */
  min_relevance: z.number().int().min(0).max(100).optional().default(75),
  /** Minimum shared signals */
  min_shared_signals: z.number().int().min(1).max(10).optional().default(2),
  /** Context input */
  context: z.object({
    predictive_window_id: z.string().uuid().optional(),
    guidance_context_id: z.string().uuid().optional(),
    memory_refs: z.array(z.string()).optional(),
    location: z.object({
      latitude: z.number(),
      longitude: z.number(),
      accuracy: z.number().optional()
    }).optional(),
    time_context: z.object({
      local_time: z.string(),
      day_of_week: z.string(),
      is_weekend: z.boolean()
    }).optional()
  }).optional()
});

export type GenerateSuggestionsRequest = z.infer<typeof GenerateSuggestionsRequestSchema>;

/**
 * Generate suggestions response
 */
export interface GenerateSuggestionsResponse {
  ok: boolean;
  error?: string;
  message?: string;
  batch_id?: string;
  suggestions?: AlignmentSuggestion[];
  count?: number;
  social_context?: SocialLoadCheck;
  processing_time_ms?: number;
}

/**
 * Get suggestions request
 */
export const GetSuggestionsRequestSchema = z.object({
  /** Filter by status */
  status: z.array(z.enum(ALIGNMENT_STATUSES)).optional().default(['pending', 'shown']),
  /** Filter by alignment domains */
  alignment_domains: z.array(z.enum(ALIGNMENT_DOMAINS)).optional(),
  /** Maximum results */
  limit: z.number().int().min(1).max(50).optional().default(10)
});

export type GetSuggestionsRequest = z.infer<typeof GetSuggestionsRequestSchema>;

/**
 * Get suggestions response
 */
export interface GetSuggestionsResponse {
  ok: boolean;
  error?: string;
  message?: string;
  suggestions?: AlignmentSuggestion[];
  count?: number;
}

/**
 * Mark shown request
 */
export const MarkShownRequestSchema = z.object({
  suggestion_id: z.string().uuid()
});

export type MarkShownRequest = z.infer<typeof MarkShownRequestSchema>;

/**
 * Mark shown response
 */
export interface MarkShownResponse {
  ok: boolean;
  error?: string;
  message?: string;
  suggestion_id?: string;
  status?: AlignmentStatus;
}

/**
 * Act on suggestion request
 */
export const ActOnSuggestionRequestSchema = z.object({
  suggestion_id: z.string().uuid(),
  action: z.enum(ALIGNMENT_ACTIONS),
  feedback: z.record(z.unknown()).optional()
});

export type ActOnSuggestionRequest = z.infer<typeof ActOnSuggestionRequestSchema>;

/**
 * Act on suggestion response
 */
export interface ActOnSuggestionResponse {
  ok: boolean;
  error?: string;
  message?: string;
  suggestion_id?: string;
  action?: AlignmentAction;
  status?: AlignmentStatus;
}

// =============================================================================
// VTID-01141: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for social alignment engine
 */
export const SOCIAL_ALIGNMENT_EVENT_TYPES = [
  'social_alignment.generated',
  'social_alignment.shown',
  'social_alignment.acted',
  'social_alignment.dismissed',
  'social_alignment.expired',
  'social_alignment.batch_completed',
  'social_alignment.error'
] as const;

export type SocialAlignmentEventType = typeof SOCIAL_ALIGNMENT_EVENT_TYPES[number];

// =============================================================================
// VTID-01141: Matching Logic Types
// =============================================================================

/**
 * Matching factor weights (spec section 4)
 */
export interface MatchingFactorWeights {
  /** Shared interests weight */
  shared_interests: number;
  /** Shared values weight */
  shared_values: number;
  /** Complementary preferences weight */
  complementary_preferences: number;
  /** Historical positive interactions weight */
  positive_history: number;
  /** Similar lifecycle/health goals weight */
  similar_goals: number;
}

/**
 * Default matching factor weights
 */
export const DEFAULT_MATCHING_WEIGHTS: MatchingFactorWeights = {
  shared_interests: 0.25,
  shared_values: 0.20,
  complementary_preferences: 0.15,
  positive_history: 0.25,
  similar_goals: 0.15
};

/**
 * Candidate for alignment matching
 */
export interface AlignmentCandidate {
  node_id: string;
  node_type: string;
  title: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  strength: number;
  relationship_type?: string;
  last_seen?: string;
}

/**
 * Matching result for a candidate
 */
export interface AlignmentMatchResult {
  candidate: AlignmentCandidate;
  relevance_score: number;
  confidence: number;
  shared_signals: AlignmentSignalRef[];
  why_now: string;
  alignment_domain: AlignmentDomain;
  passes_thresholds: boolean;
}

// =============================================================================
// VTID-01141: Helper Functions
// =============================================================================

/**
 * Map relationship node type to alignment domain
 */
export function mapNodeTypeToAlignmentDomain(nodeType: string): AlignmentDomain {
  switch (nodeType) {
    case 'person':
      return 'people';
    case 'group':
      return 'group';
    case 'event':
      return 'event';
    case 'service':
      return 'service';
    case 'live_room':
      return 'live_room';
    default:
      return 'activity';
  }
}

/**
 * Calculate relevance score from shared signals
 */
export function calculateRelevanceScore(
  signals: AlignmentSignalRef[],
  connectionStrength: number,
  weights: MatchingFactorWeights = DEFAULT_MATCHING_WEIGHTS
): number {
  let score = 30; // Base score

  // Connection strength contributes up to 50
  score += Math.min(50, connectionStrength / 2);

  // Each signal adds based on type and weight
  for (const signal of signals) {
    const typeWeight = getSignalTypeWeight(signal.type, weights);
    const signalWeight = signal.weight || 1;
    score += 10 * typeWeight * signalWeight;
  }

  return Math.min(100, Math.round(score));
}

/**
 * Get weight for signal type
 */
function getSignalTypeWeight(
  signalType: SignalType,
  weights: MatchingFactorWeights
): number {
  switch (signalType) {
    case 'interest':
      return weights.shared_interests;
    case 'value':
      return weights.shared_values;
    case 'preference':
      return weights.complementary_preferences;
    case 'behavior':
      return weights.positive_history;
    case 'goal':
      return weights.similar_goals;
    default:
      return 0.1;
  }
}

/**
 * Calculate confidence score
 */
export function calculateConfidenceScore(
  signalCount: number,
  recentInteraction: boolean,
  connectionStrength: number
): number {
  let confidence = 50; // Base confidence

  // Signal contribution (up to 30)
  confidence += Math.min(30, signalCount * 10);

  // Recency bonus
  if (recentInteraction) {
    confidence += 20;
  }

  // Strength bonus (if known)
  if (connectionStrength > 0) {
    confidence += Math.min(10, connectionStrength / 10);
  }

  return Math.min(100, Math.round(confidence));
}

/**
 * Generate contextual why_now explanation
 */
export function generateWhyNow(
  domain: AlignmentDomain,
  signals: AlignmentSignalRef[],
  connectionStrength: number,
  lastSeen?: string
): string {
  const hasRecentInteraction = lastSeen &&
    new Date(lastSeen) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const sharedInterests = signals.filter(s => s.type === 'interest').length;
  const sharedGoals = signals.filter(s => s.type === 'goal').length;

  switch (domain) {
    case 'people':
      if (connectionStrength >= 60) {
        return 'This is a close connection. Reconnecting may be supportive and energizing.';
      } else if (hasRecentInteraction) {
        return 'Based on your recent interactions, this person could be a good connection right now.';
      } else if (sharedGoals > 0) {
        return 'You share similar goals. This person might be supportive of your journey.';
      }
      return 'Based on shared interests, this person might be a good connection.';

    case 'group':
      if (sharedInterests > 0) {
        return 'This community aligns with your interests and could provide meaningful connection.';
      }
      return 'This group matches your preferences and may offer supportive community.';

    case 'event':
      return 'This event matches your interests and is coming up soon.';

    case 'live_room':
      return 'This live session is happening now with topics you care about.';

    case 'service':
      if (sharedGoals > 0) {
        return 'This service aligns with your goals and may be helpful right now.';
      }
      return 'Based on your needs, this service might be beneficial.';

    case 'activity':
      return 'This activity aligns with your preferences and could be energizing.';

    default:
      return 'Based on your preferences and history, this may be a good match.';
  }
}

/**
 * Check if candidate passes matching thresholds
 */
export function passesMatchingThresholds(
  relevanceScore: number,
  signalCount: number,
  thresholds: AlignmentThresholds = DEFAULT_ALIGNMENT_THRESHOLDS
): boolean {
  return relevanceScore >= thresholds.min_relevance &&
         signalCount >= thresholds.min_shared_signals;
}
