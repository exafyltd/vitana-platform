/**
 * VTID-01142: D48 Context-Aware Opportunity & Experience Surfacing Engine Types
 *
 * Type definitions for the intelligence aggregation layer that surfaces timely,
 * relevant opportunities and experiences that fit the user's current life context
 * and predictive windows.
 *
 * This engine answers:
 * "Given who I am and where I am now, what might meaningfully enrich my life?"
 *
 * Hard Governance (Non-Negotiable):
 *   - Memory-first
 *   - Context-aware, not promotional
 *   - User-benefit > monetization
 *   - Explainability mandatory
 *   - No dark patterns
 *   - No forced actions
 *   - All outputs logged to OASIS
 *   - No schema-breaking changes
 *
 * Position in Intelligence Stack:
 * D20-D28 (Core) -> D32-D43 (Deep Context) -> D48 (Opportunity Surfacing)
 *
 * Required Dependencies:
 *   - D45: Predictive Windows
 *   - D46: Anticipatory Guidance Context
 *   - D47: Social Alignment Signals
 */

import { PriorityDomain, FusionContext } from './context-fusion';

// =============================================================================
// VTID-01142: D45 Predictive Windows Types
// =============================================================================

/**
 * Time horizon for predictive windows
 */
export type PredictiveTimeHorizon = 'immediate' | 'today' | 'this_week' | 'this_month' | 'this_quarter';

/**
 * Predictive window types for opportunity timing
 */
export type PredictiveWindowType =
  | 'health_opportunity'      // Health-related opportunity window
  | 'social_opportunity'      // Social connection window
  | 'learning_opportunity'    // Learning/growth window
  | 'recovery_window'         // Rest/recovery window
  | 'exploration_window'      // Discovery/exploration window
  | 'routine_window'          // Routine/habit reinforcement window
  | 'transition_window';      // Life transition window

/**
 * D45 Predictive Window - represents a time-bounded opportunity window
 */
export interface PredictiveWindow {
  /** Unique identifier */
  id: string;
  /** Type of predictive window */
  type: PredictiveWindowType;
  /** Time horizon */
  horizon: PredictiveTimeHorizon;
  /** Window start time */
  starts_at: string;
  /** Window end time */
  ends_at: string;
  /** Confidence in this prediction (0-100) */
  confidence: number;
  /** Domains this window applies to */
  applicable_domains: PriorityDomain[];
  /** Context signals that triggered this window */
  trigger_signals: string[];
  /** Human-readable explanation */
  explanation: string;
  /** Strength of the opportunity (0-100) */
  strength: number;
  /** Whether this is a recurring pattern */
  is_recurring: boolean;
  /** Pattern frequency if recurring */
  recurrence_pattern?: 'daily' | 'weekly' | 'monthly' | 'seasonal';
}

/**
 * D45 Predictive Windows Context - collection of active windows
 */
export interface PredictiveWindowsContext {
  /** Active predictive windows */
  active_windows: PredictiveWindow[];
  /** Imminent windows (starting within 24h) */
  imminent_windows: PredictiveWindow[];
  /** Expired windows (recently closed) */
  recently_expired: PredictiveWindow[];
  /** Overall prediction confidence (0-100) */
  confidence: number;
  /** When this context was computed */
  computed_at: string;
  /** Evidence sources */
  evidence_sources: string[];
}

// =============================================================================
// VTID-01142: D46 Anticipatory Guidance Types
// =============================================================================

/**
 * Guidance type for anticipatory context
 */
export type GuidanceType =
  | 'proactive_suggestion'    // Suggestion before user asks
  | 'preventive_alert'        // Alert to prevent negative outcome
  | 'reinforcement_prompt'    // Reinforce positive behavior
  | 'discovery_nudge'         // Nudge toward discovery
  | 'recovery_reminder'       // Reminder for recovery/rest
  | 'social_prompt'           // Social connection prompt
  | 'goal_checkpoint';        // Progress checkpoint

/**
 * D46 Anticipatory Guidance Item
 */
export interface AnticipatoryGuidance {
  /** Unique identifier */
  id: string;
  /** Type of guidance */
  type: GuidanceType;
  /** Associated domain */
  domain: PriorityDomain;
  /** Priority level (1-5, 1=highest) */
  priority_level: 1 | 2 | 3 | 4 | 5;
  /** Context-aware message */
  message: string;
  /** Why this guidance is relevant now */
  why_now: string;
  /** Suggested timing */
  suggested_timing: 'now' | 'soon' | 'later_today' | 'this_week';
  /** Confidence in relevance (0-100) */
  confidence: number;
  /** Associated predictive window (if any) */
  window_id?: string;
  /** Evidence for this guidance */
  evidence: string[];
  /** Whether user can dismiss */
  dismissible: boolean;
  /** Cooldown period after dismissal (days) */
  cooldown_days: number;
}

/**
 * D46 Anticipatory Guidance Context
 */
export interface AnticipatoryGuidanceContext {
  /** Active guidance items */
  active_guidance: AnticipatoryGuidance[];
  /** Pending guidance (not yet ready to show) */
  pending_guidance: AnticipatoryGuidance[];
  /** User fatigue level for guidance */
  user_fatigue_level: 'none' | 'low' | 'medium' | 'high';
  /** Last guidance shown */
  last_guidance_at?: string;
  /** Guidance shown today count */
  guidance_count_today: number;
  /** Daily guidance limit */
  daily_limit: number;
  /** Overall context confidence (0-100) */
  confidence: number;
}

// =============================================================================
// VTID-01142: D47 Social Alignment Types
// =============================================================================

/**
 * Social alignment signal types
 */
export type SocialAlignmentSignalType =
  | 'community_activity'      // Activity in user's communities
  | 'peer_engagement'         // Peers engaging with content/services
  | 'trending_topic'          // Trending topic alignment
  | 'group_event'             // Upcoming group event
  | 'connection_opportunity'  // Opportunity to connect
  | 'shared_interest'         // Shared interest detected
  | 'social_proof';           // Social proof signal

/**
 * D47 Social Alignment Signal
 */
export interface SocialAlignmentSignal {
  /** Unique identifier */
  id: string;
  /** Signal type */
  type: SocialAlignmentSignalType;
  /** Signal strength (0-100) */
  strength: number;
  /** Relevant community/group */
  community_context?: string;
  /** Number of peers involved */
  peer_count?: number;
  /** Description of the alignment */
  description: string;
  /** Confidence in this signal (0-100) */
  confidence: number;
  /** Recency factor (0-100, 100=very recent) */
  recency: number;
  /** Associated opportunity types */
  opportunity_types: OpportunityType[];
}

/**
 * D47 Social Alignment Context
 */
export interface SocialAlignmentContext {
  /** Active alignment signals */
  signals: SocialAlignmentSignal[];
  /** User's current social mode */
  social_mode: 'seeking' | 'open' | 'selective' | 'private';
  /** Community engagement level (0-100) */
  community_engagement: number;
  /** Peer activity level (0-100) */
  peer_activity_level: number;
  /** Overall alignment confidence (0-100) */
  confidence: number;
  /** Last social interaction timestamp */
  last_social_interaction?: string;
}

// =============================================================================
// VTID-01142: D48 Opportunity Types
// =============================================================================

/**
 * Opportunity types - each surfaced item must be exactly one type
 */
export type OpportunityType =
  | 'experience'    // Event, retreat, session
  | 'service'       // Coach, practitioner, lab, wellness
  | 'content'       // Article, guide, program
  | 'activity'      // Routine, ritual, challenge
  | 'place'         // Location-based wellness/social
  | 'offer';        // Only if aligned & non-intrusive

/**
 * Suggested action for an opportunity
 */
export type OpportunitySuggestedAction = 'view' | 'save' | 'dismiss';

/**
 * Relevance factor types
 */
export type RelevanceFactor =
  | 'goal_match'
  | 'timing_match'
  | 'preference_match'
  | 'location_match'
  | 'social_match'
  | 'budget_match'
  | 'health_match'
  | 'learning_match';

/**
 * Opportunity priority order (spec requirement)
 * 1. Health & wellbeing
 * 2. Social belonging
 * 3. Personal growth
 * 4. Performance & productivity
 * 5. Commerce (last)
 */
export const OPPORTUNITY_PRIORITY_ORDER: OpportunityType[] = [
  'activity',     // Health & wellbeing
  'place',        // Social belonging
  'experience',   // Personal growth
  'content',      // Performance & productivity
  'service',      // Support services
  'offer'         // Commerce (last)
];

/**
 * D48 Contextual Opportunity - the main output structure
 * Strict schema as per spec Section 5
 */
export interface ContextualOpportunity {
  /** Unique opportunity identifier (UUID) */
  opportunity_id: string;
  /** Type of opportunity - exactly one */
  opportunity_type: OpportunityType;
  /** Confidence score (0-100) */
  confidence: number;
  /** Contextual explanation of why this is surfaced now */
  why_now: string;
  /** Factors contributing to relevance */
  relevance_factors: RelevanceFactor[];
  /** Suggested action for the user */
  suggested_action: OpportunitySuggestedAction;
  /** Whether user can dismiss this */
  dismissible: boolean;
  /** Title of the opportunity */
  title: string;
  /** Brief description */
  description: string;
  /** Associated external ID (service/product/event ID) */
  external_id?: string;
  /** External type for lookup */
  external_type?: 'service' | 'product' | 'event' | 'location' | 'content';
  /** Priority domain */
  priority_domain: PriorityDomain;
  /** Linked predictive window */
  window_id?: string;
  /** Linked guidance item */
  guidance_id?: string;
  /** Social alignment signal IDs */
  alignment_signal_ids?: string[];
  /** Computed at timestamp */
  computed_at: string;
  /** Expires at timestamp */
  expires_at?: string;
}

// =============================================================================
// VTID-01142: Surfacing Rules Types
// =============================================================================

/**
 * Surfacing rules configuration
 * An opportunity is surfaced ONLY if all conditions are met
 */
export interface SurfacingRules {
  /** Minimum context match threshold (default: 80%) */
  min_context_match: number;
  /** Timing must be 'now' or 'imminent' */
  timing_relevance: 'now' | 'imminent';
  /** User fatigue must not be high */
  max_fatigue_level: 'none' | 'low' | 'medium';
  /** Days since similar opportunity (default: 21) */
  similar_opportunity_cooldown_days: number;
  /** Maximum opportunities to surface per session */
  max_opportunities_per_session: number;
  /** Maximum opportunities per day */
  max_opportunities_per_day: number;
}

/**
 * Default surfacing rules
 */
export const DEFAULT_SURFACING_RULES: SurfacingRules = {
  min_context_match: 80,
  timing_relevance: 'now',
  max_fatigue_level: 'medium',
  similar_opportunity_cooldown_days: 21,
  max_opportunities_per_session: 3,
  max_opportunities_per_day: 10
};

// =============================================================================
// VTID-01142: Engine Input/Output Types
// =============================================================================

/**
 * D48 Opportunity Surfacing Engine Input
 */
export interface OpportunitySurfacingInput {
  /** User identity */
  user_id: string;
  tenant_id: string;
  session_id?: string;

  /** Required inputs (D45, D46, D47) */
  predictive_windows: Partial<PredictiveWindowsContext>;
  anticipatory_guidance: Partial<AnticipatoryGuidanceContext>;
  social_alignment: Partial<SocialAlignmentContext>;

  /** Optional: Fusion context from D42 */
  fusion_context?: Partial<FusionContext>;

  /** Optional inputs */
  location_context?: {
    latitude?: number;
    longitude?: number;
    location_type?: 'home' | 'work' | 'transit' | 'venue' | 'unknown';
  };
  travel_context?: {
    is_traveling: boolean;
    destination?: string;
    travel_type?: 'business' | 'leisure' | 'commute';
  };
  time_availability?: {
    available_minutes: number;
    flexible: boolean;
  };
  budget_sensitivity?: 'high' | 'medium' | 'low' | 'unknown';

  /** Override rules (optional) */
  surfacing_rules?: Partial<SurfacingRules>;

  /** Request specific opportunity types */
  requested_types?: OpportunityType[];

  /** Exclude specific opportunity IDs */
  exclude_ids?: string[];
}

/**
 * D48 Opportunity Surfacing Engine Response
 */
export interface OpportunitySurfacingResponse {
  ok: boolean;
  error?: string;
  message?: string;

  /** Surfaced opportunities (priority ordered) */
  opportunities?: ContextualOpportunity[];

  /** Total opportunities considered */
  total_considered?: number;

  /** Opportunities filtered out */
  filtered_count?: number;

  /** Filter reasons summary */
  filter_reasons?: Record<string, number>;

  /** Current user fatigue level */
  user_fatigue_level?: 'none' | 'low' | 'medium' | 'high';

  /** Time until next refresh recommended */
  refresh_after_seconds?: number;

  /** Metadata for audit */
  metadata?: {
    vtid: string;
    computed_at: string;
    duration_ms: number;
    rules_applied: string[];
    windows_active: number;
    guidance_active: number;
    signals_active: number;
  };
}

// =============================================================================
// VTID-01142: Opportunity History & Dismissal Types
// =============================================================================

/**
 * Opportunity dismissal record
 */
export interface OpportunityDismissal {
  id: string;
  tenant_id: string;
  user_id: string;
  opportunity_id: string;
  opportunity_type: OpportunityType;
  dismissed_at: string;
  reason?: 'not_interested' | 'not_relevant' | 'already_done' | 'too_soon' | 'other';
  cooldown_until: string;
}

/**
 * Opportunity engagement record
 */
export interface OpportunityEngagement {
  id: string;
  tenant_id: string;
  user_id: string;
  opportunity_id: string;
  opportunity_type: OpportunityType;
  action: 'viewed' | 'saved' | 'clicked' | 'completed' | 'dismissed';
  action_at: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01142: Opportunity Candidates (Internal)
// =============================================================================

/**
 * Internal candidate structure before final scoring
 */
export interface OpportunityCandidate {
  /** Source type */
  source: 'service' | 'product' | 'event' | 'location' | 'content' | 'activity';
  /** Source ID */
  source_id: string;
  /** Opportunity type to surface as */
  opportunity_type: OpportunityType;
  /** Title */
  title: string;
  /** Description */
  description: string;
  /** Base relevance score (0-100) */
  base_score: number;
  /** Context match score (0-100) */
  context_match: number;
  /** Timing match score (0-100) */
  timing_match: number;
  /** Preference match score (0-100) */
  preference_match: number;
  /** Social match score (0-100) */
  social_match: number;
  /** Location match score (0-100) */
  location_match?: number;
  /** Budget match score (0-100) */
  budget_match?: number;
  /** Matched relevance factors */
  matched_factors: RelevanceFactor[];
  /** Associated windows */
  window_ids: string[];
  /** Associated guidance */
  guidance_ids: string[];
  /** Associated social signals */
  signal_ids: string[];
  /** Why this candidate is relevant */
  why_now_fragments: string[];
  /** Priority domain */
  priority_domain: PriorityDomain;
}

// =============================================================================
// VTID-01142: Audit & Traceability Types
// =============================================================================

/**
 * OASIS event type for opportunity surfacing
 */
export const OPPORTUNITY_OASIS_EVENT = 'opportunity.surfaced' as const;

/**
 * Audit entry for opportunity surfacing decisions
 */
export interface OpportunitySurfacingAudit {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id?: string;
  /** Opportunities surfaced */
  opportunities_surfaced: number;
  /** Opportunities considered */
  opportunities_considered: number;
  /** Opportunities filtered */
  opportunities_filtered: number;
  /** Active windows count */
  windows_active: number;
  /** Active guidance count */
  guidance_active: number;
  /** Active social signals count */
  signals_active: number;
  /** Rules applied */
  rules_applied: string[];
  /** Duration */
  duration_ms: number;
  /** Timestamp */
  created_at: string;
}

// =============================================================================
// VTID-01142: Database Types
// =============================================================================

/**
 * Database record for contextual_opportunities table
 */
export interface ContextualOpportunityRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id?: string;
  opportunity_type: OpportunityType;
  title: string;
  description: string;
  confidence: number;
  why_now: string;
  relevance_factors: RelevanceFactor[];
  suggested_action: OpportunitySuggestedAction;
  dismissible: boolean;
  priority_domain: PriorityDomain;
  external_id?: string;
  external_type?: string;
  window_id?: string;
  guidance_id?: string;
  alignment_signal_ids?: string[];
  status: 'active' | 'dismissed' | 'engaged' | 'expired';
  dismissed_at?: string;
  dismissed_reason?: string;
  engaged_at?: string;
  engagement_type?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// VTID-01142: Helper Functions
// =============================================================================

/**
 * Get default predictive windows context
 */
export function getDefaultPredictiveWindowsContext(): PredictiveWindowsContext {
  return {
    active_windows: [],
    imminent_windows: [],
    recently_expired: [],
    confidence: 50,
    computed_at: new Date().toISOString(),
    evidence_sources: []
  };
}

/**
 * Get default anticipatory guidance context
 */
export function getDefaultAnticipatoryGuidanceContext(): AnticipatoryGuidanceContext {
  return {
    active_guidance: [],
    pending_guidance: [],
    user_fatigue_level: 'none',
    guidance_count_today: 0,
    daily_limit: 10,
    confidence: 50
  };
}

/**
 * Get default social alignment context
 */
export function getDefaultSocialAlignmentContext(): SocialAlignmentContext {
  return {
    signals: [],
    social_mode: 'open',
    community_engagement: 50,
    peer_activity_level: 50,
    confidence: 50
  };
}

/**
 * Check if opportunity type is valid
 */
export function isValidOpportunityType(type: string): type is OpportunityType {
  return ['experience', 'service', 'content', 'activity', 'place', 'offer'].includes(type);
}

/**
 * Get priority weight for opportunity type (higher = more important)
 */
export function getOpportunityTypePriority(type: OpportunityType): number {
  const priorities: Record<OpportunityType, number> = {
    activity: 100,    // Health & wellbeing
    place: 80,        // Social belonging
    experience: 70,   // Personal growth
    content: 60,      // Performance & productivity
    service: 50,      // Support services
    offer: 20         // Commerce (last)
  };
  return priorities[type] ?? 0;
}

/**
 * Calculate final opportunity score
 */
export function calculateOpportunityScore(candidate: OpportunityCandidate): number {
  const weights = {
    context: 0.35,
    timing: 0.25,
    preference: 0.20,
    social: 0.10,
    location: 0.05,
    budget: 0.05
  };

  let score = 0;
  score += (candidate.context_match * weights.context);
  score += (candidate.timing_match * weights.timing);
  score += (candidate.preference_match * weights.preference);
  score += (candidate.social_match * weights.social);
  score += ((candidate.location_match ?? 50) * weights.location);
  score += ((candidate.budget_match ?? 50) * weights.budget);

  // Apply type priority multiplier
  const typePriority = getOpportunityTypePriority(candidate.opportunity_type);
  const priorityMultiplier = 0.5 + (typePriority / 200); // 0.6 to 1.0

  return Math.round(score * priorityMultiplier);
}

/**
 * Generate why_now explanation from fragments
 */
export function generateWhyNow(fragments: string[]): string {
  if (fragments.length === 0) {
    return 'Based on your current context and preferences.';
  }
  if (fragments.length === 1) {
    return fragments[0];
  }
  // Combine first two most relevant fragments
  return `${fragments[0]} ${fragments[1]}`;
}
