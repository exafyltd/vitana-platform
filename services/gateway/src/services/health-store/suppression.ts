/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S9: the storage half of withdrawal.
 *
 *   suppressHealthData(sb, identity, { category?, source_id?, at? })
 *   unsuppressHealthData(sb, identity, { category?, source_id? })
 *
 * over the A1 SQL primitives health_store_suppress / health_store_unsuppress:
 * suppressed rows are unusable at once (RLS and every reader filter them),
 * can be restored within 7 days, and are hard-deleted by the purge afterwards.
 *
 * Suppression also deletes the member's raw batches of that source (or of
 * every source when no source is named) from the raw-batch bucket (plan
 * Change 6, round-1 F4 trade-off): a raw batch mixes categories, so a
 * withdrawal of one category removes all raw batches of that source; the
 * stored data of still-consented categories survives. Unsuppress cannot
 * restore raw batches (a convenience, never the system of record).
 *
 * Withdrawal always works: neither primitive checks consent or the store
 * flag (a rollback unsets the flag but leaves data in place). After the
 * commit, the registered change hooks (S8) run fire-and-forget.
 * Wiring revoke -> suppress belongs to the Phase 1 consent package.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { HEALTH_DATA_CATEGORIES, type HealthDataCategory } from './catalogue';
import type { HealthStoreIdentity } from './change-hook';
import { defaultHealthStoreDeps, storeErrorCode, type HealthStoreDeps } from './ingest';
import { rawBatchPrefix } from './raw-batch-store';
import { HEALTH_STORE_VTID } from './flags';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SuppressionInput {
  category?: HealthDataCategory | null;
  source_id?: string | null;
  /** Suppression time (default now). */
  at?: string | null;
}

export type SuppressionErrorCode = 'STORE_PENDING' | 'STORE_UNAVAILABLE' | 'INVALID_INPUT';

export type SuppressionResult =
  | {
      ok: true;
      /** Rows changed per store tier. */
      counts: Record<string, number>;
      /** Raw-batch erasure (suppress only): null when no bucket is configured. */
      raw: { deleted: number; residual: number } | { error: 'STORE_UNAVAILABLE' } | null;
    }
  | { ok: false; code: SuppressionErrorCode };

function checkInput(identity: HealthStoreIdentity, input: SuppressionInput | undefined): string | null {
  if (!identity || typeof identity.user_id !== 'string' || !UUID_RE.test(identity.user_id) || !identity.tenant_id) return 'bad identity';
  const i = input ?? {};
  if (i.category != null && !(HEALTH_DATA_CATEGORIES as readonly string[]).includes(i.category)) return 'bad category';
  if (i.source_id != null && (typeof i.source_id !== 'string' || !UUID_RE.test(i.source_id))) return 'bad source';
  if (i.at != null && !Number.isFinite(Date.parse(String(i.at)))) return 'bad at';
  return null;
}

export async function suppressHealthDataWith(
  deps: HealthStoreDeps,
  identity: HealthStoreIdentity,
  input: SuppressionInput = {},
): Promise<SuppressionResult> {
  try {
    if (checkInput(identity, input)) return { ok: false, code: 'INVALID_INPUT' };
    const at = input.at ? new Date(Date.parse(input.at)).toISOString() : deps.now().toISOString();
    const res = await deps.repo.suppress(identity.user_id, input.category ?? null, input.source_id ?? null, at);
    if (res.error) return { ok: false, code: storeErrorCode(res.error) };

    let raw: { deleted: number; residual: number } | { error: 'STORE_UNAVAILABLE' } | null = null;
    if (deps.raw) {
      const prefix = rawBatchPrefix(identity.user_id, input.source_id ?? null);
      const erased = prefix ? await deps.raw.erasePrefix(prefix) : { ok: false as const, code: 'INVALID_INPUT' as const };
      raw = erased.ok ? { deleted: erased.deleted, residual: erased.residual } : { error: 'STORE_UNAVAILABLE' };
      if (!erased.ok || erased.residual > 0) {
        deps.log({ event: 'health_store_withdrawal_raw_incomplete', vtid: HEALTH_STORE_VTID, residual: erased.ok ? erased.residual : null });
      }
    }

    deps.hooks.fire(identity, {
      categories: input.category ? [input.category] : undefined,
      source_id: input.source_id ?? undefined,
    });
    return { ok: true, counts: (res.data ?? {}) as Record<string, number>, raw };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

export async function unsuppressHealthDataWith(
  deps: HealthStoreDeps,
  identity: HealthStoreIdentity,
  input: Omit<SuppressionInput, 'at'> = {},
): Promise<SuppressionResult> {
  try {
    if (checkInput(identity, input)) return { ok: false, code: 'INVALID_INPUT' };
    const res = await deps.repo.unsuppress(identity.user_id, input.category ?? null, input.source_id ?? null);
    if (res.error) return { ok: false, code: storeErrorCode(res.error) };
    deps.hooks.fire(identity, {
      categories: input.category ? [input.category] : undefined,
      source_id: input.source_id ?? undefined,
    });
    return { ok: true, counts: (res.data ?? {}) as Record<string, number>, raw: null };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

export function suppressHealthData(sb: SupabaseClient, identity: HealthStoreIdentity, input: SuppressionInput = {}) {
  return suppressHealthDataWith(defaultHealthStoreDeps(sb), identity, input);
}

export function unsuppressHealthData(sb: SupabaseClient, identity: HealthStoreIdentity, input: Omit<SuppressionInput, 'at'> = {}) {
  return unsuppressHealthDataWith(defaultHealthStoreDeps(sb), identity, input);
}
