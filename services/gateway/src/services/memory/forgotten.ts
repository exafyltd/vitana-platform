/**
 * VTID-04441: "do not re-learn" markers for facts a user forgot.
 *
 * The Memory Garden forgets a fact by deleting every row of its key. Without
 * a marker the next session's extractor could infer the same value again and
 * it would come back. deleteGardenEntry() now records one marker per value
 * it deletes, and rememberFact() consults them:
 *
 *   - an inferred write (anything that is not an explicit user statement)
 *     whose key + value matches a marker is refused;
 *   - an explicit user statement is written and clears the marker, because
 *     the user has told Vitana again.
 *
 * The value is kept only as a SHA-256 of its normalised form: the user asked
 * for it to be forgotten, so the marker must not keep it.
 *
 * Failure posture: a marker read that fails lets the write through (logged).
 * Refusing every fact write because a side table is unreachable would break
 * memory for everyone; one re-learned value is the smaller harm.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'memory_fact_forgotten';

/** Provenances that mean the user said it themselves, now. */
const EXPLICIT_PREFIXES = ['user_stated', 'user_edited'];

export function isExplicitUserStatement(provenance: string | null | undefined): boolean {
  const p = String(provenance || '').toLowerCase();
  return EXPLICIT_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}_`));
}

export function normalizeFactValue(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function hashFactValue(value: string): string {
  return createHash('sha256').update(normalizeFactValue(value)).digest('hex');
}

export interface ForgottenKey {
  tenant_id: string;
  user_id: string;
  fact_key: string;
}

export interface ForgottenStore {
  /** True when a marker exists for this key + value hash. */
  has(key: ForgottenKey, valueHash: string): Promise<boolean>;
  add(key: ForgottenKey, valueHashes: string[]): Promise<void>;
  clear(key: ForgottenKey, valueHash: string): Promise<void>;
}

/** Store backed by a supplied Supabase client (service role). */
export function clientForgottenStore(client: SupabaseClient): ForgottenStore {
  return {
    async has(key, valueHash) {
      const { data, error } = await client
        .from(TABLE)
        .select('id')
        .eq('tenant_id', key.tenant_id)
        .eq('user_id', key.user_id)
        .eq('fact_key', key.fact_key)
        .eq('value_hash', valueHash)
        .limit(1);
      if (error) throw new Error(error.message);
      return Array.isArray(data) && data.length > 0;
    },
    async add(key, valueHashes) {
      if (valueHashes.length === 0) return;
      const rows = [...new Set(valueHashes)].map((value_hash) => ({ ...key, value_hash }));
      const { error } = await client
        .from(TABLE)
        .upsert(rows, { onConflict: 'tenant_id,user_id,fact_key,value_hash', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    },
    async clear(key, valueHash) {
      const { error } = await client
        .from(TABLE)
        .delete()
        .eq('tenant_id', key.tenant_id)
        .eq('user_id', key.user_id)
        .eq('fact_key', key.fact_key)
        .eq('value_hash', valueHash);
      if (error) throw new Error(error.message);
    },
  };
}

/** Store backed by service-role REST calls (rememberFact's default transport). */
export function restForgottenStore(): ForgottenStore | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` };
  const filter = (k: ForgottenKey, valueHash: string) =>
    `tenant_id=eq.${encodeURIComponent(k.tenant_id)}&user_id=eq.${encodeURIComponent(k.user_id)}` +
    `&fact_key=eq.${encodeURIComponent(k.fact_key)}&value_hash=eq.${valueHash}`;
  return {
    async has(k, valueHash) {
      const res = await fetch(`${url}/rest/v1/${TABLE}?select=id&limit=1&${filter(k, valueHash)}`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const rows = await res.json().catch(() => []);
      return Array.isArray(rows) && rows.length > 0;
    },
    async add(k, valueHashes) {
      if (valueHashes.length === 0) return;
      const rows = [...new Set(valueHashes)].map((value_hash) => ({ ...k, value_hash }));
      const res = await fetch(`${url}/rest/v1/${TABLE}?on_conflict=tenant_id,user_id,fact_key,value_hash`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`${res.status}`);
    },
    async clear(k, valueHash) {
      const res = await fetch(`${url}/rest/v1/${TABLE}?${filter(k, valueHash)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error(`${res.status}`);
    },
  };
}

export type ForgottenGate = { allow: true; cleared?: boolean } | { allow: false };

/**
 * Decide whether a fact write may proceed. Explicit user statements always
 * proceed and clear any marker; inferred writes of a forgotten value do not.
 */
export async function checkForgottenGate(
  store: ForgottenStore | null,
  key: ForgottenKey,
  value: string,
  provenance: string,
): Promise<ForgottenGate> {
  if (!store) return { allow: true };
  const valueHash = hashFactValue(value);
  try {
    if (isExplicitUserStatement(provenance)) {
      await store.clear(key, valueHash);
      return { allow: true, cleared: true };
    }
    return (await store.has(key, valueHash)) ? { allow: false } : { allow: true };
  } catch (err: any) {
    console.warn(`[VTID-04441] forgotten-marker check failed for ${key.fact_key}; write allowed: ${err?.message || err}`);
    return { allow: true };
  }
}
