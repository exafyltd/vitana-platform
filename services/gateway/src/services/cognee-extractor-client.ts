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

    // Persist ALL entities to memory_items with proper category classification
    // Uses Vitana's 7 memory categories: personal, company, conversation, preferences, goals, health, relationships
    for (const entity of result.entities) {
      try {
        // Build rich content from entity
        const memoryContent = entity.metadata?.value
          ? `${entity.name}: ${entity.metadata.value}`
          : entity.name;

        // Map Cognee entity types to Vitana memory categories
        const categoryKey = this.mapEntityToCategory(entity);

        // Set importance based on entity type (personal info = highest)
        const importance = this.getEntityImportance(entity, categoryKey);

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
            category_key: categoryKey,
            content: memoryContent,
            content_json: {
              entity_type: entity.entity_type,
              entity_name: entity.name,
              cognee_domain: entity.domain,
              cognee_origin: true,
              session_id: request.session_id,
              metadata: entity.metadata
            },
            importance: importance,
            occurred_at: new Date().toISOString()
          }),
        });

        if (response.ok) {
          console.log(`[VTID-01225] Persisted entity to memory_items: ${entity.name} (${categoryKey}, importance=${importance})`);
        } else {
          console.warn(`[VTID-01225] Memory persist failed for "${entity.name}": ${response.status}`);
        }
      } catch (err) {
        console.warn(`[VTID-01225] Memory persist error for "${entity.name}":`, err);
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

  /**
   * VTID-01225: Map Cognee entity types to Vitana memory categories
   * Categories: personal, company, conversation, preferences, goals, health, relationships
   */
  private mapEntityToCategory(entity: CogneeEntity): string {
    const entityType = entity.entity_type?.toUpperCase() || '';
    const domain = entity.domain?.toLowerCase() || '';
    const name = entity.name?.toLowerCase() || '';

    // Personal identity: names, birthdays, locations, contact info
    if (entityType === 'PERSON' ||
        domain === 'personal' ||
        name.includes('birthday') || name.includes('geburtstag') ||
        name.includes('name') || name.includes('age') || name.includes('alter') ||
        name.includes('address') || name.includes('adresse') ||
        name.includes('phone') || name.includes('telefon') ||
        name.includes('email') ||
        name.includes('hometown') || name.includes('heimatstadt') ||
        name.includes('wohnort') || name.includes('location')) {
      return 'personal';
    }

    // Company/business entities
    if (entityType === 'ORGANIZATION' || entityType === 'COMPANY' ||
        domain === 'business' || domain === 'company' ||
        name.includes('company') || name.includes('firma') ||
        name.includes('business') || name.includes('unternehmen') ||
        name.includes('job') || name.includes('work') || name.includes('beruf')) {
      return 'company';
    }

    // Health-related entities
    if (entityType === 'MEDICAL' || entityType === 'HEALTH' ||
        domain === 'health' || domain === 'medical' ||
        name.includes('health') || name.includes('gesundheit') ||
        name.includes('medication') || name.includes('medikament') ||
        name.includes('doctor') || name.includes('arzt') ||
        name.includes('symptom') || name.includes('illness') ||
        name.includes('disease') || name.includes('krankheit')) {
      return 'health';
    }

    // Relationship entities (family, friends, partners)
    if (entityType === 'RELATIONSHIP' ||
        domain === 'family' || domain === 'relationship' ||
        name.includes('wife') || name.includes('husband') || name.includes('frau') || name.includes('mann') ||
        name.includes('partner') || name.includes('fiancée') || name.includes('verlobte') ||
        name.includes('child') || name.includes('kind') ||
        name.includes('mother') || name.includes('mutter') ||
        name.includes('father') || name.includes('vater') ||
        name.includes('friend') || name.includes('freund') ||
        name.includes('family') || name.includes('familie')) {
      return 'relationships';
    }

    // Preferences (likes, dislikes, favorites)
    if (domain === 'preference' ||
        name.includes('prefer') || name.includes('favorite') ||
        name.includes('like') || name.includes('love') ||
        name.includes('hate') || name.includes('dislike') ||
        name.includes('liebling') || name.includes('bevorzug')) {
      return 'preferences';
    }

    // Goals and plans
    if (domain === 'goal' || domain === 'plan' ||
        name.includes('goal') || name.includes('ziel') ||
        name.includes('plan') || name.includes('want to') ||
        name.includes('dream') || name.includes('traum') ||
        name.includes('aspire') || name.includes('achieve')) {
      return 'goals';
    }

    // Default to conversation for uncategorized entities
    return 'conversation';
  }

  /**
   * VTID-01225: Determine importance score based on entity type and category
   * Personal identity info gets highest importance (80-100)
   * Relationships and health get medium-high (60-80)
   * Other categories get moderate importance (40-60)
   */
  private getEntityImportance(entity: CogneeEntity, category: string): number {
    const entityType = entity.entity_type?.toUpperCase() || '';
    const name = entity.name?.toLowerCase() || '';

    // Highest priority: Core personal identity
    if (category === 'personal') {
      // Name and birthday are most critical
      if (name.includes('name') || name.includes('birthday') || name.includes('geburtstag')) {
        return 100;
      }
      // Location and contact info very important
      if (name.includes('hometown') || name.includes('address') || name.includes('wohnort')) {
        return 90;
      }
      return 80;
    }

    // High priority: Relationships (family, partners)
    if (category === 'relationships') {
      if (name.includes('wife') || name.includes('husband') || name.includes('partner') ||
          name.includes('fiancée') || name.includes('verlobte')) {
        return 85;
      }
      return 70;
    }

    // High priority: Health info
    if (category === 'health') {
      if (name.includes('medication') || name.includes('allergy')) {
        return 80;
      }
      return 65;
    }

    // Medium priority: Company/work info
    if (category === 'company') {
      return 60;
    }

    // Medium priority: Preferences and goals
    if (category === 'preferences' || category === 'goals') {
      return 55;
    }

    // Default importance for conversation entities
    return 40;
  }
}

// =============================================================================
// VTID-01225: Singleton Export
// =============================================================================

export const cogneeExtractorClient = new CogneeExtractorClient();
