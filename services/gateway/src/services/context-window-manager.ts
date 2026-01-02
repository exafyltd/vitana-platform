/**
 * VTID-01117: Context Window Management & Saturation Control
 *
 * A deterministic Context Window Management Engine that ensures ORB operates
 * with a bounded, high-signal context—never overloaded, never under-informed.
 *
 * Position in Intelligence Stack:
 *   Memory Scoring (D23) → Confidence (D24) → D25 Context Window Control → Context Assembly (D20)
 *
 * Key Principles:
 * - More context ≠ better intelligence. Right-sized context = clarity.
 * - All exclusions must have reasons (no silent truncation)
 * - Same inputs → same outputs (deterministic)
 * - No dynamic context growth
 *
 * @see VTID-01106 (orb-memory-bridge.ts) for integration point
 * @see VTID-01100 for confidence thresholds
 */

import { MemoryItem } from './orb-memory-bridge';

// =============================================================================
// VTID-01117: Types & Interfaces
// =============================================================================

/**
 * Domain categories for context partitioning
 * Each domain has its own budget allocation
 */
export type ContextDomain =
  | 'personal'
  | 'relationships'
  | 'health'
  | 'goals'
  | 'preferences'
  | 'conversation'
  | 'tasks'
  | 'community'
  | 'events_meetups'
  | 'products_services'
  | 'notes';

/**
 * Memory type classification for budget allocation
 */
export type MemoryType = 'recent' | 'long_term' | 'pattern';

/**
 * Priority tiers for selection rules
 */
export type PriorityTier = 'critical' | 'relevant' | 'optional';

/**
 * Domain budget allocation configuration
 * All values are deterministic and configurable
 */
export interface DomainBudget {
  /** Maximum items from this domain */
  maxItems: number;
  /** Maximum characters from this domain */
  maxChars: number;
  /** Minimum relevance score (0-100) to include */
  minRelevanceScore: number;
  /** Minimum confidence threshold (0-100) from D24 */
  minConfidenceThreshold: number;
}

/**
 * Complete budget configuration for context window
 */
export interface ContextBudgetConfig {
  /** Total context budget in characters */
  totalBudgetChars: number;
  /** Total item limit across all domains */
  totalItemLimit: number;
  /** Per-domain budget allocations */
  domainBudgets: Record<ContextDomain, DomainBudget>;
  /** Memory type allocations (percentage of domain budget) */
  memoryTypeWeights: Record<MemoryType, number>;
  /** Saturation detection thresholds */
  saturationThresholds: SaturationThresholds;
}

/**
 * Thresholds for detecting context saturation
 */
export interface SaturationThresholds {
  /** Similarity threshold (0-1) for detecting redundancy */
  redundancySimilarity: number;
  /** Max items with same topic before triggering diversity preference */
  topicRepetitionLimit: number;
  /** Minimum diversity score (0-1) required in final context */
  minDiversityScore: number;
  /** Down-weight factor for similar items (0-1) */
  similarityDownWeight: number;
}

/**
 * Reason why an item was excluded from context
 */
export interface ExclusionReason {
  /** The excluded item ID */
  itemId: string;
  /** Category/domain of the item */
  domain: ContextDomain;
  /** Why this item was excluded */
  reason:
    | 'domain_cap_exceeded'
    | 'total_cap_exceeded'
    | 'below_relevance_threshold'
    | 'below_confidence_threshold'
    | 'redundant_content'
    | 'topic_saturation'
    | 'char_limit_exceeded'
    | 'sensitive_domain_protection';
  /** Human-readable explanation */
  explanation: string;
  /** Original relevance score if applicable */
  relevanceScore?: number;
  /** Original confidence score if applicable */
  confidenceScore?: number;
  /** Similarity score to included item if redundancy */
  similarityTo?: string;
}

/**
 * Result of context window selection process
 */
export interface ContextSelectionResult {
  /** Items selected for inclusion */
  includedItems: ContextItem[];
  /** Items excluded with reasons */
  excludedItems: ExclusionReason[];
  /** Metrics about the selection */
  metrics: ContextMetrics;
  /** Timestamp of selection */
  selectedAt: string;
  /** Whether selection was deterministic (always true) */
  deterministic: boolean;
}

/**
 * A memory item enhanced with context-relevant scores
 */
export interface ContextItem extends MemoryItem {
  /** Relevance score (0-100) from D23 memory scoring */
  relevanceScore: number;
  /** Confidence score (0-100) from D24 */
  confidenceScore: number;
  /** Computed priority tier */
  priorityTier: PriorityTier;
  /** Memory type classification */
  memoryType: MemoryType;
  /** Character count of content */
  charCount: number;
  /** Diversity contribution score (0-1) */
  diversityScore: number;
}

/**
 * Metrics for context selection logging and traceability
 */
export interface ContextMetrics {
  /** Total characters in context */
  totalChars: number;
  /** Total items included */
  totalItems: number;
  /** Per-domain breakdown */
  domainUsage: Record<ContextDomain, DomainMetrics>;
  /** Budget utilization percentage */
  budgetUtilization: number;
  /** Diversity score of final context (0-1) */
  diversityScore: number;
  /** Number of items excluded */
  excludedCount: number;
  /** Average relevance of included items */
  avgRelevanceScore: number;
  /** Average confidence of included items */
  avgConfidenceScore: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Per-domain metrics
 */
export interface DomainMetrics {
  /** Items included from this domain */
  itemCount: number;
  /** Characters used from this domain */
  charCount: number;
  /** Budget utilization for this domain */
  budgetUtilization: number;
  /** Items excluded from this domain */
  excludedCount: number;
}

/**
 * Context window log entry for traceability
 */
export interface ContextWindowLog {
  /** Unique log ID */
  logId: string;
  /** User ID for this context */
  userId: string;
  /** Tenant ID */
  tenantId: string;
  /** Session/turn identifier */
  turnId: string;
  /** Selection result */
  result: ContextSelectionResult;
  /** Timestamp */
  timestamp: string;
  /** Configuration used */
  configSnapshot: ContextBudgetConfig;
}

// =============================================================================
// VTID-01117: Default Configuration
// =============================================================================

/**
 * Default budget configuration
 * Tuned for optimal ORB performance with balanced domain representation
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  // Total context budget: 10000 chars (increased from 6000)
  // VTID-DEBUG-01: Need more space for personal identity + relationships
  totalBudgetChars: 10000,
  // Total item limit: 50 items max (increased from 30)
  totalItemLimit: 50,

  // Per-domain budgets with priority-based allocation
  domainBudgets: {
    // Critical domains (identity, relationships)
    // VTID-DEBUG-01: Increased limits - personal identity has MANY facets
    // (name, birthday, hometown, company, job, email, etc.)
    personal: {
      maxItems: 15,  // Was 5 - too aggressive, lost user identity
      maxChars: 2500,  // Was 1200
      minRelevanceScore: 10,  // Was 20 - personal info is always relevant
      minConfidenceThreshold: 0
    },
    relationships: {
      maxItems: 10,  // Was 4 - user may have many family members
      maxChars: 1500,  // Was 800
      minRelevanceScore: 15,  // Was 30
      minConfidenceThreshold: 0  // Was 20 - relationship info is critical
    },
    // High-priority domains
    health: {
      maxItems: 4,
      maxChars: 800,
      minRelevanceScore: 40,
      minConfidenceThreshold: 40
    },
    goals: {
      maxItems: 3,
      maxChars: 600,
      minRelevanceScore: 40,
      minConfidenceThreshold: 30
    },
    preferences: {
      maxItems: 4,
      maxChars: 600,
      minRelevanceScore: 35,
      minConfidenceThreshold: 30
    },
    // Standard domains
    conversation: {
      maxItems: 5,
      maxChars: 1000,
      minRelevanceScore: 30,
      minConfidenceThreshold: 20
    },
    tasks: {
      maxItems: 3,
      maxChars: 400,
      minRelevanceScore: 50,
      minConfidenceThreshold: 40
    },
    // Lower-priority domains
    community: {
      maxItems: 2,
      maxChars: 300,
      minRelevanceScore: 50,
      minConfidenceThreshold: 50
    },
    events_meetups: {
      maxItems: 2,
      maxChars: 300,
      minRelevanceScore: 50,
      minConfidenceThreshold: 50
    },
    products_services: {
      maxItems: 2,
      maxChars: 200,
      minRelevanceScore: 60,
      minConfidenceThreshold: 50
    },
    notes: {
      maxItems: 2,
      maxChars: 200,
      minRelevanceScore: 50,
      minConfidenceThreshold: 40
    }
  },

  // Memory type weights (must sum to 1.0)
  memoryTypeWeights: {
    recent: 0.5,    // 50% budget for recent memories
    long_term: 0.35, // 35% for long-term important memories
    pattern: 0.15    // 15% for behavioral patterns
  },

  // Saturation detection thresholds
  // VTID-DEBUG-01: Relaxed thresholds - was too aggressive
  saturationThresholds: {
    redundancySimilarity: 0.85,  // Was 0.75 - only filter near-duplicates
    topicRepetitionLimit: 8,     // Was 3 - too aggressive for personal info
    minDiversityScore: 0.3,      // Was 0.4
    similarityDownWeight: 0.7    // Was 0.5 - less aggressive down-weighting
  }
};

// =============================================================================
// VTID-01117: Confidence Bands (from D24)
// =============================================================================

/**
 * Confidence bands from VTID-01100 Memory Quality Metrics
 * Used for confidence threshold enforcement
 */
const CONFIDENCE_BANDS = {
  LOW: { min: 0, max: 39 },
  MEDIUM: { min: 40, max: 69 },
  HIGH: { min: 70, max: 85 },
  VERY_HIGH: { min: 86, max: 100 }
};

// =============================================================================
// VTID-01117: Utility Functions
// =============================================================================

/**
 * Generate a unique log ID for traceability
 */
function generateLogId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ctx-${timestamp}-${random}`;
}

/**
 * Classify memory item into a priority tier based on importance and domain
 */
function classifyPriorityTier(item: MemoryItem): PriorityTier {
  const domain = item.category_key as ContextDomain;
  const importance = item.importance || 0;

  // Critical tier: personal identity, high-importance relationships, explicit requests
  if (domain === 'personal' && importance >= 30) return 'critical';
  if (domain === 'relationships' && importance >= 50) return 'critical';
  if (importance >= 70) return 'critical';

  // Relevant tier: moderate importance, core domains
  if (importance >= 30) return 'relevant';
  if (['health', 'goals', 'preferences'].includes(domain) && importance >= 20) return 'relevant';

  // Optional tier: everything else
  return 'optional';
}

/**
 * Classify memory type based on age and characteristics
 */
function classifyMemoryType(item: MemoryItem): MemoryType {
  const now = new Date();
  const occurredAt = new Date(item.occurred_at);
  const ageHours = (now.getTime() - occurredAt.getTime()) / (1000 * 60 * 60);

  // Recent: less than 24 hours old
  if (ageHours < 24) return 'recent';

  // Pattern: items with behavioral keywords or preferences
  const contentLower = item.content.toLowerCase();
  if (/\b(always|never|usually|prefer|habit|routine)\b/i.test(contentLower)) {
    return 'pattern';
  }

  // Long-term: older than 24 hours
  return 'long_term';
}

/**
 * Calculate simple similarity between two strings using Jaccard index
 * Deterministic: same inputs → same output
 */
function calculateSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union;
}

/**
 * Calculate diversity score for a set of items
 * Higher score = more diverse content
 */
function calculateDiversityScore(items: ContextItem[]): number {
  if (items.length <= 1) return 1;

  let totalDissimilarity = 0;
  let comparisons = 0;

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const similarity = calculateSimilarity(items[i].content, items[j].content);
      totalDissimilarity += (1 - similarity);
      comparisons++;
    }
  }

  return comparisons > 0 ? totalDissimilarity / comparisons : 1;
}

/**
 * Extract primary topic/theme from content for saturation detection
 */
function extractTopic(content: string): string {
  const lower = content.toLowerCase();

  // Topic patterns ordered by specificity
  const topicPatterns: [RegExp, string][] = [
    [/\b(name|heiße?|heisse?|bin|called)\b/i, 'identity'],
    [/\b(wife|husband|partner|spouse|fiancée?|girlfriend|boyfriend)\b/i, 'spouse'],
    [/\b(mother|father|mom|dad|parent|mutter|vater)\b/i, 'parents'],
    [/\b(child|son|daughter|kid|kinder)\b/i, 'children'],
    [/\b(friend|freund)\b/i, 'friends'],
    [/\b(work|job|career|arbeit|beruf)\b/i, 'work'],
    [/\b(health|sick|pain|doctor|arzt|gesund)\b/i, 'health'],
    [/\b(goal|plan|want to|möchte|ziel)\b/i, 'goals'],
    [/\b(like|love|prefer|favorite|mag|liebe)\b/i, 'preferences'],
    [/\b(live|home|wohne|hometown)\b/i, 'location'],
  ];

  for (const [pattern, topic] of topicPatterns) {
    if (pattern.test(lower)) {
      return topic;
    }
  }

  return 'general';
}

// =============================================================================
// VTID-01117: Context Window Manager Class
// =============================================================================

/**
 * Context Window Manager
 *
 * The main engine for deterministic context selection and saturation control.
 * Ensures ORB operates with bounded, high-signal context.
 */
export class ContextWindowManager {
  private config: ContextBudgetConfig;
  private logs: ContextWindowLog[] = [];
  private static instance: ContextWindowManager | null = null;

  constructor(config: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET) {
    this.config = config;
  }

  /**
   * Get singleton instance with default config
   */
  static getInstance(): ContextWindowManager {
    if (!ContextWindowManager.instance) {
      ContextWindowManager.instance = new ContextWindowManager();
    }
    return ContextWindowManager.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance(): void {
    ContextWindowManager.instance = null;
  }

  /**
   * Main selection method: Select items for context window
   *
   * This is the primary interface for context selection.
   * Applies all rules deterministically and returns a traceable result.
   *
   * @param items - Raw memory items to select from
   * @param qualityScore - Overall memory quality score (0-100) from D24
   * @param turnId - Unique identifier for this turn (for logging)
   * @param userId - User ID for logging
   * @param tenantId - Tenant ID for logging
   */
  selectContext(
    items: MemoryItem[],
    qualityScore: number = 50,
    turnId: string = 'unknown',
    userId: string = 'unknown',
    tenantId: string = 'unknown'
  ): ContextSelectionResult {
    const startTime = Date.now();
    const selectedAt = new Date().toISOString();

    // Phase 1: Enhance items with scores and classifications
    const enhancedItems = this.enhanceItems(items, qualityScore);

    // Phase 2: Apply selection rules
    const { included, excluded } = this.applySelectionRules(enhancedItems);

    // Phase 3: Apply saturation detection and diversity enforcement
    const { finalIncluded, saturationExcluded } = this.applySaturationControl(included);

    // Combine all exclusions
    const allExcluded = [...excluded, ...saturationExcluded];

    // Calculate metrics
    const metrics = this.calculateMetrics(finalIncluded, allExcluded, startTime);

    const result: ContextSelectionResult = {
      includedItems: finalIncluded,
      excludedItems: allExcluded,
      metrics,
      selectedAt,
      deterministic: true
    };

    // Log for traceability
    this.logSelection(result, turnId, userId, tenantId);

    return result;
  }

  /**
   * Phase 1: Enhance memory items with computed scores
   */
  private enhanceItems(items: MemoryItem[], qualityScore: number): ContextItem[] {
    return items.map(item => {
      // Calculate relevance score based on importance and recency
      const relevanceScore = this.calculateRelevanceScore(item);

      // Use quality score as baseline confidence, adjusted by item characteristics
      const confidenceScore = this.calculateConfidenceScore(item, qualityScore);

      // Classify priority tier and memory type
      const priorityTier = classifyPriorityTier(item);
      const memoryType = classifyMemoryType(item);

      return {
        ...item,
        relevanceScore,
        confidenceScore,
        priorityTier,
        memoryType,
        charCount: item.content.length,
        diversityScore: 1 // Will be recalculated after selection
      };
    });
  }

  /**
   * Calculate relevance score for a memory item
   * Based on importance (D23) with time decay
   */
  private calculateRelevanceScore(item: MemoryItem): number {
    const baseScore = item.importance || 10;

    // Apply time decay: older items get reduced relevance
    const now = new Date();
    const occurredAt = new Date(item.occurred_at);
    const ageHours = (now.getTime() - occurredAt.getTime()) / (1000 * 60 * 60);

    // Decay factor: 1.0 for items < 1 hour, down to 0.5 for items > 168 hours (7 days)
    const decayFactor = Math.max(0.5, 1 - (ageHours / 336)); // 336 = 14 days for full decay

    // Domain boost for critical domains
    const domain = item.category_key as ContextDomain;
    let domainBoost = 1.0;
    if (domain === 'personal') domainBoost = 1.5;
    else if (domain === 'relationships') domainBoost = 1.3;
    else if (domain === 'health') domainBoost = 1.2;

    const relevance = Math.min(100, Math.round(baseScore * decayFactor * domainBoost));
    return relevance;
  }

  /**
   * Calculate confidence score for a memory item
   * Based on memory quality metrics (D24)
   */
  private calculateConfidenceScore(item: MemoryItem, qualityScore: number): number {
    // Start with the overall memory quality score
    let confidence = qualityScore;

    // Adjust based on item source
    const source = item.source;
    if (source === 'orb_text') confidence += 5;      // Direct text input is reliable
    if (source === 'orb_voice') confidence -= 5;    // Voice may have transcription errors
    if (source === 'system') confidence += 10;       // System-generated is highly reliable

    // Adjust based on importance (high-importance items were explicitly marked)
    if (item.importance >= 70) confidence += 10;
    else if (item.importance >= 50) confidence += 5;

    // Clamp to 0-100
    return Math.max(0, Math.min(100, confidence));
  }

  /**
   * Phase 2: Apply selection rules (budgets, thresholds, caps)
   */
  private applySelectionRules(
    items: ContextItem[]
  ): { included: ContextItem[]; excluded: ExclusionReason[] } {
    const included: ContextItem[] = [];
    const excluded: ExclusionReason[] = [];

    // Sort items by priority: critical > relevant > optional, then by relevance
    const sortedItems = [...items].sort((a, b) => {
      const tierOrder: Record<PriorityTier, number> = { critical: 0, relevant: 1, optional: 2 };
      const tierDiff = tierOrder[a.priorityTier] - tierOrder[b.priorityTier];
      if (tierDiff !== 0) return tierDiff;
      return b.relevanceScore - a.relevanceScore;
    });

    // Track per-domain usage
    const domainUsage: Record<string, { items: number; chars: number }> = {};
    let totalItems = 0;
    let totalChars = 0;

    for (const item of sortedItems) {
      const domain = item.category_key as ContextDomain;
      const budget = this.config.domainBudgets[domain] || this.config.domainBudgets.conversation;

      // Initialize domain tracking
      if (!domainUsage[domain]) {
        domainUsage[domain] = { items: 0, chars: 0 };
      }

      // Check 1: Relevance threshold
      if (item.relevanceScore < budget.minRelevanceScore) {
        excluded.push({
          itemId: item.id,
          domain,
          reason: 'below_relevance_threshold',
          explanation: `Relevance ${item.relevanceScore} < threshold ${budget.minRelevanceScore}`,
          relevanceScore: item.relevanceScore
        });
        continue;
      }

      // Check 2: Confidence threshold
      if (item.confidenceScore < budget.minConfidenceThreshold) {
        excluded.push({
          itemId: item.id,
          domain,
          reason: 'below_confidence_threshold',
          explanation: `Confidence ${item.confidenceScore} < threshold ${budget.minConfidenceThreshold}`,
          confidenceScore: item.confidenceScore
        });
        continue;
      }

      // Check 3: Domain item cap
      if (domainUsage[domain].items >= budget.maxItems) {
        excluded.push({
          itemId: item.id,
          domain,
          reason: 'domain_cap_exceeded',
          explanation: `Domain '${domain}' item cap (${budget.maxItems}) reached`,
          relevanceScore: item.relevanceScore
        });
        continue;
      }

      // Check 4: Domain char cap
      if (domainUsage[domain].chars + item.charCount > budget.maxChars) {
        excluded.push({
          itemId: item.id,
          domain,
          reason: 'char_limit_exceeded',
          explanation: `Domain '${domain}' char limit (${budget.maxChars}) would be exceeded`,
          relevanceScore: item.relevanceScore
        });
        continue;
      }

      // Check 5: Total item cap
      if (totalItems >= this.config.totalItemLimit) {
        excluded.push({
          itemId: item.id,
          domain,
          reason: 'total_cap_exceeded',
          explanation: `Total item limit (${this.config.totalItemLimit}) reached`,
          relevanceScore: item.relevanceScore
        });
        continue;
      }

      // Check 6: Total char cap
      if (totalChars + item.charCount > this.config.totalBudgetChars) {
        excluded.push({
          itemId: item.id,
          domain,
          reason: 'char_limit_exceeded',
          explanation: `Total char limit (${this.config.totalBudgetChars}) would be exceeded`,
          relevanceScore: item.relevanceScore
        });
        continue;
      }

      // Check 7: Sensitive domain protection (health flooding prevention)
      if (domain === 'health' && domainUsage[domain].items >= 3) {
        // If health items exceed 3 and they're not critical, limit further
        if (item.priorityTier !== 'critical') {
          excluded.push({
            itemId: item.id,
            domain,
            reason: 'sensitive_domain_protection',
            explanation: 'Health domain protected from flooding (non-critical item)',
            relevanceScore: item.relevanceScore
          });
          continue;
        }
      }

      // Item passes all checks - include it
      included.push(item);
      domainUsage[domain].items++;
      domainUsage[domain].chars += item.charCount;
      totalItems++;
      totalChars += item.charCount;
    }

    return { included, excluded };
  }

  /**
   * Phase 3: Apply saturation control (redundancy, diversity)
   */
  private applySaturationControl(
    items: ContextItem[]
  ): { finalIncluded: ContextItem[]; saturationExcluded: ExclusionReason[] } {
    const thresholds = this.config.saturationThresholds;
    const finalIncluded: ContextItem[] = [];
    const saturationExcluded: ExclusionReason[] = [];

    // Track topics for repetition detection
    const topicCounts: Record<string, number> = {};

    for (const item of items) {
      // Check 1: Redundancy detection
      let isRedundant = false;
      let redundantWith = '';

      for (const included of finalIncluded) {
        const similarity = calculateSimilarity(item.content, included.content);
        if (similarity >= thresholds.redundancySimilarity) {
          isRedundant = true;
          redundantWith = included.id;
          break;
        }
      }

      if (isRedundant) {
        saturationExcluded.push({
          itemId: item.id,
          domain: item.category_key as ContextDomain,
          reason: 'redundant_content',
          explanation: `Content ${Math.round(calculateSimilarity(item.content, finalIncluded.find(i => i.id === redundantWith)?.content || '') * 100)}% similar to included item`,
          similarityTo: redundantWith,
          relevanceScore: item.relevanceScore
        });
        continue;
      }

      // Check 2: Topic saturation
      // VTID-DEBUG-01: EXEMPT personal and relationships from topic saturation
      // These are fundamental identity facts that should NEVER be filtered
      const domain = item.category_key as ContextDomain;
      const isIdentityDomain = domain === 'personal' || domain === 'relationships';

      if (!isIdentityDomain) {
        const topic = extractTopic(item.content);
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;

        if (topicCounts[topic] > thresholds.topicRepetitionLimit) {
          saturationExcluded.push({
            itemId: item.id,
            domain,
            reason: 'topic_saturation',
            explanation: `Topic '${topic}' already has ${thresholds.topicRepetitionLimit} items (diminishing returns)`,
            relevanceScore: item.relevanceScore
          });
          continue;
        }
      }

      // Item passes saturation checks
      finalIncluded.push(item);
    }

    // Calculate final diversity scores for included items
    const diversityScore = calculateDiversityScore(finalIncluded);
    for (const item of finalIncluded) {
      item.diversityScore = diversityScore;
    }

    return { finalIncluded, saturationExcluded };
  }

  /**
   * Calculate metrics for the selection result
   */
  private calculateMetrics(
    included: ContextItem[],
    excluded: ExclusionReason[],
    startTime: number
  ): ContextMetrics {
    const endTime = Date.now();

    // Calculate totals
    const totalChars = included.reduce((sum, item) => sum + item.charCount, 0);
    const totalItems = included.length;

    // Calculate per-domain metrics
    const domainUsage: Record<ContextDomain, DomainMetrics> = {} as Record<ContextDomain, DomainMetrics>;
    const allDomains: ContextDomain[] = [
      'personal', 'relationships', 'health', 'goals', 'preferences',
      'conversation', 'tasks', 'community', 'events_meetups', 'products_services', 'notes'
    ];

    for (const domain of allDomains) {
      const domainItems = included.filter(i => i.category_key === domain);
      const domainExcluded = excluded.filter(e => e.domain === domain);
      const budget = this.config.domainBudgets[domain];

      const itemCount = domainItems.length;
      const charCount = domainItems.reduce((sum, i) => sum + i.charCount, 0);

      domainUsage[domain] = {
        itemCount,
        charCount,
        budgetUtilization: budget.maxItems > 0 ? (itemCount / budget.maxItems) : 0,
        excludedCount: domainExcluded.length
      };
    }

    // Calculate averages
    const avgRelevanceScore = included.length > 0
      ? included.reduce((sum, i) => sum + i.relevanceScore, 0) / included.length
      : 0;
    const avgConfidenceScore = included.length > 0
      ? included.reduce((sum, i) => sum + i.confidenceScore, 0) / included.length
      : 0;

    // Calculate diversity
    const diversityScore = calculateDiversityScore(included);

    return {
      totalChars,
      totalItems,
      domainUsage,
      budgetUtilization: this.config.totalBudgetChars > 0
        ? totalChars / this.config.totalBudgetChars
        : 0,
      diversityScore,
      excludedCount: excluded.length,
      avgRelevanceScore: Math.round(avgRelevanceScore * 100) / 100,
      avgConfidenceScore: Math.round(avgConfidenceScore * 100) / 100,
      processingTimeMs: endTime - startTime
    };
  }

  /**
   * Log selection for traceability (D59 explainability)
   */
  private logSelection(
    result: ContextSelectionResult,
    turnId: string,
    userId: string,
    tenantId: string
  ): void {
    const log: ContextWindowLog = {
      logId: generateLogId(),
      userId,
      tenantId,
      turnId,
      result,
      timestamp: result.selectedAt,
      configSnapshot: { ...this.config }
    };

    // Keep last 100 logs in memory (for debugging)
    this.logs.push(log);
    if (this.logs.length > 100) {
      this.logs.shift();
    }

    // Console logging for debugging
    console.log(
      `[VTID-01117] Context window selected: ${result.metrics.totalItems} items, ` +
      `${result.metrics.totalChars} chars, ${result.metrics.excludedCount} excluded, ` +
      `diversity=${(result.metrics.diversityScore * 100).toFixed(1)}%, ` +
      `${result.metrics.processingTimeMs}ms`
    );
  }

  /**
   * Get recent logs for debugging
   */
  getLogs(limit: number = 10): ContextWindowLog[] {
    return this.logs.slice(-limit);
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextBudgetConfig {
    return { ...this.config };
  }

  /**
   * Update configuration (for runtime tuning)
   */
  updateConfig(updates: Partial<ContextBudgetConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log('[VTID-01117] Context window config updated');
  }

  /**
   * Get a summary of exclusion reasons for explainability
   */
  getExclusionSummary(exclusions: ExclusionReason[]): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const exclusion of exclusions) {
      summary[exclusion.reason] = (summary[exclusion.reason] || 0) + 1;
    }
    return summary;
  }
}

// =============================================================================
// VTID-01117: Convenience Exports
// =============================================================================

/**
 * Get singleton context window manager
 */
export function getContextWindowManager(): ContextWindowManager {
  return ContextWindowManager.getInstance();
}

/**
 * Select context using the singleton manager
 * Convenience function for quick integration
 */
export function selectContextWindow(
  items: MemoryItem[],
  qualityScore: number = 50,
  turnId?: string,
  userId?: string,
  tenantId?: string
): ContextSelectionResult {
  return getContextWindowManager().selectContext(
    items,
    qualityScore,
    turnId || `turn-${Date.now()}`,
    userId || 'unknown',
    tenantId || 'unknown'
  );
}

// =============================================================================
// VTID-01117: Debug & Testing Utilities
// =============================================================================

/**
 * Format context selection result for debugging
 */
export function formatSelectionDebug(result: ContextSelectionResult): string {
  const lines: string[] = [];
  lines.push('=== Context Window Selection Result ===');
  lines.push(`Included: ${result.metrics.totalItems} items, ${result.metrics.totalChars} chars`);
  lines.push(`Excluded: ${result.metrics.excludedCount} items`);
  lines.push(`Diversity: ${(result.metrics.diversityScore * 100).toFixed(1)}%`);
  lines.push(`Budget Usage: ${(result.metrics.budgetUtilization * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Per-Domain Breakdown:');

  for (const [domain, metrics] of Object.entries(result.metrics.domainUsage)) {
    if (metrics.itemCount > 0 || metrics.excludedCount > 0) {
      lines.push(`  ${domain}: ${metrics.itemCount} items, ${metrics.charCount} chars (${metrics.excludedCount} excluded)`);
    }
  }

  if (result.excludedItems.length > 0) {
    lines.push('');
    lines.push('Exclusion Summary:');
    const summary = getContextWindowManager().getExclusionSummary(result.excludedItems);
    for (const [reason, count] of Object.entries(summary)) {
      lines.push(`  ${reason}: ${count}`);
    }
  }

  return lines.join('\n');
}
