/**
 * VTID-01225: Cognee Entity Extraction Client
 *
 * HTTP client for communicating with the Cognee Extractor Service.
 * Handles extraction requests, retries, timeouts, and OASIS event emission.
 *
 * Design Doc: docs/architecture/cognee-integration-design.md
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// VTID-01225: Configuration
// =============================================================================

const COGNEE_EXTRACTOR_URL = process.env.COGNEE_EXTRACTOR_URL || 'http://cognee-extractor:8080';
const TIMEOUT_MS = 30000; // 30 second timeout for extraction
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// =============================================================================
// VTID-01225: Types
// =============================================================================

/**
 * Request to extract entities from transcript
 */
export interface CogneeExtractionRequest {
  transcript: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  active_role?: string;
}

/**
 * Entity extracted by Cognee
 */
export interface CogneeEntity {
  name: string;
  entity_type: string;
  vitana_node_type: string;
  domain: string;
  metadata: Record<string, unknown>;
}

/**
 * Relationship extracted by Cognee
 */
export interface CogneeRelationship {
  from_entity: string;
  to_entity: string;
  cognee_type: string;
  vitana_type: string;
  context: Record<string, unknown>;
}

/**
 * Behavioral signal extracted by Cognee
 */
export interface CogneeSignal {
  signal_key: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

/**
 * Response from Cognee Extractor Service
 */
export interface CogneeExtractionResponse {
  ok: boolean;
  entities: CogneeEntity[];
  relationships: CogneeRelationship[];
  signals: CogneeSignal[];
  session_id: string;
  tenant_id: string;
  user_id: string;
  transcript_hash: string;
  processing_ms: number;
}

/**
 * Health check response
 */
interface CogneeHealthResponse {
  status: string;
  service: string;
  vtid: string;
  version: string;
}

// =============================================================================
// VTID-01225: Helper Functions
// =============================================================================

/**
 * Emit a Cognee-related OASIS event
 */
async function emitCogneeEvent(
  type: 'cognee.extraction.started' | 'cognee.extraction.completed' | 'cognee.extraction.timeout' | 'cognee.extraction.error' | 'cognee.extraction.persisted',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01225',
    type: type as any,
    source: 'cognee-extractor-client',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01225] Failed to emit ${type}:`, err.message));
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// VTID-01225: Cognee Extractor Client
// =============================================================================

/**
 * Client for communicating with Cognee Extractor Service
 */
class CogneeExtractorClient {
  private baseUrl: string;
  private enabled: boolean;

  constructor() {
    this.baseUrl = COGNEE_EXTRACTOR_URL;
    this.enabled = !!process.env.COGNEE_EXTRACTOR_URL;

    if (!this.enabled) {
      console.warn('[VTID-01225] Cognee Extractor URL not configured - extraction disabled');
    } else {
      console.log(`[VTID-01225] Cognee Extractor Client initialized: ${this.baseUrl}`);
    }
  }

  /**
   * Check if extraction is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Extract entities and relationships from transcript
   */
  async extract(request: CogneeExtractionRequest): Promise<CogneeExtractionResponse> {
    if (!this.enabled) {
      throw new Error('Cognee extraction is not enabled');
    }

    const startTime = Date.now();

    // Emit started event
    await emitCogneeEvent(
      'cognee.extraction.started',
      'info',
      `Starting extraction for session ${request.session_id}`,
      {
        tenant_id: request.tenant_id,
        user_id: request.user_id,
        session_id: request.session_id,
        transcript_length: request.transcript.length
      }
    );

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[VTID-01225] Retry attempt ${attempt}/${MAX_RETRIES}`);
        await sleep(RETRY_DELAY_MS * attempt);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(`${this.baseUrl}/extract`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-VTID': 'VTID-01225',
            'X-Session-ID': request.session_id
          },
          body: JSON.stringify(request),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`Cognee extractor returned ${response.status}: ${errorText}`);
        }

        const result = await response.json() as CogneeExtractionResponse;
        const durationMs = Date.now() - startTime;

        // Emit completed event
        await emitCogneeEvent(
          'cognee.extraction.completed',
          'success',
          `Extraction completed: ${result.entities.length} entities, ${result.relationships.length} relationships`,
          {
            tenant_id: request.tenant_id,
            user_id: request.user_id,
            session_id: request.session_id,
            entity_count: result.entities.length,
            relationship_count: result.relationships.length,
            signal_count: result.signals.length,
            duration_ms: durationMs,
            processing_ms: result.processing_ms
          }
        );

        console.log(
          `[VTID-01225] Extraction completed: ${result.entities.length} entities, ` +
          `${result.relationships.length} relationships, ${result.signals.length} signals ` +
          `in ${durationMs}ms`
        );

        return result;

      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            // Timeout
            await emitCogneeEvent(
              'cognee.extraction.timeout',
              'warning',
              `Extraction timed out after ${TIMEOUT_MS}ms`,
              {
                tenant_id: request.tenant_id,
                session_id: request.session_id,
                attempt: attempt + 1,
                timeout_ms: TIMEOUT_MS
              }
            );
            lastError = new Error(`Cognee extraction timed out after ${TIMEOUT_MS}ms`);
          } else {
            lastError = err;
          }
        } else {
          lastError = new Error('Unknown extraction error');
        }

        console.warn(`[VTID-01225] Extraction attempt ${attempt + 1} failed:`, lastError.message);
      }
    }

    // All retries exhausted
    await emitCogneeEvent(
      'cognee.extraction.error',
      'error',
      `Extraction failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
      {
        tenant_id: request.tenant_id,
        session_id: request.session_id,
        error: lastError?.message || 'Unknown error',
        duration_ms: Date.now() - startTime
      }
    );

    throw lastError || new Error('Extraction failed');
  }

  /**
   * Fire-and-forget extraction (async, non-blocking)
   *
   * Use this for ORB Live integration where we don't want to block
   * the conversation flow while extracting entities.
   *
   * VTID-01225: Now persists extracted entities to relationship graph
   */
  extractAsync(request: CogneeExtractionRequest): void {
    if (!this.enabled) {
      console.debug('[VTID-01225] Cognee extraction disabled, skipping async extract');
      return;
    }

    // Fire and forget - don't await
    this.extract(request)
      .then(async result => {
        if (result.ok && (result.entities.length > 0 || result.relationships.length > 0)) {
          console.log(
            `[VTID-01225] Async extraction yielded: ${result.entities.length} entities, ` +
            `${result.relationships.length} relationships`
          );

          // VTID-01225: Persist extracted entities to relationship graph
          try {
            await this.persistExtractionResults(request, result);
          } catch (persistErr) {
            console.warn('[VTID-01225] Extraction persistence failed (non-blocking):',
              persistErr instanceof Error ? persistErr.message : 'Unknown error');
          }
        }
      })
      .catch(err => {
        // Log but don't throw - this is fire-and-forget
        console.warn('[VTID-01225] Async extraction failed (non-blocking):', err.message);
      });
  }

  /**
   * VTID-01225: Persist extraction results to relationship graph and memory
   * Uses internal service call (bypasses user auth for dev sandbox)
   */
  private async persistExtractionResults(
    request: CogneeExtractionRequest,
    result: CogneeExtractionResponse
  ): Promise<void> {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      console.warn('[VTID-01225] Supabase not configured for persistence');
      return;
    }

    // Persist to relationship_nodes via RPC
    for (const entity of result.entities) {
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/relationship_ensure_node`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          },
          body: JSON.stringify({
            p_node_type: entity.vitana_node_type || 'entity',
            p_title: entity.name,
            p_domain: entity.domain || 'personal',
            p_metadata: {
              entity_type: entity.entity_type,
              origin: 'cognee',
              vtid: 'VTID-01225',
              session_id: request.session_id,
              user_id: request.user_id,
              tenant_id: request.tenant_id,
              ...entity.metadata
            }
          }),
        });

        if (!response.ok) {
          console.warn(`[VTID-01225] Node creation failed for "${entity.name}": ${response.status}`);
        }
      } catch (err) {
        console.warn(`[VTID-01225] Node persist error for "${entity.name}":`, err);
      }
    }

    // Also persist key entities directly to memory_items for retrieval
    for (const entity of result.entities) {
      // Only persist personal info entities
      if (entity.entity_type === 'PERSON' ||
          entity.domain === 'personal' ||
          entity.name?.toLowerCase().includes('birthday') ||
          entity.name?.toLowerCase().includes('name')) {
        try {
          const memoryContent = `${entity.name}: ${entity.metadata?.value || JSON.stringify(entity.metadata || {})}`;

          const response = await fetch(`${SUPABASE_URL}/rest/v1/memory_items`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: SUPABASE_SERVICE_ROLE,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              tenant_id: request.tenant_id,
              user_id: request.user_id,
              source: 'cognee_extraction',
              category_key: 'personal',
              content: memoryContent,
              content_json: {
                entity_type: entity.entity_type,
                entity_name: entity.name,
                cognee_origin: true,
                session_id: request.session_id
              },
              importance: 80, // High importance for extracted personal info
              occurred_at: new Date().toISOString()
            }),
          });

          if (response.ok) {
            console.log(`[VTID-01225] Persisted entity to memory_items: ${entity.name}`);
          }
        } catch (err) {
          console.warn(`[VTID-01225] Memory persist error for "${entity.name}":`, err);
        }
      }
    }

    console.log(`[VTID-01225] Persistence complete: ${result.entities.length} entities processed`);

    // Emit success event
    await emitCogneeEvent(
      'cognee.extraction.persisted',
      'success',
      `Persisted ${result.entities.length} entities to relationship graph and memory`,
      {
        tenant_id: request.tenant_id,
        user_id: request.user_id,
        session_id: request.session_id,
        entity_count: result.entities.length,
        relationship_count: result.relationships.length
      }
    );
  }

  /**
   * Check health of Cognee Extractor Service
   */
  async healthCheck(): Promise<{ healthy: boolean; details?: CogneeHealthResponse }> {
    if (!this.enabled) {
      return { healthy: false };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { healthy: false };
      }

      const details = await response.json() as CogneeHealthResponse;
      return { healthy: details.status === 'healthy', details };

    } catch (err) {
      console.warn('[VTID-01225] Health check failed:', err instanceof Error ? err.message : 'Unknown error');
      return { healthy: false };
    }
  }
}

// =============================================================================
// VTID-01225: Singleton Export
// =============================================================================

export const cogneeExtractorClient = new CogneeExtractorClient();
