/**
 * VTID-01184 Phase 2: Memory Source Configuration
 *
 * Controls the transition from dual-source (Qdrant + Supabase) to
 * Supabase-only memory persistence.
 *
 * GOVERNANCE:
 * - Supabase is the ONLY source of truth for durable memory
 * - No production-critical memory may live on local disk (/tmp)
 * - Mem0/Qdrant is DEPRECATED and will be removed
 *
 * Configuration:
 * - MEMORY_SOURCE=supabase (default, recommended)
 * - MEMORY_SOURCE=mem0 (deprecated, for migration only)
 * - MEMORY_SOURCE=both (deprecated, for testing only)
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01184';
const SERVICE_NAME = 'memory-source-config';

/**
 * Memory source options
 *
 * @deprecated 'mem0' and 'both' are deprecated. Use 'supabase' only.
 */
export type MemorySource = 'supabase' | 'mem0' | 'both';

/**
 * Get configured memory source
 *
 * Default: 'supabase' (the only supported option going forward)
 */
export function getMemorySource(): MemorySource {
  const source = (process.env.MEMORY_SOURCE || 'supabase').toLowerCase() as MemorySource;

  // Emit deprecation warning for non-Supabase sources
  if (source === 'mem0' || source === 'both') {
    logDeprecationWarning(source);
  }

  return source === 'mem0' || source === 'both' ? source : 'supabase';
}

/**
 * Check if Supabase semantic memory is the primary source
 */
export function isSupabasePrimary(): boolean {
  const source = getMemorySource();
  return source === 'supabase' || source === 'both';
}

/**
 * Check if Mem0/Qdrant is still enabled (deprecated)
 *
 * @deprecated Mem0/Qdrant is deprecated. This will return false in future versions.
 */
export function isMem0Enabled(): boolean {
  const source = getMemorySource();
  const enabled = source === 'mem0' || source === 'both';

  if (enabled) {
    logDeprecationWarning(source);
  }

  return enabled;
}

/**
 * Check if dual-source mode is enabled (deprecated, for testing only)
 *
 * @deprecated Dual-source mode is deprecated. Use Supabase only.
 */
export function isDualSourceEnabled(): boolean {
  const source = getMemorySource();
  return source === 'both';
}

// =============================================================================
// Deprecation Warnings
// =============================================================================

let _deprecationWarningEmitted = false;

/**
 * Log deprecation warning for non-Supabase memory sources
 */
function logDeprecationWarning(source: MemorySource): void {
  if (_deprecationWarningEmitted) {
    return;
  }

  const message = `
================================================================================
VTID-01184 DEPRECATION WARNING: Local Vector Persistence (Qdrant)
================================================================================

Memory source '${source}' is DEPRECATED and will be removed.

Current Status:
- MEMORY_SOURCE=${source}

Action Required:
1. Migrate all memory data to Supabase using semantic search
2. Remove MEMORY_SOURCE environment variable (or set to 'supabase')
3. Disable memory-indexer service (Qdrant-based)

Supabase is now the ONLY source of truth for memory persistence.
Local vector stores (/tmp/qdrant) are:
- NOT durable (lost on restart/scale-to-zero)
- NOT compliant with data governance requirements
- NOT tenant-isolated by default

Migration Guide:
1. Enable Supabase semantic memory (MEMORY_SOURCE=supabase)
2. Run embedding pipeline to backfill existing memories
3. Verify semantic search works: POST /api/v1/memory/semantic/search
4. Disable Mem0 service

================================================================================
`;

  console.warn(message);

  // Emit OASIS event
  emitOasisEvent({
    vtid: VTID,
    type: 'memory.deprecation_warning',
    source: SERVICE_NAME,
    status: 'warning',
    message: `Deprecated memory source '${source}' is still in use`,
    payload: {
      memory_source: source,
      recommended_source: 'supabase',
      action_required: 'Migrate to Supabase semantic memory'
    }
  }).catch(() => {});

  _deprecationWarningEmitted = true;
}

// =============================================================================
// Feature Flags
// =============================================================================

/**
 * Check if semantic search is available
 *
 * Requires:
 * - VTID-01184 migration applied
 * - Embedding service configured (OPENAI_API_KEY or GOOGLE_GEMINI_API_KEY)
 */
export function isSemanticSearchAvailable(): boolean {
  // Semantic search requires embedding keys
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GOOGLE_GEMINI_API_KEY;

  return hasOpenAI || hasGemini;
}

/**
 * Check if embedding pipeline is available
 */
export function isEmbeddingPipelineAvailable(): boolean {
  return isSemanticSearchAvailable();
}

// =============================================================================
// Migration Helpers
// =============================================================================

/**
 * Get memory source status for diagnostics
 */
export function getMemorySourceStatus(): {
  source: MemorySource;
  supabase_enabled: boolean;
  mem0_enabled: boolean;
  semantic_search_available: boolean;
  embedding_pipeline_available: boolean;
  is_deprecated: boolean;
  deprecation_message?: string;
} {
  const source = getMemorySource();
  const isDeprecated = source === 'mem0' || source === 'both';

  return {
    source,
    supabase_enabled: isSupabasePrimary(),
    mem0_enabled: source === 'mem0' || source === 'both',
    semantic_search_available: isSemanticSearchAvailable(),
    embedding_pipeline_available: isEmbeddingPipelineAvailable(),
    is_deprecated: isDeprecated,
    deprecation_message: isDeprecated
      ? `Memory source '${source}' is deprecated. Migrate to 'supabase'.`
      : undefined
  };
}
