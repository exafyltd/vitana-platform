/**
 * VTID-01114: Domain & Topic Routing Engine (D22)
 *
 * Deterministic routing engine that decides which intelligence domain(s)
 * must be activated for the current turn.
 *
 * Position in Intelligence Stack:
 * D20 Context -> D21 Intent -> D22 Domain Routing -> D23+ Intelligence
 *
 * Core Principles:
 * - Deterministic: same inputs -> same routing
 * - No probabilistic randomness
 * - Routing decisions are immutable per turn
 * - All decisions are auditable
 *
 * Hard Constraints:
 * - No intelligence may operate outside routed domains
 * - Health domain may not activate commerce directly
 * - System domain blocks autonomy by default
 * - Mixed domain requires explicit confidence > threshold
 */

import { createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  IntelligenceDomain,
  INTELLIGENCE_DOMAINS,
  DOMAIN_METADATA,
  DOMAIN_TOPIC_KEYWORDS,
  RoutingBundle,
  RoutingInput,
  RoutingTopic,
  RoutingConfig,
  DEFAULT_ROUTING_CONFIG,
  SafetyFlag,
  SafetyFlagType,
  SAFETY_TRIGGER_KEYWORDS,
  getDomainMetadata,
  domainAllowsCommerce,
  getDomainAutonomy
} from '../types/domain-routing';

// =============================================================================
// VTID-01114: Routing Engine Version
// =============================================================================

const ROUTING_VERSION = '1.0.0';

// =============================================================================
// VTID-01114: Determinism Helpers
// =============================================================================

/**
 * Generate a deterministic hash from routing inputs.
 * Used to ensure same inputs -> same routing.
 */
function generateInputHash(input: RoutingInput): string {
  const normalized = JSON.stringify({
    message: input.current_message.toLowerCase().trim(),
    role: input.active_role,
    context_keys: input.context.memory_items.map(m => m.category_key).sort(),
    intent_topics: input.intent.top_topics.map(t => t.topic_key).sort(),
    turn: input.session.turn_number
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Generate a determinism key for cache/verification.
 * This allows downstream systems to verify routing hasn't changed.
 */
function generateDeterminismKey(
  primaryDomain: IntelligenceDomain,
  secondaryDomains: IntelligenceDomain[],
  topicKeys: string[]
): string {
  const components = [
    primaryDomain,
    ...secondaryDomains.sort(),
    ...topicKeys.sort()
  ];
  return createHash('md5').update(components.join('|')).digest('hex').slice(0, 12);
}

// =============================================================================
// VTID-01114: Domain Detection
// =============================================================================

/**
 * Domain score accumulator for deterministic ranking
 */
interface DomainScore {
  domain: IntelligenceDomain;
  score: number;
  keyword_matches: number;
  context_matches: number;
  intent_matches: number;
}

/**
 * Detect domains from message content using keyword matching.
 * Pure deterministic logic - no AI/ML.
 */
function detectDomainsFromMessage(message: string): Map<IntelligenceDomain, number> {
  const scores = new Map<IntelligenceDomain, number>();
  const lowerMessage = message.toLowerCase();
  const words = lowerMessage.split(/\s+/);

  // Initialize all domains with 0
  for (const domain of INTELLIGENCE_DOMAINS) {
    if (domain !== 'mixed') {
      scores.set(domain, 0);
    }
  }

  // Score each domain based on keyword matches
  for (const [domain, topicKeywords] of Object.entries(DOMAIN_TOPIC_KEYWORDS)) {
    if (domain === 'mixed') continue;

    let domainScore = 0;
    for (const [_topic, keywords] of Object.entries(topicKeywords)) {
      for (const keyword of keywords) {
        // Exact word match (more precise)
        if (words.includes(keyword.toLowerCase())) {
          domainScore += 15;
        }
        // Substring match (less precise)
        else if (lowerMessage.includes(keyword.toLowerCase())) {
          domainScore += 8;
        }
      }
    }
    scores.set(domain as IntelligenceDomain, domainScore);
  }

  return scores;
}

/**
 * Detect domains from context bundle (D20).
 */
function detectDomainsFromContext(context: RoutingInput['context']): Map<IntelligenceDomain, number> {
  const scores = new Map<IntelligenceDomain, number>();

  // Initialize all domains with 0
  for (const domain of INTELLIGENCE_DOMAINS) {
    if (domain !== 'mixed') {
      scores.set(domain, 0);
    }
  }

  // Map memory categories to domains
  const categoryToDomain: Record<string, IntelligenceDomain> = {
    'personal': 'reflection',
    'conversation': 'reflection',
    'preferences': 'reflection',
    'goals': 'learning',
    'health': 'health',
    'relationships': 'relationships',
    'tasks': 'business',
    'products_services': 'commerce',
    'events_meetups': 'relationships',
    'notes': 'reflection',
    'community': 'relationships'
  };

  // Score based on memory items
  for (const item of context.memory_items) {
    const domain = categoryToDomain[item.category_key];
    if (domain) {
      // Weight by importance (1-100 scale)
      const weight = Math.min(item.importance / 10, 10);
      const current = scores.get(domain) || 0;
      scores.set(domain, current + weight);
    }
  }

  return scores;
}

/**
 * Detect domains from intent bundle (D21).
 */
function detectDomainsFromIntent(intent: RoutingInput['intent']): Map<IntelligenceDomain, number> {
  const scores = new Map<IntelligenceDomain, number>();

  // Initialize all domains with 0
  for (const domain of INTELLIGENCE_DOMAINS) {
    if (domain !== 'mixed') {
      scores.set(domain, 0);
    }
  }

  // Map topic keys to domains
  const topicToDomain: Record<string, IntelligenceDomain> = {
    'walking': 'health',
    'meditation': 'health',
    'nutrition': 'health',
    'sleep': 'health',
    'fitness': 'health',
    'mindfulness': 'health',
    'movement': 'health',
    'social': 'relationships',
    'community': 'relationships',
    'networking': 'relationships',
    'learning': 'learning',
    'skills': 'learning',
    'knowledge': 'learning',
    'work': 'business',
    'career': 'business',
    'productivity': 'business',
    'shopping': 'commerce',
    'products': 'commerce',
    'services': 'commerce'
  };

  // Score from top topics
  for (const topic of intent.top_topics) {
    const domain = topicToDomain[topic.topic_key];
    if (domain) {
      const weight = topic.score / 10;
      const current = scores.get(domain) || 0;
      scores.set(domain, current + weight);
    }
  }

  // Boost from weaknesses
  const weaknessToDomain: Record<string, IntelligenceDomain> = {
    'movement_low': 'health',
    'sleep_declining': 'health',
    'stress_high': 'health',
    'nutrition_low': 'health',
    'social_low': 'relationships'
  };

  for (const weakness of intent.weaknesses) {
    const domain = weaknessToDomain[weakness];
    if (domain) {
      const current = scores.get(domain) || 0;
      scores.set(domain, current + 10);
    }
  }

  return scores;
}

/**
 * Combine domain scores with deterministic weighting.
 */
function combineDomainScores(
  messageScores: Map<IntelligenceDomain, number>,
  contextScores: Map<IntelligenceDomain, number>,
  intentScores: Map<IntelligenceDomain, number>
): DomainScore[] {
  const combined: DomainScore[] = [];

  for (const domain of INTELLIGENCE_DOMAINS) {
    if (domain === 'mixed') continue;

    const messageScore = messageScores.get(domain) || 0;
    const contextScore = contextScores.get(domain) || 0;
    const intentScore = intentScores.get(domain) || 0;

    // Weighted combination: message (50%), context (25%), intent (25%)
    const totalScore = messageScore * 0.5 + contextScore * 0.25 + intentScore * 0.25;

    combined.push({
      domain,
      score: totalScore,
      keyword_matches: messageScore,
      context_matches: contextScore,
      intent_matches: intentScore
    });
  }

  // Sort by score (descending), then by domain name (for determinism)
  combined.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.domain.localeCompare(b.domain);
  });

  return combined;
}

// =============================================================================
// VTID-01114: Topic Extraction
// =============================================================================

/**
 * Extract and normalize topics from message within a domain.
 */
function extractTopicsFromMessage(
  message: string,
  domain: IntelligenceDomain
): RoutingTopic[] {
  const topics: RoutingTopic[] = [];
  const lowerMessage = message.toLowerCase();
  const words = lowerMessage.split(/\s+/);

  const domainKeywords = DOMAIN_TOPIC_KEYWORDS[domain] || {};

  for (const [topicKey, keywords] of Object.entries(domainKeywords)) {
    let matchCount = 0;

    for (const keyword of keywords) {
      if (words.includes(keyword.toLowerCase())) {
        matchCount += 2;
      } else if (lowerMessage.includes(keyword.toLowerCase())) {
        matchCount += 1;
      }
    }

    if (matchCount > 0) {
      // Calculate confidence based on match density
      const confidence = Math.min(matchCount * 15, 100);

      topics.push({
        topic_key: topicKey,
        display_name: formatTopicDisplayName(topicKey),
        domain,
        confidence,
        source: 'keyword',
        is_sensitive: isSensitiveTopic(topicKey, domain)
      });
    }
  }

  return topics;
}

/**
 * Extract topics from context bundle.
 */
function extractTopicsFromContext(
  context: RoutingInput['context'],
  domain: IntelligenceDomain
): RoutingTopic[] {
  const topics: RoutingTopic[] = [];

  // Extract topics from formatted context
  const domainKeywords = DOMAIN_TOPIC_KEYWORDS[domain] || {};
  const lowerContext = context.formatted_context.toLowerCase();

  for (const [topicKey, keywords] of Object.entries(domainKeywords)) {
    let matchCount = 0;

    for (const keyword of keywords) {
      if (lowerContext.includes(keyword.toLowerCase())) {
        matchCount += 1;
      }
    }

    if (matchCount >= 2) {
      topics.push({
        topic_key: topicKey,
        display_name: formatTopicDisplayName(topicKey),
        domain,
        confidence: Math.min(matchCount * 10, 80),
        source: 'context',
        is_sensitive: isSensitiveTopic(topicKey, domain)
      });
    }
  }

  return topics;
}

/**
 * Extract topics from intent bundle.
 */
function extractTopicsFromIntent(
  intent: RoutingInput['intent'],
  domain: IntelligenceDomain
): RoutingTopic[] {
  const topics: RoutingTopic[] = [];

  // Map intent topics to domain topics
  for (const intentTopic of intent.top_topics) {
    const domainKeywords = DOMAIN_TOPIC_KEYWORDS[domain] || {};

    for (const topicKey of Object.keys(domainKeywords)) {
      if (intentTopic.topic_key.includes(topicKey) || topicKey.includes(intentTopic.topic_key)) {
        topics.push({
          topic_key: topicKey,
          display_name: formatTopicDisplayName(topicKey),
          domain,
          confidence: intentTopic.score,
          source: 'intent',
          is_sensitive: isSensitiveTopic(topicKey, domain)
        });
      }
    }
  }

  return topics;
}

/**
 * Merge and deduplicate topics, keeping highest confidence.
 */
function mergeTopics(topicArrays: RoutingTopic[][]): RoutingTopic[] {
  const topicMap = new Map<string, RoutingTopic>();

  for (const topics of topicArrays) {
    for (const topic of topics) {
      const key = `${topic.domain}:${topic.topic_key}`;
      const existing = topicMap.get(key);

      if (!existing || topic.confidence > existing.confidence) {
        topicMap.set(key, topic);
      }
    }
  }

  // Sort by confidence (descending), then by topic_key (for determinism)
  return Array.from(topicMap.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.topic_key.localeCompare(b.topic_key);
  });
}

/**
 * Format topic key as display name
 */
function formatTopicDisplayName(topicKey: string): string {
  return topicKey
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Check if a topic is sensitive
 */
function isSensitiveTopic(topicKey: string, domain: IntelligenceDomain): boolean {
  const sensitiveTopics = ['medication', 'symptoms', 'mental_health', 'biomarkers'];
  const sensitiveDomains: IntelligenceDomain[] = ['health', 'commerce', 'system'];

  return sensitiveTopics.includes(topicKey) || sensitiveDomains.includes(domain);
}

// =============================================================================
// VTID-01114: Safety Detection
// =============================================================================

/**
 * Detect safety flags from message and topics.
 */
function detectSafetyFlags(
  message: string,
  topics: RoutingTopic[],
  primaryDomain: IntelligenceDomain
): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  const lowerMessage = message.toLowerCase();

  // Check each safety trigger category
  for (const [flagType, keywords] of Object.entries(SAFETY_TRIGGER_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        const severity = getSafetySeverity(flagType as SafetyFlagType);
        flags.push({
          type: flagType as SafetyFlagType,
          triggered_by: `keyword:${keyword}`,
          severity,
          requires_human_review: severity === 'critical' || severity === 'high',
          message: getSafetyMessage(flagType as SafetyFlagType)
        });
        break; // One flag per type
      }
    }
  }

  // Check domain-specific safety flags
  const domainMeta = getDomainMetadata(primaryDomain);
  if (domainMeta.triggers_medical_safety) {
    const hasMedicalTopic = topics.some(t =>
      ['medication', 'symptoms', 'biomarkers', 'mental_health'].includes(t.topic_key)
    );
    if (hasMedicalTopic && !flags.some(f => f.type === 'medical_advice')) {
      flags.push({
        type: 'medical_advice',
        triggered_by: `domain:${primaryDomain}`,
        severity: 'medium',
        requires_human_review: false,
        message: getSafetyMessage('medical_advice')
      });
    }
  }

  if (domainMeta.triggers_financial_safety) {
    const hasFinancialTopic = topics.some(t =>
      ['pricing', 'transactions', 'products', 'services'].includes(t.topic_key)
    );
    if (hasFinancialTopic && !flags.some(f => f.type === 'financial_advice')) {
      flags.push({
        type: 'financial_advice',
        triggered_by: `domain:${primaryDomain}`,
        severity: 'low',
        requires_human_review: false,
        message: getSafetyMessage('financial_advice')
      });
    }
  }

  return flags;
}

/**
 * Get severity for safety flag type
 */
function getSafetySeverity(flagType: SafetyFlagType): 'low' | 'medium' | 'high' | 'critical' {
  const severityMap: Record<SafetyFlagType, 'low' | 'medium' | 'high' | 'critical'> = {
    medical_advice: 'medium',
    medical_emergency: 'critical',
    financial_advice: 'low',
    financial_transaction: 'medium',
    personal_crisis: 'critical',
    legal_advice: 'medium',
    minor_involved: 'high',
    sensitive_content: 'medium'
  };
  return severityMap[flagType];
}

/**
 * Get message for safety flag type
 */
function getSafetyMessage(flagType: SafetyFlagType): string {
  const messages: Record<SafetyFlagType, string> = {
    medical_advice: 'Medical topics detected. Responses should not provide medical advice.',
    medical_emergency: 'EMERGENCY: Immediate human intervention may be required.',
    financial_advice: 'Financial topics detected. Responses should not provide investment advice.',
    financial_transaction: 'Financial transaction detected. Additional verification may be required.',
    personal_crisis: 'CRISIS: Potential personal safety concern detected.',
    legal_advice: 'Legal topics detected. Responses should not provide legal advice.',
    minor_involved: 'Minor involvement detected. Enhanced safety protocols apply.',
    sensitive_content: 'Sensitive content detected. Response filtering may be applied.'
  };
  return messages[flagType];
}

// =============================================================================
// VTID-01114: Hard Constraints
// =============================================================================

/**
 * Apply hard constraints to routing decisions.
 */
function applyHardConstraints(
  primaryDomain: IntelligenceDomain,
  secondaryDomains: IntelligenceDomain[],
  topics: RoutingTopic[]
): {
  primaryDomain: IntelligenceDomain;
  secondaryDomains: IntelligenceDomain[];
  excludedDomains: IntelligenceDomain[];
  allowsCommerce: boolean;
  autonomyLevel: number;
} {
  const excludedDomains: IntelligenceDomain[] = [];
  let allowsCommerce = domainAllowsCommerce(primaryDomain);
  let autonomyLevel = getDomainAutonomy(primaryDomain);

  // Hard Constraint 1: Health domain may not activate commerce directly
  if (primaryDomain === 'health') {
    if (secondaryDomains.includes('commerce')) {
      secondaryDomains = secondaryDomains.filter(d => d !== 'commerce');
      excludedDomains.push('commerce');
    }
    allowsCommerce = false;
  }

  // Hard Constraint 2: System domain blocks autonomy by default
  if (primaryDomain === 'system') {
    autonomyLevel = Math.min(autonomyLevel, 20);
  }

  // Hard Constraint 3: If any critical safety flag exists, reduce autonomy
  // (This is applied in the main routing function)

  // Filter out excluded domains from secondary
  const filteredSecondary = secondaryDomains.filter(d => !excludedDomains.includes(d));

  return {
    primaryDomain,
    secondaryDomains: filteredSecondary,
    excludedDomains,
    allowsCommerce,
    autonomyLevel
  };
}

// =============================================================================
// VTID-01114: Main Routing Function
// =============================================================================

/**
 * Compute routing bundle from input.
 * This is the main entry point for the routing engine.
 *
 * Determinism guarantee: same inputs -> same outputs
 */
export function computeRoutingBundle(
  input: RoutingInput,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG
): RoutingBundle {
  const computedAt = new Date().toISOString();
  const inputHash = generateInputHash(input);

  // Step 1: Detect domains from all sources
  const messageScores = detectDomainsFromMessage(input.current_message);
  const contextScores = detectDomainsFromContext(input.context);
  const intentScores = detectDomainsFromIntent(input.intent);

  // Step 2: Combine scores deterministically
  const combinedScores = combineDomainScores(messageScores, contextScores, intentScores);

  // Step 3: Select primary domain (highest scoring above threshold)
  let primaryDomain: IntelligenceDomain = 'reflection'; // Default fallback
  let primaryScore = 0;

  for (const score of combinedScores) {
    if (score.score >= config.domain_confidence_threshold) {
      primaryDomain = score.domain;
      primaryScore = score.score;
      break;
    }
  }

  // Step 4: Check for mixed domain
  const qualifyingDomains = combinedScores.filter(
    s => s.score >= config.domain_confidence_threshold
  );

  if (qualifyingDomains.length > 2 && primaryScore >= config.mixed_domain_threshold) {
    // Multiple strong domains -> consider mixed
    const secondHighest = qualifyingDomains[1]?.score || 0;
    if (secondHighest / primaryScore > 0.7) {
      // Second domain is close to primary -> use mixed
      primaryDomain = 'mixed';
    }
  }

  // Step 5: Select secondary domains
  let secondaryDomains = combinedScores
    .filter(s => s.domain !== primaryDomain && s.score >= config.domain_confidence_threshold * 0.6)
    .slice(0, config.max_secondary_domains)
    .map(s => s.domain);

  // Step 6: Extract topics for primary and secondary domains
  const allDomains = [primaryDomain, ...secondaryDomains].filter(d => d !== 'mixed');
  const topicArrays: RoutingTopic[][] = [];

  for (const domain of allDomains) {
    topicArrays.push(extractTopicsFromMessage(input.current_message, domain));
    topicArrays.push(extractTopicsFromContext(input.context, domain));
    topicArrays.push(extractTopicsFromIntent(input.intent, domain));
  }

  let activeTopics = mergeTopics(topicArrays)
    .filter(t => t.confidence >= config.topic_confidence_threshold)
    .slice(0, config.max_active_topics);

  // Step 7: Detect safety flags
  const safetyFlags = detectSafetyFlags(input.current_message, activeTopics, primaryDomain);

  // Step 8: Apply hard constraints
  const constraints = applyHardConstraints(primaryDomain, secondaryDomains, activeTopics);
  primaryDomain = constraints.primaryDomain;
  secondaryDomains = constraints.secondaryDomains;

  // Step 9: Adjust autonomy based on safety flags
  let autonomyLevel = constraints.autonomyLevel;
  const hasCriticalFlag = safetyFlags.some(f => f.severity === 'critical');
  const hasHighFlag = safetyFlags.some(f => f.severity === 'high');

  if (hasCriticalFlag) {
    autonomyLevel = Math.min(autonomyLevel, 10);
  } else if (hasHighFlag) {
    autonomyLevel = Math.min(autonomyLevel, 30);
  }

  // Step 10: Calculate routing confidence
  const routingConfidence = Math.min(
    Math.round(primaryScore * (1 - safetyFlags.length * 0.1)),
    100
  );

  // Step 11: Generate determinism key
  const topicKeys = activeTopics.map(t => t.topic_key);
  const determinismKey = generateDeterminismKey(primaryDomain, secondaryDomains, topicKeys);

  // Step 12: Build routing bundle
  const routingBundle: RoutingBundle = {
    primary_domain: primaryDomain,
    secondary_domains: secondaryDomains,
    active_topics: activeTopics,
    excluded_domains: constraints.excludedDomains,
    routing_confidence: routingConfidence,
    safety_flags: safetyFlags,
    autonomy_level: autonomyLevel,
    allows_commerce: constraints.allowsCommerce,
    metadata: {
      routing_version: ROUTING_VERSION,
      computed_at: computedAt,
      input_hash: inputHash,
      determinism_key: determinismKey
    }
  };

  return routingBundle;
}

// =============================================================================
// VTID-01114: Convenience Functions
// =============================================================================

/**
 * Quick routing from just a message (for simple cases).
 * Uses minimal context/intent.
 */
export function quickRoute(
  message: string,
  userId: string = 'anonymous',
  role: 'patient' | 'professional' | 'admin' | 'developer' = 'patient'
): RoutingBundle {
  const input: RoutingInput = {
    context: {
      user_id: userId,
      tenant_id: 'default',
      memory_items: [],
      formatted_context: ''
    },
    intent: {
      top_topics: [],
      weaknesses: [],
      recommended_actions: []
    },
    current_message: message,
    active_role: role,
    session: {
      session_id: 'quick-route',
      turn_number: 1
    }
  };

  return computeRoutingBundle(input);
}

/**
 * Check if a routing bundle allows a specific operation.
 */
export function routingAllows(bundle: RoutingBundle, operation: string): boolean {
  switch (operation) {
    case 'commerce':
      return bundle.allows_commerce;
    case 'autonomous_action':
      return bundle.autonomy_level >= 50;
    case 'sensitive_response':
      return !bundle.safety_flags.some(f => f.severity === 'critical' || f.severity === 'high');
    default:
      return true;
  }
}

/**
 * Get a summary of routing decision for logging.
 */
export function getRoutingSummary(bundle: RoutingBundle): string {
  const topics = bundle.active_topics.map(t => t.topic_key).join(', ') || 'none';
  const flags = bundle.safety_flags.map(f => f.type).join(', ') || 'none';

  return `[D22] ${bundle.primary_domain} (${bundle.routing_confidence}%) | topics: ${topics} | safety: ${flags} | autonomy: ${bundle.autonomy_level}`;
}

// =============================================================================
// VTID-01114: OASIS Event Emission
// =============================================================================

/**
 * Emit routing decision to OASIS for audit (D59 compliance).
 */
export async function emitRoutingEvent(
  bundle: RoutingBundle,
  userId: string,
  tenantId: string,
  sessionId: string
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01114',
      type: 'orb.routing.computed' as any,
      source: 'domain-routing-service',
      status: 'success',
      message: getRoutingSummary(bundle),
      payload: {
        user_id: userId,
        tenant_id: tenantId,
        session_id: sessionId,
        primary_domain: bundle.primary_domain,
        secondary_domains: bundle.secondary_domains,
        topic_count: bundle.active_topics.length,
        safety_flag_count: bundle.safety_flags.length,
        routing_confidence: bundle.routing_confidence,
        autonomy_level: bundle.autonomy_level,
        allows_commerce: bundle.allows_commerce,
        determinism_key: bundle.metadata.determinism_key
      }
    });
  } catch (err) {
    console.warn('[VTID-01114] Failed to emit routing event:', err);
  }
}

// =============================================================================
// VTID-01114: Debug/Audit Helpers
// =============================================================================

/**
 * Debug snapshot of routing decision.
 */
export interface RoutingDebugSnapshot {
  ok: boolean;
  version: string;
  input_summary: {
    message_length: number;
    context_items: number;
    intent_topics: number;
    role: string;
  };
  domain_scores: Array<{ domain: string; score: number }>;
  routing_bundle: RoutingBundle;
  timestamp: string;
}

/**
 * Get debug snapshot of routing decision.
 */
export function getRoutingDebugSnapshot(
  input: RoutingInput,
  bundle: RoutingBundle
): RoutingDebugSnapshot {
  // Recalculate scores for debug output
  const messageScores = detectDomainsFromMessage(input.current_message);
  const contextScores = detectDomainsFromContext(input.context);
  const intentScores = detectDomainsFromIntent(input.intent);
  const combinedScores = combineDomainScores(messageScores, contextScores, intentScores);

  return {
    ok: true,
    version: ROUTING_VERSION,
    input_summary: {
      message_length: input.current_message.length,
      context_items: input.context.memory_items.length,
      intent_topics: input.intent.top_topics.length,
      role: input.active_role
    },
    domain_scores: combinedScores.map(s => ({
      domain: s.domain,
      score: Math.round(s.score * 100) / 100
    })),
    routing_bundle: bundle,
    timestamp: new Date().toISOString()
  };
}

// =============================================================================
// VTID-01114: Exports
// =============================================================================

export {
  ROUTING_VERSION,
  generateInputHash,
  generateDeterminismKey,
  detectDomainsFromMessage,
  detectDomainsFromContext,
  detectDomainsFromIntent,
  extractTopicsFromMessage,
  detectSafetyFlags,
  applyHardConstraints
};

export default {
  computeRoutingBundle,
  quickRoute,
  routingAllows,
  getRoutingSummary,
  emitRoutingEvent,
  getRoutingDebugSnapshot,
  ROUTING_VERSION
};
