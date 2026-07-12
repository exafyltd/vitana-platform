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
// VTID-03158 (CPB-7/8/9): typed readers own all direct Supabase
// access for the ledger, OASIS event, and autopilot-recommendation
// surfaces. CPB just receives shaped results.
import { getActiveVTIDs } from './vtid-ledger-reader';
import {
  getDeveloperOasisContext,
  getCommunityOasisContext,
} from './oasis-context-reader';
import { searchKnowledge, KnowledgeSearchRequest } from './knowledge-hub';
import {
  getCurrentFacts,
  searchFactsSemantic,
  listFactsByConfidence,
} from './memory-facts-service';
// VTID-03145 (PR 2): DIARY + NETWORK blocks now route through the
// memory-broker boundary instead of raw Supabase fetches. See
// fetchDiaryHits / fetchRelationshipContext below.
import { getMemoryContext, type DiaryBlock, type NetworkBlock } from './memory-broker';
import { ContextLens } from '../types/context-lens';
// VTID-01230: Session buffer for Tier 0 short-term memory
import { formatSessionBufferForLLM, getSessionContext } from './session-memory-buffer';
// VTID-01955: Tier 0 Memorystore Redis turn buffer (multi-instance shared) — gated by tier0_redis_enabled flag.
import { getSessionContextRedis, formatRedisBufferForLLM } from './redis-turn-buffer';
import { isTier0RedisEnabled } from './system-controls-service';
// VTID-01966 Phase 2: HIPAA-grade audit on every memory read.
import { auditMemoryRead } from './memory-audit';
// VTID-02000: Marketplace context primitive
import { getUserHealthContext } from './user-health-context';
// Phase B (ORB Memory Resilience): relevance-ranked memory selection, gated
// OFF-by-default behind FEATURE_BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL_ENV with a
// FEATURE_VOICE_RANKING_SHADOW_ENV shadow-compare log. See memory-ranker.ts.
import { isFeatureLive } from './feature-flags';
import { rankMemoryHits, shadowCompareHits } from './memory-hit-ranking';

// =============================================================================
// Identity Core — fact keys that are ALWAYS loaded regardless of limits
// =============================================================================

const IDENTITY_CORE_KEYS = [
  'user_name', 'user_birthday', 'user_residence', 'user_hometown',
  'user_company', 'user_occupation', 'user_email', 'user_phone',
  'spouse_name', 'fiancee_name', 'mother_name', 'father_name',
  'fiancee_birthday',
  'user_health_condition', 'user_medication', 'user_allergy',
  'preferred_language',
];

// =============================================================================
// Configuration
// =============================================================================

export const CONTEXT_PACK_CONFIG = {
  /** Maximum total size in bytes (~20KB) */
  MAX_SIZE_BYTES: 20 * 1024,

  /** VTID-01225: Increased max memory hits from 12→25 to include more context */
  MAX_MEMORY_HITS: 25,
  MIN_MEMORY_HITS: 8,

  /** Maximum knowledge hits */
  MAX_KNOWLEDGE_HITS: 8,

  /** Maximum web hits */
  MAX_WEB_HITS: 6,

  /** VTID-01225: Increased content length from 500→800 to avoid truncating facts */
  MAX_CONTENT_LENGTH: 800,

  /** Token budget approximation (4 chars per token) */
  CHARS_PER_TOKEN: 4,

  /** VTID-01225: Increased token budget from 4000→6000 to fit more memories */
  TOKEN_BUDGET: 6000,

  /** VTID-01224-FIX: Timeout for individual fetch calls within buildContextPack.
   *  Must be shorter than the Live API tool timeout (3s) to allow response time. */
  FETCH_TIMEOUT_MS: 2500,
};

// =============================================================================
// Fetch Timeout Helper
// =============================================================================

/**
 * VTID-01224-FIX: Create an AbortController with a timeout.
 * Returns { signal, clear } — call clear() in finally blocks to avoid timer leaks.
 */
function fetchWithTimeout(timeoutMs: number = CONTEXT_PACK_CONFIG.FETCH_TIMEOUT_MS): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

// =============================================================================
// Memory Retrieval
// =============================================================================

/**
 * Fetch episodic memory hits.
 *
 * VTID-03156 (CPB-1/2): all episodic memory reads — including the
 * legacy semantic + REST fallbacks — now live behind the memory
 * broker. CPB no longer constructs Supabase REST/RPC requests for
 * this path; it just asks the broker for the EPISODIC block and
 * maps the returned hits.
 *
 * The broker owns the full fallback ladder (mem_episodes_semantic →
 * mem_episodes recency → legacy semantic → legacy REST)
 * and returns pre-ranked hits; the position-based relevance score
 * here preserves the broker's ordering.
 */
async function fetchMemoryHits(
  lens: ContextLens,
  query: string,
  limit: number
): Promise<{ hits: MemoryHit[]; latency_ms: number }> {
  const startTime = Date.now();
  try {
    if (!lens.tenant_id || !lens.user_id) {
      console.warn('[VTID-01216] Missing tenant_id or user_id in lens');
      return { hits: [], latency_ms: Date.now() - startTime };
    }
    const brokerHits = await fetchMemoryHitsViaBroker(lens, query, limit);
    console.log(
      `[VTID-03156] Broker EPISODIC: ${brokerHits.length} hits ` +
      `(${Date.now() - startTime}ms)`
    );
    return { hits: brokerHits, latency_ms: Date.now() - startTime };
  } catch (error: any) {
    console.error(`[VTID-01216] Memory retrieval error: ${error.message}`);
    return { hits: [], latency_ms: Date.now() - startTime };
  }
}

/**
 * VTID-02058 Phase 6c: ask the Memory Broker for the EPISODIC block.
 *
 * Broker is gated by system_controls.memory_broker_enabled (flipped on in
 * Phase 6a). When the flag is off, getMemoryContext returns ok=false with
 * error='memory_broker_disabled' and we silently fall through to the
 * legacy semantic path. When the flag is on, the broker queries the
 * Phase 5a/5c-populated mem_episodes via the mem_episodes_semantic_search
 * RPC (which already cosine+recency ranks).
 *
 * If the EPISODIC block returns 0 hits or errors, we also fall through
 * so canary callers never lose retrieval coverage during Phase 6c.
 */
async function fetchMemoryHitsViaBroker(
  lens: ContextLens,
  query: string,
  limit: number
): Promise<MemoryHit[]> {
  try {
    const { getMemoryContext } = await import('./memory-broker');
    const pack = await getMemoryContext({
      tenant_id: lens.tenant_id!,
      user_id: lens.user_id!,
      intent: 'recall_history',
      channel: 'conversation',
      role: 'community',
      latency_budget_ms: 1500,
      required_blocks: ['EPISODIC'],
      query: query && query.trim().length > 5 ? query : undefined,
    });

    if (!pack.ok) return [];
    const ep = (pack.blocks as any).EPISODIC;
    if (!ep || !Array.isArray(ep.hits) || ep.hits.length === 0) return [];

    return ep.hits.slice(0, limit).map((h: any, idx: number) => ({
      id: h.id,
      category_key: h.category_key ?? 'conversation',
      content: (h.content ?? '').substring(0, CONTEXT_PACK_CONFIG.MAX_CONTENT_LENGTH),
      importance: h.importance ?? 30,
      occurred_at: h.occurred_at,
      source: h.source ?? 'mem_episodes',
      // The broker's EPISODIC hits arrive in already-ranked order (semantic
      // when query was set, recency otherwise). Encode that rank as a
      // descending relevance_score so the context-pack ranker downstream
      // preserves the broker's ordering.
      relevance_score: Math.max(0, Math.min(1, 1 - (idx / Math.max(1, ep.hits.length)))),
    }));
  } catch (err: any) {
    console.warn(`[VTID-02058] broker EPISODIC fetch failed, falling back: ${err?.message ?? err}`);
    return [];
  }
}

// VTID-03156 (CPB-1/2): the legacy `fetchMemoryHitsSemantic`,
// `fetchMemoryHitsREST`, and unused `computeRecencyBoost` helpers
// were deleted from this file. The broker now owns the full episodic
// fallback ladder. See `services/gateway/src/services/memory-broker.ts`
// → `fetchEpisodicBlock` for the canonical implementation. CPB no
// longer references the legacy tables / RPCs or constructs Supabase
// credentials for the episodic memory path; that contract is locked
// by `test/services/context-pack-episodic-boundary.test.ts`.

/**
 * Fetch structured facts for the context pack using a three-tier approach.
 *
 * VTID-03155 (CPB-3 boundary): the table + RPC names live in
 * `memory-facts-service.ts` now. This function owns only the
 * context-pack mapping + merge order (Identity → Semantic → General),
 * which is context-pack-specific (relevance-score formulas tuned for
 * the LLM ranker).
 *
 *   Tier 1 (Identity Core): always fetched via `getCurrentFacts()` —
 *     pinned facts (user_name, user_birthday, …) at relevance 1.0.
 *   Tier 2 (Semantic): `searchFactsSemantic()` cosine-similarity
 *     against the query (skipped for empty/bootstrap queries).
 *   Tier 3 (General): `listFactsByConfidence()` ordered by
 *     confidence + recency.
 *
 * Results are merged and deduplicated by fact ID, in tier order.
 */
async function fetchMemoryFacts(
  lens: ContextLens,
  query: string,
  limit: number = 50
): Promise<{ facts: MemoryHit[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    if (!lens.tenant_id || !lens.user_id) {
      return { facts: [], latency_ms: Date.now() - startTime };
    }

    // --- Tier 1: Identity Core via getCurrentFacts() RPC ---
    // These facts are ALWAYS loaded regardless of limit or ordering.
    let identityCoreFacts: MemoryHit[] = [];
    try {
      const coreResult = await getCurrentFacts({
        tenant_id: lens.tenant_id,
        user_id: lens.user_id,
        fact_keys: IDENTITY_CORE_KEYS,
      });
      if (coreResult.ok && coreResult.facts.length > 0) {
        identityCoreFacts = coreResult.facts.map((f) => ({
          id: f.id,
          category_key: `fact:${f.entity || 'general'}`,
          content: `${f.fact_key}: ${f.fact_value}`,
          importance: Math.round(f.provenance_confidence * 100),
          occurred_at: f.extracted_at || new Date().toISOString(),
          source: f.provenance_source || 'cognee_extraction',
          relevance_score: 1.0, // Identity core facts are always max relevance
        }));
        console.log(`[VTID-01216] Identity Core: ${identityCoreFacts.length} pinned facts loaded`);
      }
    } catch (coreErr: any) {
      console.warn(`[VTID-01216] Identity Core fetch failed (falling back to REST): ${coreErr.message}`);
    }

    // --- Tier 2: Semantic search ---
    // VTID-03155: routed through `searchFactsSemantic`. The service
    // owns the embedding gen, RPC call, timeout, and query-length gate.
    let semanticFacts: MemoryHit[] = [];
    const semResult = await searchFactsSemantic(lens, query);
    if (semResult.ok && semResult.facts.length > 0) {
      semanticFacts = semResult.facts.map((r) => ({
        id: r.id,
        category_key: `fact:${r.entity || 'general'}`,
        content: `${r.fact_key}: ${r.fact_value}`,
        importance: Math.round(r.provenance_confidence * 100),
        occurred_at: new Date().toISOString(),
        source: r.provenance_source || 'cognee_extraction',
        relevance_score: Math.min(1, 0.7 + r.similarity_score * 0.3),
      }));
      console.log(`[VTID-01216] Semantic search: ${semanticFacts.length} facts matched query`);
    } else if (!semResult.ok && semResult.error && semResult.error !== 'missing_lens') {
      console.warn(`[VTID-01216] Semantic search failed (non-fatal): ${semResult.error}`);
    }

    // --- Tier 3: General facts (confidence + recency sorted) ---
    // VTID-03155: routed through `listFactsByConfidence`.
    let generalFacts: MemoryHit[] = [];
    const generalResult = await listFactsByConfidence(lens, { limit });
    if (generalResult.ok && generalResult.facts.length > 0) {
      generalFacts = generalResult.facts.map((r) => ({
        id: r.id,
        category_key: `fact:${r.entity || 'general'}`,
        content: `${r.fact_key}: ${r.fact_value}`,
        importance: Math.round(r.provenance_confidence * 100),
        occurred_at: new Date().toISOString(),
        source: r.provenance_source || 'cognee_extraction',
        relevance_score: Math.min(1, 0.85 + r.provenance_confidence * 0.15),
      }));
    } else if (!generalResult.ok && generalResult.error && generalResult.error !== 'missing_lens') {
      console.warn(`[VTID-01216] general facts retrieval failed: ${generalResult.error}`);
    }

    // --- Merge: Identity Core → Semantic → General (deduplicated by ID) ---
    const seenIds = new Set(identityCoreFacts.map(f => f.id));
    const dedupedSemantic = semanticFacts.filter(f => !seenIds.has(f.id));
    dedupedSemantic.forEach(f => seenIds.add(f.id));
    const dedupedGeneral = generalFacts.filter(f => !seenIds.has(f.id));
    const facts = [...identityCoreFacts, ...dedupedSemantic, ...dedupedGeneral];

    console.log(`[VTID-01216] structured facts: ${identityCoreFacts.length} identity core + ${dedupedSemantic.length} semantic + ${dedupedGeneral.length} general = ${facts.length} total`);

    return {
      facts,
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01216] structured facts retrieval error: ${error.message}`);
    return { facts: [], latency_ms: Date.now() - startTime };
  }
}

/**
 * VTID-01224-FIX: Fetch diary entries to surface in the LLM context pack.
 *
 * VTID-03145 (PR 2): routed through the memory-broker DIARY block —
 * raw table reads no longer live in this file. The broker owns the
 * canonical diary stream.
 *
 * VTID-03153 (CPB-4 anti-regression): forbidden table names are
 * intentionally absent from this file. Reintroducing them is caught
 * by `test/services/context-pack-broker-boundary.test.ts`.
 *
 * Results are returned as MemoryHit[] to merge with other memory hits.
 */
async function fetchDiaryHits(
  lens: ContextLens,
  query: string,
  limit: number = 10
): Promise<{ hits: MemoryHit[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    if (!lens.tenant_id || !lens.user_id) {
      return { hits: [], latency_ms: Date.now() - startTime };
    }

    // VTID-03145 (PR 2): DIARY routed through the memory-broker. The
    // broker owns the canonical diary store. The legacy alternative
    // diary store (voice tool_save_diary_entry write path) is no
    // longer mirrored into the context pack here; that bridge moves
    // when the write path is unified upstream.
    const pack = await getMemoryContext({
      tenant_id: lens.tenant_id,
      user_id: lens.user_id,
      intent: 'recall_history',
      required_blocks: ['DIARY'],
      query: query || undefined,
    });

    const diaryBlock = pack.blocks.DIARY as DiaryBlock | undefined;
    const entries = diaryBlock?.entries ?? [];
    const hits: MemoryHit[] = entries.map((e, idx) => {
      const content = e.content ?? '';
      return {
        id: e.id,
        category_key: e.category_key || 'diary',
        content: content.substring(0, CONTEXT_PACK_CONFIG.MAX_CONTENT_LENGTH),
        importance: 60,
        occurred_at: e.occurred_at,
        source: 'diary',
        relevance_score: computeRelevanceScore(
          { importance: 60, occurred_at: e.occurred_at, content },
          query,
          idx,
        ),
      };
    });

    // Sort by relevance and cap (same as legacy behaviour).
    hits.sort((a, b) => b.relevance_score - a.relevance_score);
    console.log(`[VTID-01224-FIX] fetchDiaryHits: ${hits.length} diary entries found`);

    return {
      hits: hits.slice(0, limit),
      latency_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error(`[VTID-01224-FIX] diary retrieval error: ${error.message}`);
    return { hits: [], latency_ms: Date.now() - startTime };
  }
}

/**
 * Fetch relationship graph context. Returns human-readable strings
 * describing the user's closest connections.
 *
 * VTID-03145 (PR 2): NETWORK routed through the memory-broker NETWORK
 * block. The broker owns the canonical graph traversal; this file
 * does not name graph tables anymore. The output array shape
 * (string[]) is unchanged; each string is now centred on the user-
 * vs-other-side of an edge (the broker resolves the "other side"
 * already).
 *
 * VTID-03153 (CPB-5 anti-regression): forbidden table names are
 * intentionally absent from this file; see
 * `test/services/context-pack-broker-boundary.test.ts`.
 */
async function fetchRelationshipContext(
  lens: ContextLens,
  limit: number = 15
): Promise<{ context: string[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    if (!lens.tenant_id || !lens.user_id) {
      return { context: [], latency_ms: Date.now() - startTime };
    }

    const pack = await getMemoryContext({
      tenant_id: lens.tenant_id,
      user_id: lens.user_id,
      intent: 'social_query',
      required_blocks: ['NETWORK'],
    });

    const networkBlock = pack.blocks.NETWORK as NetworkBlock | undefined;
    const people = networkBlock?.people ?? [];
    const context: string[] = people.slice(0, limit).map(p => {
      const edge = p.edge_type || 'connected to';
      const name = p.display_name || p.node_id;
      return `User ${edge}: ${name} (${p.node_type})`;
    });

    console.log(`[VTID-01216] relationship graph returned ${context.length} connections (NETWORK block)`);
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
  limit: number,
  userId?: string,
): Promise<{ hits: KnowledgeHit[]; latency_ms: number }> {
  const startTime = Date.now();

  try {
    const request: KnowledgeSearchRequest = {
      query,
      maxResults: limit,
      // Pass userId so the answer is generated in the user's preferred
      // language (German by default — community is German-first).
      userId,
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

  // VTID-01224-FIX: Add timeout to Perplexity API fetch
  const webTimeout = fetchWithTimeout();
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
      signal: webTimeout.signal,
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
  } finally {
    webTimeout.clear();
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

// VTID-03158 (CPB-7): the ledger read lives behind the typed
// `vtid-ledger-reader` boundary now. CPB no longer constructs Supabase
// REST URLs for the ledger here. See
// `test/services/context-pack-oasis-boundary.test.ts` for the
// anti-regression contract.

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

  /** VTID-01230: Session ID for session buffer lookup (thread_id or orb session ID) */
  session_id?: string;
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
    calendar: 0,
  };
  const latencies: Record<RetrievalSource, number> = {
    memory_garden: 0,
    knowledge_hub: 0,
    web_search: 0,
    calendar: 0,
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
      fetchKnowledgeHits(input.query, input.router_decision.limits.knowledge_hub, input.lens.user_id ?? undefined)
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

  // VTID-01224-FIX: Diary entries retrieval (stored in their own dedicated tables, broker-owned)
  let diaryHits: MemoryHit[] = [];
  if (input.router_decision.sources_to_query.includes('memory_garden')) {
    retrievalPromises.push(
      fetchDiaryHits(input.lens, input.query, input.router_decision.limits.memory_garden)
        .then(result => {
          diaryHits = result.hits;
        })
    );
  }

  // Intelligent Calendar: fetch calendar context in parallel
  let calendarContext: ContextPack['calendar_context'] | undefined;
  if (input.lens.user_id) {
    retrievalPromises.push(
      (async () => {
        try {
          const { getUserTodayEvents, getUserUpcomingEvents, getCalendarGaps, toSummary } = await import('./calendar-service');
          const role = input.role || 'community';
          const [today, upcoming, gaps] = await Promise.all([
            getUserTodayEvents(input.lens.user_id, role),
            getUserUpcomingEvents(input.lens.user_id, role, 10),
            getCalendarGaps(input.lens.user_id, role, new Date()),
          ]);
          // Journey stage — canonical day_in_journey (same source the ORB
          // greeting and My Journey screen read). The old
          // journey-calendar-mapper getJourneyStage() call here passed
          // `input.conversation_start` (the CURRENT conversation's start
          // time, seconds/minutes old) where it expected the user's
          // REGISTRATION date, so the day-count always floored to 0 — every
          // text conversation was told "Journey: Day 0 of 90", regardless of
          // the user's real tenure.
          let journeyStage: { wave_name: string; day_number: number; total_days: number } | undefined;
          try {
            const SUPABASE_URL = process.env.SUPABASE_URL;
            const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
            if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
              const { createClient: createJourneyClient } = await import('@supabase/supabase-js');
              const { getJourneyState } = await import('./journey/user-journey-service');
              const journeySupabase = createJourneyClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
              const journeyState = await getJourneyState(journeySupabase, input.lens.user_id);
              if (journeyState) {
                journeyStage = {
                  day_number: journeyState.day_in_journey,
                  total_days: journeyState.total_days,
                  wave_name: journeyState.current_wave?.name ?? 'Discovery',
                };
              }
            }
          } catch {}
          calendarContext = {
            today_events: today.map(e => ({ id: e.id, title: e.title, start_time: e.start_time, end_time: e.end_time, event_type: e.event_type, status: e.status })),
            upcoming_events: upcoming.map(e => ({ id: e.id, title: e.title, start_time: e.start_time, end_time: e.end_time, event_type: e.event_type, status: e.status })),
            gaps_today: gaps,
            active_role: role,
            journey_stage: journeyStage,
            patterns: [],
          };
        } catch (calErr: any) {
          console.warn(`[Calendar] Context fetch failed (non-fatal): ${calErr.message}`);
        }
      })()
    );
  }

  // Run tool health + active VTIDs in parallel with the main retrievals
  let toolHealth: ToolHealthStatus[] = [];
  let activeVtids: ActiveVTID[] = [];

  retrievalPromises.push(
    checkToolHealth().then(result => { toolHealth = result; })
  );
  retrievalPromises.push(
    getActiveVTIDs(input.lens.tenant_id).then(result => { activeVtids = result; })
  );

  // VITANA-BRAIN: Fetch OASIS system awareness context (role-gated)
  //
  // VTID-03158 (CPB-8 / CPB-9): all direct Supabase access for this
  // block now lives behind `oasis-context-reader`. CPB owns only the
  // role-routing decision; the reader owns table names, URLs, env
  // reads, and the parallel-fan-out shape.
  let oasisContext: ContextPack['oasis_context'] | undefined;
  const oasisRole = input.role || 'community';
  if (
    oasisRole === 'developer' ||
    oasisRole === 'admin' ||
    oasisRole === 'super_admin' ||
    oasisRole === 'DEV' ||
    oasisRole === 'infra'
  ) {
    retrievalPromises.push(
      (async () => {
        try {
          const block = await getDeveloperOasisContext({
            tenantId: input.lens.tenant_id,
          });
          if (block) {
            oasisContext = block;
            console.log(
              `[OASIS-CTX] Fetched: ${block.active_tasks.length} tasks, ` +
              `${block.recent_deploys.length} deploys, ` +
              `${block.pending_approvals_count} approvals, ` +
              `${block.self_healing_alerts} healing alerts`,
            );
          }
        } catch (oasisErr: any) {
          console.warn(`[OASIS-CTX] OASIS context fetch failed (non-fatal): ${oasisErr.message}`);
        }
      })()
    );
  } else {
    // Community role: surface recent recommendation activations only.
    retrievalPromises.push(
      (async () => {
        try {
          const block = await getCommunityOasisContext(input.lens.user_id);
          if (block) oasisContext = block;
        } catch {}
      })()
    );
  }

  // Execute ALL retrievals in parallel (memory, knowledge, web, facts, relationships, tool health, VTIDs, OASIS)
  // VTID-02000: Load marketplace context (limitations + past purchases + upcoming events + feed stage)
  let marketplaceContext: ContextPack['marketplace_context'] | undefined;
  retrievalPromises.push(
    (async () => {
      try {
        if (!input.lens.user_id) return;
        const hc = await getUserHealthContext(input.lens.user_id, {
          include_calendar: true,
          include_past_purchases: true,
          include_wearable: true,
        });
        const upcomingHints: string[] = [];
        for (const e of hc.upcoming_events.slice(0, 5)) {
          const daysOut = Math.max(
            0,
            Math.round((Date.parse(e.start) - Date.now()) / (1000 * 60 * 60 * 24))
          );
          const tags = e.shifts_recommendations.length
            ? e.shifts_recommendations.join(',')
            : e.event_type;
          upcomingHints.push(`${tags} in ${daysOut}d${e.title ? ` (${e.title})` : ''}`);
        }
        marketplaceContext = {
          lifecycle_stage: hc.lifecycle_stage,
          region_group: hc.region_group,
          scope_preference: hc.scope_preference,
          budget_max_per_product_cents: hc.budget_max_per_product_cents,
          hard_limitations: {
            allergies: hc.allergies,
            dietary_restrictions: hc.dietary_restrictions,
            contraindications: hc.contraindications,
            current_medications: hc.current_medications,
          },
          active_conditions: hc.active_conditions.map((c) => ({ key: c.key, source: c.source })),
          recent_purchases_count: hc.past_purchases.length,
          upcoming_events_hints: upcomingHints,
          marketplace_picks: [], // populated by marketplace-analyzer daily; Phase 0 leaves empty
          wearable_summary_7d: hc.wearable_summary_7d,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[VTID-02000] Marketplace context fetch failed (non-fatal): ${message}`);
      }
    })()
  );

  await Promise.all(retrievalPromises);

  // Merge structured facts + diary hits into memory hits (prepend - higher priority)
  // VTID-01224-FIX: Include diary entries so search_memory tool can find diary data
  //
  // Phase B (Finding 2): keep an UNSLICED candidate pool. The naive path slices
  // to MAX_MEMORY_HITS here by relevance_score; the ranked path must instead get
  // to choose its top-N from the FULL merged pool, so a high-importance/recent
  // candidate sitting just below the old relevance_score cutoff can still be
  // selected. We compute the naive result exactly as before (byte-for-byte for
  // the flag-OFF path) AND retain the unsliced pool for the ranker.
  const mergeItems = [...structuredFacts, ...diaryHits];
  // `memoryPool` is the full, unsliced candidate set in relevance_score order
  // when merges happened, or the raw fetch result otherwise (mirrors the
  // original control flow where the merge block was skipped with no merges).
  let memoryPool: MemoryHit[] = memoryHits;
  if (mergeItems.length > 0) {
    memoryPool = [...mergeItems, ...memoryHits];
    // Re-sort by relevance (full pool, NO slice — slice deferred to the naive
    // computation below so the ranker can see every candidate).
    memoryPool.sort((a, b) => b.relevance_score - a.relevance_score);
    // Naive selection: relevance_score desc, sliced to the budget. This is the
    // exact output the old code produced and what ships when both flags are OFF.
    memoryHits = memoryPool.slice(0, CONTEXT_PACK_CONFIG.MAX_MEMORY_HITS);
    hitCounts.memory_garden = memoryHits.length;
  }

  // ===========================================================================
  // Phase B (ORB Memory Resilience): relevance-ranked memory selection.
  //
  // At this point `memoryHits` is the NAIVE selection: merged, relevance_score
  // desc, sliced to MAX_MEMORY_HITS. Phase B replaces "first N by relevance_score"
  // with a relevance-RANKED top-N (importance + recency + optional similarity)
  // so the content that survives the cap is the most useful.
  //
  // Finding 2: the ranker is fed the UNSLICED `memoryPool`, not the naive
  // (already-sliced) `memoryHits`. This lets ranking SELECT the true top-N by
  // the new formula from the full candidate set instead of merely REORDERING
  // the naive survivors. `topK` still caps the output at MAX_MEMORY_HITS, so the
  // size budget is unchanged.
  //
  // Behavior-safe:
  //   - When neither flag is live, this block is a no-op — `memoryHits` ships
  //     byte-for-byte as the naive path produced it.
  //   - VOICE_RANKING_SHADOW: compute the ranked set, log a structured
  //     [memory.retrieval.shadow] comparison, but ship the naive set unchanged.
  //   - BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL: ship the ranked set (same budget).
  // Both flags default OFF (FEATURE_<NAME>_ENV unset → 'off').
  // ===========================================================================
  const rankedRetrievalLive = isFeatureLive('BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL');
  const rankingShadowLive = isFeatureLive('VOICE_RANKING_SHADOW');
  if (rankedRetrievalLive || rankingShadowLive) {
    const rankInputs = {
      // UNSLICED pool: ranker selects top-`topK` from every candidate.
      hits: memoryPool,
      topK: CONTEXT_PACK_CONFIG.MAX_MEMORY_HITS,
      now: new Date(),
      // MemoryHit carries no embedding column today, so similarity degrades to 0
      // and ranking reduces to importance + recency. Seam left open for later.
      intentEmbedding: undefined as number[] | undefined,
    };
    if (rankingShadowLive) {
      // Shadow compares the NAIVE sliced set (what ships when flag is off)
      // against the ranked set, so the diff reflects exactly what flipping the
      // flag would change.
      const { ranked, comparison } = shadowCompareHits(memoryHits, rankInputs);
      // Structured shadow log: old order vs new order, char totals, overlap.
      console.log(
        `[memory.retrieval.shadow] ${JSON.stringify({
          user_id: input.lens.user_id ?? null,
          query: input.query,
          applied: rankedRetrievalLive ? 'ranked' : 'naive',
          ...comparison,
        })}`,
      );
      if (rankedRetrievalLive) {
        memoryHits = ranked;
        hitCounts.memory_garden = memoryHits.length;
      }
    } else if (rankedRetrievalLive) {
      memoryHits = rankMemoryHits(rankInputs);
      hitCounts.memory_garden = memoryHits.length;
    }
  }

  // VTID-01230: Session buffer — inject recent turns from Tier 0
  // This is the FASTEST path: no DB round-trip, guaranteed turn-to-turn coherence
  const sessionId = input.session_id || input.thread_id;

  // VTID-01955: Read from Memorystore Redis when tier0_redis_enabled flag is on
  // (multi-instance shared so "what did I just say?" survives Cloud Run cold
  // starts and worker scale-out). Falls back to in-process Map on any error
  // OR when Redis returns empty (cold cache, brand-new session).
  // Writes are dual-routed unconditionally — both buffers receive every turn.
  let sessionCtx = getSessionContext(sessionId);
  let sessionBufferFormatted = formatSessionBufferForLLM(sessionId);
  let bufferSource: 'in-process' | 'redis' = 'in-process';
  try {
    if (await isTier0RedisEnabled()) {
      const redisCtx = await getSessionContextRedis(sessionId);
      if (redisCtx && redisCtx.turn_count > 0) {
        // Redis hit: use Redis turns. Keep session_facts from in-process
        // (facts aren't yet mirrored to Redis — Phase 5+ work).
        const inProcessFacts = sessionCtx?.session_facts ?? {};
        sessionCtx = {
          recent_turns: redisCtx.recent_turns.map((t) => ({
            role: t.role,
            content: t.content,
            timestamp: t.timestamp,
          })),
          session_facts: inProcessFacts,
          turn_count: redisCtx.turn_count,
          is_continuation: redisCtx.is_continuation,
        };
        sessionBufferFormatted = await formatRedisBufferForLLM(sessionId);
        bufferSource = 'redis';
      }
    }
  } catch (err) {
    console.warn('[VTID-01955] tier0_redis read failed (falling back to in-process):', (err as Error)?.message);
  }

  const sessionBufferData = sessionCtx ? {
    turn_count: sessionCtx.turn_count,
    session_facts_count: Object.keys(sessionCtx.session_facts).length,
    formatted_context: sessionBufferFormatted,
  } : undefined;

  if (sessionBufferData && sessionBufferData.turn_count > 0) {
    console.log(`[VTID-01230] Session buffer (source=${bufferSource}): ${sessionBufferData.turn_count} turns, ${sessionBufferData.session_facts_count} facts for session ${sessionId.substring(0, 8)}...`);
  }

  // Estimate token usage
  const estimateTokens = (obj: unknown): number => {
    const str = JSON.stringify(obj);
    return Math.ceil(str.length / CONTEXT_PACK_CONFIG.CHARS_PER_TOKEN);
  };

  const sessionBufferTokens = sessionBufferFormatted
    ? Math.ceil(sessionBufferFormatted.length / CONTEXT_PACK_CONFIG.CHARS_PER_TOKEN)
    : 0;

  const tokensUsed =
    estimateTokens(memoryHits) +
    estimateTokens(knowledgeHits) +
    estimateTokens(webHits) +
    estimateTokens(activeVtids) +
    estimateTokens(toolHealth) +
    estimateTokens(relationshipContext) +
    sessionBufferTokens +
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
    calendar_context: calendarContext,
    oasis_context: oasisContext,
    marketplace_context: marketplaceContext,
    session_buffer: sessionBufferData,

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

  // VTID-01966 Phase 2: HIPAA-grade audit log entry for every memory read.
  // Fire-and-forget — never blocks the LLM call. Health-scoped writes get the
  // dedicated index for fast HIPAA replay.
  auditMemoryRead({
    tenant_id: input.lens.tenant_id,
    user_id: input.lens.user_id,
    tier: 'context-pack-builder',
    actor_id: `conversation-${input.channel}`,
    source_engine: 'context-pack-builder',
    source_event_id: packId,
    health_scope: hitCounts.memory_garden > 0,  // memory garden hits often touch health
    details: {
      intent: input.query?.slice(0, 80) ?? null,
      blocks_returned: [
        ...(memoryHits.length > 0 ? ['MEMORY'] : []),
        ...(knowledgeHits.length > 0 ? ['KNOWLEDGE'] : []),
        ...(webHits.length > 0 ? ['WEB'] : []),
        ...(relationshipContext.length > 0 ? ['RELATIONSHIPS'] : []),
        ...(calendarContext ? ['CALENDAR'] : []),
        ...(oasisContext ? ['OASIS'] : []),
        ...(sessionBufferData && sessionBufferData.turn_count > 0 ? ['SESSION_BUFFER'] : []),
      ],
      item_counts: hitCounts,
      latency_ms: pack.assembly_duration_ms,
      cache_hit: bufferSource === 'redis',
      tokens_used: tokensUsed,
      channel: input.channel,
      thread_id: input.thread_id,
      router_decision_rule: input.router_decision?.matched_rule,
      router_decision_sources: input.router_decision?.sources_to_query,
    },
  });

  return pack;
}

/**
 * Format Context Pack for LLM system instruction injection
 */
export function formatContextPackForLLM(pack: ContextPack, opts?: { userTimezone?: string }): string {
  const userTz = opts?.userTimezone || 'UTC';
  let context = '';

  // VTID-01230: Session buffer FIRST — highest priority, most recent context
  // This ensures the LLM always sees what was just said, even before async
  // fact extraction completes or DB writes propagate
  if (pack.session_buffer && pack.session_buffer.formatted_context) {
    context += pack.session_buffer.formatted_context;
  }

  // Identity section
  context += `<user_context>\n`;
  context += `User: ${pack.identity.display_name || pack.identity.user_id}\n`;
  context += `Role: ${pack.identity.role}\n`;
  context += `Session: Turn ${pack.session_state.turn_number} via ${pack.session_state.channel}\n`;

  // Extract and embed preferred language in identity context
  const preferredLang = extractLanguageFromContextPack(pack);
  if (preferredLang) {
    context += `Preferred Language: ${preferredLang}\n`;
  }

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

  // Intelligent Calendar section — the 4th pillar of infinite memory
  if (pack.calendar_context) {
    const cal = pack.calendar_context;
    context += `<calendar_memory>\n`;
    context += `All calendar times below are in the user's local timezone (${userTz}). When speaking to the user, state these times verbatim — do NOT convert to UTC or any other timezone.\n\n`;

    if (cal.today_events.length > 0) {
      context += `Today's schedule (${userTz}):\n`;
      for (const ev of cal.today_events) {
        const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
        context += `- ${time}: ${ev.title} (${ev.event_type})\n`;
      }
      context += `\n`;
    } else {
      context += `Today's schedule: No events scheduled.\n\n`;
    }

    if (cal.upcoming_events.length > 0) {
      context += `Upcoming (next 7 days, ${userTz}):\n`;
      for (const ev of cal.upcoming_events.slice(0, 5)) {
        const date = new Date(ev.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTz });
        const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
        context += `- ${date} ${time}: ${ev.title}\n`;
      }
      context += `\n`;
    }

    if (cal.gaps_today.length > 0) {
      context += `Free time today (${userTz}):\n`;
      for (const gap of cal.gaps_today.slice(0, 3)) {
        const start = new Date(gap.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
        const end = new Date(gap.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
        context += `- ${start}–${end} (${gap.duration_minutes} min free)\n`;
      }
      context += `\n`;
    }

    if (cal.journey_stage) {
      context += `Journey: Day ${cal.journey_stage.day_number} of ${cal.journey_stage.total_days} — "${cal.journey_stage.wave_name}"\n\n`;
    }

    if (cal.patterns.length > 0) {
      context += `Calendar patterns:\n`;
      for (const p of cal.patterns) {
        context += `- ${p}\n`;
      }
      context += `\n`;
    }

    context += `When the user asks about their schedule, reference these events. Suggest activities for free time slots. When they ask to change, add, or cancel events, include calendar_actions in your response.\n`;
    context += `</calendar_memory>\n\n`;
  }

  // VITANA-BRAIN: OASIS system awareness (role-gated — only for developer/admin)
  if (pack.oasis_context) {
    const oasis = pack.oasis_context;
    const hasContent = oasis.active_tasks.length > 0 || oasis.recent_deploys.length > 0 || oasis.pending_approvals_count > 0 || oasis.self_healing_alerts > 0 || oasis.recent_recommendations.length > 0;

    if (hasContent) {
      context += `<system_awareness>\n`;

      if (oasis.active_tasks.length > 0) {
        context += `Active tasks:\n`;
        for (const task of oasis.active_tasks) {
          context += `- ${task.vtid}: ${task.title} (${task.status})\n`;
        }
        context += `\n`;
      }

      if (oasis.recent_deploys.length > 0) {
        context += `Recent deployments:\n`;
        for (const deploy of oasis.recent_deploys) {
          const ago = Math.round((Date.now() - new Date(deploy.created_at).getTime()) / 60000);
          const agoText = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
          context += `- ${deploy.service}: ${deploy.status} (${agoText})\n`;
        }
        context += `\n`;
      }

      if (oasis.pending_approvals_count > 0) {
        context += `Pending approvals: ${oasis.pending_approvals_count}\n\n`;
      }

      if (oasis.self_healing_alerts > 0) {
        context += `Self-healing alerts (last 24h): ${oasis.self_healing_alerts}\n\n`;
      }

      if (oasis.recent_recommendations.length > 0) {
        context += `Recent recommendations:\n`;
        for (const rec of oasis.recent_recommendations) {
          context += `- ${rec.title} (${rec.status})\n`;
        }
        context += `\n`;
      }

      context += `When the user asks about tasks, deployments, or system health, reference this data. For community users, reference recommendations only.\n`;
      context += `</system_awareness>\n\n`;
    }
  }

  // VTID-02000: Marketplace context — limitations + upcoming events + feed stage
  if (pack.marketplace_context) {
    const m = pack.marketplace_context;
    context += `<marketplace_context>\n`;
    if (m.lifecycle_stage) context += `Lifecycle stage: ${m.lifecycle_stage}\n`;
    if (m.region_group) context += `Region: ${m.region_group}\n`;
    context += `Product scope preference: ${m.scope_preference}\n`;
    if (m.budget_max_per_product_cents) {
      context += `Budget ceiling per product: ${(m.budget_max_per_product_cents / 100).toFixed(0)}\n`;
    }
    const limits = m.hard_limitations;
    const hardParts: string[] = [];
    if (limits.allergies.length) hardParts.push(`allergies: ${limits.allergies.join(', ')}`);
    if (limits.dietary_restrictions.length) hardParts.push(`dietary: ${limits.dietary_restrictions.join(', ')}`);
    if (limits.contraindications.length) hardParts.push(`conditions: ${limits.contraindications.join(', ')}`);
    if (limits.current_medications.length) hardParts.push(`medications: ${limits.current_medications.join(', ')}`);
    if (hardParts.length) {
      context += `Hard limitations (NEVER recommend products that violate): ${hardParts.join('; ')}\n`;
    }
    if (m.active_conditions.length) {
      context += `Active conditions: ${m.active_conditions.map((c) => c.key).join(', ')}\n`;
    }
    if (m.upcoming_events_hints.length) {
      context += `Upcoming events: ${m.upcoming_events_hints.join('; ')}\n`;
    }
    // VTID-02100: wearable signal if present
    const w = m.wearable_summary_7d;
    if (w) {
      const parts: string[] = [];
      if (w.sleep_avg_minutes) parts.push(`sleep avg ${(w.sleep_avg_minutes / 60).toFixed(1)}h`);
      if (w.sleep_deep_pct) parts.push(`deep sleep ${w.sleep_deep_pct.toFixed(1)}%`);
      if (w.hrv_avg_ms) parts.push(`HRV ${w.hrv_avg_ms.toFixed(0)}ms`);
      if (w.resting_hr) parts.push(`resting HR ${w.resting_hr}`);
      if (w.activity_minutes) parts.push(`${w.activity_minutes} min active/day`);
      if (w.workout_count) parts.push(`${w.workout_count} workouts/7d`);
      if (parts.length) {
        context += `Wearable 7-day: ${parts.join(', ')}\n`;
      }
    }
    if (m.recent_purchases_count > 0) {
      context += `Past purchases: ${m.recent_purchases_count} (avoid re-recommending recently purchased items)\n`;
    }
    if (m.marketplace_picks.length) {
      context += `Top marketplace picks for this user:\n`;
      for (const p of m.marketplace_picks.slice(0, 5)) {
        context += `- ${p.title} (${p.product_id}): ${p.match_reason}\n`;
      }
    }
    context += `When the user asks about products or shopping, use search_marketplace_products or open_discover_feed. Never surface products that violate hard limitations.\n`;
    context += `</marketplace_context>\n\n`;
  }

  return context;
}

/**
 * Extract the user's preferred language from a context pack's structured facts.
 * Returns the language name (e.g. "German", "Serbian") or null if not set.
 */
export function extractLanguageFromContextPack(pack: ContextPack): string | null {
  const langHit = pack.memory_hits.find(
    h => h.category_key.startsWith('fact:') && h.content.toLowerCase().includes('preferred_language')
  );
  if (langHit) {
    // Content format: "preferred_language: German"
    const parts = langHit.content.split(':');
    if (parts.length >= 2) {
      return parts.slice(1).join(':').trim();
    }
  }
  return null;
}

/**
 * Build a language directive string for system instructions.
 * Returns an empty string if no language preference is found.
 */
export function buildLanguageDirective(languageName: string | null): string {
  if (!languageName) return '';
  return `\nLANGUAGE: Respond ONLY in ${languageName}. Do NOT mix languages or switch to English unless the user explicitly asks.\n`;
}
