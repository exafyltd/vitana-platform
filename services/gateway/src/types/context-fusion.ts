/**
 * VTID-01136: Cross-Domain Context Fusion & Priority Resolution Types (D42)
 *
 * Type definitions for the Deep Context Intelligence engine that resolves
 * conflicts and priorities across domains so the system acts coherently
 * as one intelligence, not as competing modules.
 *
 * D42 is the "context arbitrator" - it answers:
 * "When multiple domains want to act, which one should lead — and which must wait?"
 *
 * Position in Intelligence Stack:
 * D20-D28 (Core) -> D32-D41 (Deep Context) -> D42 (Fusion & Priority)
 *
 * Non-Negotiable Priority Rules:
 *   1. Health & safety override all other domains
 *   2. Boundaries & consent override optimization
 *   3. Monetization is always lowest priority unless explicitly requested
 *   4. Low availability suppresses multi-domain actions
 *   5. Explicit user intent can override inferred priority
 */

// =============================================================================
// VTID-01136: Fusion Domain Definitions
// =============================================================================

/**
 * Priority domains for fusion resolution.
 * These are the high-level domains that compete for attention.
 */
export const PRIORITY_DOMAINS = [
  'health_wellbeing',       // Health, capacity, safety
  'social_relationships',   // Community, connections, events
  'learning_growth',        // Skills, knowledge, development
  'commerce_monetization',  // Products, services, transactions
  'exploration_discovery'   // Browsing, curiosity, serendipity
] as const;

export type PriorityDomain = typeof PRIORITY_DOMAINS[number];

/**
 * Priority tags for downstream consumption.
 * Used by ORB, autopilot, proactive nudges, and governance.
 */
export const PRIORITY_TAGS = [
  'health_first',
  'social_first',
  'learning_first',
  'commerce_suppressed',
  'monetization_suppressed',
  'exploration_only',
  'rest_mode',
  'low_capacity',
  'high_urgency',
  'user_override'
] as const;

export type PriorityTag = typeof PRIORITY_TAGS[number];

// =============================================================================
// VTID-01136: Deep Context Engine Stubs (D32-D41)
// =============================================================================
// These interfaces define the expected outputs from deep context engines
// that D42 consumes. Implementations are pending (SPEC ONLY).

/**
 * D32-D34: Situational Context
 * Location, time, environment signals
 */
export interface SituationalContext {
  /** Current time context */
  time_of_day: 'early_morning' | 'morning' | 'afternoon' | 'evening' | 'late_night';
  /** Day type */
  day_type: 'weekday' | 'weekend' | 'holiday';
  /** Location context (if available) */
  location_type?: 'home' | 'work' | 'transit' | 'social_venue' | 'unknown';
  /** Device context */
  device_type?: 'mobile' | 'desktop' | 'tablet' | 'voice';
  /** Session duration in minutes */
  session_duration_minutes?: number;
  /** Confidence in situational signals (0-100) */
  confidence: number;
  /** Evidence for situational inference */
  evidence: string[];
}

/**
 * D35: Social Context
 * Social signals, connection patterns, community state
 */
export interface SocialContext {
  /** Recent social activity level */
  social_activity_level: 'high' | 'medium' | 'low' | 'isolated';
  /** Pending social obligations */
  pending_obligations: Array<{
    type: 'meetup' | 'message' | 'event' | 'commitment';
    urgency: 'high' | 'medium' | 'low';
    description?: string;
  }>;
  /** Recent connection patterns */
  connection_pattern: 'seeking' | 'maintaining' | 'retreating' | 'neutral';
  /** Community engagement score (0-100) */
  community_score: number;
  /** Confidence in social signals (0-100) */
  confidence: number;
  /** Risk flags for social domain */
  risk_flags: string[];
}

/**
 * D36: Financial & Monetization Context
 * Budget awareness, purchase patterns, commerce signals
 */
export interface FinancialContext {
  /** Budget sensitivity level */
  budget_sensitivity: 'high' | 'medium' | 'low' | 'unknown';
  /** Recent purchase activity */
  recent_purchase_activity: 'active' | 'moderate' | 'minimal' | 'none';
  /** Commerce intent signals */
  commerce_intent: 'explicit' | 'implicit' | 'none';
  /** Monetization eligibility (user consent to see offers) */
  monetization_eligible: boolean;
  /** Confidence in financial signals (0-100) */
  confidence: number;
  /** Risk flags for financial domain */
  risk_flags: string[];
}

/**
 * D37: Health & Capacity Context
 * Energy levels, availability, health signals
 */
export interface HealthCapacityContext {
  /** Current energy/capacity level (0-100) */
  energy_level: number;
  /** Availability for engagement */
  availability: 'high' | 'medium' | 'low' | 'minimal';
  /** Sleep quality (if known, 0-100) */
  sleep_quality?: number;
  /** Stress indicators (0-100) */
  stress_level?: number;
  /** Active health concerns */
  active_health_concerns: string[];
  /** Safety flags (medical, emergency) */
  safety_flags: Array<{
    type: 'medical_advice' | 'emergency' | 'crisis' | 'medication';
    severity: 'low' | 'medium' | 'high' | 'critical';
  }>;
  /** Confidence in health signals (0-100) */
  confidence: number;
}

/**
 * D38: Learning & Absorption Context
 * Learning capacity, absorption rate, progress signals
 */
export interface LearningContext {
  /** Current learning capacity (0-100) */
  absorption_capacity: number;
  /** Active learning goals */
  active_learning_goals: string[];
  /** Learning session state */
  session_state: 'deep_focus' | 'active' | 'browsing' | 'fatigued' | 'none';
  /** Recent progress signals */
  recent_progress: 'breakthrough' | 'steady' | 'struggling' | 'unknown';
  /** Preferred learning depth */
  preferred_depth: 'deep' | 'moderate' | 'light';
  /** Confidence in learning signals (0-100) */
  confidence: number;
}

/**
 * D39: Taste & Lifestyle Context
 * Preferences, style, aesthetic signals
 */
export interface TasteLifestyleContext {
  /** Active lifestyle preferences */
  active_preferences: string[];
  /** Style signals (for recommendations) */
  style_signals: Record<string, string>;
  /** Dietary/health preferences */
  dietary_preferences?: string[];
  /** Activity preferences */
  activity_preferences?: string[];
  /** Confidence in taste signals (0-100) */
  confidence: number;
}

/**
 * D40: Goals & Trajectory Context
 * Long-term goals, current trajectory, progress
 */
export interface GoalsTrajectoryContext {
  /** Active goals */
  active_goals: Array<{
    id: string;
    domain: PriorityDomain;
    description: string;
    priority: 'high' | 'medium' | 'low';
    progress_percent?: number;
  }>;
  /** Current trajectory alignment */
  trajectory_alignment: 'on_track' | 'needs_attention' | 'off_track' | 'unknown';
  /** Short-term vs long-term balance */
  time_horizon_focus: 'immediate' | 'short_term' | 'long_term' | 'balanced';
  /** Confidence in trajectory signals (0-100) */
  confidence: number;
}

/**
 * D41: Boundaries & Consent Context
 * User-set boundaries, consent states, privacy preferences
 */
export interface BoundariesConsentContext {
  /** Active boundaries */
  active_boundaries: Array<{
    type: 'time' | 'topic' | 'domain' | 'contact' | 'commerce' | 'data';
    scope: string;
    enforcement: 'hard' | 'soft';
  }>;
  /** Domain-specific consent */
  domain_consent: Record<PriorityDomain, boolean>;
  /** Privacy mode */
  privacy_mode: 'standard' | 'enhanced' | 'minimal_data';
  /** Do-not-disturb active */
  do_not_disturb: boolean;
  /** Commerce opt-out */
  commerce_opted_out: boolean;
  /** Confidence in consent signals (0-100) */
  confidence: number;
}

// =============================================================================
// VTID-01136: Fusion Context (Combined Input)
// =============================================================================

/**
 * Complete fusion context combining all deep context engines.
 * This is the input to the priority resolution engine.
 */
export interface FusionContext {
  /** Situational context (D32-D34) */
  situational: SituationalContext;
  /** Social context (D35) */
  social: SocialContext;
  /** Financial context (D36) */
  financial: FinancialContext;
  /** Health & capacity context (D37) */
  health_capacity: HealthCapacityContext;
  /** Learning context (D38) */
  learning: LearningContext;
  /** Taste & lifestyle context (D39) */
  taste_lifestyle: TasteLifestyleContext;
  /** Goals & trajectory context (D40) */
  goals_trajectory: GoalsTrajectoryContext;
  /** Boundaries & consent context (D41) */
  boundaries_consent: BoundariesConsentContext;
}

/**
 * Domain signal for fusion scoring
 */
export interface DomainSignal {
  domain: PriorityDomain;
  /** Raw activation score (0-100) */
  activation_score: number;
  /** Confidence in this domain's signals (0-100) */
  confidence: number;
  /** Urgency level for this domain */
  urgency: 'critical' | 'high' | 'medium' | 'low' | 'none';
  /** Risk flags active for this domain */
  risk_flags: string[];
  /** Sources of this signal */
  sources: string[];
}

// =============================================================================
// VTID-01136: Domain Priority Scoring
// =============================================================================

/**
 * Priority score for a single domain.
 * Scores are dynamic and reversible.
 */
export interface DomainPriorityScore {
  domain: PriorityDomain;
  /** Final priority score after all adjustments (0-100) */
  score: number;
  /** Base score before adjustments */
  base_score: number;
  /** Adjustments applied */
  adjustments: Array<{
    reason: string;
    delta: number;
    rule: string;
  }>;
  /** Whether this domain is suppressed */
  suppressed: boolean;
  /** Suppression reason if applicable */
  suppression_reason?: string;
}

/**
 * Complete domain priority map
 */
export interface DomainPriorityMap {
  health_wellbeing: DomainPriorityScore;
  social_relationships: DomainPriorityScore;
  learning_growth: DomainPriorityScore;
  commerce_monetization: DomainPriorityScore;
  exploration_discovery: DomainPriorityScore;
}

// =============================================================================
// VTID-01136: Conflict Detection & Resolution
// =============================================================================

/**
 * Detected conflict between domains
 */
export interface DomainConflict {
  /** Conflicting domains */
  domains: [PriorityDomain, PriorityDomain];
  /** Type of conflict */
  conflict_type:
    | 'health_vs_monetization'
    | 'rest_vs_social'
    | 'learning_vs_availability'
    | 'goals_vs_desire'
    | 'boundaries_vs_optimization'
    | 'capacity_vs_demand'
    | 'generic';
  /** Severity of conflict (0-100) */
  severity: number;
  /** Description of the conflict */
  description: string;
  /** Evidence for conflict detection */
  evidence: string[];
}

/**
 * Resolution strategy for a conflict
 */
export type ResolutionStrategy =
  | 'defer_lower_priority'     // Defer the lower-priority domain
  | 'reframe_suggestion'       // Reframe to align with priority
  | 'split_across_time'        // "Now vs later" split
  | 'suppress_entirely'        // Suppress if unsafe
  | 'merge_compatible'         // Merge if domains can coexist
  | 'user_arbitration';        // Ask user to decide

/**
 * Resolution for a detected conflict
 */
export interface ConflictResolution {
  conflict: DomainConflict;
  strategy: ResolutionStrategy;
  /** Winner of the conflict (if applicable) */
  winner?: PriorityDomain;
  /** Deferred domain (if applicable) */
  deferred?: PriorityDomain;
  /** Reframing suggestion (if applicable) */
  reframe_hint?: string;
  /** Time split suggestion (if applicable) */
  time_split?: {
    now: PriorityDomain;
    later: PriorityDomain;
    later_delay_minutes?: number;
  };
  /** Rationale for resolution */
  rationale: string;
}

// =============================================================================
// VTID-01136: Priority-Resolved Action Plan (Output)
// =============================================================================

/**
 * Priority-resolved action plan.
 * This is the canonical output of D42.
 */
export interface ResolvedActionPlan {
  /** Primary domain that should lead */
  primary_domain: PriorityDomain;
  /** Secondary domains that can assist */
  secondary_domains: PriorityDomain[];
  /** Domains explicitly deferred for later */
  deferred_domains: Array<{
    domain: PriorityDomain;
    reason: string;
    suggested_delay_minutes?: number;
  }>;
  /** Domains entirely suppressed */
  suppressed_domains: Array<{
    domain: PriorityDomain;
    reason: string;
  }>;
  /** Priority tags for downstream consumption */
  priority_tags: PriorityTag[];
  /** Conflicts detected and resolved */
  resolved_conflicts: ConflictResolution[];
  /** Human-readable rationale */
  rationale: string;
  /** Action constraints for downstream */
  constraints: {
    /** Max simultaneous high-effort domains (spec: never > 1) */
    max_high_effort_domains: number;
    /** Allow commerce recommendations */
    allow_commerce: boolean;
    /** Allow proactive nudges */
    allow_proactive: boolean;
    /** Suggested response depth */
    suggested_depth: 'minimal' | 'moderate' | 'detailed';
    /** Suggested response pacing */
    suggested_pacing: 'slower' | 'normal' | 'energetic';
  };
}

// =============================================================================
// VTID-01136: Fusion Engine Input/Output
// =============================================================================

/**
 * Input to the fusion engine
 */
export interface FusionEngineInput {
  /** User identity */
  user_id: string;
  tenant_id: string;
  session_id?: string;
  turn_id?: string;
  /** Current user intent (from D21) */
  current_intent?: {
    primary_intent: string;
    domain_tags: string[];
    urgency_level: 'critical' | 'high' | 'medium' | 'low';
    explicit_request?: string;
  };
  /** Fusion context from deep engines (D32-D41) */
  fusion_context: Partial<FusionContext>;
  /** Confidence levels per context source */
  confidence_levels?: Record<string, number>;
  /** Explicit user priority override (if any) */
  user_priority_override?: PriorityDomain;
}

/**
 * Response from the fusion engine
 */
export interface FusionEngineResponse {
  ok: boolean;
  error?: string;
  message?: string;
  /** Resolved action plan */
  resolved_plan?: ResolvedActionPlan;
  /** Full domain priority scores */
  domain_priorities?: DomainPriorityMap;
  /** Domain signals used for scoring */
  domain_signals?: DomainSignal[];
  /** Conflicts detected */
  conflicts_detected?: DomainConflict[];
  /** Stability window (prevent oscillation) */
  stability_window_seconds?: number;
  /** Metadata for audit */
  metadata?: {
    vtid: string;
    computed_at: string;
    input_hash: string;
    rules_applied: string[];
    duration_ms: number;
  };
}

// =============================================================================
// VTID-01136: Configuration
// =============================================================================

/**
 * Fusion engine configuration
 */
export interface FusionEngineConfig {
  /** Minimum activation score to consider a domain (0-100) */
  domain_activation_threshold: number;
  /** Minimum conflict severity to trigger resolution (0-100) */
  conflict_resolution_threshold: number;
  /** Stability window to prevent priority oscillation (seconds) */
  stability_window_seconds: number;
  /** Base priority weights per domain */
  base_priority_weights: Record<PriorityDomain, number>;
  /** Whether to allow monetization at all */
  monetization_enabled: boolean;
  /** Maximum secondary domains */
  max_secondary_domains: number;
}

/**
 * Default fusion engine configuration
 */
export const DEFAULT_FUSION_CONFIG: FusionEngineConfig = {
  domain_activation_threshold: 20,
  conflict_resolution_threshold: 30,
  stability_window_seconds: 60,
  base_priority_weights: {
    health_wellbeing: 100,        // Highest base (safety first)
    social_relationships: 70,
    learning_growth: 60,
    exploration_discovery: 50,
    commerce_monetization: 20     // Lowest base (spec requirement)
  },
  monetization_enabled: true,
  max_secondary_domains: 2
};

// =============================================================================
// VTID-01136: Audit & Traceability
// =============================================================================

/**
 * Audit entry for fusion decisions (D59 compliance)
 */
export interface FusionAuditEntry {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id?: string;
  turn_id?: string;
  /** Input summary (not full context for privacy) */
  input_summary: {
    contexts_provided: string[];
    intent_type?: string;
    user_override?: boolean;
  };
  /** Resolved plan */
  resolved_plan: ResolvedActionPlan;
  /** Conflicts resolved */
  conflicts_count: number;
  /** Rules applied */
  rules_applied: string[];
  /** Processing duration */
  duration_ms: number;
  created_at: string;
}

// =============================================================================
// VTID-01136: Helper Functions
// =============================================================================

/**
 * Check if a priority domain is valid
 */
export function isValidPriorityDomain(domain: string): domain is PriorityDomain {
  return PRIORITY_DOMAINS.includes(domain as PriorityDomain);
}

/**
 * Check if a priority tag is valid
 */
export function isValidPriorityTag(tag: string): tag is PriorityTag {
  return PRIORITY_TAGS.includes(tag as PriorityTag);
}

/**
 * Get default context stubs when deep engines are not available
 */
export function getDefaultFusionContext(): FusionContext {
  const now = new Date();
  const hour = now.getHours();

  let timeOfDay: SituationalContext['time_of_day'] = 'afternoon';
  if (hour >= 5 && hour < 8) timeOfDay = 'early_morning';
  else if (hour >= 8 && hour < 12) timeOfDay = 'morning';
  else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
  else if (hour >= 17 && hour < 22) timeOfDay = 'evening';
  else timeOfDay = 'late_night';

  const dayOfWeek = now.getDay();
  const dayType: SituationalContext['day_type'] =
    (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';

  return {
    situational: {
      time_of_day: timeOfDay,
      day_type: dayType,
      location_type: 'unknown',
      confidence: 50,
      evidence: ['time_derived']
    },
    social: {
      social_activity_level: 'medium',
      pending_obligations: [],
      connection_pattern: 'neutral',
      community_score: 50,
      confidence: 30,
      risk_flags: []
    },
    financial: {
      budget_sensitivity: 'unknown',
      recent_purchase_activity: 'none',
      commerce_intent: 'none',
      monetization_eligible: false,
      confidence: 20,
      risk_flags: []
    },
    health_capacity: {
      energy_level: 70,
      availability: 'medium',
      active_health_concerns: [],
      safety_flags: [],
      confidence: 30
    },
    learning: {
      absorption_capacity: 60,
      active_learning_goals: [],
      session_state: 'browsing',
      recent_progress: 'unknown',
      preferred_depth: 'moderate',
      confidence: 30
    },
    taste_lifestyle: {
      active_preferences: [],
      style_signals: {},
      confidence: 20
    },
    goals_trajectory: {
      active_goals: [],
      trajectory_alignment: 'unknown',
      time_horizon_focus: 'balanced',
      confidence: 20
    },
    boundaries_consent: {
      active_boundaries: [],
      domain_consent: {
        health_wellbeing: true,
        social_relationships: true,
        learning_growth: true,
        commerce_monetization: false,
        exploration_discovery: true
      },
      privacy_mode: 'standard',
      do_not_disturb: false,
      commerce_opted_out: true,
      confidence: 50
    }
  };
}

/**
 * Format resolved plan for ORB context injection
 */
export function formatResolvedPlanForPrompt(plan: ResolvedActionPlan): string {
  const lines: string[] = [
    '## Current Priority Context (D42 Fusion)',
    ''
  ];

  lines.push(`Primary Focus: ${plan.primary_domain.replace('_', ' & ')}`);

  if (plan.secondary_domains.length > 0) {
    lines.push(`Secondary: ${plan.secondary_domains.map(d => d.replace('_', ' & ')).join(', ')}`);
  }

  if (plan.priority_tags.length > 0) {
    lines.push(`Tags: ${plan.priority_tags.join(', ')}`);
  }

  lines.push('');
  lines.push('### Constraints');
  lines.push(`- Max high-effort domains: ${plan.constraints.max_high_effort_domains}`);
  lines.push(`- Commerce allowed: ${plan.constraints.allow_commerce ? 'yes' : 'no'}`);
  lines.push(`- Proactive allowed: ${plan.constraints.allow_proactive ? 'yes' : 'no'}`);
  lines.push(`- Depth: ${plan.constraints.suggested_depth}`);
  lines.push(`- Pacing: ${plan.constraints.suggested_pacing}`);

  if (plan.deferred_domains.length > 0) {
    lines.push('');
    lines.push('### Deferred for Later');
    plan.deferred_domains.forEach(d => {
      lines.push(`- ${d.domain.replace('_', ' & ')}: ${d.reason}`);
    });
  }

  return lines.join('\n');
}
