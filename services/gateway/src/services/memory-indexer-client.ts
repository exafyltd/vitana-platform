/**
 * VTID-01153: Memory Indexer Client Service
 *
 * HTTP client for calling the Mem0-based memory-indexer service.
 * Provides context retrieval and memory writes for ORB.
 *
 * Endpoints called:
 * - POST /memory/context - Get context injection for prompts
 * - POST /memory/write - Write user facts to memory
 * - POST /memory/search - Search memory (alternative to context)
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Configuration
// =============================================================================

const MEMORY_INDEXER_URL = process.env.MEMORY_INDEXER_URL || '';
const MEMORY_INDEXER_TIMEOUT_MS = 5000; // 5 second timeout for real-time
const DEV_MODE = process.env.NODE_ENV !== 'production' || process.env.DEV_SANDBOX === 'true';

// =============================================================================
// Types
// =============================================================================

export interface MemoryWriteRequest {
  user_id: string;
  content: string;
  role: 'user' | 'assistant';
  metadata?: Record<string, unknown>;
}

export interface MemoryWriteResponse {
  user_id: string;
  role: string;
  decision: string;
  stored: boolean;
  memory_ids: string[];
  timestamp: number;
  error?: string;
}

export interface MemorySearchRequest {
  user_id: string;
  query: string;
  top_k?: number;
}

export interface MemorySearchHit {
  id: string;
  memory: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

export interface MemorySearchResponse {
  user_id: string;
  query: string;
  hits: MemorySearchHit[];
  decision: string;
  timestamp: number;
  error?: string;
}

export interface MemoryContextRequest {
  user_id: string;
  query: string;
  top_k?: number;
}

export interface MemoryContextResponse {
  context: string;
  user_id: string;
  error?: string;
}

// =============================================================================
// Client Functions
// =============================================================================

/**
 * Check if memory-indexer is configured
 */
export function isMemoryIndexerEnabled(): boolean {
  return !!MEMORY_INDEXER_URL;
}

/**
 * Get the memory-indexer URL
 */
export function getMemoryIndexerUrl(): string {
  return MEMORY_INDEXER_URL;
}

/**
 * Write a user message to memory
 * Fire-and-forget pattern - returns immediately, doesn't block response
 */
export async function writeToMemoryIndexer(
  request: MemoryWriteRequest
): Promise<MemoryWriteResponse> {
  if (!MEMORY_INDEXER_URL) {
    return {
      user_id: request.user_id,
      role: request.role,
      decision: 'skipped_no_url',
      stored: false,
      memory_ids: [],
      timestamp: Date.now() / 1000
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MEMORY_INDEXER_TIMEOUT_MS);

    const response = await fetch(`${MEMORY_INDEXER_URL}/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json() as MemoryWriteResponse;
    const latencyMs = Date.now() - startTime;

    if (DEV_MODE) {
      console.log(`[VTID-01153] Memory write: decision=${data.decision}, stored=${data.stored}, latency=${latencyMs}ms`);
    }

    // Emit OASIS event
    emitOasisEvent({
      vtid: 'VTID-01153',
      type: 'orb.memory_indexer.write',
      source: 'memory-indexer-client',
      status: data.stored ? 'success' : 'info',
      message: `Memory write: ${data.decision}`,
      payload: {
        user_id: request.user_id,
        decision: data.decision,
        stored: data.stored,
        memory_ids: data.memory_ids,
        latency_ms: latencyMs
      }
    }).catch(err => console.warn('[VTID-01153] OASIS event failed:', err.message));

    return data;
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.warn(`[VTID-01153] Memory write error: ${err.message} (${latencyMs}ms)`);

    return {
      user_id: request.user_id,
      role: request.role,
      decision: 'error',
      stored: false,
      memory_ids: [],
      timestamp: Date.now() / 1000,
      error: err.message
    };
  }
}

/**
 * Search memory for relevant facts
 */
export async function searchMemoryIndexer(
  request: MemorySearchRequest
): Promise<MemorySearchResponse> {
  if (!MEMORY_INDEXER_URL) {
    return {
      user_id: request.user_id,
      query: request.query,
      hits: [],
      decision: 'skipped_no_url',
      timestamp: Date.now() / 1000
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MEMORY_INDEXER_TIMEOUT_MS);

    const response = await fetch(`${MEMORY_INDEXER_URL}/memory/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: request.user_id,
        query: request.query,
        top_k: request.top_k || 5
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json() as MemorySearchResponse;
    const latencyMs = Date.now() - startTime;

    if (DEV_MODE) {
      console.log(`[VTID-01153] Memory search: hits=${data.hits?.length || 0}, latency=${latencyMs}ms`);
    }

    // Emit OASIS event
    emitOasisEvent({
      vtid: 'VTID-01153',
      type: 'orb.memory_indexer.search',
      source: 'memory-indexer-client',
      status: 'success',
      message: `Memory search: ${data.hits?.length || 0} hits`,
      payload: {
        user_id: request.user_id,
        query: request.query,
        hits_count: data.hits?.length || 0,
        top_fact_previews: data.hits?.slice(0, 3).map(h => h.memory?.substring(0, 50)),
        latency_ms: latencyMs
      }
    }).catch(err => console.warn('[VTID-01153] OASIS event failed:', err.message));

    return data;
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.warn(`[VTID-01153] Memory search error: ${err.message} (${latencyMs}ms)`);

    return {
      user_id: request.user_id,
      query: request.query,
      hits: [],
      decision: 'error',
      timestamp: Date.now() / 1000,
      error: err.message
    };
  }
}

/**
 * Get formatted context string for prompt injection
 */
export async function getMemoryContext(
  request: MemoryContextRequest
): Promise<MemoryContextResponse> {
  if (!MEMORY_INDEXER_URL) {
    return {
      context: '',
      user_id: request.user_id,
      error: 'MEMORY_INDEXER_URL not configured'
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MEMORY_INDEXER_TIMEOUT_MS);

    const response = await fetch(`${MEMORY_INDEXER_URL}/memory/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: request.user_id,
        query: request.query,
        top_k: request.top_k || 5
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json() as MemoryContextResponse;
    const latencyMs = Date.now() - startTime;

    if (DEV_MODE) {
      console.log(`[VTID-01153] Memory context: chars=${data.context?.length || 0}, latency=${latencyMs}ms`);
    }

    // Emit OASIS event
    emitOasisEvent({
      vtid: 'VTID-01153',
      type: 'orb.memory_indexer.context',
      source: 'memory-indexer-client',
      status: 'success',
      message: `Memory context retrieved: ${data.context?.length || 0} chars`,
      payload: {
        user_id: request.user_id,
        query: request.query,
        memory_context_chars: data.context?.length || 0,
        latency_ms: latencyMs
      }
    }).catch(err => console.warn('[VTID-01153] OASIS event failed:', err.message));

    return data;
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.warn(`[VTID-01153] Memory context error: ${err.message} (${latencyMs}ms)`);

    return {
      context: '',
      user_id: request.user_id,
      error: err.message
    };
  }
}

/**
 * Build enhanced system instruction with memory context from indexer
 */
export async function buildMemoryIndexerEnhancedInstruction(
  baseInstruction: string,
  userId: string,
  query: string
): Promise<{ instruction: string; contextChars: number; error?: string }> {
  const contextResult = await getMemoryContext({
    user_id: userId,
    query: query,
    top_k: 5
  });

  if (contextResult.error || !contextResult.context) {
    return {
      instruction: baseInstruction,
      contextChars: 0,
      error: contextResult.error
    };
  }

  const enhancedInstruction = `${baseInstruction}

## User Memory Context (from Mem0)
${contextResult.context}

Use the above facts when responding to the user. These are real facts stored from previous conversations.`;

  return {
    instruction: enhancedInstruction,
    contextChars: contextResult.context.length
  };
}
