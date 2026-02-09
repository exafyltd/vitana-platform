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
 * Queries memory_items directly with user/tenant scoping (SERVICE_ROLE bypasses RLS)
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

    if (!lens.tenant_id || !lens.user_id) {
      console.warn('[VTID-01216] Missing tenant_id or user_id in lens');
      return { hits: [], latency_ms: Date.now() - startTime };
    }

    // Query memory_items directly with user/tenant scoping
    // The RPC memory_get_context relies on JWT context (auth.uid()) which doesn't
    // work with SERVICE_ROLE key, so we query the table directly instead.
    const maxAgeHours = lens.max_age_hours || 168; // 7 days default
    const sinceDate = new Date();
    sinceDate.setHours(sinceDate.getHours() - maxAgeHours);

    let url = `${SUPABASE_URL}/rest/v1/memory_items?select=id,category_key,content,importance,occurred_at,source&tenant_id=eq.${lens.tenant_id}&user_id=eq.${lens.user_id}&order=importance.desc&limit=${limit}`;

    if (lens.allowed_categories && lens.allowed_categories.length > 0) {
      url += `&category_key=in.(${lens.allowed_categories.join(',')})`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
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
 * Fetch structured facts from memory_facts table (written by cognee extraction pipeline)
 * These are high-confidence extracted facts about the user that provide structured context.
 */
async function fetchMemoryFacts(
  lens: ContextLens,
  query: string,
  limit: number = 20
): Promise<{ facts: MemoryHit[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return { facts: [], latency_ms: Date.now() - startTime };
    }

    if (!lens.tenant_id || !lens.user_id) {
      return { facts: [], latency_ms: Date.now() - startTime };
    }

    const url = `${SUPABASE_URL}/rest/v1/memory_facts?select=id,fact_key,fact_value,entity,confidence,provenance_source&tenant_id=eq.${lens.tenant_id}&user_id=eq.${lens.user_id}&order=confidence.desc&limit=${limit}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!response.ok) {
      console.warn(`[VTID-01216] memory_facts retrieval failed: ${response.status}`);
      return { facts: [], latency_ms: Date.now() - startTime };
    }

    const results = await response.json() as Array<{
      id: string;
      fact_key: string;
      fact_value: string;
      entity: string;
      confidence: number;
      provenance_source: string;
    }>;

    // Transform facts into MemoryHit objects with high relevance scores
    const facts: MemoryHit[] = results.map((r) => ({
      id: r.id,
      category_key: `fact:${r.entity || 'general'}`,
      content: `${r.fact_key}: ${r.fact_value}`,
      importance: Math.round(r.confidence * 100),
      occurred_at: new Date().toISOString(),
      source: r.provenance_source || 'cognee_extraction',
      relevance_score: Math.min(1, 0.85 + r.confidence * 0.15), // High base relevance for structured facts
    }));

    console.log(`[VTID-01216] memory_facts returned ${facts.length} structured facts`);

    return {
      facts,
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01216] memory_facts retrieval error: ${error.message}`);
    return { facts: [], latency_ms: Date.now() - startTime };
  }
}

/**
 * Fetch relationship graph context from relationship_nodes and relationship_edges tables
 * (written by cognee extraction pipeline). Returns human-readable relationship strings.
 */
async function fetchRelationshipContext(
  lens: ContextLens,
  limit: number = 15
): Promise<{ context: string[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return { context: [], latency_ms: Date.now() - startTime };
    }

    if (!lens.tenant_id || !lens.user_id) {
      return { context: [], latency_ms: Date.now() - startTime };
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    };

    // Fetch nodes and edges in parallel
    const nodesUrl = `${SUPABASE_URL}/rest/v1/relationship_nodes?select=id,title,node_type,domain,metadata&tenant_id=eq.${lens.tenant_id}&order=created_at.desc&limit=${limit}`;
    const edgesUrl = `${SUPABASE_URL}/rest/v1/relationship_edges?select=from_node_id,to_node_id,relationship_type,strength&tenant_id=eq.${lens.tenant_id}&user_id=eq.${lens.user_id}&order=strength.desc&limit=20`;

    const [nodesResponse, edgesResponse] = await Promise.all([
      fetch(nodesUrl, { method: 'GET', headers }),
      fetch(edgesUrl, { method: 'GET', headers }),
    ]);

    if (!nodesResponse.ok || !edgesResponse.ok) {
      console.warn(`[VTID-01216] relationship retrieval failed: nodes=${nodesResponse.status}, edges=${edgesResponse.status}`);
      return { context: [], latency_ms: Date.now() - startTime };
    }

    const nodes = await nodesResponse.json() as Array<{
      id: string;
      title: string;
      node_type: string;
      domain: string;
      metadata: Record<string, unknown>;
    }>;

    const edges = await edgesResponse.json() as Array<{
      from_node_id: string;
      to_node_id: string;
      relationship_type: string;
      strength: number;
    }>;

    // Build node lookup map
    const nodeMap = new Map<string, { title: string; node_type: string }>();
    for (const node of nodes) {
      nodeMap.set(node.id, { title: node.title, node_type: node.node_type });
    }

    // Map edges to human-readable strings
    const context: string[] = edges
      .map((edge) => {
        const fromNode = nodeMap.get(edge.from_node_id);
        const toNode = nodeMap.get(edge.to_node_id);
        if (!fromNode || !toNode) return null;

        return `${fromNode.node_type}: ${fromNode.title} (${edge.relationship_type}) → connected to → ${toNode.title} (${toNode.node_type})`;
      })
      .filter((s): s is string => s !== null);

    console.log(`[VTID-01216] relationship graph returned ${context.length} connections from ${nodes.length} nodes`);

    return {
      context,
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01216] relationship retrieval error: ${error.message}`);
    return { context: [], latency_ms: Date.now() - startTime };
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
// Web Search Retrieval via Perplexity MCP
// =============================================================================

/**
 * Fetch web search hits via Perplexity API
 *
 * GOVERNANCE REQUIREMENT (per Vitana standards):
 * - Web search MUST use Perplexity as the approved provider
 * - Must follow Ask/Research schemas with recency filters
 * - Must include citations in response
 * - Validator must verify citations are present
 */
async function fetchWebHits(
  query: string,
  limit: number
): Promise<{ hits: WebHit[]; latency_ms: number }> {
  const startTime = Date.now();

  const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PERPLEXITY_API_KEY) {
    console.warn('[VTID-01216] PERPLEXITY_API_KEY not configured - web search disabled');
    return { hits: [], latency_ms: Date.now() - startTime };
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Provide concise, factual answers with citations. Format each fact on its own line.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 1024,
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[VTID-01216] Perplexity API error: ${response.status} - ${errorText}`);
      return { hits: [], latency_ms: Date.now() - startTime };
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      citations?: string[];
    };

    const content = data.choices[0]?.message?.content || '';
    const citations = data.citations || [];

    // Parse response into web hits
    const hits: WebHit[] = [];
    const sentences = content.split(/\.\s+/).filter(s => s.trim().length > 20);

    for (let i = 0; i < Math.min(sentences.length, limit); i++) {
      const sentence = sentences[i].trim();
      if (sentence) {
        hits.push({
          id: `web-${i}`,
          title: sentence.substring(0, 80) + (sentence.length > 80 ? '...' : ''),
          snippet: sentence.substring(0, CONTEXT_PACK_CONFIG.MAX_CONTENT_LENGTH),
          url: citations[i] || citations[0] || 'https://perplexity.ai',
          citation: citations[i] || citations[0] || '[Perplexity AI]',
          relevance_score: 1 - (i * 0.1),
        });
      }
    }

    console.log(`[VTID-01216] Perplexity returned ${hits.length} web hits for: ${query.substring(0, 50)}`);

    return {
      hits: hits.slice(0, CONTEXT_PACK_CONFIG.MAX_WEB_HITS),
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01216] Perplexity API error: ${error.message}`);
    return { hits: [], latency_ms: Date.now() - startTime };
  }
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

  // Web Search via Perplexity
  const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
  tools.push({
    name: 'web_search',
    available: !!PERPLEXITY_API_KEY,
    last_checked: now,
    error: PERPLEXITY_API_KEY ? undefined : 'PERPLEXITY_API_KEY not configured',
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
  let structuredFacts: MemoryHit[] = [];
  let relationshipContext: string[] = [];

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

  // Memory Facts retrieval (cognee extraction pipeline output)
  if (input.router_decision.sources_to_query.includes('memory_garden')) {
    retrievalPromises.push(
      fetchMemoryFacts(input.lens, input.query)
        .then(result => {
          structuredFacts = result.facts;
        })
    );
  }

  // Relationship Graph retrieval (cognee extraction pipeline output)
  if (input.router_decision.sources_to_query.includes('memory_garden')) {
    retrievalPromises.push(
      fetchRelationshipContext(input.lens)
        .then(result => {
          relationshipContext = result.context;
        })
    );
  }

  // Execute all retrievals in parallel
  await Promise.all(retrievalPromises);

  // Merge structured facts into memory hits (prepend - higher priority)
  if (structuredFacts.length > 0) {
    memoryHits = [...structuredFacts, ...memoryHits];
    // Re-sort by relevance and enforce limit
    memoryHits.sort((a, b) => b.relevance_score - a.relevance_score);
    memoryHits = memoryHits.slice(0, CONTEXT_PACK_CONFIG.MAX_MEMORY_HITS);
    hitCounts.memory_garden = memoryHits.length;
  }

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
    estimateTokens(relationshipContext) +
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
    relationship_context: relationshipContext.length > 0 ? relationshipContext : undefined,

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

  // Structured facts section (from cognee extraction pipeline)
  const structuredFactHits = pack.memory_hits.filter(h => h.category_key.startsWith('fact:'));
  if (structuredFactHits.length > 0) {
    context += `<structured_facts>\n`;
    context += `The following are verified structured facts about the user:\n\n`;
    for (const hit of structuredFactHits) {
      context += `- ${hit.content}\n`;
    }
    context += `</structured_facts>\n\n`;
  }

  // Relationship graph section (from cognee extraction pipeline)
  if (pack.relationship_context && pack.relationship_context.length > 0) {
    context += `<relationship_graph>\n`;
    context += `The following is the user's relationship graph:\n\n`;
    for (const rel of pack.relationship_context) {
      context += `- ${rel}\n`;
    }
    context += `</relationship_graph>\n\n`;
  }

  // Memory section
  if (pack.memory_hits.length > 0) {
    const nonFactHits = pack.memory_hits.filter(h => !h.category_key.startsWith('fact:'));
    if (nonFactHits.length > 0) {
      context += `<memory_context>\n`;
      context += `The following information is from the user's personal memory:\n\n`;
      for (const hit of nonFactHits) {
        context += `[${hit.category_key}] ${hit.content}\n`;
      }
      context += `</memory_context>\n\n`;
    }
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
