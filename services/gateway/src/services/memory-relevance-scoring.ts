/**
 * VTID-01115: Memory Relevance Scoring Engine (D23)
 *
 * Deterministic scoring engine that assigns numerical relevance scores
 * to every candidate memory item before it enters the context bundle.
 *
 * Position in Intelligence Stack:
 * D20 Context Assembly
 *   -> D21 Intent
 *   -> D22 Routing
 *   -> D23 Memory Scoring (THIS)
 *
 * Scoring Inputs (each capped at max weight):
 * 1. Intent match strength (from D21) - max 25 points
 * 2. Domain alignment (from D22) - max 25 points
 * 3. Temporal distance (decay) - max 20 points
 * 4. Confidence score (source reliability) - max 15 points
 * 5. User reinforcement signals - max 10 points
 * 6. Role compatibility - max 5 points
 *
 * Total possible score: 100
 *
 * Hard Constraints:
 * - No memory enters context without a score
 * - No unscored memory in ORB reasoning
 * - Raw timestamps alone may not determine relevance
 * - All scoring logic must be inspectable
 *
 * Determinism Requirements:
 * - Same inputs -> same score
 * - Same score -> same rank
 * - No randomness or learning at this layer
 */

import { emitOasisEvent } from './oasis-event-service';
import type { MemoryItem } from './orb-memory-bridge';

// =============================================================================
// VTID-01115: Types & Interfaces
// =============================================================================

/**
 * Intent types from D21 (Memory Retrieve Router)
 */
export const RETRIEVE_INTENTS = [
  'health',
  'longevity',
  'community',
  'lifestyle',
  'planner',
  'general'
] as const;

export type RetrieveIntent = typeof RETRIEVE_INTENTS[number];

/**
 * Domain types from D22 (Routing/Personalization)
 */
export const DOMAINS = [
  'community',
  'health',
  'business',
  'lifestyle'
] as const;

export type Domain = typeof DOMAINS[number];

/**
 * Memory categories from D20 (Context Assembly)
 */
export const MEMORY_CATEGORIES = [
  'personal',
  'conversation',
  'preferences',
  'goals',
  'health',
  'relationships',
  'tasks',
  'products_services',
  'events_meetups',
  'notes',
  'community'
] as const;

export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

/**
 * Source types with reliability rankings
 */
export const SOURCE_TYPES = [
  'orb_voice',   // Highest reliability (direct user speech)
  'orb_text',    // High reliability (direct user input)
  'diary',       // Medium-high reliability (user reflection)
  'upload',      // Medium reliability (user-provided data)
  'system'       // Lowest reliability (auto-generated)
] as const;

export type SourceType = typeof SOURCE_TYPES[number];

/**
 * User roles for role compatibility scoring
 */
export const USER_ROLES = ['patient', 'professional', 'staff', 'admin', 'developer'] as const;
export type UserRole = typeof USER_ROLES[number];

/**
 * Component breakdown of relevance factors
 * Each factor must be logged for explainability
 */
export interface RelevanceFactors {
  intent_match: number;      // 0-25: How well memory matches current intent
  domain_match: number;      // 0-25: How well memory aligns with current domain
  recency: number;           // 0-20: Time-based decay (not raw timestamp)
  confidence: number;        // 0-15: Source reliability + importance
  reinforcement: number;     // 0-10: User reuse, corrections, explicit signals
  role_fit: number;          // 0-5: Role compatibility for sensitive content
}

/**
 * Memory item with relevance score attached
 */
export interface ScoredMemoryItem extends MemoryItem {
  relevance_score: number;           // 0-100 canonical score
  relevance_factors: RelevanceFactors;
  sensitivity_flags: SensitivityFlag[];
  exclusion_reason?: string;         // If excluded, why
}

/**
 * Sensitivity flags for medical/emotional content
 */
export interface SensitivityFlag {
  type: 'medical' | 'emotional' | 'financial' | 'relationship' | 'legal';
  detected_keywords: string[];
  requires_elevated_threshold: boolean;
}

/**
 * Context for scoring - all inputs needed for deterministic scoring
 */
export interface ScoringContext {
  intent: RetrieveIntent;
  domain?: Domain;
  role: UserRole;
  user_id: string;
  tenant_id: string;
  current_time: Date;
  user_reinforcement_signals?: UserReinforcementSignals;
}

/**
 * User reinforcement signals from previous interactions
 */
export interface UserReinforcementSignals {
  reused_memory_ids: string[];       // Memories explicitly referenced again
  corrected_memory_ids: string[];    // Memories user corrected
  pinned_memory_ids: string[];       // Memories user pinned/starred
  dismissed_memory_ids: string[];    // Memories user dismissed
}

/**
 * Scoring decision for logging/traceability
 */
export interface ScoringDecision {
  memory_id: string;
  relevance_score: number;
  relevance_factors: RelevanceFactors;
  decision: 'include' | 'deprioritize' | 'exclude';
  sensitivity_flags: SensitivityFlag[];
  exclusion_reason?: string;
}

/**
 * Context assembly result with scoring metadata
 */
export interface ScoredContextResult {
  scored_items: ScoredMemoryItem[];
  excluded_items: ScoredMemoryItem[];
  scoring_metadata: ScoringMetadata;
}

/**
 * Metadata about the scoring process for traceability
 */
export interface ScoringMetadata {
  scoring_run_id: string;
  scoring_timestamp: string;
  context: {
    intent: RetrieveIntent;
    domain?: Domain;
    role: UserRole;
  };
  total_candidates: number;
  included_count: number;
  deprioritized_count: number;
  excluded_count: number;
  top_n_with_factors: Array<{
    memory_id: string;
    relevance_score: number;
    relevance_factors: RelevanceFactors;
  }>;
  exclusion_reasons: Array<{
    memory_id: string;
    reason: string;
  }>;
}

// =============================================================================
// VTID-01115: Scoring Configuration
// =============================================================================

/**
 * Maximum weights for each scoring factor
 * HARD CONSTRAINT: No single factor may exceed its max weight
 */
export const FACTOR_MAX_WEIGHTS = {
  intent_match: 25,
  domain_match: 25,
  recency: 20,
  confidence: 15,
  reinforcement: 10,
  role_fit: 5
} as const;

/**
 * Score thresholds for decision making
 */
export const SCORE_THRESHOLDS = {
  include: 50,       // Score >= 50: Include in context
  deprioritize: 30,  // Score 30-49: Include but lower priority
  exclude: 30        // Score < 30: Exclude from context
} as const;

/**
 * Elevated threshold for sensitive memories
 */
export const SENSITIVE_MEMORY_THRESHOLD = 65;

/**
 * Domain caps - max memories per domain in final context
 */
export const DOMAIN_CAPS: Record<Domain | 'general', number> = {
  health: 10,
  community: 8,
  business: 6,
  lifestyle: 8,
  general: 15
};

/**
 * Recency decay configuration
 */
export const RECENCY_DECAY = {
  HOUR_1: { max_hours: 1, score: 20 },
  HOURS_24: { max_hours: 24, score: 15 },
  DAYS_7: { max_hours: 168, score: 10 },
  DAYS_30: { max_hours: 720, score: 5 },
  OLDER: { max_hours: Infinity, score: 2 }
} as const;

// =============================================================================
// VTID-01115: Intent-Category Mapping (D21)
// =============================================================================

/**
 * Maps intents to relevant memory categories
 * Used for intent_match scoring
 */
const INTENT_CATEGORY_MAP: Record<RetrieveIntent, {
  primary: MemoryCategory[];
  secondary: MemoryCategory[];
}> = {
  health: {
    primary: ['health'],
    secondary: ['preferences', 'goals', 'personal']
  },
  longevity: {
    primary: ['health', 'goals'],
    secondary: ['preferences', 'personal', 'relationships']
  },
  community: {
    primary: ['community', 'relationships', 'events_meetups'],
    secondary: ['preferences', 'personal']
  },
  lifestyle: {
    primary: ['preferences', 'goals', 'personal'],
    secondary: ['health', 'relationships', 'conversation']
  },
  planner: {
    primary: ['tasks', 'goals', 'events_meetups'],
    secondary: ['preferences', 'personal']
  },
  general: {
    primary: ['personal', 'preferences', 'conversation'],
    secondary: ['goals', 'health', 'relationships', 'tasks']
  }
};

// =============================================================================
// VTID-01115: Domain-Category Mapping (D22)
// =============================================================================

/**
 * Maps domains to relevant memory categories
 * Used for domain_match scoring
 */
const DOMAIN_CATEGORY_MAP: Record<Domain, {
  primary: MemoryCategory[];
  secondary: MemoryCategory[];
}> = {
  health: {
    primary: ['health'],
    secondary: ['goals', 'preferences']
  },
  community: {
    primary: ['community', 'relationships', 'events_meetups'],
    secondary: ['preferences', 'conversation']
  },
  business: {
    primary: ['tasks', 'products_services'],
    secondary: ['goals', 'notes']
  },
  lifestyle: {
    primary: ['preferences', 'personal', 'goals'],
    secondary: ['health', 'relationships']
  }
};

// =============================================================================
// VTID-01115: Source Reliability Mapping
// =============================================================================

/**
 * Base confidence scores by source type
 * Higher = more reliable
 */
const SOURCE_CONFIDENCE_SCORES: Record<SourceType, number> = {
  orb_voice: 12,    // Direct speech - highest trust
  orb_text: 10,     // Direct text input
  diary: 8,         // User reflection
  upload: 6,        // User-provided data
  system: 4         // Auto-generated
};

// =============================================================================
// VTID-01115: Sensitivity Detection
// =============================================================================

/**
 * Keywords that trigger sensitivity flags
 */
const SENSITIVITY_KEYWORDS: Record<SensitivityFlag['type'], string[]> = {
  medical: [
    'diagnosis', 'medication', 'prescription', 'doctor', 'hospital',
    'surgery', 'symptoms', 'treatment', 'therapy', 'blood', 'test results',
    'cancer', 'disease', 'illness', 'pain', 'chronic', 'mental health',
    'anxiety', 'depression', 'medikament', 'arzt', 'krankenhaus'
  ],
  emotional: [
    'death', 'divorce', 'breakup', 'grief', 'trauma', 'abuse',
    'suicide', 'crisis', 'panic', 'fear', 'crying', 'devastated',
    'trauer', 'scheidung', 'trennung', 'tod'
  ],
  financial: [
    'salary', 'debt', 'loan', 'bankruptcy', 'tax', 'investment',
    'credit', 'mortgage', 'income', 'savings', 'bank account',
    'gehalt', 'schulden', 'kredit'
  ],
  relationship: [
    'affair', 'cheating', 'secret', 'confidential', 'private',
    'intimate', 'conflict', 'fight', 'argument',
    'affäre', 'geheimnis', 'streit'
  ],
  legal: [
    'lawsuit', 'attorney', 'court', 'police', 'arrest', 'criminal',
    'legal action', 'subpoena', 'testimony',
    'anwalt', 'gericht', 'polizei'
  ]
};

// =============================================================================
// VTID-01115: Core Scoring Functions
// =============================================================================

/**
 * Calculate intent match score (0-25)
 * Deterministic: category-based matching
 */
function calculateIntentMatch(
  memoryCategory: string,
  intent: RetrieveIntent
): number {
  const mapping = INTENT_CATEGORY_MAP[intent];

  if (mapping.primary.includes(memoryCategory as MemoryCategory)) {
    return FACTOR_MAX_WEIGHTS.intent_match; // Full 25 points
  }

  if (mapping.secondary.includes(memoryCategory as MemoryCategory)) {
    return Math.floor(FACTOR_MAX_WEIGHTS.intent_match * 0.6); // 15 points
  }

  return Math.floor(FACTOR_MAX_WEIGHTS.intent_match * 0.2); // 5 points for any memory
}

/**
 * Calculate domain match score (0-25)
 * Deterministic: category-based matching
 */
function calculateDomainMatch(
  memoryCategory: string,
  domain?: Domain
): number {
  // If no domain specified, give neutral score
  if (!domain) {
    return Math.floor(FACTOR_MAX_WEIGHTS.domain_match * 0.5); // 12-13 points
  }

  const mapping = DOMAIN_CATEGORY_MAP[domain];

  if (mapping.primary.includes(memoryCategory as MemoryCategory)) {
    return FACTOR_MAX_WEIGHTS.domain_match; // Full 25 points
  }

  if (mapping.secondary.includes(memoryCategory as MemoryCategory)) {
    return Math.floor(FACTOR_MAX_WEIGHTS.domain_match * 0.6); // 15 points
  }

  return Math.floor(FACTOR_MAX_WEIGHTS.domain_match * 0.2); // 5 points
}

/**
 * Calculate recency score (0-20)
 * Deterministic: time-based decay, NOT raw timestamp ranking
 */
function calculateRecency(
  occurredAt: string,
  currentTime: Date
): number {
  const memoryTime = new Date(occurredAt);
  const hoursDiff = (currentTime.getTime() - memoryTime.getTime()) / (1000 * 60 * 60);

  if (hoursDiff < RECENCY_DECAY.HOUR_1.max_hours) {
    return RECENCY_DECAY.HOUR_1.score;
  }
  if (hoursDiff < RECENCY_DECAY.HOURS_24.max_hours) {
    return RECENCY_DECAY.HOURS_24.score;
  }
  if (hoursDiff < RECENCY_DECAY.DAYS_7.max_hours) {
    return RECENCY_DECAY.DAYS_7.score;
  }
  if (hoursDiff < RECENCY_DECAY.DAYS_30.max_hours) {
    return RECENCY_DECAY.DAYS_30.score;
  }
  return RECENCY_DECAY.OLDER.score;
}

/**
 * Calculate confidence score (0-15)
 * Deterministic: source reliability + importance weighting
 */
function calculateConfidence(
  source: string,
  importance: number,
  category: string
): number {
  // Base score from source type
  const sourceScore = SOURCE_CONFIDENCE_SCORES[source as SourceType] || 4;

  // Importance boost (0-3 points based on importance 0-100)
  const importanceBoost = Math.min(3, Math.floor(importance / 33));

  // Category boost for personal/relationship memories
  let categoryBoost = 0;
  if (category === 'personal') {
    categoryBoost = 2;
  } else if (category === 'relationships') {
    categoryBoost = 1;
  }

  // Cap at max weight
  return Math.min(
    FACTOR_MAX_WEIGHTS.confidence,
    sourceScore + importanceBoost + categoryBoost
  );
}

/**
 * Calculate reinforcement score (0-10)
 * Deterministic: based on explicit user signals
 */
function calculateReinforcement(
  memoryId: string,
  signals?: UserReinforcementSignals
): number {
  if (!signals) {
    return 0;
  }

  let score = 0;

  // Pinned memories get full reinforcement
  if (signals.pinned_memory_ids?.includes(memoryId)) {
    score += 10;
  }

  // Reused memories get boost
  if (signals.reused_memory_ids?.includes(memoryId)) {
    score += 5;
  }

  // Corrected memories (user cared enough to fix)
  if (signals.corrected_memory_ids?.includes(memoryId)) {
    score += 3;
  }

  // Dismissed memories get penalty (negative reinforcement)
  if (signals.dismissed_memory_ids?.includes(memoryId)) {
    score -= 5;
  }

  // Cap at max weight (can go negative)
  return Math.max(-5, Math.min(FACTOR_MAX_WEIGHTS.reinforcement, score));
}

/**
 * Calculate role fit score (0-5)
 * Deterministic: role-based access compatibility
 */
function calculateRoleFit(
  category: string,
  role: UserRole,
  sensitivityFlags: SensitivityFlag[]
): number {
  // Patients have full access to their own data
  if (role === 'patient') {
    return FACTOR_MAX_WEIGHTS.role_fit;
  }

  // Medical/sensitive content requires elevated role
  const hasMedicalContent = sensitivityFlags.some(f => f.type === 'medical');
  const hasEmotionalContent = sensitivityFlags.some(f => f.type === 'emotional');

  if (hasMedicalContent || hasEmotionalContent) {
    // Professionals can access with reduced score
    if (role === 'professional') {
      return 3;
    }
    // Staff/admin have limited access
    if (role === 'staff' || role === 'admin') {
      return 1;
    }
    // Developers have no access to sensitive content
    if (role === 'developer') {
      return 0;
    }
  }

  // Non-sensitive content accessible to all roles
  return FACTOR_MAX_WEIGHTS.role_fit;
}

/**
 * Detect sensitivity flags in memory content
 * Deterministic: keyword-based detection
 */
export function detectSensitivityFlags(content: string): SensitivityFlag[] {
  const flags: SensitivityFlag[] = [];
  const lowerContent = content.toLowerCase();

  for (const [type, keywords] of Object.entries(SENSITIVITY_KEYWORDS)) {
    const detected: string[] = [];

    for (const keyword of keywords) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        detected.push(keyword);
      }
    }

    if (detected.length > 0) {
      flags.push({
        type: type as SensitivityFlag['type'],
        detected_keywords: detected,
        requires_elevated_threshold: type === 'medical' || type === 'emotional'
      });
    }
  }

  return flags;
}

// =============================================================================
// VTID-01115: Main Scoring Function
// =============================================================================

/**
 * Score a single memory item
 * Returns fully scored memory with all factors
 *
 * DETERMINISM GUARANTEE: Same inputs always produce same output
 */
export function scoreMemoryItem(
  memory: MemoryItem,
  context: ScoringContext
): ScoredMemoryItem {
  // Detect sensitivity flags first (needed for role_fit)
  const sensitivityFlags = detectSensitivityFlags(memory.content);

  // Calculate each factor
  const factors: RelevanceFactors = {
    intent_match: calculateIntentMatch(memory.category_key, context.intent),
    domain_match: calculateDomainMatch(memory.category_key, context.domain),
    recency: calculateRecency(memory.occurred_at, context.current_time),
    confidence: calculateConfidence(
      memory.source,
      memory.importance,
      memory.category_key
    ),
    reinforcement: calculateReinforcement(
      memory.id,
      context.user_reinforcement_signals
    ),
    role_fit: calculateRoleFit(
      memory.category_key,
      context.role,
      sensitivityFlags
    )
  };

  // Calculate total score (sum of all factors)
  const relevanceScore = Math.max(0, Math.min(100,
    factors.intent_match +
    factors.domain_match +
    factors.recency +
    factors.confidence +
    factors.reinforcement +
    factors.role_fit
  ));

  // Determine if memory should be excluded
  let exclusionReason: string | undefined;

  // Check role-based exclusion
  if (factors.role_fit === 0 && sensitivityFlags.length > 0) {
    exclusionReason = `Role '${context.role}' cannot access sensitive content`;
  }

  // Check threshold for sensitive memories
  const requiresElevatedThreshold = sensitivityFlags.some(f => f.requires_elevated_threshold);
  if (requiresElevatedThreshold && relevanceScore < SENSITIVE_MEMORY_THRESHOLD) {
    exclusionReason = `Sensitive memory below elevated threshold (${relevanceScore} < ${SENSITIVE_MEMORY_THRESHOLD})`;
  }

  // Check general exclusion threshold
  if (!exclusionReason && relevanceScore < SCORE_THRESHOLDS.exclude) {
    exclusionReason = `Below exclusion threshold (${relevanceScore} < ${SCORE_THRESHOLDS.exclude})`;
  }

  return {
    ...memory,
    relevance_score: relevanceScore,
    relevance_factors: factors,
    sensitivity_flags: sensitivityFlags,
    exclusion_reason: exclusionReason
  };
}

/**
 * Score and rank multiple memory items
 * Returns sorted list with excluded items separated
 *
 * DETERMINISM GUARANTEE: Same inputs always produce same ranking
 */
export function scoreAndRankMemories(
  memories: MemoryItem[],
  context: ScoringContext
): ScoredContextResult {
  const scoringRunId = `score_${context.tenant_id}_${Date.now()}`;
  const scoringTimestamp = context.current_time.toISOString();

  // Score all memories
  const scoredItems = memories.map(memory => scoreMemoryItem(memory, context));

  // Separate included vs excluded
  const included: ScoredMemoryItem[] = [];
  const excluded: ScoredMemoryItem[] = [];

  for (const item of scoredItems) {
    if (item.exclusion_reason) {
      excluded.push(item);
    } else {
      included.push(item);
    }
  }

  // Sort included items by relevance score (descending)
  // Deterministic tie-breaking: by memory ID (alphabetical)
  included.sort((a, b) => {
    if (a.relevance_score !== b.relevance_score) {
      return b.relevance_score - a.relevance_score;
    }
    // Tie-breaker: alphabetical by ID for determinism
    return a.id.localeCompare(b.id);
  });

  // Apply domain caps
  const capped = applyDomainCaps(included, context.domain);

  // Build metadata
  const metadata: ScoringMetadata = {
    scoring_run_id: scoringRunId,
    scoring_timestamp: scoringTimestamp,
    context: {
      intent: context.intent,
      domain: context.domain,
      role: context.role
    },
    total_candidates: memories.length,
    included_count: capped.filter(i => i.relevance_score >= SCORE_THRESHOLDS.include).length,
    deprioritized_count: capped.filter(i =>
      i.relevance_score >= SCORE_THRESHOLDS.exclude &&
      i.relevance_score < SCORE_THRESHOLDS.include
    ).length,
    excluded_count: excluded.length,
    top_n_with_factors: capped.slice(0, 10).map(item => ({
      memory_id: item.id,
      relevance_score: item.relevance_score,
      relevance_factors: item.relevance_factors
    })),
    exclusion_reasons: excluded.map(item => ({
      memory_id: item.id,
      reason: item.exclusion_reason || 'Unknown'
    }))
  };

  return {
    scored_items: capped,
    excluded_items: excluded,
    scoring_metadata: metadata
  };
}

/**
 * Apply domain caps to prevent any single domain from dominating
 */
function applyDomainCaps(
  items: ScoredMemoryItem[],
  activeDomain?: Domain
): ScoredMemoryItem[] {
  const domainCounts: Record<string, number> = {};
  const result: ScoredMemoryItem[] = [];

  for (const item of items) {
    // Map category to domain for capping
    const itemDomain = categoryToDomain(item.category_key);
    const cap = DOMAIN_CAPS[itemDomain] || DOMAIN_CAPS.general;

    // Initialize count
    if (!domainCounts[itemDomain]) {
      domainCounts[itemDomain] = 0;
    }

    // Check if under cap
    if (domainCounts[itemDomain] < cap) {
      result.push(item);
      domainCounts[itemDomain]++;
    } else {
      // Mark as deprioritized due to domain cap
      result.push({
        ...item,
        exclusion_reason: `Domain cap reached for ${itemDomain} (${cap} items)`
      });
    }
  }

  return result;
}

/**
 * Map memory category to domain
 */
function categoryToDomain(category: string): Domain | 'general' {
  const mapping: Record<string, Domain> = {
    health: 'health',
    community: 'community',
    relationships: 'community',
    events_meetups: 'community',
    tasks: 'business',
    products_services: 'business',
    preferences: 'lifestyle',
    goals: 'lifestyle',
    personal: 'lifestyle'
  };

  return mapping[category] || 'general';
}

// =============================================================================
// VTID-01115: Decision Functions
// =============================================================================

/**
 * Determine if a memory should be included based on score
 */
export function shouldIncludeMemory(
  scoredMemory: ScoredMemoryItem
): 'include' | 'deprioritize' | 'exclude' {
  if (scoredMemory.exclusion_reason) {
    return 'exclude';
  }

  if (scoredMemory.relevance_score >= SCORE_THRESHOLDS.include) {
    return 'include';
  }

  if (scoredMemory.relevance_score >= SCORE_THRESHOLDS.deprioritize) {
    return 'deprioritize';
  }

  return 'exclude';
}

/**
 * Get scoring decision for a memory item
 */
export function getScoringDecision(
  scoredMemory: ScoredMemoryItem
): ScoringDecision {
  return {
    memory_id: scoredMemory.id,
    relevance_score: scoredMemory.relevance_score,
    relevance_factors: scoredMemory.relevance_factors,
    decision: shouldIncludeMemory(scoredMemory),
    sensitivity_flags: scoredMemory.sensitivity_flags,
    exclusion_reason: scoredMemory.exclusion_reason
  };
}

// =============================================================================
// VTID-01115: Logging & Traceability
// =============================================================================

/**
 * Emit OASIS event for scoring decisions
 */
export async function emitScoringEvent(
  type: 'memory.scoring.completed' | 'memory.scoring.excluded' | 'memory.scoring.sensitive_flagged',
  metadata: ScoringMetadata,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01115',
      type: type as any,
      source: 'memory-relevance-scoring',
      status: 'success',
      message: `Memory scoring ${type.split('.').pop()}: ${metadata.included_count} included, ${metadata.excluded_count} excluded`,
      payload: {
        scoring_run_id: metadata.scoring_run_id,
        context: metadata.context,
        total_candidates: metadata.total_candidates,
        included_count: metadata.included_count,
        deprioritized_count: metadata.deprioritized_count,
        excluded_count: metadata.excluded_count,
        top_scores: metadata.top_n_with_factors.slice(0, 5).map(i => ({
          id: i.memory_id,
          score: i.relevance_score
        })),
        ...details
      }
    });
  } catch (err) {
    console.warn('[VTID-01115] Failed to emit scoring event:', err);
  }
}

/**
 * Log scoring run for debugging and traceability
 */
export function logScoringRun(
  metadata: ScoringMetadata,
  verbose: boolean = false
): void {
  console.log(`[VTID-01115] Scoring run ${metadata.scoring_run_id}:`);
  console.log(`  Intent: ${metadata.context.intent}, Domain: ${metadata.context.domain || 'none'}, Role: ${metadata.context.role}`);
  console.log(`  Candidates: ${metadata.total_candidates} -> Included: ${metadata.included_count}, Deprioritized: ${metadata.deprioritized_count}, Excluded: ${metadata.excluded_count}`);

  if (verbose && metadata.top_n_with_factors.length > 0) {
    console.log('  Top scores:');
    for (const item of metadata.top_n_with_factors.slice(0, 5)) {
      console.log(`    - ${item.memory_id}: ${item.relevance_score} (intent=${item.relevance_factors.intent_match}, domain=${item.relevance_factors.domain_match}, recency=${item.relevance_factors.recency})`);
    }
  }

  if (metadata.exclusion_reasons.length > 0) {
    console.log(`  Exclusions: ${metadata.exclusion_reasons.length}`);
    if (verbose) {
      for (const ex of metadata.exclusion_reasons.slice(0, 3)) {
        console.log(`    - ${ex.memory_id}: ${ex.reason}`);
      }
    }
  }
}

// =============================================================================
// VTID-01115: Exports
// =============================================================================

export default {
  // Core scoring
  scoreMemoryItem,
  scoreAndRankMemories,

  // Decision helpers
  shouldIncludeMemory,
  getScoringDecision,

  // Sensitivity detection
  detectSensitivityFlags,

  // Logging
  emitScoringEvent,
  logScoringRun,

  // Constants
  FACTOR_MAX_WEIGHTS,
  SCORE_THRESHOLDS,
  SENSITIVE_MEMORY_THRESHOLD,
  DOMAIN_CAPS,
  RECENCY_DECAY
};
