/**
 * VTID-01216: Context Pack Builder (D3)
 *
 * Builds a compact Context Pack that is injected into the LLM for every turn.
 * The Context Pack consumes data from:
 * - Memory Garden (D1-D63)
 * - Knowledge Hub
 * - Web Search
 *
 * Hard rules:
 * - Strict size cap (~15KB)
 * - Rank, dedupe, and summarize
 * - No raw dumps
 *
 * Fields:
 * - identity
 * - session_state
 * - memory_hits (5-12 max)
 * - knowledge_hits (0-8)
 * - web_hits (0-6 with citations)
 * - active_vtids
 * - tenant_policies
 * - tool_health
 * - ui_context
 */

import { randomUUID, createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  ContextPack,
  MemoryHit,
  KnowledgeHit,
  WebHit,
  ToolHealthStatus,
  ActiveVTID,
  TenantPolicy,
  UIContext,
  RetrievalRouterDecision,
  RetrievalSource,
  ConversationChannel,
} from '../types/conversation';
import { searchKnowledge, KnowledgeSearchRequest } from './knowledge-hub';
import { ContextLens } from '../types/context-lens';

// =============================================================================
// Configuration
// =============================================================================

export const CONTEXT_PACK_CONFIG = {
  /** Maximum total size in bytes (~15KB) */
  MAX_SIZE_BYTES: 15 * 1024,

  /** Maximum memory hits */
  MAX_MEMORY_HITS: 12,
  MIN_MEMORY_HITS: 5,

  /** Maximum knowledge hits */
  MAX_KNOWLEDGE_HITS: 8,

  /** Maximum web hits */
  MAX_WEB_HITS: 6,

  /** Maximum content length per hit */
  MAX_CONTENT_LENGTH: 500,

  /** Token budget approximation (4 chars per token) */
  CHARS_PER_TOKEN: 4,

  /** Total token budget */
  TOKEN_BUDGET: 4000,
};

// =============================================================================
// Memory Retrieval
// =============================================================================

/**
 * Fetch memory hits from Memory Garden
 */
async function fetchMemoryHits(
  lens: ContextLens,
  query: string,
  limit: number
): Promise<{ hits: MemoryHit[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      console.warn('[VTID-01216] Supabase not configured for memory retrieval');
      return { hits: [], latency_ms: Date.now() - startTime };
    }

    // Use the memory_get_context RPC function
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/memory_get_context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        p_tenant_id: lens.tenant_id,
        p_user_id: lens.user_id,
        p_limit: limit,
        p_categories: lens.allowed_categories || null,
        p_max_age_hours: lens.max_age_hours || 168, // 7 days default
      }),
    });

    if (!response.ok) {
      console.warn(`[VTID-01216] Memory retrieval failed: ${response.status}`);
      return { hits: [], latency_ms: Date.now() - startTime };
    }

    const results = await response.json() as Array<{
      id: string;
      category_key: string;
      content: string;
      importance: number;
      occurred_at: string;
      source: string;
    }>;

    // Score and transform results
    const hits: MemoryHit[] = results.map((r, index) => ({
      id: r.id,
      category_key: r.category_key,
      content: r.content.substring(0, CONTEXT_PACK_CONFIG.MAX_CONTENT_LENGTH),
      importance: r.importance,
      occurred_at: r.occurred_at,
      source: r.source,
      relevance_score: computeRelevanceScore(r, query, index),
    }));

    // Sort by relevance score
    hits.sort((a, b) => b.relevance_score - a.relevance_score);

    return {
      hits: hits.slice(0, Math.min(limit, CONTEXT_PACK_CONFIG.MAX_MEMORY_HITS)),
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01216] Memory retrieval error: ${error.message}`);
    return { hits: [], latency_ms: Date.now() - startTime };
  }
}

/**
 * Compute relevance score for a memory item
 */
function computeRelevanceScore(
  item: { importance: number; occurred_at: string; content: string },
  query: string,
  position: number
): number {
  // Base score from importance (0-100)
  let score = item.importance / 100;

  // Recency boost (exponential decay)
  const ageHours = (Date.now() - new Date(item.occurred_at).getTime()) / (1000 * 60 * 60);
  const recencyScore = Math.exp(-ageHours / 168); // 7-day half-life
  score += recencyScore * 0.3;

  // Position penalty (items returned earlier are more relevant from RPC)
  score -= position * 0.01;

  // Simple keyword match boost
  const queryWords = query.toLowerCase().split(/\s+/);
  const contentLower = item.content.toLowerCase();
  const matchCount = queryWords.filter(w => contentLower.includes(w)).length;
  score += (matchCount / queryWords.length) * 0.2;

  return Math.min(1, Math.max(0, score));
}

// =============================================================================
// Knowledge Hub Retrieval
// =============================================================================

/**
 * Fetch knowledge hits from Vitana Knowledge Hub
 */
async function fetchKnowledgeHits(
  query: string,
  limit: number
): Promise<{ hits: KnowledgeHit[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    const request: KnowledgeSearchRequest = {
      query,
      maxResults: limit,
    };

    const result = await searchKnowledge(request);

    if (!result.ok) {
      console.warn(`[VTID-01216] Knowledge search failed: ${result.error}`);
      return { hits: [], latency_ms: Date.now() - startTime };
    }

    const hits: KnowledgeHit[] = result.docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      snippet: doc.snippet.substring(0, CONTEXT_PACK_CONFIG.MAX_CONTENT_LENGTH),
      source_path: doc.source,
      relevance_score: doc.score,
    }));

    return {
      hits: hits.slice(0, CONTEXT_PACK_CONFIG.MAX_KNOWLEDGE_HITS),
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01216] Knowledge retrieval error: ${error.message}`);
    return { hits: [], latency_ms: Date.now() - startTime };
  }
}

// =============================================================================
// Web Search Retrieval (Placeholder - needs external integration)
// =============================================================================

/**
 * Fetch web search hits
 * NOTE: This is a placeholder. Web search integration needs to be configured
 * with a provider (e.g., Serper, Google Search API, Bing API)
 */
async function fetchWebHits(
  query: string,
  limit: number
): Promise<{ hits: WebHit[]; latency_ms: number }> {
  const startTime = Date.now();

  // TODO: Implement web search integration
  // For now, return empty results
  console.log(`[VTID-01216] Web search not implemented yet for query: ${query.substring(0, 50)}`);

  return {
    hits: [],
    latency_ms: Date.now() - startTime,
  };
}

// =============================================================================
// Tool Health Check
// =============================================================================

/**
 * Check health of registered tools
 */
async function checkToolHealth(): Promise<ToolHealthStatus[]> {
  const tools: ToolHealthStatus[] = [];
  const now = new Date().toISOString();

  // Memory Garden
  const SUPABASE_URL = process.env.SUPABASE_URL;
  tools.push({
    name: 'memory_garden',
    available: !!SUPABASE_URL,
    last_checked: now,
    error: SUPABASE_URL ? undefined : 'Supabase not configured',
  });

  // Knowledge Hub
  tools.push({
    name: 'knowledge_hub',
    available: !!SUPABASE_URL,
    last_checked: now,
    error: SUPABASE_URL ? undefined : 'Supabase not configured',
  });

  // Autopilot Tools
  tools.push({
    name: 'autopilot_create_task',
    available: !!SUPABASE_URL,
    last_checked: now,
  });

  tools.push({
    name: 'autopilot_get_status',
    available: !!SUPABASE_URL,
    last_checked: now,
  });

  tools.push({
    name: 'autopilot_list_recent_tasks',
    available: !!SUPABASE_URL,
    last_checked: now,
  });

  // Web Search (not implemented yet)
  tools.push({
    name: 'web_search',
    available: false,
    last_checked: now,
    error: 'Web search integration not configured',
  });

  return tools;
}

// =============================================================================
// Active VTIDs Retrieval
// =============================================================================

/**
 * Fetch active VTIDs for context
 */
async function fetchActiveVTIDs(
  tenant_id: string,
  limit: number = 5
): Promise<ActiveVTID[]> {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return [];
    }

    // Fetch recent active tasks from vtid_ledger
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?status=in.(in-progress,scheduled,planned)&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      return [];
    }

    const results = await response.json() as Array<{
      vtid: string;
      title: string;
      status: string;
      priority?: string;
    }>;

    return results.map(r => ({
      vtid: r.vtid,
      title: r.title || r.vtid,
      status: r.status,
      priority: r.priority,
    }));
  } catch (error: any) {
    console.warn(`[VTID-01216] Failed to fetch active VTIDs: ${error.message}`);
    return [];
  }
}

// =============================================================================
// Context Pack Builder
// =============================================================================

export interface BuildContextPackInput {
  /** Context lens for memory access */
  lens: ContextLens;

  /** User's query/message */
  query: string;

  /** Channel (ORB or Operator) */
  channel: ConversationChannel;

  /** Thread ID */
  thread_id: string;

  /** Turn number in conversation */
  turn_number: number;

  /** Conversation start time */
  conversation_start: string;

  /** User's role */
  role: string;

  /** User display name */
  display_name?: string;

  /** UI context */
  ui_context?: UIContext;

  /** Retrieval router decision */
  router_decision: RetrievalRouterDecision;

  /** Optional VTID link */
  vtid?: string;
}

/**
 * Build a Context Pack for LLM injection
 */
export async function buildContextPack(
  input: BuildContextPackInput
): Promise<ContextPack> {
  const startTime = Date.now();
  const packId = randomUUID();

  // Initialize hit counts and latencies
  const hitCounts: Record<RetrievalSource, number> = {
    memory_garden: 0,
    knowledge_hub: 0,
    web_search: 0,
  };
  const latencies: Record<RetrievalSource, number> = {
    memory_garden: 0,
    knowledge_hub: 0,
    web_search: 0,
  };

  // Execute retrievals based on router decision
  const retrievalPromises: Promise<void>[] = [];

  let memoryHits: MemoryHit[] = [];
  let knowledgeHits: KnowledgeHit[] = [];
  let webHits: WebHit[] = [];

  // Memory Garden retrieval
  if (input.router_decision.sources_to_query.includes('memory_garden')) {
    retrievalPromises.push(
      fetchMemoryHits(input.lens, input.query, input.router_decision.limits.memory_garden)
        .then(result => {
          memoryHits = result.hits;
          hitCounts.memory_garden = result.hits.length;
          latencies.memory_garden = result.latency_ms;
        })
    );
  }

  // Knowledge Hub retrieval
  if (input.router_decision.sources_to_query.includes('knowledge_hub')) {
    retrievalPromises.push(
      fetchKnowledgeHits(input.query, input.router_decision.limits.knowledge_hub)
        .then(result => {
          knowledgeHits = result.hits;
          hitCounts.knowledge_hub = result.hits.length;
          latencies.knowledge_hub = result.latency_ms;
        })
    );
  }

  // Web Search retrieval
  if (input.router_decision.sources_to_query.includes('web_search')) {
    retrievalPromises.push(
      fetchWebHits(input.query, input.router_decision.limits.web_search)
        .then(result => {
          webHits = result.hits;
          hitCounts.web_search = result.hits.length;
          latencies.web_search = result.latency_ms;
        })
    );
  }

  // Execute all retrievals in parallel
  await Promise.all(retrievalPromises);

  // Fetch tool health
  const toolHealth = await checkToolHealth();

  // Fetch active VTIDs
  const activeVtids = await fetchActiveVTIDs(input.lens.tenant_id);

  // Estimate token usage
  const estimateTokens = (obj: unknown): number => {
    const str = JSON.stringify(obj);
    return Math.ceil(str.length / CONTEXT_PACK_CONFIG.CHARS_PER_TOKEN);
  };

  const tokensUsed =
    estimateTokens(memoryHits) +
    estimateTokens(knowledgeHits) +
    estimateTokens(webHits) +
    estimateTokens(activeVtids) +
    estimateTokens(toolHealth) +
    500; // Overhead for other fields

  // Build the pack
  const pack: ContextPack = {
    pack_id: packId,
    pack_hash: createHash('sha256')
      .update(JSON.stringify({ memoryHits, knowledgeHits, webHits, query: input.query }))
      .digest('hex')
      .substring(0, 16),
    assembled_at: new Date().toISOString(),
    assembly_duration_ms: Date.now() - startTime,

    identity: {
      tenant_id: input.lens.tenant_id,
      user_id: input.lens.user_id,
      role: input.role,
      display_name: input.display_name,
    },

    session_state: {
      thread_id: input.thread_id,
      channel: input.channel,
      turn_number: input.turn_number,
      conversation_start: input.conversation_start,
    },

    memory_hits: memoryHits,
    knowledge_hits: knowledgeHits,
    web_hits: webHits,
    active_vtids: activeVtids,
    tenant_policies: [], // TODO: Implement tenant policy retrieval
    tool_health: toolHealth,
    ui_context: input.ui_context,

    retrieval_trace: {
      router_decision: input.router_decision,
      sources_queried: input.router_decision.sources_to_query,
      latencies,
      hit_counts: hitCounts,
    },

    token_budget: {
      total_budget: CONTEXT_PACK_CONFIG.TOKEN_BUDGET,
      used: tokensUsed,
      remaining: CONTEXT_PACK_CONFIG.TOKEN_BUDGET - tokensUsed,
    },
  };

  // Log pack build event
  await emitOasisEvent({
    vtid: input.vtid || 'VTID-01216',
    type: 'conversation.context_pack.built',
    source: `conversation-${input.channel}`,
    status: 'info',
    message: `Context pack built: ${hitCounts.memory_garden} memory, ${hitCounts.knowledge_hub} knowledge, ${hitCounts.web_search} web`,
    payload: {
      pack_id: packId,
      tenant_id: input.lens.tenant_id,
      user_id: input.lens.user_id,
      thread_id: input.thread_id,
      channel: input.channel,
      assembly_duration_ms: pack.assembly_duration_ms,
      hit_counts: hitCounts,
      latencies,
      tokens_used: tokensUsed,
    },
  }).catch(err => {
    console.warn(`[VTID-01216] Failed to log context pack event: ${err.message}`);
  });

  return pack;
}

/**
 * Format Context Pack for LLM system instruction injection
 */
export function formatContextPackForLLM(pack: ContextPack): string {
  let context = '';

  // Identity section
  context += `<user_context>\n`;
  context += `User: ${pack.identity.display_name || pack.identity.user_id}\n`;
  context += `Role: ${pack.identity.role}\n`;
  context += `Session: Turn ${pack.session_state.turn_number} via ${pack.session_state.channel}\n`;
  context += `</user_context>\n\n`;

  // Memory section
  if (pack.memory_hits.length > 0) {
    context += `<memory_context>\n`;
    context += `The following information is from the user's personal memory:\n\n`;
    for (const hit of pack.memory_hits) {
      context += `[${hit.category_key}] ${hit.content}\n`;
    }
    context += `</memory_context>\n\n`;
  }

  // Knowledge section
  if (pack.knowledge_hits.length > 0) {
    context += `<vitana_knowledge>\n`;
    context += `The following information is from Vitana documentation:\n\n`;
    for (const hit of pack.knowledge_hits) {
      context += `**${hit.title}**\n${hit.snippet}\n\n`;
    }
    context += `</vitana_knowledge>\n\n`;
  }

  // Web search section
  if (pack.web_hits.length > 0) {
    context += `<web_search_results>\n`;
    context += `The following information is from web search:\n\n`;
    for (const hit of pack.web_hits) {
      context += `**${hit.title}**\n${hit.snippet}\nSource: ${hit.citation}\n\n`;
    }
    context += `</web_search_results>\n\n`;
  }

  // Active VTIDs section
  if (pack.active_vtids.length > 0) {
    context += `<active_tasks>\n`;
    context += `Currently active tasks:\n`;
    for (const vtid of pack.active_vtids) {
      context += `- ${vtid.vtid}: ${vtid.title} (${vtid.status})\n`;
    }
    context += `</active_tasks>\n\n`;
  }

  return context;
}
