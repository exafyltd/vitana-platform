/**
 * VTID-02005 — Phase 5b — Tier 2 dual-writer.
 *
 * Fans memory writes out to the new bi-temporal mem_* tables introduced
 * in Phase 5a (VTID-02003) WITHOUT changing the existing primary writes.
 * The legacy tables (memory_items, memory_facts, relationship_edges)
 * remain the source of truth during the migration; mem_* receives an
 * additive mirror with bi-temporal columns + provenance.
 *
 * Contract:
 *   - Every function here is fire-and-forget. Failures DO NOT throw.
 *   - On Tier 2 insert failure, the row is parked in `memory_write_dlq`
 *     for the self-healing reconciler to drain.
 *   - Gated by the `mem_tier2_dual_write_enabled` system_controls flag
 *     (default false). Off = no-op, fully backwards compatible.
 *
 * Plan reference: the-vitana-system-has-wild-puffin.md, Part 6
 * ("Layer 2 — Tier 2 pgvector") + Part 8 Phase 5.
 */

import { getSupabase } from '../lib/supabase';
import { getSystemControl } from './system-controls-service';

const VTID = 'VTID-02005';
const POLICY_VERSION = 'mem-2026.04';

// In-process flag cache. system_controls is hit at most once every CACHE_TTL_MS.
let cachedFlagValue: boolean | null = null;
let cachedFlagAt = 0;
const FLAG_CACHE_TTL_MS = 30_000;

/**
 * Whether Tier 2 dual-write is currently enabled.
 *
 * Cached for 30s to keep this off the hot path of every memory write.
 * The cache is intentionally process-local; re-reading at 30s intervals
 * is plenty for a flag flip on a non-critical mirror.
 */
async function isTier2DualWriteEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedFlagValue !== null && now - cachedFlagAt < FLAG_CACHE_TTL_MS) {
    return cachedFlagValue;
  }
  try {
    const control = await getSystemControl('mem_tier2_dual_write_enabled');
    cachedFlagValue = !!(control && control.enabled);
  } catch {
    cachedFlagValue = false;
  }
  cachedFlagAt = now;
  return cachedFlagValue;
}

// =============================================================================
// Episodic mirror — feeds the EPISODIC block of MemoryPack
// =============================================================================

export interface EpisodeMirrorInput {
  tenant_id: string;
  user_id: string;
  // Original primary-table row id, for traceability + idempotency.
  source_event_id?: string;
  session_id?: string;
  conversation_id?: string;
  kind:
    | 'utterance'
    | 'event'
    | 'completion'
    | 'observation'
    | 'dyk_view'
    | 'dismissal'
    | 'navigation'
    | 'arrival'
    | 'departure'
    | 'milestone'
    | 'mention';
  content: string;
  content_json?: Record<string, unknown>;
  importance?: number;
  category_key?: string;
  source?: string;
  workspace_scope?: string;
  active_role?: string;
  visibility_scope?: string;
  origin_service?: string;
  vtid?: string;
  // Provenance (mandatory at the table level)
  actor_id: string;
  confidence?: number;
  source_engine?: string;
  classification?: Record<string, unknown>;
  occurred_at?: string;
}

/**
 * Mirror an episodic memory row into mem_episodes.
 *
 * Fire-and-forget. Returns silently. On error, parks the row in
 * memory_write_dlq for the reconciler. Caller never blocks.
 */
export async function mirrorEpisode(input: EpisodeMirrorInput): Promise<void> {
  if (!(await isTier2DualWriteEnabled())) {
    return;
  }

  const supabase = getSupabase();
  if (!supabase) return;

  const row = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    session_id: input.session_id ?? null,
    conversation_id: input.conversation_id ?? null,
    kind: input.kind,
    content: input.content,
    content_json: input.content_json ?? null,
    importance: input.importance ?? 30,
    category_key: input.category_key ?? null,
    source: input.source ?? null,
    workspace_scope: input.workspace_scope ?? null,
    active_role: input.active_role ?? null,
    visibility_scope: input.visibility_scope ?? 'private',
    origin_service: input.origin_service ?? null,
    vtid: input.vtid ?? null,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    actor_id: input.actor_id,
    confidence: input.confidence ?? 1.0,
    source_event_id: input.source_event_id ?? null,
    policy_version: POLICY_VERSION,
    source_engine: input.source_engine ?? null,
    classification: input.classification ?? {},
  };

  try {
    const { error } = await supabase.from('mem_episodes').insert(row);
    if (error) {
      await parkToDLQ('mem_episodes', row, error);
    }
  } catch (err: any) {
    await parkToDLQ('mem_episodes', row, err);
  }
}

// =============================================================================
// Fact mirror — feeds the SEMANTIC block of MemoryPack
// =============================================================================

export interface FactMirrorInput {
  tenant_id: string;
  user_id: string;
  source_event_id?: string;
  source_episode_id?: string;
  entity?: string;
  fact_key: string;
  fact_value: string;
  fact_value_type?: string;
  vtid?: string;
  // Provenance
  actor_id: string;
  confidence?: number;
  source_engine?: string;
  classification?: Record<string, unknown>;
}

/**
 * Mirror a semantic fact into mem_facts with auto-supersession on the
 * unique (tenant_id, user_id, entity, fact_key) WHERE valid_to IS NULL
 * partial unique index.
 */
export async function mirrorFact(input: FactMirrorInput): Promise<void> {
  if (!(await isTier2DualWriteEnabled())) {
    return;
  }

  const supabase = getSupabase();
  if (!supabase) return;

  const entity = input.entity ?? 'self';
  const now = new Date().toISOString();

  try {
    // Supersede the prior active row for this (tenant,user,entity,fact_key) pair.
    await supabase
      .from('mem_facts')
      .update({ valid_to: now, superseded_at: now })
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .eq('entity', entity)
      .eq('fact_key', input.fact_key)
      .is('valid_to', null);

    const row = {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      entity,
      fact_key: input.fact_key,
      fact_value: input.fact_value,
      fact_value_type: input.fact_value_type ?? 'text',
      asserted_at: now,
      valid_from: now,
      actor_id: input.actor_id,
      confidence: input.confidence ?? 1.0,
      source_event_id: input.source_event_id ?? null,
      source_episode_id: input.source_episode_id ?? null,
      policy_version: POLICY_VERSION,
      source_engine: input.source_engine ?? null,
      classification: input.classification ?? {},
      vtid: input.vtid ?? null,
    };

    const { error } = await supabase.from('mem_facts').insert(row);
    if (error) {
      await parkToDLQ('mem_facts', row, error);
    }
  } catch (err: any) {
    await parkToDLQ('mem_facts', { ...input, entity }, err);
  }
}

// =============================================================================
// Graph edge mirror — feeds the SOCIAL/NETWORK block of MemoryPack
// =============================================================================

export interface GraphEdgeMirrorInput {
  tenant_id: string;
  user_id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  edge_type: string;
  strength?: number;
  metadata?: Record<string, unknown>;
  last_interaction_at?: string;
  // Provenance
  actor_id: string;
  confidence?: number;
  source_event_id?: string;
  source_engine?: string;
}

/**
 * Mirror a graph edge into mem_graph_edges.
 */
export async function mirrorGraphEdge(input: GraphEdgeMirrorInput): Promise<void> {
  if (!(await isTier2DualWriteEnabled())) {
    return;
  }

  const supabase = getSupabase();
  if (!supabase) return;

  const row = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    source_type: input.source_type,
    source_id: input.source_id,
    target_type: input.target_type,
    target_id: input.target_id,
    edge_type: input.edge_type,
    strength: input.strength ?? 0.5,
    metadata: input.metadata ?? {},
    last_interaction_at: input.last_interaction_at ?? null,
    actor_id: input.actor_id,
    confidence: input.confidence ?? 1.0,
    source_event_id: input.source_event_id ?? null,
    policy_version: POLICY_VERSION,
    source_engine: input.source_engine ?? null,
  };

  try {
    const { error } = await supabase.from('mem_graph_edges').insert(row);
    if (error) {
      await parkToDLQ('mem_graph_edges', row, error);
    }
  } catch (err: any) {
    await parkToDLQ('mem_graph_edges', row, err);
  }
}

// =============================================================================
// DLQ helper
// =============================================================================

async function parkToDLQ(
  stream: 'mem_episodes' | 'mem_facts' | 'mem_graph_edges',
  payload: Record<string, unknown>,
  error: any
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    await supabase.from('memory_write_dlq').insert({
      tenant_id: (payload.tenant_id as string) ?? null,
      user_id: (payload.user_id as string) ?? null,
      stream,
      payload,
      provenance: {
        actor_id: payload.actor_id ?? null,
        policy_version: POLICY_VERSION,
        source_engine: payload.source_engine ?? null,
      },
      error_class: error?.code ?? error?.name ?? 'unknown',
      error_message: (error?.message ?? String(error)).slice(0, 1000),
      attempt_count: 0,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
  } catch (dlqErr: any) {
    // Last resort: log + drop. A dual-writer that takes down the request
    // path is worse than a missed mirror; the legacy table still has the row.
    console.error(
      `[${VTID}] dual-write to ${stream} failed AND DLQ park failed:`,
      'orig=', error?.message ?? error,
      'dlq=', dlqErr?.message ?? dlqErr
    );
  }
}

/**
 * Test/admin helper: clear the in-process flag cache so a fresh
 * `system_controls` read happens on the next call. Used by the
 * `/api/v1/admin/system-controls` flip endpoint.
 */
export function invalidateTier2FlagCache(): void {
  cachedFlagValue = null;
  cachedFlagAt = 0;
}
