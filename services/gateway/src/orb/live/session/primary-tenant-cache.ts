/**
 * VTID-04543 — in-process cache for the user → primary tenant lookup.
 *
 * `lookupPrimaryTenant()` (routes/orb-live.ts) runs whenever a JWT carries no
 * tenant (Cognito tokens never do; many Supabase tokens don't either). It is
 * one or two `user_tenants` reads, and it sat on the ORB voice hot path: the
 * SSE transport resolves identity on every mic-frame POST (~15/s).
 *
 * Contract:
 *   - Only a resolved tenant id is cached. A null result (no row, error,
 *     thrown loader) is never cached, so a user whose membership is being
 *     provisioned right now is found on the next call, exactly as before.
 *   - Entries expire after `ttlMs` (default 5 min). Invalidation risk: a user
 *     whose PRIMARY tenant is switched to a different tenant can see the old
 *     one for at most `ttlMs` in this process. Nothing in the gateway writes
 *     `user_tenants.is_primary` today; if something starts to, call
 *     `invalidate(userId)` after the write.
 *   - Bounded: at most `maxEntries` users; the oldest entry is evicted first.
 *   - Concurrent lookups for the same user share one in-flight loader.
 */

export interface PrimaryTenantCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface PrimaryTenantCache {
  resolve(userId: string, loader: () => Promise<string | null>): Promise<string | null>;
  invalidate(userId: string): void;
  clear(): void;
  size(): number;
}

export const PRIMARY_TENANT_CACHE_TTL_MS = 5 * 60 * 1000;
export const PRIMARY_TENANT_CACHE_MAX_ENTRIES = 5_000;

export function createPrimaryTenantCache(opts: PrimaryTenantCacheOptions = {}): PrimaryTenantCache {
  const ttlMs = opts.ttlMs ?? PRIMARY_TENANT_CACHE_TTL_MS;
  const maxEntries = Math.max(1, opts.maxEntries ?? PRIMARY_TENANT_CACHE_MAX_ENTRIES);
  const now = opts.now ?? (() => Date.now());
  // Map preserves insertion order → the first key is the oldest entry.
  const entries = new Map<string, { tenantId: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  return {
    async resolve(userId, loader) {
      const hit = entries.get(userId);
      if (hit) {
        if (hit.expiresAt > now()) return hit.tenantId;
        entries.delete(userId);
      }
      const pending = inFlight.get(userId);
      if (pending) return pending;

      const load = (async () => {
        const tenantId = await loader();
        if (tenantId) {
          entries.delete(userId);
          entries.set(userId, { tenantId, expiresAt: now() + ttlMs });
          while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            entries.delete(oldest);
          }
        }
        return tenantId;
      })();
      inFlight.set(userId, load);
      try {
        return await load;
      } finally {
        inFlight.delete(userId);
      }
    },
    invalidate(userId) {
      entries.delete(userId);
    },
    clear() {
      entries.clear();
      inFlight.clear();
    },
    size() {
      return entries.size;
    },
  };
}
