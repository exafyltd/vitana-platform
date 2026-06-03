/**
 * Data-export consent gate — Phase 1 W2 (BOOTSTRAP-PHASE1-W2-CONSENT-METADATA).
 *
 * The Phase 1 dataset-extraction loop (services/gateway/scripts/datasets/lib.ts)
 * only ingests oasis_events whose metadata carries `data_export_ok: true`. That
 * flag is the machine-readable record that the tenant has consented to their
 * conversational telemetry being used to build training corpora. W1 shipped the
 * SQL-layer PII gate (`metadata->>data_export_ok=eq.true`); W1 left every
 * producing surface emitting events WITHOUT the flag, so the gate filtered
 * everything and the first cron run yielded 0 rows. This module closes that wire.
 *
 * This is the single source of truth for "is export consent established for this
 * surface?". Producing surfaces (orb-live turn/session events, the autopilot
 * intent emitter, the memory-write emitter) call `dataExportConsentTag()` and
 * spread the result into their event payload. When consent is NOT established the
 * result is an empty object, so untagged events stay filtered out of every
 * dataset — fail-closed by construction.
 *
 * Consent source (tenant policy): `tenant_settings.feature_flags.data_export_ok`
 * must be strictly `true`. Default OFF. Any lookup error → not consented.
 *
 * Reads are cached in-process for 5 minutes (separately per tenant-policy and per
 * user→tenant mapping) so the orb hot path never pays a Supabase round-trip per
 * turn. Cron fan-outs reuse the same cache.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const TTL_MS = 5 * 60 * 1000;
const LOG_PREFIX = '[data-export-consent]';

/** tenantId → { consented, expires_at } */
const tenantPolicyCache = new Map<string, { consented: boolean; expires_at: number }>();
/** userId → { tenantId | null, expires_at } */
const userTenantCache = new Map<string, { tenantId: string | null; expires_at: number }>();

let _client: SupabaseClient | null | undefined;

function getServiceClient(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = process.env.SUPABASE_URL;
  // SUPABASE_SERVICE_ROLE is the canonical var bound on every gateway deploy
  // (CLAUDE.md §8); use it directly so we introduce no unbound env reference.
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.warn(`${LOG_PREFIX} missing SUPABASE_URL / SUPABASE_SERVICE_ROLE; consent stays off`);
    _client = null;
    return null;
  }
  _client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _client;
}

/**
 * Resolve the tenant a user belongs to via the user_tenants membership table.
 * Cached. Returns null on miss/error (→ fail-closed at the policy step).
 */
async function resolveTenantForUser(userId: string): Promise<string | null> {
  const cached = userTenantCache.get(userId);
  if (cached && cached.expires_at > Date.now()) return cached.tenantId;

  let tenantId: string | null = null;
  try {
    const supa = getServiceClient();
    if (supa) {
      const { data } = await supa
        .from('user_tenants')
        .select('tenant_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      tenantId = (data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} resolveTenantForUser(${userId}) error:`, e instanceof Error ? e.message : e);
  }

  userTenantCache.set(userId, { tenantId, expires_at: Date.now() + TTL_MS });
  return tenantId;
}

/**
 * Read tenant_settings.feature_flags.data_export_ok for a tenant. Cached.
 * Strictly `true` ⇒ consented; anything else (missing row, missing flag,
 * non-boolean, error) ⇒ not consented.
 */
async function tenantExportPolicy(tenantId: string): Promise<boolean> {
  const cached = tenantPolicyCache.get(tenantId);
  if (cached && cached.expires_at > Date.now()) return cached.consented;

  let consented = false;
  try {
    const supa = getServiceClient();
    if (supa) {
      const { data } = await supa
        .from('tenant_settings')
        .select('feature_flags')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const flags = (data as { feature_flags?: Record<string, unknown> } | null)?.feature_flags;
      consented = flags?.data_export_ok === true;
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} tenantExportPolicy(${tenantId}) error:`, e instanceof Error ? e.message : e);
  }

  tenantPolicyCache.set(tenantId, { consented, expires_at: Date.now() + TTL_MS });
  return consented;
}

export interface ConsentContext {
  /** Tenant UUID — preferred when available (resolves directly to policy). */
  tenantId?: string | null;
  /** User UUID — used to resolve a tenant when tenantId isn't passed. */
  userId?: string | null;
}

/**
 * True iff data-export consent is established for the given surface. Resolves a
 * tenant (directly, or via userId) and reads the tenant policy. Fail-closed:
 * no ids, no tenant, or any error ⇒ false.
 */
export async function isDataExportConsented(ctx: ConsentContext): Promise<boolean> {
  let tenantId = ctx.tenantId ?? null;
  if (!tenantId && ctx.userId) {
    tenantId = await resolveTenantForUser(ctx.userId);
  }
  if (!tenantId) return false;
  return tenantExportPolicy(tenantId);
}

/**
 * The resolver shape, so callers (and tests) can inject a mock.
 */
export type ConsentResolver = (ctx: ConsentContext) => Promise<boolean>;

/**
 * Returns `{ data_export_ok: true }` when consent is established for the surface,
 * otherwise an empty object. Spread the result into an OASIS event payload:
 *
 *   payload: { ...stuff, ...(await dataExportConsentTag({ userId })) }
 *
 * `resolver` is injectable for unit tests; production callers use the default.
 */
export async function dataExportConsentTag(
  ctx: ConsentContext,
  resolver: ConsentResolver = isDataExportConsented,
): Promise<{ data_export_ok: true } | Record<string, never>> {
  try {
    return (await resolver(ctx)) ? { data_export_ok: true } : {};
  } catch {
    // Fail-closed — telemetry consent must never throw into the hot path.
    return {};
  }
}

/** Test/ops helper — clears the in-process caches. */
export function _resetConsentCaches(): void {
  tenantPolicyCache.clear();
  userTenantCache.clear();
  _client = undefined;
}
