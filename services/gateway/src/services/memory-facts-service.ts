/**
 * VTID-01192: Memory Facts Service
 *
 * Manages immutable facts with provenance tracking.
 * Facts are the canonical source of user knowledge.
 *
 * Key Principles:
 * 1. Facts are APPEND-ONLY (immutable)
 * 2. Conflicting facts coexist (supersession tracked)
 * 3. Provenance is MANDATORY
 * 4. Deterministic retrieval
 *
 * Fact Types:
 * - 'self': Facts about the user themselves
 * - 'disclosed': Facts the user disclosed about others
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01192';
const SERVICE_NAME = 'memory-facts-service';

// Minimum confidence to store inferred facts
const MIN_INFERENCE_CONFIDENCE = 0.70;

// =============================================================================
// Types
// =============================================================================

export interface MemoryFact {
  id: string;
  entity: 'self' | 'disclosed';
  fact_key: string;
  fact_value: string;
  fact_value_type: 'text' | 'date' | 'number' | 'json';
  provenance_source: 'user_stated' | 'assistant_inferred' | 'system_observed';
  provenance_confidence: number;
  extracted_at: string;
}

export interface WriteFactRequest {
  tenant_id: string;
  user_id: string;
  fact_key: string;
  fact_value: string;
  entity?: 'self' | 'disclosed';
  fact_value_type?: 'text' | 'date' | 'number' | 'json';
  provenance_source?: 'user_stated' | 'assistant_inferred' | 'system_observed';
  provenance_utterance_id?: string;
  provenance_confidence?: number;
  thread_id?: string;
}

export interface WriteFactResult {
  ok: boolean;
  fact_id?: string;
  superseded_fact_id?: string;
  error?: string;
}

export interface GetFactsRequest {
  tenant_id: string;
  user_id: string;
  entity?: 'self' | 'disclosed';
  fact_keys?: string[];
}

export interface GetFactsResult {
  ok: boolean;
  facts: MemoryFact[];
  error?: string;
}

export interface FactCheckRequest {
  tenant_id: string;
  user_id: string;
  required_facts: string[];  // Fact keys that must exist
}

export interface FactCheckResult {
  ok: boolean;
  all_present: boolean;
  all_user_stated: boolean;
  all_high_confidence: boolean;
  missing_facts: string[];
  low_confidence_facts: string[];
  facts: MemoryFact[];
}

// =============================================================================
// Supabase Client
// =============================================================================

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
// Write Facts
// =============================================================================

/**
 * Write a fact to memory.
 *
 * If a fact with the same key already exists, it will be superseded
 * (marked with superseded_by pointing to the new fact).
 *
 * @param request Fact write request
 * @returns Result with new fact ID
 */
export async function writeFact(request: WriteFactRequest): Promise<WriteFactResult> {
  const startTime = Date.now();

  // Validate confidence for inferred facts
  const confidence = request.provenance_confidence ?? 0.90;
  if (request.provenance_source === 'assistant_inferred' && confidence < MIN_INFERENCE_CONFIDENCE) {
    console.log(`[${VTID}] Rejecting inferred fact with low confidence: ${confidence}`);
    return {
      ok: false,
      error: `Confidence ${confidence} below minimum ${MIN_INFERENCE_CONFIDENCE} for inferred facts`
    };
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const { data, error } = await supabase.rpc('write_fact', {
      p_tenant_id: request.tenant_id,
      p_user_id: request.user_id,
      p_fact_key: request.fact_key,
      p_fact_value: request.fact_value,
      p_entity: request.entity || 'self',
      p_fact_value_type: request.fact_value_type || 'text',
      p_provenance_source: request.provenance_source || 'user_stated',
      p_provenance_utterance_id: request.provenance_utterance_id || null,
      p_provenance_confidence: confidence,
      p_thread_id: request.thread_id || null
    });

    if (error) {
      console.error(`[${VTID}] Fact write failed:`, error.message);

      await emitOasisEvent({
        vtid: VTID,
        type: 'memory.fact.write.failed' as any,
        source: SERVICE_NAME,
        status: 'error',
        message: `Fact write failed: ${error.message}`,
        payload: {
          tenant_id: request.tenant_id,
          user_id: request.user_id,
          fact_key: request.fact_key,
          error: error.message,
          duration_ms: Date.now() - startTime
        }
      });

      return { ok: false, error: error.message };
    }

    // Emit success event
    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.fact.written' as any,
      source: SERVICE_NAME,
      status: 'success',
      message: `Fact written: ${request.fact_key}`,
      payload: {
        tenant_id: request.tenant_id,
        user_id: request.user_id,
        fact_id: data,
        fact_key: request.fact_key,
        entity: request.entity || 'self',
        provenance_source: request.provenance_source || 'user_stated',
        provenance_confidence: confidence,
        duration_ms: Date.now() - startTime
      }
    });

    console.log(`[${VTID}] Fact written: ${request.fact_key} = ${request.fact_value.substring(0, 50)}...`);

    return {
      ok: true,
      fact_id: data
    };
  } catch (err: any) {
    console.error(`[${VTID}] Fact write error:`, err.message);
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// Read Facts
// =============================================================================

/**
 * Get current (non-superseded) facts for a user.
 *
 * @param request Get facts request
 * @returns List of current facts
 */
export async function getCurrentFacts(request: GetFactsRequest): Promise<GetFactsResult> {
  const supabase = createServiceClient();
  if (!supabase) {
    return { ok: false, facts: [], error: 'Supabase not configured' };
  }

  try {
    const { data, error } = await supabase.rpc('get_current_facts', {
      p_tenant_id: request.tenant_id,
      p_user_id: request.user_id,
      p_entity: request.entity || null,
      p_fact_keys: request.fact_keys || null
    });

    if (error) {
      console.error(`[${VTID}] Fact retrieval failed:`, error.message);
      return { ok: false, facts: [], error: error.message };
    }

    const facts: MemoryFact[] = (data || []).map((row: any) => ({
      id: row.id,
      entity: row.entity,
      fact_key: row.fact_key,
      fact_value: row.fact_value,
      fact_value_type: row.fact_value_type,
      provenance_source: row.provenance_source,
      provenance_confidence: parseFloat(row.provenance_confidence),
      extracted_at: row.extracted_at
    }));

    return { ok: true, facts };
  } catch (err: any) {
    return { ok: false, facts: [], error: err.message };
  }
}

// =============================================================================
// Fact Checking (for Derived Answers)
// =============================================================================

/**
 * Check if all required facts exist and meet quality criteria.
 *
 * Used before answering derived questions to ensure:
 * 1. All required facts exist
 * 2. Facts are user-stated (not inferred)
 * 3. Confidence is high enough
 *
 * @param request Fact check request
 * @returns Check result with missing/low-confidence facts
 */
export async function checkFactsForDerivedAnswer(
  request: FactCheckRequest
): Promise<FactCheckResult> {
  const result = await getCurrentFacts({
    tenant_id: request.tenant_id,
    user_id: request.user_id,
    fact_keys: request.required_facts
  });

  if (!result.ok) {
    return {
      ok: false,
      all_present: false,
      all_user_stated: false,
      all_high_confidence: false,
      missing_facts: request.required_facts,
      low_confidence_facts: [],
      facts: []
    };
  }

  const foundKeys = new Set(result.facts.map(f => f.fact_key));
  const missingFacts = request.required_facts.filter(k => !foundKeys.has(k));

  const lowConfidenceFacts = result.facts
    .filter(f => f.provenance_confidence < 0.90)
    .map(f => f.fact_key);

  const nonUserStatedFacts = result.facts
    .filter(f => f.provenance_source !== 'user_stated');

  return {
    ok: true,
    all_present: missingFacts.length === 0,
    all_user_stated: nonUserStatedFacts.length === 0,
    all_high_confidence: lowConfidenceFacts.length === 0,
    missing_facts: missingFacts,
    low_confidence_facts: lowConfidenceFacts,
    facts: result.facts
  };
}

// =============================================================================
// Format Facts for Context
// =============================================================================

/**
 * Format facts into a context string for LLM injection.
 *
 * @param facts List of facts
 * @returns Formatted string for system prompt
 */
export function formatFactsForContext(facts: MemoryFact[]): string {
  if (facts.length === 0) {
    return '';
  }

  const lines: string[] = ['Known facts about the user:'];

  // Group by entity
  const selfFacts = facts.filter(f => f.entity === 'self');
  const disclosedFacts = facts.filter(f => f.entity === 'disclosed');

  if (selfFacts.length > 0) {
    for (const fact of selfFacts) {
      lines.push(`- ${formatFactKey(fact.fact_key)}: ${fact.fact_value}`);
    }
  }

  if (disclosedFacts.length > 0) {
    lines.push('');
    lines.push('Facts disclosed by the user about others:');
    for (const fact of disclosedFacts) {
      lines.push(`- ${formatFactKey(fact.fact_key)}: ${fact.fact_value}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a fact key for display.
 * Converts snake_case to Title Case.
 */
function formatFactKey(key: string): string {
  return key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// =============================================================================
// Estimate Token Count
// =============================================================================

/**
 * Estimate token count for facts.
 * Uses rough approximation: 1 token ≈ 4 characters.
 *
 * @param facts List of facts
 * @returns Estimated token count
 */
export function estimateFactsTokens(facts: MemoryFact[]): number {
  const formatted = formatFactsForContext(facts);
  return Math.ceil(formatted.length / 4);
}

// =============================================================================
// Async Embedding Generation (VTID-01225)
// =============================================================================

/**
 * Generate and store an embedding for a memory fact (async, non-blocking).
 *
 * Call this AFTER writeFact() returns — it runs fire-and-forget so it doesn't
 * add latency to the write path. If embedding generation fails, the fact is
 * still stored; embedding can be backfilled later via batch pipeline.
 *
 * @param factId The UUID of the fact to embed
 * @param factKey The fact_key (e.g., 'user_name')
 * @param factValue The fact_value (e.g., 'Dragan Alexander')
 */
export function generateFactEmbeddingAsync(
  factId: string,
  factKey: string,
  factValue: string
): void {
  // Fire-and-forget — don't await
  (async () => {
    try {
      const { generateEmbedding } = await import('./embedding-service');

      // Embed the combined key+value for semantic searchability
      const textToEmbed = `${factKey}: ${factValue}`;
      const result = await generateEmbedding(textToEmbed);

      if (!result.ok || !result.embedding) {
        console.warn(`[${VTID}] Embedding generation failed for fact ${factId}: ${result.error}`);
        return;
      }

      const supabase = createServiceClient();
      if (!supabase) return;

      const { error } = await supabase
        .from('memory_facts')
        .update({
          embedding: JSON.stringify(result.embedding),
          embedding_model: result.model || 'text-embedding-3-small',
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('id', factId);

      if (error) {
        console.warn(`[${VTID}] Embedding storage failed for fact ${factId}: ${error.message}`);
      } else {
        console.log(`[${VTID}] Embedding stored for fact ${factId} (${result.latency_ms}ms)`);
      }
    } catch (err: any) {
      console.warn(`[${VTID}] Async embedding failed for fact ${factId}: ${err.message}`);
    }
  })();
}

// =============================================================================
// Exports
// =============================================================================

export default {
  writeFact,
  getCurrentFacts,
  checkFactsForDerivedAnswer,
  formatFactsForContext,
  estimateFactsTokens,
  generateFactEmbeddingAsync
};
