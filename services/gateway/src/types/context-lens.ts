/**
 * VTID-01184: Active Context Lens Types
 *
 * The Context Lens is a required object for every memory query.
 * It enforces hard filters for tenant isolation, user identity,
 * workspace scope, and role-based access control.
 *
 * GOVERNANCE:
 * - tenant_id: REQUIRED - enforces tenant isolation
 * - user_id: REQUIRED - enforces user-level access control
 * - workspace_scope: REQUIRED - separates prod/dev data
 * - active_role: OPTIONAL - role-based filtering
 */

// =============================================================================
// Core Context Lens Type
// =============================================================================

/**
 * Active Context Lens - REQUIRED for all memory operations
 *
 * This object encapsulates the security context for memory queries.
 * All queries MUST include tenant_id and user_id at minimum.
 */
export interface ContextLens {
  /**
   * Tenant ID - REQUIRED
   * UUID identifying the tenant/organization
   * Hard filter: cannot retrieve memories from other tenants
   */
  tenant_id: string;

  /**
   * User ID - REQUIRED
   * UUID identifying the user
   * Hard filter: cannot retrieve memories from other users
   */
  user_id: string;

  /**
   * Workspace Scope - REQUIRED
   * 'product' for production, 'dev' for development/testing
   * Prevents dev data from polluting production context
   */
  workspace_scope: 'product' | 'dev';

  /**
   * Active Role - OPTIONAL
   * The user's current role (e.g., 'patient', 'professional', 'admin')
   * Used for role-based memory filtering
   */
  active_role?: string;

  /**
   * Allowed Categories - OPTIONAL
   * Restrict retrieval to specific memory categories
   * If null, all categories are allowed
   */
  allowed_categories?: string[];

  /**
   * Visibility Scope - OPTIONAL (defaults to 'private')
   * 'private': only user's own memories
   * 'shared': includes memories shared with user
   * 'public': includes public memories
   */
  visibility_scope?: 'private' | 'shared' | 'public';

  /**
   * Max Age Hours - OPTIONAL
   * Limit memories to within this time window
   * If null, no time limit is applied
   */
  max_age_hours?: number;
}

// =============================================================================
// Semantic Search Request/Response Types
// =============================================================================

/**
 * Semantic search request with Context Lens
 */
export interface SemanticSearchRequest {
  /**
   * Query text to search for semantically
   */
  query: string;

  /**
   * Pre-computed query embedding (1536 dimensions)
   * If not provided, embedding will be computed server-side
   */
  query_embedding?: number[];

  /**
   * Maximum number of results to return
   * @default 10
   */
  top_k?: number;

  /**
   * Context Lens for security filtering
   */
  lens: ContextLens;

  /**
   * Whether to apply recency boost
   * @default true
   */
  recency_boost?: boolean;
}

/**
 * A single semantic search result
 */
export interface SemanticSearchResult {
  /** Memory item UUID */
  id: string;

  /** Text content of the memory */
  content: string;

  /** Structured content (if any) */
  content_json: Record<string, unknown> | null;

  /** Memory category */
  category_key: string;

  /** Source of the memory */
  source: 'orb_text' | 'orb_voice' | 'diary' | 'upload' | 'system';

  /** Importance score (0-100) */
  importance: number;

  /** When the memory event occurred */
  occurred_at: string;

  /** When the memory was created */
  created_at: string;

  /** Role active when memory was created */
  active_role: string | null;

  /** Workspace scope */
  workspace_scope: string | null;

  /** Visibility scope */
  visibility_scope: string | null;

  /** VTID that created this memory */
  vtid: string | null;

  /** Service that created this memory */
  origin_service: string | null;

  /** Associated conversation ID */
  conversation_id: string | null;

  /** Cosine similarity score (0-1) */
  similarity_score: number;

  /** Recency score (0-1, exponential decay) */
  recency_score: number;

  /** Combined score (weighted similarity + recency) */
  combined_score: number;
}

/**
 * Semantic search response
 */
export interface SemanticSearchResponse {
  ok: boolean;
  results: SemanticSearchResult[];
  query: string;
  lens: ContextLens;
  total_found: number;
  search_time_ms: number;
  error?: string;
}

// =============================================================================
// Memory Write Types (Enhanced for VTID-01184)
// =============================================================================

/**
 * Enhanced memory write payload with embedding support
 */
export interface MemoryWritePayload {
  /** Memory content (required) */
  content: string;

  /** Structured content (optional) */
  content_json?: Record<string, unknown>;

  /** Source of the memory */
  source: 'orb_text' | 'orb_voice' | 'diary' | 'upload' | 'system';

  /** Category key */
  category_key?: string;

  /** Importance score (0-100) */
  importance?: number;

  /** When the event occurred */
  occurred_at?: string;

  /** Context Lens for the write operation */
  lens: ContextLens;

  /** VTID for provenance tracking */
  vtid?: string;

  /** Origin service name */
  origin_service?: string;

  /** Associated conversation ID */
  conversation_id?: string;

  /**
   * Pre-computed embedding (1536 dimensions)
   * If provided, skips embedding generation
   */
  embedding?: number[];

  /** Model used to generate the embedding */
  embedding_model?: string;
}

/**
 * Memory write response
 */
export interface MemoryWriteResponse {
  ok: boolean;
  id?: string;
  tenant_id?: string;
  user_id?: string;
  category_key?: string;
  workspace_scope?: string;
  occurred_at?: string;
  has_embedding?: boolean;
  error?: string;
}

// =============================================================================
// Embedding Pipeline Types
// =============================================================================

/**
 * Item needing embedding generation
 */
export interface ItemNeedingEmbedding {
  id: string;
  content: string;
  category_key: string;
  tenant_id: string;
  user_id: string;
  created_at: string;
}

/**
 * Embedding update for batch processing
 */
export interface EmbeddingUpdate {
  id: string;
  embedding: number[];
  embedding_model: string;
}

/**
 * Batch embedding update response
 */
export interface BatchEmbeddingUpdateResponse {
  ok: boolean;
  updated_count: number;
  requested_count: number;
  error?: string;
}

/**
 * Re-embed trigger request
 */
export interface ReembedTriggerRequest {
  tenant_id?: string;
  user_id?: string;
  category_key?: string;
  since?: string;
  until?: string;
}

/**
 * Re-embed trigger response
 */
export interface ReembedTriggerResponse {
  ok: boolean;
  marked_for_reembed: number;
  filters: ReembedTriggerRequest;
  error?: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a default Context Lens from tenant/user IDs
 */
export function createContextLens(
  tenant_id: string,
  user_id: string,
  options?: Partial<Omit<ContextLens, 'tenant_id' | 'user_id'>>
): ContextLens {
  return {
    tenant_id,
    user_id,
    workspace_scope: options?.workspace_scope ?? 'product',
    active_role: options?.active_role,
    allowed_categories: options?.allowed_categories,
    visibility_scope: options?.visibility_scope ?? 'private',
    max_age_hours: options?.max_age_hours,
  };
}

/**
 * Validate a Context Lens has required fields
 */
export function validateContextLens(lens: unknown): lens is ContextLens {
  if (!lens || typeof lens !== 'object') {
    return false;
  }

  const l = lens as Record<string, unknown>;

  // Required fields
  if (typeof l.tenant_id !== 'string' || !l.tenant_id) {
    return false;
  }
  if (typeof l.user_id !== 'string' || !l.user_id) {
    return false;
  }
  if (l.workspace_scope !== 'product' && l.workspace_scope !== 'dev') {
    return false;
  }

  // Optional field validation
  if (l.visibility_scope !== undefined &&
      l.visibility_scope !== 'private' &&
      l.visibility_scope !== 'shared' &&
      l.visibility_scope !== 'public') {
    return false;
  }

  return true;
}

/**
 * Create Context Lens for dev sandbox (uses fixed dev identity)
 */
export function createDevSandboxLens(options?: {
  active_role?: string;
  allowed_categories?: string[];
  max_age_hours?: number;
}): ContextLens {
  // DEV_IDENTITY from orb-memory-bridge.ts
  return {
    tenant_id: '00000000-0000-0000-0000-000000000001',
    user_id: '00000000-0000-0000-0000-000000000099',
    workspace_scope: 'dev',
    active_role: options?.active_role ?? 'developer',
    allowed_categories: options?.allowed_categories,
    visibility_scope: 'private',
    max_age_hours: options?.max_age_hours,
  };
}
