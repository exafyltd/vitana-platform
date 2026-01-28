/**
 * VTID-01216: Retrieval Router (D2)
 *
 * Single router that decides per turn which sources to query:
 * 1. Memory Garden (D1-D63) - Personal/historical questions
 * 2. Knowledge Hub - Vitana system questions
 * 3. Web Search - External/time-sensitive questions
 *
 * Routing rules:
 * - Vitana system questions → Knowledge Hub first
 * - Personal/historical questions → Memory Garden first
 * - External/time sensitive → Web Search
 * - Mixed queries allowed
 *
 * The router is deterministic and all decisions are logged.
 */

import { randomUUID, createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  RetrievalSource,
  RetrievalRouterDecision,
  ConversationChannel,
} from '../types/conversation';

// =============================================================================
// Configuration
// =============================================================================

export const RETRIEVAL_CONFIG = {
  /** Default limits per source */
  DEFAULT_LIMITS: {
    memory_garden: 12,
    knowledge_hub: 8,
    web_search: 6,
  } as Record<RetrievalSource, number>,

  /** Minimum limits per source */
  MIN_LIMITS: {
    memory_garden: 5,
    knowledge_hub: 0,
    web_search: 0,
  } as Record<RetrievalSource, number>,

  /** Maximum limits per source */
  MAX_LIMITS: {
    memory_garden: 20,
    knowledge_hub: 15,
    web_search: 10,
  } as Record<RetrievalSource, number>,
};

// =============================================================================
// Routing Rules
// =============================================================================

interface RoutingRule {
  name: string;
  priority: number;
  /** Patterns that trigger this rule */
  patterns: RegExp[];
  /** Keywords that trigger this rule (case-insensitive) */
  keywords: string[];
  /** Primary source to query first */
  primary_source: RetrievalSource;
  /** Secondary sources to query */
  secondary_sources: RetrievalSource[];
  /** Rationale for this routing */
  rationale: string;
}

/**
 * Ordered routing rules (evaluated by priority DESC)
 */
const ROUTING_RULES: RoutingRule[] = [
  // ===== Vitana System Questions → Knowledge Hub First =====
  {
    name: 'vitana_system',
    priority: 100,
    patterns: [
      /what is (the )?vitana/i,
      /how does (the )?(vitana|oasis|autopilot|command hub)/i,
      /explain (the )?(vitana|oasis|autopilot|command hub|gateway|governance)/i,
      /what are (the )?(tenants|maxina|alkalma|earthlings)/i,
      /vtid[\s-]?\d+/i,
    ],
    keywords: [
      'vitana', 'oasis', 'autopilot', 'command hub', 'commandhub',
      'vtid', 'governance', 'planner', 'worker', 'validator',
      'gateway', 'ledger', 'maxina', 'alkalma', 'earthlings',
      'spec', 'specification', 'architecture', 'index'
    ],
    primary_source: 'knowledge_hub',
    secondary_sources: ['memory_garden'],
    rationale: 'Vitana system questions prioritize Knowledge Hub for accurate documentation',
  },

  // ===== Personal/Historical Questions → Memory Garden First =====
  {
    name: 'personal_history',
    priority: 90,
    patterns: [
      /my (name|birthday|family|wife|husband|partner|child|children|kid|kids)/i,
      /(remember|recall|told you|mentioned|said) (about )?(my|i)/i,
      /what (do you|did i) (know|tell|say|mention) about/i,
      /who (is|are) my/i,
      /when did (i|we)/i,
      /last time (i|we)/i,
      /my (preference|goal|habit|routine|schedule)/i,
    ],
    keywords: [
      'remember', 'recall', 'my name', 'my family', 'my wife', 'my husband',
      'my partner', 'my children', 'my birthday', 'told you', 'mentioned',
      'last time', 'previously', 'before', 'my preference', 'my goal',
      'my habit', 'my routine', 'my schedule', 'personal'
    ],
    primary_source: 'memory_garden',
    secondary_sources: ['knowledge_hub'],
    rationale: 'Personal and historical questions prioritize Memory Garden for user context',
  },

  // ===== Health Questions → Memory Garden First (for user's health data) =====
  {
    name: 'health_personal',
    priority: 85,
    patterns: [
      /my (health|blood pressure|weight|sleep|exercise|diet|medication)/i,
      /how (am i|have i been) (doing|feeling)/i,
      /my (symptoms|condition|diagnosis|treatment)/i,
    ],
    keywords: [
      'my health', 'my blood pressure', 'my weight', 'my sleep',
      'my exercise', 'my diet', 'my medication', 'my symptoms',
      'how am i', 'my condition', 'my diagnosis'
    ],
    primary_source: 'memory_garden',
    secondary_sources: ['knowledge_hub', 'web_search'],
    rationale: 'Personal health questions prioritize Memory Garden for user health data',
  },

  // ===== External/Current Events → Web Search First =====
  {
    name: 'external_current',
    priority: 80,
    patterns: [
      /what is happening in/i,
      /latest news (about|on|regarding)/i,
      /current (price|weather|stock|market)/i,
      /(today|this week|this month)'s/i,
      /what time is it in/i,
      /convert \d+ (usd|eur|gbp|jpy)/i,
    ],
    keywords: [
      'news', 'latest', 'current', 'today', 'weather', 'stock price',
      'market', 'breaking', 'happening now', 'live', 'real-time',
      'exchange rate', 'convert'
    ],
    primary_source: 'web_search',
    secondary_sources: ['knowledge_hub', 'memory_garden'],
    rationale: 'External and time-sensitive questions prioritize web search for current data',
  },

  // ===== General Knowledge → Knowledge Hub + Memory =====
  {
    name: 'general_knowledge',
    priority: 50,
    patterns: [
      /what is (a |an )?[a-z]+$/i,
      /how (do|does|to) [a-z]+/i,
      /explain [a-z]+/i,
      /define [a-z]+/i,
    ],
    keywords: [
      'what is', 'how to', 'explain', 'define', 'describe',
      'tell me about', 'learn about'
    ],
    primary_source: 'knowledge_hub',
    secondary_sources: ['memory_garden', 'web_search'],
    rationale: 'General knowledge questions check Knowledge Hub first, then context',
  },

  // ===== Default: Memory + Knowledge =====
  {
    name: 'default',
    priority: 0,
    patterns: [],
    keywords: [],
    primary_source: 'memory_garden',
    secondary_sources: ['knowledge_hub'],
    rationale: 'Default routing prioritizes memory context with knowledge fallback',
  },
];

// =============================================================================
// Router Implementation
// =============================================================================

/**
 * Compute router decision for a given query
 */
export function computeRetrievalRouterDecision(
  query: string,
  options?: {
    channel?: ConversationChannel;
    force_sources?: RetrievalSource[];
    limit_overrides?: Partial<Record<RetrievalSource, number>>;
  }
): RetrievalRouterDecision {
  const startTime = Date.now();
  const normalizedQuery = query.toLowerCase().trim();

  // Find matching rule (highest priority wins)
  let matchedRule: RoutingRule = ROUTING_RULES[ROUTING_RULES.length - 1]; // default

  for (const rule of ROUTING_RULES.sort((a, b) => b.priority - a.priority)) {
    // Check patterns
    const patternMatch = rule.patterns.some(p => p.test(normalizedQuery));
    if (patternMatch) {
      matchedRule = rule;
      break;
    }

    // Check keywords
    const keywordMatch = rule.keywords.some(k => normalizedQuery.includes(k.toLowerCase()));
    if (keywordMatch) {
      matchedRule = rule;
      break;
    }
  }

  // Build sources to query
  let sourcesToQuery: RetrievalSource[];
  if (options?.force_sources?.length) {
    sourcesToQuery = options.force_sources;
  } else {
    sourcesToQuery = [matchedRule.primary_source, ...matchedRule.secondary_sources];
    // Dedupe while preserving order
    sourcesToQuery = [...new Set(sourcesToQuery)];
  }

  // Compute limits
  const limits: Record<RetrievalSource, number> = {
    memory_garden: options?.limit_overrides?.memory_garden ?? RETRIEVAL_CONFIG.DEFAULT_LIMITS.memory_garden,
    knowledge_hub: options?.limit_overrides?.knowledge_hub ?? RETRIEVAL_CONFIG.DEFAULT_LIMITS.knowledge_hub,
    web_search: options?.limit_overrides?.web_search ?? RETRIEVAL_CONFIG.DEFAULT_LIMITS.web_search,
  };

  // Enforce min/max limits
  for (const source of Object.keys(limits) as RetrievalSource[]) {
    limits[source] = Math.max(RETRIEVAL_CONFIG.MIN_LIMITS[source], limits[source]);
    limits[source] = Math.min(RETRIEVAL_CONFIG.MAX_LIMITS[source], limits[source]);
  }

  const decision: RetrievalRouterDecision = {
    sources_to_query: sourcesToQuery,
    query_order: sourcesToQuery,
    limits,
    matched_rule: matchedRule.name,
    decided_at: new Date().toISOString(),
    rationale: matchedRule.rationale,
  };

  return decision;
}

/**
 * Log router decision to OASIS
 */
export async function logRetrievalRouterDecision(
  decision: RetrievalRouterDecision,
  context: {
    tenant_id: string;
    user_id: string;
    thread_id: string;
    channel: ConversationChannel;
    query: string;
  }
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01216',
    type: 'conversation.retrieval.router_decision',
    source: `conversation-${context.channel}`,
    status: 'info',
    message: `Retrieval router decision: ${decision.matched_rule}`,
    payload: {
      tenant_id: context.tenant_id,
      user_id: context.user_id,
      thread_id: context.thread_id,
      channel: context.channel,
      query_preview: context.query.substring(0, 100),
      decision: {
        matched_rule: decision.matched_rule,
        sources_to_query: decision.sources_to_query,
        query_order: decision.query_order,
        limits: decision.limits,
        rationale: decision.rationale,
      },
    },
  }).catch(err => {
    console.warn(`[VTID-01216] Failed to log router decision: ${err.message}`);
  });
}

/**
 * Get routing rule names for debugging
 */
export function getRoutingRuleNames(): string[] {
  return ROUTING_RULES.map(r => r.name);
}

/**
 * Get routing rule by name
 */
export function getRoutingRuleByName(name: string): RoutingRule | undefined {
  return ROUTING_RULES.find(r => r.name === name);
}

/**
 * Analyze query and return all matching rules (for debugging)
 */
export function analyzeQueryRouting(query: string): Array<{
  rule: string;
  matched_by: 'pattern' | 'keyword' | 'default';
  priority: number;
}> {
  const normalizedQuery = query.toLowerCase().trim();
  const matches: Array<{
    rule: string;
    matched_by: 'pattern' | 'keyword' | 'default';
    priority: number;
  }> = [];

  for (const rule of ROUTING_RULES) {
    // Check patterns
    const patternMatch = rule.patterns.some(p => p.test(normalizedQuery));
    if (patternMatch) {
      matches.push({ rule: rule.name, matched_by: 'pattern', priority: rule.priority });
      continue;
    }

    // Check keywords
    const keywordMatch = rule.keywords.some(k => normalizedQuery.includes(k.toLowerCase()));
    if (keywordMatch) {
      matches.push({ rule: rule.name, matched_by: 'keyword', priority: rule.priority });
      continue;
    }

    // Default rule always matches
    if (rule.name === 'default') {
      matches.push({ rule: rule.name, matched_by: 'default', priority: rule.priority });
    }
  }

  return matches.sort((a, b) => b.priority - a.priority);
}
