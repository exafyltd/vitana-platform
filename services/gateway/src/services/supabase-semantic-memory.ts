/**
 * VTID-01184: Supabase Semantic Memory Service
 *
 * Provides semantic (vector) search and memory operations using
 * Supabase Postgres with pgvector extension.
 *
 * This is the SINGLE SOURCE OF TRUTH for memory persistence.
 * No dual-source with local vector stores (Qdrant, etc.)
 *
 * GOVERNANCE:
 * - All queries use hard filters: tenant_id, user_id, workspace_scope
 * - Context Lens is REQUIRED for all operations
 * - Embeddings stored in Supabase, not external services
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  ContextLens,
  SemanticSearchRequest,
  SemanticSearchResponse,
  SemanticSearchResult,
  MemoryWritePayload,
  MemoryWriteResponse,
  ItemNeedingEmbedding,
  EmbeddingUpdate,
  BatchEmbeddingUpdateResponse,
  ReembedTriggerRequest,
  ReembedTriggerResponse,
  validateContextLens,
} from '../types/context-lens';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01184';
const SERVICE_NAME = 'supabase-semantic-memory';

// Embedding dimensions (must match migration)
const EMBEDDING_DIMENSIONS = 1536;

// Default embedding model
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

// =============================================================================
// Supabase Client Factory
// =============================================================================

/**
 * Create a service-role Supabase client for memory operations
 * Service role bypasses RLS for system operations
 */
function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`[${VTID}] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// Semantic Search
// =============================================================================

/**
 * Perform semantic search using pgvector similarity
 *
 * HARD FILTERS ENFORCED:
 * - tenant_id (REQUIRED)
 * - user_id (REQUIRED)
 * - workspace_scope (REQUIRED)
 * - active_role (optional)
 *
 * @param request - Search request with query and Context Lens
 * @returns Ranked search results
 */
export async function semanticSearch(
  request: SemanticSearchRequest
): Promise<SemanticSearchResponse> {
  const startTime = Date.now();

  // Validate Context Lens
  if (!validateContextLens(request.lens)) {
    return {
      ok: false,
      results: [],
      query: request.query,
      lens: request.lens,
      total_found: 0,
      search_time_ms: 0,
      error: 'Invalid Context Lens: tenant_id, user_id, and workspace_scope are required'
    };
  }

  // Check for embedding
  if (!request.query_embedding || request.query_embedding.length !== EMBEDDING_DIMENSIONS) {
    return {
      ok: false,
      results: [],
      query: request.query,
      lens: request.lens,
      total_found: 0,
      search_time_ms: Date.now() - startTime,
      error: `Query embedding required (${EMBEDDING_DIMENSIONS} dimensions). Use embedding service to generate.`
    };
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return {
      ok: false,
      results: [],
      query: request.query,
      lens: request.lens,
      total_found: 0,
      search_time_ms: Date.now() - startTime,
      error: 'Supabase not configured'
    };
  }

  try {
    // Format embedding as PostgreSQL vector string
    const embeddingStr = `[${request.query_embedding.join(',')}]`;

    // Call the memory_semantic_search RPC
    const { data, error } = await supabase.rpc('memory_semantic_search', {
      p_query_embedding: embeddingStr,
      p_top_k: request.top_k ?? 10,
      p_tenant_id: request.lens.tenant_id,
      p_user_id: request.lens.user_id,
      p_workspace_scope: request.lens.workspace_scope,
      p_active_role: request.lens.active_role ?? null,
      p_categories: request.lens.allowed_categories ?? null,
      p_visibility_scope: request.lens.visibility_scope ?? 'private',
      p_max_age_hours: request.lens.max_age_hours ?? null,
      p_recency_boost: request.recency_boost ?? true
    });

    if (error) {
      // Check for function not found (migration not applied)
      if (error.message.includes('does not exist')) {
        console.warn(`[${VTID}] memory_semantic_search RPC not found (migration pending)`);
        return {
          ok: false,
          results: [],
          query: request.query,
          lens: request.lens,
          total_found: 0,
          search_time_ms: Date.now() - startTime,
          error: 'Semantic search not available (VTID-01184 migration required)'
        };
      }
      throw error;
    }

    const results: SemanticSearchResult[] = (data || []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      content: row.content as string,
      content_json: row.content_json as Record<string, unknown> | null,
      category_key: row.category_key as string,
      source: row.source as SemanticSearchResult['source'],
      importance: row.importance as number,
      occurred_at: row.occurred_at as string,
      created_at: row.created_at as string,
      active_role: row.active_role as string | null,
      workspace_scope: row.workspace_scope as string | null,
      visibility_scope: row.visibility_scope as string | null,
      vtid: row.vtid as string | null,
      origin_service: row.origin_service as string | null,
      conversation_id: row.conversation_id as string | null,
      similarity_score: row.similarity_score as number,
      recency_score: row.recency_score as number,
      combined_score: row.combined_score as number,
    }));

    const searchTimeMs = Date.now() - startTime;

    console.log(`[${VTID}] Semantic search: ${results.length} results in ${searchTimeMs}ms`);

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.semantic_search.completed',
      source: SERVICE_NAME,
      status: 'success',
      message: `Semantic search returned ${results.length} results`,
      payload: {
        query_preview: request.query.substring(0, 100),
        results_count: results.length,
        top_similarity: results[0]?.similarity_score ?? 0,
        search_time_ms: searchTimeMs,
        lens: {
          tenant_id: request.lens.tenant_id,
          user_id: request.lens.user_id,
          workspace_scope: request.lens.workspace_scope,
          active_role: request.lens.active_role
        }
      }
    }).catch(err => console.warn(`[${VTID}] OASIS event failed:`, err.message));

    return {
      ok: true,
      results,
      query: request.query,
      lens: request.lens,
      total_found: results.length,
      search_time_ms: searchTimeMs
    };

  } catch (err: any) {
    console.error(`[${VTID}] Semantic search error:`, err.message);

    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.semantic_search.failed',
      source: SERVICE_NAME,
      status: 'error',
      message: `Semantic search failed: ${err.message}`,
      payload: {
        query_preview: request.query.substring(0, 100),
        error: err.message,
        search_time_ms: Date.now() - startTime
      }
    }).catch(() => {});

    return {
      ok: false,
      results: [],
      query: request.query,
      lens: request.lens,
      total_found: 0,
      search_time_ms: Date.now() - startTime,
      error: err.message
    };
  }
}

// =============================================================================
// Memory Write (with embedding support)
// =============================================================================

/**
 * Write a memory item with optional embedding
 *
 * Uses memory_write_item_v2 RPC which supports:
 * - workspace_scope
 * - provenance (vtid, origin_service, conversation_id)
 * - pre-computed embeddings
 *
 * @param payload - Memory write payload with Context Lens
 * @returns Write result
 */
export async function writeMemoryItem(
  payload: MemoryWritePayload
): Promise<MemoryWriteResponse> {
  // Validate Context Lens
  if (!validateContextLens(payload.lens)) {
    return {
      ok: false,
      error: 'Invalid Context Lens: tenant_id, user_id, and workspace_scope are required'
    };
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return {
      ok: false,
      error: 'Supabase not configured'
    };
  }

  try {
    // Build the RPC payload
    const rpcPayload: Record<string, unknown> = {
      tenant_id: payload.lens.tenant_id,
      user_id: payload.lens.user_id,
      workspace_scope: payload.lens.workspace_scope,
      active_role: payload.lens.active_role,
      content: payload.content,
      content_json: payload.content_json,
      source: payload.source,
      category_key: payload.category_key ?? 'conversation',
      importance: payload.importance ?? 10,
      occurred_at: payload.occurred_at,
      vtid: payload.vtid ?? VTID,
      origin_service: payload.origin_service ?? SERVICE_NAME,
      conversation_id: payload.conversation_id,
      visibility_scope: payload.lens.visibility_scope ?? 'private',
    };

    // Add embedding if provided
    if (payload.embedding && payload.embedding.length === EMBEDDING_DIMENSIONS) {
      rpcPayload.embedding = `[${payload.embedding.join(',')}]`;
      rpcPayload.embedding_model = payload.embedding_model ?? DEFAULT_EMBEDDING_MODEL;
    }

    // Call memory_write_item_v2 RPC
    const { data, error } = await supabase.rpc('memory_write_item_v2', {
      p_payload: rpcPayload
    });

    if (error) {
      // Fallback to original RPC if v2 not available
      if (error.message.includes('does not exist')) {
        console.warn(`[${VTID}] memory_write_item_v2 not found, falling back to v1`);
        return await writeMemoryItemV1(payload, supabase);
      }
      throw error;
    }

    const result = data as MemoryWriteResponse;

    if (result.ok) {
      console.log(`[${VTID}] Memory written: ${result.id} (${result.category_key}, embedding=${result.has_embedding})`);

      await emitOasisEvent({
        vtid: VTID,
        type: 'memory.write.completed',
        source: SERVICE_NAME,
        status: 'success',
        message: `Memory item written: ${result.id}`,
        payload: {
          memory_id: result.id,
          category_key: result.category_key,
          workspace_scope: result.workspace_scope,
          has_embedding: result.has_embedding,
          tenant_id: payload.lens.tenant_id,
          user_id: payload.lens.user_id
        }
      }).catch(err => console.warn(`[${VTID}] OASIS event failed:`, err.message));
    }

    return result;

  } catch (err: any) {
    console.error(`[${VTID}] Memory write error:`, err.message);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Fallback to v1 write RPC (without embedding columns)
 */
async function writeMemoryItemV1(
  payload: MemoryWritePayload,
  supabase: SupabaseClient
): Promise<MemoryWriteResponse> {
  const rpcPayload = {
    source: payload.source,
    content: payload.content,
    content_json: payload.content_json,
    category_key: payload.category_key ?? 'conversation',
    importance: payload.importance ?? 10,
    occurred_at: payload.occurred_at,
  };

  // Set context first
  await supabase.rpc('dev_bootstrap_request_context', {
    p_tenant_id: payload.lens.tenant_id,
    p_active_role: payload.lens.active_role ?? 'developer'
  }).catch(() => {});

  const { data, error } = await supabase.rpc('memory_write_item', {
    p_payload: rpcPayload
  });

  if (error) {
    throw error;
  }

  return data as MemoryWriteResponse;
}

// =============================================================================
// Embedding Pipeline Operations (Service Role Only)
// =============================================================================

/**
 * Get items that need embeddings generated
 *
 * Used by the embedding pipeline to find items without embeddings.
 *
 * @param limit - Maximum items to return
 * @param filters - Optional filters
 * @returns Items needing embeddings
 */
export async function getItemsNeedingEmbeddings(
  limit: number = 100,
  filters?: {
    tenant_id?: string;
    category_key?: string;
    since?: string;
  }
): Promise<{ ok: boolean; items: ItemNeedingEmbedding[]; error?: string }> {
  const supabase = createServiceClient();
  if (!supabase) {
    return { ok: false, items: [], error: 'Supabase not configured' };
  }

  try {
    const { data, error } = await supabase.rpc('memory_get_items_needing_embeddings', {
      p_limit: limit,
      p_tenant_id: filters?.tenant_id ?? null,
      p_category_key: filters?.category_key ?? null,
      p_since: filters?.since ?? null
    });

    if (error) {
      if (error.message.includes('does not exist')) {
        return { ok: false, items: [], error: 'Embedding pipeline RPC not available (migration required)' };
      }
      throw error;
    }

    const items: ItemNeedingEmbedding[] = (data || []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      content: row.content as string,
      category_key: row.category_key as string,
      tenant_id: row.tenant_id as string,
      user_id: row.user_id as string,
      created_at: row.created_at as string,
    }));

    console.log(`[${VTID}] Found ${items.length} items needing embeddings`);

    return { ok: true, items };

  } catch (err: any) {
    console.error(`[${VTID}] Get items needing embeddings error:`, err.message);
    return { ok: false, items: [], error: err.message };
  }
}

/**
 * Update embeddings for multiple items
 *
 * Used by the embedding pipeline to batch-update embeddings.
 *
 * @param updates - Array of embedding updates
 * @returns Update result
 */
export async function updateEmbeddings(
  updates: EmbeddingUpdate[]
): Promise<BatchEmbeddingUpdateResponse> {
  const supabase = createServiceClient();
  if (!supabase) {
    return { ok: false, updated_count: 0, requested_count: updates.length, error: 'Supabase not configured' };
  }

  try {
    // Convert embeddings to PostgreSQL vector format
    const formattedUpdates = updates.map(u => ({
      id: u.id,
      embedding: `[${u.embedding.join(',')}]`,
      embedding_model: u.embedding_model
    }));

    const { data, error } = await supabase.rpc('memory_update_embeddings', {
      p_updates: formattedUpdates
    });

    if (error) {
      if (error.message.includes('does not exist')) {
        return { ok: false, updated_count: 0, requested_count: updates.length, error: 'Embedding update RPC not available (migration required)' };
      }
      throw error;
    }

    const result = data as BatchEmbeddingUpdateResponse;

    console.log(`[${VTID}] Updated embeddings: ${result.updated_count}/${result.requested_count}`);

    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.embeddings.updated',
      source: SERVICE_NAME,
      status: 'success',
      message: `Updated ${result.updated_count} embeddings`,
      payload: {
        updated_count: result.updated_count,
        requested_count: result.requested_count
      }
    }).catch(() => {});

    return result;

  } catch (err: any) {
    console.error(`[${VTID}] Update embeddings error:`, err.message);
    return { ok: false, updated_count: 0, requested_count: updates.length, error: err.message };
  }
}

/**
 * Mark items for re-embedding
 *
 * Admin operation to trigger re-embedding of existing items.
 *
 * @param request - Filter criteria for items to re-embed
 * @returns Number of items marked
 */
export async function markForReembed(
  request: ReembedTriggerRequest
): Promise<ReembedTriggerResponse> {
  const supabase = createServiceClient();
  if (!supabase) {
    return { ok: false, marked_for_reembed: 0, filters: request, error: 'Supabase not configured' };
  }

  try {
    const { data, error } = await supabase.rpc('memory_mark_for_reembed', {
      p_tenant_id: request.tenant_id ?? null,
      p_user_id: request.user_id ?? null,
      p_category_key: request.category_key ?? null,
      p_since: request.since ?? null,
      p_until: request.until ?? null
    });

    if (error) {
      if (error.message.includes('does not exist')) {
        return { ok: false, marked_for_reembed: 0, filters: request, error: 'Re-embed RPC not available (migration required)' };
      }
      throw error;
    }

    const result = data as ReembedTriggerResponse;

    console.log(`[${VTID}] Marked ${result.marked_for_reembed} items for re-embedding`);

    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.reembed.triggered',
      source: SERVICE_NAME,
      status: 'success',
      message: `Marked ${result.marked_for_reembed} items for re-embedding`,
      payload: {
        marked_for_reembed: result.marked_for_reembed,
        filters: request
      }
    }).catch(() => {});

    return result;

  } catch (err: any) {
    console.error(`[${VTID}] Mark for re-embed error:`, err.message);
    return { ok: false, marked_for_reembed: 0, filters: request, error: err.message };
  }
}

// =============================================================================
// Context Building (Semantic + Formatted)
// =============================================================================

/**
 * Build memory context for prompt injection using semantic search
 *
 * This replaces the old keyword-based context retrieval with
 * vector similarity search.
 *
 * @param query - Query text for semantic matching
 * @param lens - Context Lens for filtering
 * @param topK - Number of results to include
 * @returns Formatted context string
 */
export async function buildSemanticContext(
  query: string,
  queryEmbedding: number[],
  lens: ContextLens,
  topK: number = 10
): Promise<{
  ok: boolean;
  context: string;
  results: SemanticSearchResult[];
  error?: string;
}> {
  const searchResult = await semanticSearch({
    query,
    query_embedding: queryEmbedding,
    top_k: topK,
    lens,
    recency_boost: true
  });

  if (!searchResult.ok) {
    return {
      ok: false,
      context: '',
      results: [],
      error: searchResult.error
    };
  }

  // Format results for prompt injection
  const context = formatResultsForPrompt(searchResult.results);

  return {
    ok: true,
    context,
    results: searchResult.results
  };
}

/**
 * Format search results for prompt injection
 */
function formatResultsForPrompt(results: SemanticSearchResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Relevant Memory Context (Semantic Search)');
  lines.push('');

  // Group by category
  const byCategory: Record<string, SemanticSearchResult[]> = {};
  for (const result of results) {
    if (!byCategory[result.category_key]) {
      byCategory[result.category_key] = [];
    }
    byCategory[result.category_key].push(result);
  }

  // Category priority order
  const categoryOrder = ['personal', 'relationships', 'preferences', 'health', 'goals', 'conversation'];
  const sortedCategories = Object.keys(byCategory).sort((a, b) => {
    const aIdx = categoryOrder.indexOf(a);
    const bIdx = categoryOrder.indexOf(b);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  // Format each category
  for (const category of sortedCategories) {
    const items = byCategory[category];
    lines.push(`### ${formatCategoryName(category)}`);

    for (const item of items.slice(0, 10)) {
      const timestamp = formatRelativeTime(item.occurred_at);
      const content = truncateContent(item.content, 300);
      const relevanceMarker = item.similarity_score >= 0.8 ? '*' :
                              item.similarity_score >= 0.6 ? '+' : '-';

      lines.push(`${relevanceMarker} [${timestamp}] ${content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatCategoryName(category: string): string {
  const names: Record<string, string> = {
    personal: 'Personal Identity',
    conversation: 'Recent Conversations',
    preferences: 'User Preferences',
    goals: 'Goals & Plans',
    health: 'Health & Wellness',
    relationships: 'Relationships & Family',
    tasks: 'Tasks & Work',
    community: 'Community',
    products_services: 'Products & Services',
    events_meetups: 'Events',
    notes: 'Notes'
  };
  return names[category] || category;
}

function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 5) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

// =============================================================================
// Exports
// =============================================================================

export {
  VTID,
  SERVICE_NAME,
  EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  createServiceClient
};
