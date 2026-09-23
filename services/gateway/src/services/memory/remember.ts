/**
 * VTID-04364: the single write path for memory facts.
 *
 * Before this module, six call sites each built their own `write_fact` RPC
 * call. Two of them ran the Identity Lock check, one embedded the new row,
 * one mirrored it to the tier-2 `mem_facts` table, and none did all three.
 * That is how the two fact tables drifted apart and how most facts ended up
 * with no embedding (docs/MEMORY-SYSTEM-PLAN.md, defect D8).
 *
 * `rememberFact()` does the same three steps for every caller:
 *   1. the Identity Lock check (VTID-01952). The DB trigger enforces it
 *      too; this check runs first so a blocked write is logged with its actor;
 *   2. the `write_fact` RPC. The database decides whether to insert,
 *      supersede, or keep the existing row (VTID-04341);
 *   3. a Titan embedding for the written row, fire-and-forget.
 *      AP-0910 re-embeds any row this step misses.
 *
 * The transport is the caller's choice: pass `client` to use a supplied
 * Supabase client (the automation handlers do), or leave it out to use a
 * service-role REST call. Both send the identical payload.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWriteFact } from '../memory-audit';

export type FactProvenance =
  | 'user_stated'
  | 'user_stated_via_settings'
  | 'user_edited'
  | 'assistant_inferred'
  | 'system_observed'
  | 'behavior_inferred'
  | string;

export interface RememberFactInput {
  tenant_id: string;
  user_id: string;
  fact_key: string;
  fact_value: string;
  entity?: 'self' | 'disclosed' | string;
  fact_value_type?: string;
  provenance_source: FactProvenance;
  provenance_confidence?: number;
  provenance_utterance_id?: string | null;
  thread_id?: string | null;
  /** Who is writing, e.g. 'inline-fact-extractor'. Recorded by the Identity Lock audit. */
  actor: string;
}

export interface RememberFactOptions {
  /** Use this client's `.rpc()` instead of a REST call. */
  client?: SupabaseClient | null;
  /** Embed the written row. Defaults to true. */
  embed?: boolean;
}

export interface RememberFactResult {
  ok: boolean;
  fact_id?: string;
  error?: string;
  /** Set when the Identity Lock refused the write; no RPC was sent. */
  blocked?: 'identity_lock';
}

const DEFAULT_CONFIDENCE = 0.9;

export function buildWriteFactPayload(input: RememberFactInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    p_tenant_id: input.tenant_id,
    p_user_id: input.user_id,
    p_fact_key: input.fact_key,
    p_fact_value: input.fact_value,
    p_entity: input.entity || 'self',
    p_fact_value_type: input.fact_value_type || 'text',
    p_provenance_source: input.provenance_source || 'user_stated',
    p_provenance_confidence: input.provenance_confidence ?? DEFAULT_CONFIDENCE,
  };
  // The RPC defaults both to NULL; send them only when set so the payload
  // stays identical to what the pre-VTID-04364 callers sent.
  if (input.provenance_utterance_id) payload.p_provenance_utterance_id = input.provenance_utterance_id;
  if (input.thread_id) payload.p_thread_id = input.thread_id;
  return payload;
}

async function writeViaRest(payload: Record<string, unknown>): Promise<{ id: string | null; error: string | null }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { id: null, error: 'Supabase not configured' };
  const response = await fetch(`${url}/rest/v1/rpc/write_fact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { id: null, error: `${response.status} ${body.slice(0, 200)}`.trim() };
  }
  const id = await response.json().catch(() => null);
  return { id: typeof id === 'string' ? id : null, error: null };
}

async function writeViaClient(
  client: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc('write_fact', payload);
  if (error) return { id: null, error: error.message || String(error) };
  return { id: typeof data === 'string' ? data : null, error: null };
}

function embedAsync(factId: string, key: string, value: string): void {
  void import('../memory-facts-service')
    .then((m) => m.generateFactEmbeddingAsync(factId, key, value))
    .catch(() => {
      /* best-effort; AP-0910 re-embeds rows with a NULL embedding */
    });
}

export async function rememberFact(
  input: RememberFactInput,
  options: RememberFactOptions = {},
): Promise<RememberFactResult> {
  if (!input.tenant_id || !input.user_id) return { ok: false, error: 'tenant_id and user_id are required' };
  if (!input.fact_key || typeof input.fact_value !== 'string' || !input.fact_value.trim()) {
    return { ok: false, error: 'fact_key and a non-empty fact_value are required' };
  }

  const lock = await assertWriteFact({
    fact_key: input.fact_key,
    provenance_source: input.provenance_source,
    provenance_confidence: input.provenance_confidence ?? DEFAULT_CONFIDENCE,
    actor_id: input.actor,
    source_engine: input.actor,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
  });
  if (!lock.ok) {
    return {
      ok: false,
      blocked: 'identity_lock',
      error: `identity_locked: ${input.fact_key} cannot be written from this source`,
    };
  }

  const payload = buildWriteFactPayload(input);
  let result: { id: string | null; error: string | null };
  try {
    result = options.client ? await writeViaClient(options.client, payload) : await writeViaRest(payload);
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (result.error) return { ok: false, error: result.error };

  if (result.id && options.embed !== false) embedAsync(result.id, input.fact_key, input.fact_value);
  return { ok: true, fact_id: result.id ?? undefined };
}
