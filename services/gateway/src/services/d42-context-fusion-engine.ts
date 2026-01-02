/**
 * VTID-01136: D42 Cross-Domain Context Fusion & Priority Resolution Engine
 *
 * Deterministic engine that resolves conflicts and priorities across domains
 * (health, social, learning, commerce, exploration) so the system acts
 * coherently as one intelligence, not as competing modules.
 *
 * D42 is the "context arbitrator" - it answers:
 * "When multiple domains want to act, which one should lead — and which must wait?"
 *
 * Position in Intelligence Stack:
 * D20-D28 (Core) -> D32-D41 (Deep Context) -> D42 (Fusion & Priority)
 *
 * Non-Negotiable Priority Rules (from spec):
 *   1. Health & safety override ALL other domains
 *   2. Boundaries & consent override optimization
 *   3. Monetization is ALWAYS lowest priority unless explicitly requested
 *   4. Low availability suppresses multi-domain actions
 *   5. Explicit user intent can override inferred priority
 *
 * Behavioral Rules (from spec):
 *   - Never act on multiple high-effort domains simultaneously
 *   - Always explain prioritization implicitly through behavior (not lectures)
 *   - Prefer fewer, clearer actions over broad coverage
 *   - Allow user to re-prioritize explicitly
 *
 * Determinism Requirements:
 *   - Same inputs → same output
 *   - No randomness at this layer
 *   - Stable sorting for ties
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  PriorityDomain,
  PriorityTag,
  PRIORITY_DOMAINS,
  FusionContext,
  FusionEngineInput,
  FusionEngineResponse,
  FusionEngineConfig,
  DEFAULT_FUSION_CONFIG,
  DomainSignal,
  DomainPriorityScore,
  DomainPriorityMap,
  DomainConflict,
  ConflictResolution,
  ResolutionStrategy,
  ResolvedActionPlan,
  FusionAuditEntry,
  getDefaultFusionContext,
  HealthCapacityContext,
  BoundariesConsentContext
} from '../types/context-fusion';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01136';
const LOG_PREFIX = '[D42-Fusion]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * Conflict type mappings for detection
 */
const CONFLICT_TYPE_MAP: Record<string, [PriorityDomain, PriorityDomain][]> = {
  'health_vs_monetization': [['health_wellbeing', 'commerce_monetization']],
  'rest_vs_social': [['health_wellbeing', 'social_relationships']],
  'learning_vs_availability': [['learning_growth', 'health_wellbeing']],
  'goals_vs_desire': [['learning_growth', 'exploration_discovery']],
  'boundaries_vs_optimization': [
    ['health_wellbeing', 'commerce_monetization'],
    ['social_relationships', 'commerce_monetization']
  ],
  'capacity_vs_demand': [
    ['health_wellbeing', 'learning_growth'],
    ['health_wellbeing', 'social_relationships']
  ]
};

// =============================================================================
// Environment Detection
// =============================================================================

function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

// =============================================================================
// Supabase Client
// =============================================================================

function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function createUserClient(token: string): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_ANON_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create deterministic hash of input for audit
 */
function hashInput(input: FusionEngineInput): string {
  const normalized = JSON.stringify({
    user_id: input.user_id,
    tenant_id: input.tenant_id,
    intent: input.current_intent,
    override: input.user_priority_override
  });
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

/**
 * Stable sort to ensure determinism
 */
function stableSort<T extends { score: number; domain: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score; // Higher score first
    }
    return a.domain.localeCompare(b.domain); // Alphabetical for ties
  });
}

// =============================================================================
// Domain Signal Computation
// =============================================================================

/**
 * Compute domain activation signals from fusion context
 */
function computeDomainSignals(
  fusionContext: FusionContext,
  intent?: FusionEngineInput['current_intent']
): DomainSignal[] {
  const signals: DomainSignal[] = [];

  // Health & Wellbeing Signal
  const healthSignal = computeHealthSignal(fusionContext);
  signals.push(healthSignal);

  // Social & Relationships Signal
  const socialSignal = computeSocialSignal(fusionContext);
  signals.push(socialSignal);

  // Learning & Growth Signal
  const learningSignal = computeLearningSignal(fusionContext);
  signals.push(learningSignal);

  // Commerce & Monetization Signal
  const commerceSignal = computeCommerceSignal(fusionContext);
  signals.push(commerceSignal);

  // Exploration & Discovery Signal
  const explorationSignal = computeExplorationSignal(fusionContext, intent);
  signals.push(explorationSignal);

  return signals;
}

function computeHealthSignal(ctx: FusionContext): DomainSignal {
  const health = ctx.health_capacity;
  const sources: string[] = ['health_capacity'];
  const riskFlags: string[] = [];

  let activation = 0;
  let urgency: DomainSignal['urgency'] = 'none';

  // Safety flags trigger high activation
  if (health.safety_flags.length > 0) {
    const maxSeverity = health.safety_flags.reduce((max, flag) => {
      const severityScore = { critical: 4, high: 3, medium: 2, low: 1 }[flag.severity];
      return Math.max(max, severityScore);
    }, 0);

    activation += maxSeverity * 25; // Up to 100 for critical
    urgency = maxSeverity >= 4 ? 'critical' : maxSeverity >= 3 ? 'high' : 'medium';
    riskFlags.push(...health.safety_flags.map(f => f.type));
  }

  // Low energy increases health priority
  if (health.energy_level < 30) {
    activation += 40;
    if (urgency === 'none') urgency = 'medium';
    riskFlags.push('low_energy');
  } else if (health.energy_level < 50) {
    activation += 20;
    if (urgency === 'none') urgency = 'low';
  }

  // Low availability increases health priority
  if (health.availability === 'minimal') {
    activation += 30;
    riskFlags.push('minimal_availability');
  } else if (health.availability === 'low') {
    activation += 15;
  }

  // Active health concerns
  if (health.active_health_concerns.length > 0) {
    activation += Math.min(health.active_health_concerns.length * 10, 30);
    riskFlags.push('active_concerns');
  }

  // Stress level
  if (health.stress_level && health.stress_level > 70) {
    activation += 20;
    riskFlags.push('high_stress');
  }

  // Late night + low energy = health priority
  if (ctx.situational.time_of_day === 'late_night' && health.energy_level < 50) {
    activation += 25;
    riskFlags.push('late_night_fatigue');
  }

  return {
    domain: 'health_wellbeing',
    activation_score: Math.min(activation, 100),
    confidence: health.confidence,
    urgency,
    risk_flags: riskFlags,
    sources
  };
}

function computeSocialSignal(ctx: FusionContext): DomainSignal {
  const social = ctx.social;
  const sources: string[] = ['social'];
  const riskFlags: string[] = [];

  let activation = 0;
  let urgency: DomainSignal['urgency'] = 'none';

  // Pending obligations
  if (social.pending_obligations.length > 0) {
    const highUrgency = social.pending_obligations.filter(o => o.urgency === 'high').length;
    const mediumUrgency = social.pending_obligations.filter(o => o.urgency === 'medium').length;

    activation += highUrgency * 25 + mediumUrgency * 10;
    if (highUrgency > 0) urgency = 'high';
    else if (mediumUrgency > 0) urgency = 'medium';
  }

  // Connection seeking pattern
  if (social.connection_pattern === 'seeking') {
    activation += 30;
    sources.push('connection_seeking');
  }

  // Low social activity + isolation
  if (social.social_activity_level === 'isolated') {
    activation += 20;
    riskFlags.push('social_isolation');
  }

  // High community score with evening time = social opportunity
  if (social.community_score > 70 && ctx.situational.time_of_day === 'evening') {
    activation += 15;
  }

  // Weekend bonus for social
  if (ctx.situational.day_type === 'weekend') {
    activation += 10;
  }

  // Check boundaries
  if (!ctx.boundaries_consent.domain_consent.social_relationships) {
    activation = 0;
    riskFlags.push('consent_denied');
  }

  return {
    domain: 'social_relationships',
    activation_score: Math.min(activation, 100),
    confidence: social.confidence,
    urgency,
    risk_flags: riskFlags,
    sources
  };
}

function computeLearningSignal(ctx: FusionContext): DomainSignal {
  const learning = ctx.learning;
  const goals = ctx.goals_trajectory;
  const sources: string[] = ['learning'];
  const riskFlags: string[] = [];

  let activation = 0;
  let urgency: DomainSignal['urgency'] = 'none';

  // Active learning session
  if (learning.session_state === 'deep_focus') {
    activation += 50;
    urgency = 'medium';
  } else if (learning.session_state === 'active') {
    activation += 30;
  }

  // Active learning goals
  const learningGoals = goals.active_goals.filter(g => g.domain === 'learning_growth');
  if (learningGoals.length > 0) {
    const highPriority = learningGoals.filter(g => g.priority === 'high').length;
    activation += highPriority * 20 + (learningGoals.length - highPriority) * 10;
  }

  // Good absorption capacity
  if (learning.absorption_capacity > 70) {
    activation += 15;
  }

  // Morning/morning = good learning time
  if (ctx.situational.time_of_day === 'morning' || ctx.situational.time_of_day === 'early_morning') {
    activation += 10;
  }

  // Low absorption capacity = suppress learning
  if (learning.absorption_capacity < 30) {
    activation = Math.max(activation - 30, 0);
    riskFlags.push('low_absorption');
  }

  // Fatigued session state
  if (learning.session_state === 'fatigued') {
    activation = Math.max(activation - 40, 0);
    riskFlags.push('learning_fatigue');
  }

  // Check boundaries
  if (!ctx.boundaries_consent.domain_consent.learning_growth) {
    activation = 0;
    riskFlags.push('consent_denied');
  }

  return {
    domain: 'learning_growth',
    activation_score: Math.min(activation, 100),
    confidence: learning.confidence,
    urgency,
    risk_flags: riskFlags,
    sources
  };
}

function computeCommerceSignal(ctx: FusionContext): DomainSignal {
  const financial = ctx.financial;
  const boundaries = ctx.boundaries_consent;
  const sources: string[] = ['financial'];
  const riskFlags: string[] = [];

  let activation = 0;
  let urgency: DomainSignal['urgency'] = 'none';

  // HARD RULE: Commerce opt-out = zero activation
  if (boundaries.commerce_opted_out) {
    return {
      domain: 'commerce_monetization',
      activation_score: 0,
      confidence: 100,
      urgency: 'none',
      risk_flags: ['commerce_opted_out'],
      sources
    };
  }

  // Explicit commerce intent
  if (financial.commerce_intent === 'explicit') {
    activation += 60;
    urgency = 'medium';
    sources.push('explicit_intent');
  } else if (financial.commerce_intent === 'implicit') {
    activation += 20;
  }

  // Monetization eligibility
  if (financial.monetization_eligible) {
    activation += 10;
  }

  // Recent purchase activity
  if (financial.recent_purchase_activity === 'active') {
    activation += 15;
  }

  // High budget sensitivity = reduce commerce push
  if (financial.budget_sensitivity === 'high') {
    activation = Math.max(activation - 20, 0);
    riskFlags.push('budget_sensitive');
  }

  // Financial risk flags
  riskFlags.push(...financial.risk_flags);

  // HARD RULE: Domain consent check
  if (!boundaries.domain_consent.commerce_monetization) {
    activation = 0;
    riskFlags.push('consent_denied');
  }

  // SPEC RULE: Commerce is ALWAYS lowest priority base
  // This is enforced in priority scoring, but we also cap activation
  activation = Math.min(activation, 60); // Cap at 60%

  return {
    domain: 'commerce_monetization',
    activation_score: activation,
    confidence: financial.confidence,
    urgency,
    risk_flags: riskFlags,
    sources
  };
}

function computeExplorationSignal(
  ctx: FusionContext,
  intent?: FusionEngineInput['current_intent']
): DomainSignal {
  const sources: string[] = ['exploration'];
  const riskFlags: string[] = [];

  let activation = 30; // Base exploration activation
  let urgency: DomainSignal['urgency'] = 'none';

  // Browsing session = exploration
  if (ctx.learning.session_state === 'browsing') {
    activation += 20;
  }

  // No specific intent = exploration opportunity
  if (!intent?.primary_intent || intent.primary_intent === 'exploration') {
    activation += 15;
  }

  // High availability = can explore
  if (ctx.health_capacity.availability === 'high') {
    activation += 10;
  }

  // Weekend afternoon = good exploration time
  if (ctx.situational.day_type === 'weekend' && ctx.situational.time_of_day === 'afternoon') {
    activation += 10;
  }

  // Low energy = reduce exploration
  if (ctx.health_capacity.energy_level < 40) {
    activation = Math.max(activation - 20, 0);
    riskFlags.push('low_energy');
  }

  // Do not disturb = suppress exploration
  if (ctx.boundaries_consent.do_not_disturb) {
    activation = 0;
    riskFlags.push('do_not_disturb');
  }

  // Check boundaries
  if (!ctx.boundaries_consent.domain_consent.exploration_discovery) {
    activation = 0;
    riskFlags.push('consent_denied');
  }

  return {
    domain: 'exploration_discovery',
    activation_score: Math.min(activation, 100),
    confidence: 50, // Exploration is inherently uncertain
    urgency,
    risk_flags: riskFlags,
    sources
  };
}

// =============================================================================
// Domain Priority Scoring
// =============================================================================

/**
 * Compute priority scores from domain signals
 */
function computePriorityScores(
  signals: DomainSignal[],
  fusionContext: FusionContext,
  config: FusionEngineConfig,
  userOverride?: PriorityDomain
): DomainPriorityMap {
  const scores: Record<PriorityDomain, DomainPriorityScore> = {} as Record<PriorityDomain, DomainPriorityScore>;

  for (const signal of signals) {
    const baseWeight = config.base_priority_weights[signal.domain];
    const baseScore = (signal.activation_score * baseWeight) / 100;

    const adjustments: DomainPriorityScore['adjustments'] = [];
    let finalScore = baseScore;
    let suppressed = false;
    let suppressionReason: string | undefined;

    // Apply adjustments based on non-negotiable rules

    // RULE 1: Health & safety override all
    if (signal.domain === 'health_wellbeing' && signal.urgency === 'critical') {
      adjustments.push({
        reason: 'Critical health/safety signal',
        delta: 50,
        rule: 'health_safety_override'
      });
      finalScore += 50;
    }

    // RULE 2: Boundaries override optimization
    if (signal.risk_flags.includes('consent_denied')) {
      suppressed = true;
      suppressionReason = 'User consent denied for this domain';
      finalScore = 0;
    }

    // RULE 3: Monetization is always lowest unless explicit
    if (signal.domain === 'commerce_monetization') {
      if (!signal.sources.includes('explicit_intent')) {
        adjustments.push({
          reason: 'Monetization deprioritized (not explicit)',
          delta: -30,
          rule: 'monetization_lowest'
        });
        finalScore = Math.max(finalScore - 30, 0);
      }
    }

    // RULE 4: Low availability suppresses multi-domain
    if (fusionContext.health_capacity.availability === 'minimal' ||
        fusionContext.health_capacity.availability === 'low') {
      if (signal.domain !== 'health_wellbeing') {
        adjustments.push({
          reason: 'Low availability - non-health domains deprioritized',
          delta: -20,
          rule: 'low_availability_suppression'
        });
        finalScore = Math.max(finalScore - 20, 0);
      }
    }

    // RULE 5: User override
    if (userOverride && userOverride === signal.domain) {
      adjustments.push({
        reason: 'User explicit priority override',
        delta: 40,
        rule: 'user_override'
      });
      finalScore += 40;
    }

    // Urgency bonus
    const urgencyBonus = {
      critical: 30,
      high: 20,
      medium: 10,
      low: 5,
      none: 0
    }[signal.urgency];

    if (urgencyBonus > 0) {
      adjustments.push({
        reason: `Urgency: ${signal.urgency}`,
        delta: urgencyBonus,
        rule: 'urgency_bonus'
      });
      finalScore += urgencyBonus;
    }

    // Confidence weighting
    const confidenceMultiplier = signal.confidence / 100;
    const confidenceAdjustment = (finalScore * (1 - confidenceMultiplier)) * -0.3;
    if (Math.abs(confidenceAdjustment) > 1) {
      adjustments.push({
        reason: `Confidence adjustment (${signal.confidence}%)`,
        delta: Math.round(confidenceAdjustment),
        rule: 'confidence_weight'
      });
      finalScore += confidenceAdjustment;
    }

    scores[signal.domain] = {
      domain: signal.domain,
      score: Math.max(0, Math.min(100, Math.round(finalScore))),
      base_score: Math.round(baseScore),
      adjustments,
      suppressed,
      suppression_reason: suppressionReason
    };
  }

  return scores as DomainPriorityMap;
}

// =============================================================================
// Conflict Detection
// =============================================================================

/**
 * Detect conflicts between active domains
 */
function detectConflicts(
  signals: DomainSignal[],
  priorities: DomainPriorityMap,
  fusionContext: FusionContext,
  config: FusionEngineConfig
): DomainConflict[] {
  const conflicts: DomainConflict[] = [];
  const activeSignals = signals.filter(s =>
    s.activation_score >= config.domain_activation_threshold &&
    !priorities[s.domain].suppressed
  );

  // Check each conflict type
  for (const [conflictType, domainPairs] of Object.entries(CONFLICT_TYPE_MAP)) {
    for (const [domain1, domain2] of domainPairs) {
      const signal1 = activeSignals.find(s => s.domain === domain1);
      const signal2 = activeSignals.find(s => s.domain === domain2);

      if (signal1 && signal2) {
        const conflict = detectSpecificConflict(
          conflictType as DomainConflict['conflict_type'],
          signal1,
          signal2,
          fusionContext,
          priorities
        );
        if (conflict && conflict.severity >= config.conflict_resolution_threshold) {
          conflicts.push(conflict);
        }
      }
    }
  }

  return conflicts;
}

function detectSpecificConflict(
  conflictType: DomainConflict['conflict_type'],
  signal1: DomainSignal,
  signal2: DomainSignal,
  ctx: FusionContext,
  priorities: DomainPriorityMap
): DomainConflict | null {
  const evidence: string[] = [];
  let severity = 0;
  let description = '';

  switch (conflictType) {
    case 'health_vs_monetization':
      // Health concerns + commerce pressure = conflict
      if (signal1.risk_flags.length > 0 && signal2.activation_score > 30) {
        severity = 80; // Always high severity
        description = 'Health concerns conflict with commerce activation';
        evidence.push('health_risk_flags_present', 'commerce_active');
      }
      break;

    case 'rest_vs_social':
      // Low energy + social obligations = conflict
      if (ctx.health_capacity.energy_level < 40 &&
          ctx.social.pending_obligations.length > 0) {
        severity = 60;
        description = 'Low energy conflicts with social obligations';
        evidence.push('low_energy', 'pending_social_obligations');
      }
      break;

    case 'learning_vs_availability':
      // Deep learning goals + low capacity = conflict
      if (ctx.learning.session_state === 'deep_focus' &&
          ctx.health_capacity.availability === 'low') {
        severity = 50;
        description = 'Learning depth conflicts with low availability';
        evidence.push('deep_focus_session', 'low_availability');
      }
      break;

    case 'goals_vs_desire':
      // Long-term goals vs immediate exploration
      if (ctx.goals_trajectory.time_horizon_focus === 'long_term' &&
          ctx.learning.session_state === 'browsing') {
        severity = 30;
        description = 'Long-term goals may conflict with exploration';
        evidence.push('long_term_focus', 'browsing_mode');
      }
      break;

    case 'boundaries_vs_optimization':
      // Boundaries set but optimization wants to override
      if (ctx.boundaries_consent.active_boundaries.length > 0) {
        const relevantBoundaries = ctx.boundaries_consent.active_boundaries.filter(
          b => b.enforcement === 'hard'
        );
        if (relevantBoundaries.length > 0) {
          severity = 90; // Hard boundaries = high severity
          description = 'Hard boundaries conflict with optimization';
          evidence.push('hard_boundaries_active');
        }
      }
      break;

    case 'capacity_vs_demand':
      // Low capacity + high domain demand = conflict
      if (ctx.health_capacity.availability === 'minimal' &&
          (signal1.activation_score > 50 || signal2.activation_score > 50)) {
        severity = 70;
        description = 'Minimal capacity cannot meet domain demands';
        evidence.push('minimal_capacity', 'high_demand');
      }
      break;

    default:
      return null;
  }

  if (severity === 0) return null;

  return {
    domains: [signal1.domain, signal2.domain],
    conflict_type: conflictType,
    severity,
    description,
    evidence
  };
}

// =============================================================================
// Conflict Resolution
// =============================================================================

/**
 * Resolve detected conflicts
 */
function resolveConflicts(
  conflicts: DomainConflict[],
  priorities: DomainPriorityMap,
  fusionContext: FusionContext
): ConflictResolution[] {
  const resolutions: ConflictResolution[] = [];

  for (const conflict of conflicts) {
    const resolution = resolveConflict(conflict, priorities, fusionContext);
    resolutions.push(resolution);
  }

  return resolutions;
}

function resolveConflict(
  conflict: DomainConflict,
  priorities: DomainPriorityMap,
  ctx: FusionContext
): ConflictResolution {
  const [domain1, domain2] = conflict.domains;
  const priority1 = priorities[domain1].score;
  const priority2 = priorities[domain2].score;

  let strategy: ResolutionStrategy;
  let winner: PriorityDomain | undefined;
  let deferred: PriorityDomain | undefined;
  let reframeHint: string | undefined;
  let timeSplit: ConflictResolution['time_split'] | undefined;
  let rationale: string;

  switch (conflict.conflict_type) {
    case 'health_vs_monetization':
      // RULE: Health ALWAYS wins over monetization
      strategy = 'suppress_entirely';
      winner = 'health_wellbeing';
      deferred = 'commerce_monetization';
      rationale = 'Health & safety override monetization (non-negotiable)';
      break;

    case 'rest_vs_social':
      // Check if social obligation is truly urgent
      const urgentObligations = ctx.social.pending_obligations.filter(
        o => o.urgency === 'high'
      );
      if (urgentObligations.length > 0) {
        strategy = 'reframe_suggestion';
        winner = 'social_relationships';
        reframeHint = 'Suggest minimal-effort social engagement that respects energy limits';
        rationale = 'Urgent social obligation acknowledged with low-energy approach';
      } else {
        strategy = 'split_across_time';
        timeSplit = {
          now: 'health_wellbeing',
          later: 'social_relationships',
          later_delay_minutes: 120
        };
        rationale = 'Rest now, social engagement deferred to later';
      }
      break;

    case 'learning_vs_availability':
      if (ctx.health_capacity.availability === 'minimal') {
        strategy = 'defer_lower_priority';
        winner = 'health_wellbeing';
        deferred = 'learning_growth';
        rationale = 'Learning deferred due to minimal availability';
      } else {
        strategy = 'reframe_suggestion';
        winner = 'learning_growth';
        reframeHint = 'Suggest lighter learning content matching current capacity';
        rationale = 'Learning continues with adjusted depth';
      }
      break;

    case 'goals_vs_desire':
      // Lower severity, prefer merge
      strategy = 'merge_compatible';
      rationale = 'Exploration can support long-term goals through discovery';
      break;

    case 'boundaries_vs_optimization':
      // RULE: Boundaries ALWAYS win
      strategy = 'suppress_entirely';
      deferred = domain1 === 'health_wellbeing' ? domain2 : domain1;
      rationale = 'Boundaries & consent override optimization (non-negotiable)';
      break;

    case 'capacity_vs_demand':
      strategy = 'defer_lower_priority';
      winner = 'health_wellbeing';
      deferred = priority1 > priority2 ? domain2 : domain1;
      rationale = 'Capacity limits require deferring lower-priority domain';
      break;

    default:
      // Generic resolution: higher priority wins
      strategy = 'defer_lower_priority';
      if (priority1 >= priority2) {
        winner = domain1;
        deferred = domain2;
      } else {
        winner = domain2;
        deferred = domain1;
      }
      rationale = 'Higher priority domain leads';
  }

  return {
    conflict,
    strategy,
    winner,
    deferred,
    reframe_hint: reframeHint,
    time_split: timeSplit,
    rationale
  };
}

// =============================================================================
// Action Plan Generation
// =============================================================================

/**
 * Generate the final resolved action plan
 */
function generateActionPlan(
  priorities: DomainPriorityMap,
  signals: DomainSignal[],
  resolutions: ConflictResolution[],
  fusionContext: FusionContext,
  config: FusionEngineConfig,
  userOverride?: PriorityDomain
): ResolvedActionPlan {
  // Get sorted active domains
  const sortedDomains = stableSort(
    Object.values(priorities)
      .filter(p => !p.suppressed && p.score >= config.domain_activation_threshold)
      .map(p => ({ score: p.score, domain: p.domain }))
  );

  // Determine primary domain
  let primaryDomain: PriorityDomain;
  if (userOverride && !priorities[userOverride].suppressed) {
    primaryDomain = userOverride;
  } else if (sortedDomains.length > 0) {
    primaryDomain = sortedDomains[0].domain as PriorityDomain;
  } else {
    // Default to exploration if nothing else active
    primaryDomain = 'exploration_discovery';
  }

  // Determine secondary domains (max 2, excluding deferred/suppressed)
  const deferredDomains = new Set(resolutions.map(r => r.deferred).filter(Boolean));
  const secondaryDomains = sortedDomains
    .filter(d =>
      d.domain !== primaryDomain &&
      !deferredDomains.has(d.domain as PriorityDomain)
    )
    .slice(0, config.max_secondary_domains)
    .map(d => d.domain as PriorityDomain);

  // Collect deferred domains with reasons
  const deferredList = resolutions
    .filter(r => r.deferred)
    .map(r => ({
      domain: r.deferred!,
      reason: r.rationale,
      suggested_delay_minutes: r.time_split?.later_delay_minutes
    }));

  // Collect suppressed domains
  const suppressedList = Object.values(priorities)
    .filter(p => p.suppressed)
    .map(p => ({
      domain: p.domain,
      reason: p.suppression_reason || 'Suppressed by priority rules'
    }));

  // Determine priority tags
  const priorityTags = determinePriorityTags(
    primaryDomain,
    priorities,
    signals,
    fusionContext,
    userOverride
  );

  // Determine constraints
  const constraints = determineConstraints(
    primaryDomain,
    priorities,
    fusionContext
  );

  // Generate rationale
  const rationale = generateRationale(
    primaryDomain,
    secondaryDomains,
    resolutions,
    userOverride
  );

  return {
    primary_domain: primaryDomain,
    secondary_domains: secondaryDomains,
    deferred_domains: deferredList,
    suppressed_domains: suppressedList,
    priority_tags: priorityTags,
    resolved_conflicts: resolutions,
    rationale,
    constraints
  };
}

function determinePriorityTags(
  primary: PriorityDomain,
  priorities: DomainPriorityMap,
  signals: DomainSignal[],
  ctx: FusionContext,
  userOverride?: PriorityDomain
): PriorityTag[] {
  const tags: PriorityTag[] = [];

  // Domain-first tags
  if (primary === 'health_wellbeing') tags.push('health_first');
  if (primary === 'social_relationships') tags.push('social_first');
  if (primary === 'learning_growth') tags.push('learning_first');

  // Commerce suppression
  if (priorities.commerce_monetization.suppressed ||
      priorities.commerce_monetization.score < 10) {
    tags.push('commerce_suppressed');
    tags.push('monetization_suppressed');
  }

  // Exploration only (no other domains active)
  if (primary === 'exploration_discovery' &&
      Object.values(priorities).filter(p => !p.suppressed && p.score > 30).length === 1) {
    tags.push('exploration_only');
  }

  // Rest mode
  if (ctx.health_capacity.energy_level < 30 ||
      ctx.health_capacity.availability === 'minimal') {
    tags.push('rest_mode');
    tags.push('low_capacity');
  }

  // High urgency
  const hasUrgency = signals.some(s => s.urgency === 'high' || s.urgency === 'critical');
  if (hasUrgency) {
    tags.push('high_urgency');
  }

  // User override
  if (userOverride) {
    tags.push('user_override');
  }

  return tags;
}

function determineConstraints(
  primary: PriorityDomain,
  priorities: DomainPriorityMap,
  ctx: FusionContext
): ResolvedActionPlan['constraints'] {
  // SPEC RULE: Never act on multiple high-effort domains simultaneously
  const maxHighEffort = 1;

  // Commerce allowed only if not suppressed and not opted out
  const allowCommerce = !priorities.commerce_monetization.suppressed &&
                        !ctx.boundaries_consent.commerce_opted_out;

  // Proactive allowed based on do-not-disturb and availability
  const allowProactive = !ctx.boundaries_consent.do_not_disturb &&
                         ctx.health_capacity.availability !== 'minimal';

  // Suggested depth based on capacity
  let suggestedDepth: ResolvedActionPlan['constraints']['suggested_depth'] = 'moderate';
  if (ctx.health_capacity.energy_level < 40 ||
      ctx.learning.absorption_capacity < 40) {
    suggestedDepth = 'minimal';
  } else if (ctx.health_capacity.energy_level > 70 &&
             ctx.learning.absorption_capacity > 70) {
    suggestedDepth = 'detailed';
  }

  // Suggested pacing based on emotional/cognitive state and availability
  let suggestedPacing: ResolvedActionPlan['constraints']['suggested_pacing'] = 'normal';
  if (ctx.health_capacity.availability === 'low' ||
      ctx.health_capacity.availability === 'minimal') {
    suggestedPacing = 'slower';
  } else if (ctx.health_capacity.availability === 'high' &&
             ctx.health_capacity.energy_level > 70) {
    suggestedPacing = 'energetic';
  }

  return {
    max_high_effort_domains: maxHighEffort,
    allow_commerce: allowCommerce,
    allow_proactive: allowProactive,
    suggested_depth: suggestedDepth,
    suggested_pacing: suggestedPacing
  };
}

function generateRationale(
  primary: PriorityDomain,
  secondary: PriorityDomain[],
  resolutions: ConflictResolution[],
  userOverride?: PriorityDomain
): string {
  const parts: string[] = [];

  if (userOverride) {
    parts.push(`User explicitly prioritized ${userOverride.replace('_', ' & ')}.`);
  }

  parts.push(`Primary focus: ${primary.replace('_', ' & ')}.`);

  if (secondary.length > 0) {
    parts.push(`Secondary: ${secondary.map(d => d.replace('_', ' & ')).join(', ')}.`);
  }

  if (resolutions.length > 0) {
    const resolved = resolutions.length === 1
      ? '1 conflict resolved'
      : `${resolutions.length} conflicts resolved`;
    parts.push(resolved);
  }

  return parts.join(' ');
}

// =============================================================================
// Main Engine Functions
// =============================================================================

/**
 * Resolve priorities and generate action plan
 *
 * This is the main entry point for D42 fusion.
 *
 * @param input - Fusion engine input
 * @param authToken - Optional JWT token for authenticated requests
 * @param config - Optional configuration overrides
 * @returns Fusion engine response with resolved plan
 */
export async function resolvePriorities(
  input: FusionEngineInput,
  authToken?: string,
  config: FusionEngineConfig = DEFAULT_FUSION_CONFIG
): Promise<FusionEngineResponse> {
  const startTime = Date.now();
  const rulesApplied: string[] = [];

  try {
    // Get or default fusion context
    const fusionContext: FusionContext = {
      ...getDefaultFusionContext(),
      ...input.fusion_context
    };

    // Step 1: Compute domain signals
    const signals = computeDomainSignals(fusionContext, input.current_intent);
    rulesApplied.push('compute_domain_signals');

    // Step 2: Compute priority scores
    const priorities = computePriorityScores(
      signals,
      fusionContext,
      config,
      input.user_priority_override
    );
    rulesApplied.push('compute_priority_scores');

    // Step 3: Detect conflicts
    const conflicts = detectConflicts(signals, priorities, fusionContext, config);
    rulesApplied.push('detect_conflicts');

    // Step 4: Resolve conflicts
    const resolutions = resolveConflicts(conflicts, priorities, fusionContext);
    rulesApplied.push('resolve_conflicts');

    // Step 5: Generate action plan
    const resolvedPlan = generateActionPlan(
      priorities,
      signals,
      resolutions,
      fusionContext,
      config,
      input.user_priority_override
    );
    rulesApplied.push('generate_action_plan');

    const duration = Date.now() - startTime;

    // Emit OASIS event for traceability
    await emitOasisEvent({
      vtid: VTID,
      type: 'd42.priorities.resolved',
      source: 'gateway-d42',
      status: 'success',
      message: `Priorities resolved: ${resolvedPlan.primary_domain}`,
      payload: {
        user_id: input.user_id,
        session_id: input.session_id,
        primary_domain: resolvedPlan.primary_domain,
        secondary_domains: resolvedPlan.secondary_domains,
        conflicts_count: conflicts.length,
        tags: resolvedPlan.priority_tags,
        duration_ms: duration
      }
    });

    console.log(
      `${LOG_PREFIX} Resolved priorities in ${duration}ms: ` +
      `primary=${resolvedPlan.primary_domain}, ` +
      `conflicts=${conflicts.length}, ` +
      `tags=${resolvedPlan.priority_tags.join(',')}`
    );

    return {
      ok: true,
      resolved_plan: resolvedPlan,
      domain_priorities: priorities,
      domain_signals: signals,
      conflicts_detected: conflicts,
      stability_window_seconds: config.stability_window_seconds,
      metadata: {
        vtid: VTID,
        computed_at: new Date().toISOString(),
        input_hash: hashInput(input),
        rules_applied: rulesApplied,
        duration_ms: duration
      }
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error resolving priorities:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd42.priorities.failed',
      source: 'gateway-d42',
      status: 'error',
      message: `Priority resolution failed: ${errorMessage}`,
      payload: {
        user_id: input.user_id,
        session_id: input.session_id,
        error: errorMessage
      }
    });

    return {
      ok: false,
      error: 'RESOLUTION_FAILED',
      message: errorMessage
    };
  }
}

/**
 * Get priority tags for current context (lightweight)
 *
 * Quick check without full conflict resolution.
 * Useful for fast-path decisions.
 */
export async function getPriorityTags(
  input: FusionEngineInput,
  config: FusionEngineConfig = DEFAULT_FUSION_CONFIG
): Promise<PriorityTag[]> {
  const fusionContext: FusionContext = {
    ...getDefaultFusionContext(),
    ...input.fusion_context
  };

  const signals = computeDomainSignals(fusionContext, input.current_intent);
  const priorities = computePriorityScores(
    signals,
    fusionContext,
    config,
    input.user_priority_override
  );

  // Quick primary determination
  const sortedDomains = stableSort(
    Object.values(priorities)
      .filter(p => !p.suppressed && p.score >= config.domain_activation_threshold)
      .map(p => ({ score: p.score, domain: p.domain }))
  );

  const primary = sortedDomains.length > 0
    ? sortedDomains[0].domain as PriorityDomain
    : 'exploration_discovery';

  return determinePriorityTags(
    primary,
    priorities,
    signals,
    fusionContext,
    input.user_priority_override
  );
}

/**
 * Check if a domain action is currently allowed
 *
 * Quick validation for specific domain operations.
 */
export async function isDomainActionAllowed(
  domain: PriorityDomain,
  input: FusionEngineInput,
  config: FusionEngineConfig = DEFAULT_FUSION_CONFIG
): Promise<{ allowed: boolean; reason?: string }> {
  const fusionContext: FusionContext = {
    ...getDefaultFusionContext(),
    ...input.fusion_context
  };

  // Check consent
  if (!fusionContext.boundaries_consent.domain_consent[domain]) {
    return { allowed: false, reason: 'User consent not granted for this domain' };
  }

  // Check do-not-disturb
  if (fusionContext.boundaries_consent.do_not_disturb && domain !== 'health_wellbeing') {
    return { allowed: false, reason: 'Do not disturb mode active' };
  }

  // Check commerce opt-out
  if (domain === 'commerce_monetization' && fusionContext.boundaries_consent.commerce_opted_out) {
    return { allowed: false, reason: 'User has opted out of commerce' };
  }

  // Check capacity for high-effort domains
  if (fusionContext.health_capacity.availability === 'minimal') {
    if (domain !== 'health_wellbeing' && domain !== 'exploration_discovery') {
      return { allowed: false, reason: 'Minimal availability - only health and light exploration allowed' };
    }
  }

  return { allowed: true };
}

/**
 * Store fusion audit entry
 */
export async function storeFusionAudit(
  entry: FusionAuditEntry,
  authToken?: string
): Promise<boolean> {
  try {
    let supabase: SupabaseClient | null;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    } else {
      console.warn(`${LOG_PREFIX} Cannot store audit without auth`);
      return false;
    }

    if (!supabase) {
      return false;
    }

    const { error } = await supabase
      .from('d42_fusion_audit')
      .insert({
        id: entry.id,
        tenant_id: entry.tenant_id,
        user_id: entry.user_id,
        session_id: entry.session_id,
        turn_id: entry.turn_id,
        input_summary: entry.input_summary,
        resolved_plan: entry.resolved_plan,
        conflicts_count: entry.conflicts_count,
        rules_applied: entry.rules_applied,
        duration_ms: entry.duration_ms,
        created_at: entry.created_at
      });

    if (error) {
      console.warn(`${LOG_PREFIX} Failed to store audit:`, error.message);
      return false;
    }

    return true;

  } catch (error) {
    console.error(`${LOG_PREFIX} Error storing audit:`, error);
    return false;
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  getDefaultFusionContext,
  DEFAULT_FUSION_CONFIG
};

export type {
  FusionContext,
  FusionEngineInput,
  FusionEngineResponse,
  FusionEngineConfig,
  DomainSignal,
  DomainPriorityScore,
  DomainPriorityMap,
  DomainConflict,
  ConflictResolution,
  ResolvedActionPlan,
  FusionAuditEntry,
  PriorityDomain,
  PriorityTag
};
