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

  // ===== Intent Classifier — Navigation vs Teaching =====
  // BOOTSTRAP-TEACH-BEFORE-REDIRECT Phase 1. Three sibling rules sitting
  // between vitana_system (100) and personal_index (95). They route to
  // the how-to KB corpus with a `mode` hint downstream consumers (logs,
  // explain_feature tool) read to decide whether to navigate, teach, or
  // teach-then-redirect. Same target source; different rationale tags so
  // misclassifications are auditable.

  // NAV-ONLY — clear navigation phrasings. Voice opens the screen,
  // does NOT explain. "Show me the X" only matches when X is a noun
  // (screen / page / Diary / Health / etc.), NOT when followed by
  // "how to <verb>" (which is teach-only).
  {
    name: 'nav_intent',
    priority: 94,
    patterns: [
      /\b(open|öffne|mach\s+\w+\s+auf)\s+(the\s+|a\s+|den\s+|die\s+|das\s+)?[\w-]+/i,
      /\b(go to|geh zu|navigate to|jump to|pull up|take me to|bring me to|bring mich zu)\s+/i,
      /\b(show me|let me see|i want to see|zeig mir|ich will sehen)\s+(the|a|my|den|die|das|mein|meine)\s+(screen|page|section|tab|list|dashboard|bildschirm|seite|bereich|liste|diary|tagebuch|health|index|autopilot|kalender|calendar)/i,
      /\bwhere is\s+(the|a|my)\s+\w+/i,
      /\bwo ist\s+(der|die|das|mein|meine)\s+\w+/i,
    ],
    keywords: [
      'open', 'go to', 'take me to', 'navigate', 'pull up',
      'öffne', 'geh zu', 'mach auf', 'bring mich zu',
      'show me the', 'i want to see the',
      'zeig mir den', 'ich will den', 'wo ist der',
    ],
    primary_source: 'knowledge_hub',
    secondary_sources: [],
    rationale: 'INTENT=NAV — phrase is a clear navigation request. Voice should call the navigation tool, no explanation.',
  },

  // TEACH-ONLY — clear explanatory phrasings. Voice calls explain_feature,
  // speaks summary + ALL steps, does NOT navigate. Includes the
  // unambiguous "show me how <verb>" form (verb-phrase, not noun).
  {
    name: 'teach_intent',
    priority: 93,
    patterns: [
      /\b(explain|erkläre|tell me about|teach me|what does\s+\w+\s+do|what is\s+.+\s+for|wofür ist|was bedeutet)\b/i,
      /\b(how does|wie funktioniert)\s+(it|this|that|es|das|dies)\b/i,
      /\b(show me how|tell me how|zeig mir wie)\s+(to|i can|ich)\b/i,
      /\b(i don'?t (understand|get)|ich verstehe (das )?nicht)\b/i,
      /\b(i'?m new|ich bin neu)\b/i,
    ],
    keywords: [
      'explain', 'tell me about', 'teach me', 'what does', 'what is for',
      'how does it work', 'how does this work',
      'show me how to', 'tell me how to',
      'i don\'t understand', 'i\'m new',
      'erkläre mir', 'wie funktioniert', 'wofür ist', 'was bedeutet',
      'zeig mir wie', 'ich verstehe nicht', 'ich bin neu',
    ],
    primary_source: 'knowledge_hub',
    secondary_sources: [],
    rationale: 'INTENT=TEACH — phrase asks for understanding. Voice should call explain_feature with mode=teach_only, speak full explanation, no redirect.',
  },

  // TEACH-THEN-NAV — ambiguous "how do I <action>" / "where do I <action>"
  // phrasings. Voice teaches briefly, then offers redirect. Default for
  // anything between pure-nav and pure-teach.
  {
    name: 'teach_then_nav_intent',
    priority: 92,
    patterns: [
      /\b(how|wie)\s+(do|can|kann)\s+i\s+(log|track|enter|record|connect|set up|setup|use|find|wear|dictate|sync|link|input)/i,
      /\b(wie|wo)\s+(mache|kann|trage|verbinde|finde|nutze)\s+ich\b/i,
      /\b(where do i|wo trage ich|wo kann ich)\b/i,
      /\b(can i|kann ich)\s+(log|track|enter|record|connect|verbinde|protokoll|eintrag)/i,
      /\bwhat should i do to\b/i,
    ],
    keywords: [
      'how do i log', 'how can i log', 'how do i track', 'how can i connect',
      'where do i log', 'where do i find',
      'can i log', 'can i enter', 'can i connect',
      'wie mache ich', 'wie kann ich', 'wo trage ich', 'wo kann ich',
      'kann ich protokollieren', 'kann ich eintragen', 'kann ich verbinden',
    ],
    primary_source: 'knowledge_hub',
    secondary_sources: [],
    rationale: 'INTENT=TEACH-THEN-NAV — phrase is action-shaped but ambiguous. Voice should call explain_feature with mode=teach_then_nav, speak brief explanation + redirect_offer, only navigate on confirmation.',
  },

  // ===== Personal Vitana Index Questions → User Data First =====
  // BOOTSTRAP-ORB-INDEX-AWARENESS: when the user asks about THEIR Index,
  // tier, pillars, or how to improve THEIR score, route to user data
  // (memory garden + autopilot recommendations) first, then to KB
  // narrative. Generic "what IS the Vitana Index?" stays at vitana_system
  // (priority 100) and goes to KB docs. Sits BETWEEN vitana_system (100)
  // and personal_history (90) so it wins on "MY index" while leaving "the
  // index" to the higher-priority KB route.
  {
    name: 'personal_index',
    priority: 95,
    patterns: [
      /\bmy (vitana )?(index|score|tier|pillars?|s\u00e4ul[en]?)/i,
      /\bmein(en|e)? (vitana )?(index|score|tier|s\u00e4ul[en]?)/i,
      /how (do|can) i (improve|raise|lift|boost) (my )?(index|score|tier)/i,
      /(verbess|improv|raise|lift|boost).*(meinen?|my)\s*(vitana )?(index|score|s\u00e4ul[en]?)/i,
      /what(\u2019|')?s (holding me back|my weakest)/i,
      /(make|build|set up|create)\s+(me\s+)?a?\s*plan.*(index|score|pillar|s\u00e4ule)/i,
      /(plan|schedule).*(improve|verbess).*(index|score|tier|s\u00e4ule)/i,
      // BOOTSTRAP-ORB-INDEX-AWARENESS-R4 \u2014 balance-aware queries
      /\b(balance|ratio|lopsided|unbalanced|in harmony)\b.*(pillar|index|score)/i,
      /(pillar|index|score).*(balance|ratio|lopsided|unbalanced|in harmony)/i,
      // BOOTSTRAP-ORB-INDEX-AWARENESS-R4 \u2014 per-pillar personal queries
      /\bmy (nutrition|hydration|exercise|sleep|mental)\b/i,
      /\bmein(en|e)? (ern\u00e4hrung|hydration|fl\u00fcssigkeit|bewegung|sport|schlaf|mental)\b/i,
      /how\s+(is|are)\s+my\s+(nutrition|hydration|exercise|sleep|mental)/i,
      /wie\s+(ist|steht)\s+mein(en|e)?\s+(ern\u00e4hrung|schlaf|bewegung|mental)/i,
    ],
    keywords: [
      'my index', 'my vitana index', 'my score', 'my tier', 'my pillar', 'my pillars',
      'mein index', 'mein vitana index', 'meinen index', 'meine s\u00e4ule',
      'improve my index', 'raise my score', 'lift my index', 'boost my tier',
      'verbessere meinen index', 'verbesser meinen score',
      'weakest pillar', 'lowest pillar', 'schw\u00e4chste s\u00e4ule',
      'plan to improve', 'plan zur verbesserung',
      // R4 \u2014 balance + per-pillar
      'balance factor', 'balance score', 'pillar balance', 'lopsided', 'in harmony',
      'my nutrition', 'my hydration', 'my exercise', 'my sleep', 'my mental',
      'meine ern\u00e4hrung', 'meine hydration', 'mein schlaf', 'meine bewegung', 'mein mental',
      'how is my sleep', 'how is my nutrition',
    ],
    primary_source: 'memory_garden',
    secondary_sources: ['knowledge_hub'],
    rationale: 'Personal Index questions need the live score + user-specific recommendations. Memory Garden first surfaces the [HEALTH] profile block (5-pillar score, balance factor, weakest pillar with sub-score hint, trend, tier framing); Knowledge Hub supplements with the Book-of-the-Index chapters for per-pillar deep questions.',
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
    calendar: 20, // Calendar events are always fetched, limit 20
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
