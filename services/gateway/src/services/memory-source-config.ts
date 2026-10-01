/**
 * VTID-01184 Phase 2: Memory Source Configuration
 *
 * Supabase is the ONLY source of truth for durable memory.
 *
 * VTID-04344: the deprecated Mem0/Qdrant path (MEMORY_SOURCE=mem0|both and
 * its memory-indexer-client) was removed. MEMORY_SOURCE always resolved to
 * 'supabase' by default; any other value is now ignored.
 */

// =============================================================================
// Configuration
// =============================================================================

/**
 * Memory source options. Supabase is the only supported source.
 */
export type MemorySource = 'supabase';

/**
 * Get configured memory source — always 'supabase'.
 */
export function getMemorySource(): MemorySource {
  return 'supabase';
}

/**
 * Check if Supabase semantic memory is the primary source (always true).
 */
export function isSupabasePrimary(): boolean {
  return true;
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
// Diagnostics
// =============================================================================

/**
 * Get memory source status for diagnostics
 */
export function getMemorySourceStatus(): {
  source: MemorySource;
  supabase_enabled: boolean;
  semantic_search_available: boolean;
  embedding_pipeline_available: boolean;
} {
  return {
    source: getMemorySource(),
    supabase_enabled: isSupabasePrimary(),
    semantic_search_available: isSemanticSearchAvailable(),
    embedding_pipeline_available: isEmbeddingPipelineAvailable(),
  };
}
