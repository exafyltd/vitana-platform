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
      // VTID-01225: This is a critical configuration error that should be surfaced
      const error = new Error(`[VTID-01225] Supabase not configured for persistence: URL=${!!SUPABASE_URL}, SERVICE_ROLE=${!!SUPABASE_SERVICE_ROLE}`);
      console.error(error.message);
      throw error;
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
            // VTID-01225: Valid node_types: person, group, event, service, product, location, live_room
            // Default to 'person' instead of invalid 'entity'
            p_node_type: entity.vitana_node_type || 'person',
            p_title: entity.name,
            // VTID-01225: Valid domains: community, health, business, lifestyle
            // Default to 'community' instead of invalid 'personal'
            p_domain: entity.domain || 'community',
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
          // VTID-01225: Read error body to understand why RPC failed
          const errorBody = await response.text().catch(() => 'Unable to read error body');
          console.error(`[VTID-01225] Node creation failed for "${entity.name}": ${response.status} - ${errorBody}`);
        } else {
          const nodeResult = await response.json().catch(() => null);
          console.log(`[VTID-01225] Node created for "${entity.name}":`, nodeResult);
        }
      } catch (err) {
        console.error(`[VTID-01225] Node persist error for "${entity.name}":`, err instanceof Error ? err.message : err);
      }
    }

    // VTID-01192: Persist entities as STRUCTURED FACTS using write_fact() RPC
    // This is the proper memory system with provenance, supersession, and confidence
    for (const entity of result.entities) {
      try {
        // Convert entity to fact_key and fact_value
        const { factKey, factValue, entityScope } = this.entityToFact(entity);

        if (!factKey || !factValue) {
          console.debug(`[VTID-01225] Skipping entity without fact mapping: ${entity.name}`);
          continue;
        }

        // Call write_fact() RPC (VTID-01192) - the proper way to store facts
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/write_fact`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          },
          body: JSON.stringify({
            p_tenant_id: request.tenant_id,
            p_user_id: request.user_id,
            p_fact_key: factKey,
            p_fact_value: factValue,
            p_entity: entityScope, // 'self' for user facts, 'disclosed' for facts about others
            p_fact_value_type: this.getFactValueType(entity),
            p_provenance_source: 'assistant_inferred', // Cognee extraction
            p_provenance_confidence: 0.85, // High confidence from NLP extraction
          }),
        });

        if (response.ok) {
          const factId = await response.json();
          console.log(`[VTID-01225] Persisted fact via write_fact(): ${factKey}="${factValue}" (id=${factId})`);
        } else {
          const errorText = await response.text();
          console.warn(`[VTID-01225] write_fact failed for "${factKey}": ${response.status} - ${errorText}`);
        }
      } catch (err) {
        console.warn(`[VTID-01225] Fact persist error for "${entity.name}":`, err);
      }
    }

    // Also persist to memory_items for backwards compatibility with existing retrieval
    // This ensures both the new facts system AND legacy retrieval work
    for (const entity of result.entities) {
      try {
        const memoryContent = entity.metadata?.value
          ? `${entity.name}: ${entity.metadata.value}`
          : entity.name;

        const categoryKey = this.mapEntityToCategory(entity);
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
          console.log(`[VTID-01225] Persisted to memory_items: ${entity.name} (${categoryKey})`);
        } else {
          // VTID-01225: Read error body to understand why INSERT failed
          const errorBody = await response.text().catch(() => 'Unable to read error body');
          console.error(`[VTID-01225] memory_items INSERT failed for "${entity.name}": ${response.status} - ${errorBody}`);
        }
      } catch (err) {
        console.error(`[VTID-01225] Memory items persist error for "${entity.name}":`, err instanceof Error ? err.message : err);
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
   * VTID-01225: Map Cognee entity types to Memory Garden categories
   *
   * MUST use valid source categories from memory_category_mapping:
   * - conversation → uncategorized
   * - health → health_wellness
   * - relationships → network_relationships
   * - community → network_relationships
   * - preferences → lifestyle_routines
   * - goals → values_aspirations
   * - tasks → business_projects
   * - products_services → finance_assets
   * - events_meetups → network_relationships
   * - notes → uncategorized
   *
   * Memory Garden has 13 categories total:
   * personal_identity, health_wellness, lifestyle_routines, network_relationships,
   * learning_knowledge, business_projects, finance_assets, location_environment,
   * digital_footprint, values_aspirations, autopilot_context, future_plans, uncategorized
   *
   * Note: Personal identity facts are stored via write_fact() in memory_facts table.
   * memory_items provides supplementary context using source categories above.
   */
  private mapEntityToCategory(entity: CogneeEntity): string {
    const entityType = entity.entity_type?.toUpperCase() || '';
    const domain = entity.domain?.toLowerCase() || '';
    const name = entity.name?.toLowerCase() || '';

    // Health-related entities → 'health' (maps to health_wellness)
    if (entityType === 'MEDICAL' || entityType === 'HEALTH' ||
        domain === 'health' || domain === 'medical' ||
        name.includes('health') || name.includes('gesundheit') ||
        name.includes('medication') || name.includes('medikament') ||
        name.includes('doctor') || name.includes('arzt') ||
        name.includes('symptom') || name.includes('illness') ||
        name.includes('disease') || name.includes('krankheit') ||
        name.includes('fitness') || name.includes('exercise') ||
        name.includes('sleep') || name.includes('schlaf')) {
      return 'health';
    }

    // Relationship entities (family, friends, partners) → 'relationships' (maps to network_relationships)
    if (entityType === 'RELATIONSHIP' ||
        domain === 'family' || domain === 'relationship' ||
        name.includes('wife') || name.includes('husband') || name.includes('frau') || name.includes('mann') ||
        name.includes('partner') || name.includes('fiancée') || name.includes('verlobte') ||
        name.includes('child') || name.includes('kind') ||
        name.includes('mother') || name.includes('mutter') ||
        name.includes('father') || name.includes('vater') ||
        name.includes('friend') || name.includes('freund') ||
        name.includes('family') || name.includes('familie') ||
        name.includes('colleague') || name.includes('kollege')) {
      return 'relationships';
    }

    // Community/events → 'community' (maps to network_relationships)
    if (domain === 'community' || domain === 'event' ||
        name.includes('community') || name.includes('gemeinschaft') ||
        name.includes('event') || name.includes('veranstaltung') ||
        name.includes('meetup') || name.includes('treffen') ||
        name.includes('group') || name.includes('gruppe')) {
      return 'community';
    }

    // Business/company/work entities → 'tasks' (maps to business_projects)
    if (entityType === 'ORGANIZATION' || entityType === 'COMPANY' ||
        domain === 'business' || domain === 'company' || domain === 'work' ||
        name.includes('company') || name.includes('firma') ||
        name.includes('business') || name.includes('unternehmen') ||
        name.includes('job') || name.includes('work') || name.includes('beruf') ||
        name.includes('project') || name.includes('projekt') ||
        name.includes('task') || name.includes('aufgabe') ||
        name.includes('meeting') || name.includes('besprechung')) {
      return 'tasks';
    }

    // Products/services/commerce → 'products_services' (maps to finance_assets)
    if (domain === 'commerce' || domain === 'product' || domain === 'service' ||
        name.includes('product') || name.includes('produkt') ||
        name.includes('service') || name.includes('dienstleistung') ||
        name.includes('purchase') || name.includes('kauf') ||
        name.includes('subscription') || name.includes('abo')) {
      return 'products_services';
    }

    // Preferences (likes, dislikes, favorites) → 'preferences' (maps to lifestyle_routines)
    if (domain === 'preference' || domain === 'lifestyle' ||
        name.includes('prefer') || name.includes('favorite') ||
        name.includes('like') || name.includes('love') ||
        name.includes('hate') || name.includes('dislike') ||
        name.includes('liebling') || name.includes('bevorzug') ||
        name.includes('routine') || name.includes('habit') ||
        name.includes('gewohnheit')) {
      return 'preferences';
    }

    // Goals and aspirations → 'goals' (maps to values_aspirations)
    if (domain === 'goal' || domain === 'aspiration' || domain === 'value' ||
        name.includes('goal') || name.includes('ziel') ||
        name.includes('dream') || name.includes('traum') ||
        name.includes('aspire') || name.includes('achieve') ||
        name.includes('value') || name.includes('wert') ||
        name.includes('believe') || name.includes('glaub')) {
      return 'goals';
    }

    // Personal identity facts → 'notes' (maps to uncategorized)
    // Note: Structured personal identity is stored in memory_facts via write_fact()
    // This is just supplementary context for full-text search
    if (entityType === 'PERSON' ||
        domain === 'personal' || domain === 'identity' ||
        name.includes('birthday') || name.includes('geburtstag') ||
        name.includes('name') || name.includes('age') || name.includes('alter') ||
        name.includes('address') || name.includes('adresse') ||
        name.includes('phone') || name.includes('telefon') ||
        name.includes('email') ||
        name.includes('hometown') || name.includes('heimatstadt') ||
        name.includes('wohnort') || name.includes('location') ||
        name.includes('residence') || name.includes('live in')) {
      return 'notes'; // Personal identity → notes → uncategorized (structured data in memory_facts)
    }

    // Default to conversation (maps to uncategorized)
    return 'conversation';
  }

  /**
   * VTID-01225: Determine importance score based on entity type and category
   *
   * Importance scores by category (maps to garden categories):
   * - notes (personal identity → uncategorized): 80-100 (structured data in memory_facts)
   * - relationships (→ network_relationships): 70-85
   * - health (→ health_wellness): 65-80
   * - tasks (→ business_projects): 60
   * - preferences/goals (→ lifestyle_routines/values_aspirations): 55
   * - conversation/community (→ uncategorized/network): 40-50
   */
  private getEntityImportance(entity: CogneeEntity, category: string): number {
    const name = entity.name?.toLowerCase() || '';

    // Highest priority: Personal identity stored in 'notes' (structured facts go to memory_facts)
    if (category === 'notes') {
      // Name and birthday are most critical
      if (name.includes('name') || name.includes('birthday') || name.includes('geburtstag')) {
        return 100;
      }
      // Location and contact info very important
      if (name.includes('hometown') || name.includes('address') || name.includes('wohnort') ||
          name.includes('residence') || name.includes('location')) {
        return 90;
      }
      return 80;
    }

    // High priority: Relationships (family, partners) → network_relationships
    if (category === 'relationships') {
      if (name.includes('wife') || name.includes('husband') || name.includes('partner') ||
          name.includes('fiancée') || name.includes('verlobte') || name.includes('spouse')) {
        return 85;
      }
      if (name.includes('mother') || name.includes('father') || name.includes('child') ||
          name.includes('parent') || name.includes('family')) {
        return 80;
      }
      return 70;
    }

    // High priority: Community/events → network_relationships
    if (category === 'community' || category === 'events_meetups') {
      return 65;
    }

    // High priority: Health info → health_wellness
    if (category === 'health') {
      if (name.includes('medication') || name.includes('allergy') || name.includes('condition')) {
        return 80;
      }
      return 65;
    }

    // Medium priority: Business/work info → business_projects
    if (category === 'tasks') {
      if (name.includes('company') || name.includes('job') || name.includes('beruf')) {
        return 70;
      }
      return 60;
    }

    // Medium priority: Products/services → finance_assets
    if (category === 'products_services') {
      return 55;
    }

    // Medium priority: Preferences and goals → lifestyle_routines/values_aspirations
    if (category === 'preferences' || category === 'goals') {
      return 55;
    }

    // Default importance for conversation entities → uncategorized
    return 40;
  }

  /**
   * VTID-01225 + VTID-01192: Convert Cognee entity to fact_key/fact_value for write_fact()
   *
   * Fact keys use semantic naming: user_name, user_birthday, fiancee_name, etc.
   * This enables proper supersession (new fact replaces old) and retrieval.
   */
  private entityToFact(entity: CogneeEntity): { factKey: string; factValue: string; entityScope: string } {
    const entityType = entity.entity_type?.toUpperCase() || '';
    const name = entity.name?.toLowerCase() || '';
    const value = entity.metadata?.value || entity.name;

    // Determine if this is about the user ('self') or someone else ('disclosed')
    let entityScope = 'self';
    let factKey = '';
    let factValue = String(value);

    // Personal identity facts
    if (name.includes('name') || entityType === 'PERSON') {
      // Check if it's about user or someone else
      if (name.includes('my name') || name.includes('mein name') || name.includes('ich heiße')) {
        factKey = 'user_name';
        entityScope = 'self';
      } else if (name.includes('fiancée') || name.includes('verlobte') || name.includes('fiancee')) {
        factKey = 'fiancee_name';
        entityScope = 'disclosed';
      } else if (name.includes('wife') || name.includes('frau') || name.includes('husband') || name.includes('mann')) {
        factKey = 'spouse_name';
        entityScope = 'disclosed';
      } else if (name.includes('mother') || name.includes('mutter')) {
        factKey = 'mother_name';
        entityScope = 'disclosed';
      } else if (name.includes('father') || name.includes('vater')) {
        factKey = 'father_name';
        entityScope = 'disclosed';
      } else {
        factKey = 'user_name';
        entityScope = 'self';
      }
    }
    // Birthday/age facts
    else if (name.includes('birthday') || name.includes('geburtstag') || name.includes('geburtsdatum') || name.includes('born')) {
      if (name.includes('fiancée') || name.includes('verlobte')) {
        factKey = 'fiancee_birthday';
        entityScope = 'disclosed';
      } else {
        factKey = 'user_birthday';
        entityScope = 'self';
      }
    }
    // Location facts
    else if (name.includes('hometown') || name.includes('heimatstadt')) {
      factKey = 'user_hometown';
      entityScope = 'self';
    }
    else if (name.includes('wohnort') || name.includes('residence') || name.includes('live in') || name.includes('wohne')) {
      factKey = 'user_residence';
      entityScope = 'self';
    }
    // Company/work facts
    else if (name.includes('company') || name.includes('firma') || name.includes('unternehmen') || name.includes('business')) {
      factKey = 'user_company';
      entityScope = 'self';
    }
    else if (name.includes('job') || name.includes('beruf') || name.includes('occupation') || name.includes('work')) {
      factKey = 'user_occupation';
      entityScope = 'self';
    }
    // Health facts
    else if (name.includes('medication') || name.includes('medikament')) {
      factKey = 'user_medication';
      entityScope = 'self';
    }
    else if (name.includes('allergy') || name.includes('allergie')) {
      factKey = 'user_allergy';
      entityScope = 'self';
    }
    else if (name.includes('condition') || name.includes('diagnosis') || name.includes('krankheit')) {
      factKey = 'user_health_condition';
      entityScope = 'self';
    }
    // Preference facts
    else if (name.includes('prefer') || name.includes('favorite') || name.includes('liebling')) {
      factKey = `user_preference_${this.sanitizeKey(name)}`;
      entityScope = 'self';
    }
    // Goal facts
    else if (name.includes('goal') || name.includes('ziel') || name.includes('plan')) {
      factKey = `user_goal_${this.sanitizeKey(name)}`;
      entityScope = 'self';
    }
    // Generic entity - create fact key from name
    else {
      factKey = `entity_${this.sanitizeKey(name)}`;
      entityScope = 'self';
    }

    return { factKey, factValue, entityScope };
  }

  /**
   * Determine fact_value_type based on entity
   */
  private getFactValueType(entity: CogneeEntity): string {
    const name = entity.name?.toLowerCase() || '';

    if (name.includes('birthday') || name.includes('date') || name.includes('geburtstag')) {
      return 'date';
    }
    if (name.includes('age') || name.includes('alter') || name.includes('count')) {
      return 'number';
    }
    return 'text';
  }

  /**
   * Sanitize string for use as fact key (lowercase, underscores)
   */
  private sanitizeKey(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 50);
  }
}

// =============================================================================
// VTID-01225: Singleton Export
// =============================================================================

export const cogneeExtractorClient = new CogneeExtractorClient();
