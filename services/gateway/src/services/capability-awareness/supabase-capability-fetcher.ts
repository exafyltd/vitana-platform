/**
 * VTID-02923 (B0e.3) — Supabase-backed CapabilityFetcher.
 *
 * Binds the B0e.2 Feature Discovery provider to the real
 * `system_capabilities` + `user_capability_awareness` tables created
 * in B0e.1.
 *
 * Wall discipline (locked by user):
 *   - **Read-only.** This module exposes NO write/mutate methods.
 *     State advancement (introduced → seen → tried → completed →
 *     mastered, or → dismissed) lives in B0e.4 behind a separate
 *     event/RPC path. Even adding an `upsert*` method here would
 *     violate the wall.
 *   - Cache reads conservatively to keep per-turn latency low without
 *     letting stale data drive a wrong "this is a new feature for
 *     you" prompt: 60s in-memory cache, keyed by tenant+user. Catalog
 *     reads are slower-moving — 5-minute cache.
 *
 * Failure policy: any Supabase error returns an empty array (provider
 * then suppresses with the standard `no_eligible_capability` reason).
 * We never throw upward — feature-discovery is observability + nudge
 * surface, never a wake-blocker.
 */

import { getSupabase } from '../../lib/supabase';
import type {
  AwarenessRow,
  AwarenessState,
  CapabilityFetcher,
  CapabilityRow,
} from '../assistant-continuation/providers/feature-discovery';

// ---------------------------------------------------------------------------
// Cache primitives
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AWARENESS_TTL_MS = 60 * 1000;   // 1 minute

// Catalog cache is keyed by tenantId (defensive: the catalog is global
// today via system_capabilities RLS read-all, but per-tenant overrides
// may ship later — the cache key needs to be tenant-correct from the
// start so we don't have to chase down callers later). The key
// '__global__' captures the tenant-less inspection path.
const _catalogCache = new Map<string, CacheEntry<CapabilityRow[]>>();
const _awarenessCache = new Map<string, CacheEntry<AwarenessRow[]>>();

function awarenessCacheKey(tenantId: string, userId: string): string {
  return `${tenantId}::${userId}`;
}

function catalogCacheKey(tenantId: string | undefined): string {
  return tenantId && tenantId.length > 0 ? tenantId : '__global__';
}

/** Test seam: clear all caches between tests. */
export function resetSupabaseCapabilityFetcherCache(): void {
  _catalogCache.clear();
  _awarenessCache.clear();
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface SupabaseCapabilityFetcherOptions {
  /** Injected for tests. Production uses Date.now. */
  now?: () => number;
  /** Inject a supabase client for tests; defaults to the singleton. */
  getDb?: typeof getSupabase;
}

export function createSupabaseCapabilityFetcher(
  opts: SupabaseCapabilityFetcherOptions = {},
): CapabilityFetcher {
  const now = opts.now ?? (() => Date.now());
  const getDb = opts.getDb ?? getSupabase;

  return {
    async listCapabilities(args = {}): Promise<CapabilityRow[]> {
      const t = now();
      const key = catalogCacheKey(args.tenantId);
      const cached = _catalogCache.get(key);
      if (cached && cached.expiresAtMs > t) {
        return cached.value;
      }
      const sb = getDb();
      if (!sb) {
        // No DB available (unit tests / disabled environment). The
        // provider's suppression path catches this gracefully.
        _catalogCache.set(key, { value: [], expiresAtMs: t + CATALOG_TTL_MS });
        return [];
      }
      try {
        const { data, error } = await sb
          .from('system_capabilities')
          .select(
            'capability_key, display_name, description, required_role, required_tenant_features, required_integrations, helpful_for_intents, enabled',
          )
          .eq('enabled', true);
        if (error || !Array.isArray(data)) {
          _catalogCache.set(key, { value: [], expiresAtMs: t + CATALOG_TTL_MS });
          return [];
        }
        const rows: CapabilityRow[] = data.map(rowToCapability);
        _catalogCache.set(key, { value: rows, expiresAtMs: t + CATALOG_TTL_MS });
        return rows;
      } catch {
        _catalogCache.set(key, { value: [], expiresAtMs: t + CATALOG_TTL_MS });
        return [];
      }
    },

    async listAwareness(args): Promise<AwarenessRow[]> {
      const t = now();
      const key = awarenessCacheKey(args.tenantId, args.userId);
      const cached = _awarenessCache.get(key);
      if (cached && cached.expiresAtMs > t) {
        return cached.value;
      }
      const sb = getDb();
      if (!sb) {
        _awarenessCache.set(key, { value: [], expiresAtMs: t + AWARENESS_TTL_MS });
        return [];
      }
      try {
        const { data, error } = await sb
          .from('user_capability_awareness')
          .select(
            'capability_key, awareness_state, first_introduced_at, last_introduced_at, first_used_at, last_used_at, use_count, dismiss_count, mastery_confidence, last_surface',
          )
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId);
        if (error || !Array.isArray(data)) {
          _awarenessCache.set(key, { value: [], expiresAtMs: t + AWARENESS_TTL_MS });
          return [];
        }
        const rows: AwarenessRow[] = data.map(rowToAwareness);
        _awarenessCache.set(key, { value: rows, expiresAtMs: t + AWARENESS_TTL_MS });
        return rows;
      } catch {
        _awarenessCache.set(key, { value: [], expiresAtMs: t + AWARENESS_TTL_MS });
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Production singleton
// ---------------------------------------------------------------------------

export const defaultSupabaseCapabilityFetcher = createSupabaseCapabilityFetcher();

// ---------------------------------------------------------------------------
// Row mappers — pure, exported for tests
// ---------------------------------------------------------------------------

function asStringArrayOrNull(v: unknown): string[] | null {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return v as string[];
  }
  return null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function rowToCapability(row: Record<string, unknown>): CapabilityRow {
  return {
    capability_key: String(row.capability_key ?? ''),
    display_name: String(row.display_name ?? ''),
    description: String(row.description ?? ''),
    required_role: asStringOrNull(row.required_role),
    required_tenant_features: asStringArrayOrNull(row.required_tenant_features),
    required_integrations: asStringArrayOrNull(row.required_integrations),
    helpful_for_intents: asStringArrayOrNull(row.helpful_for_intents),
    enabled: row.enabled !== false,
  };
}

const KNOWN_AWARENESS_STATES: ReadonlySet<AwarenessState> = new Set<AwarenessState>([
  'unknown',
  'introduced',
  'seen',
  'tried',
  'completed',
  'dismissed',
  'mastered',
]);

export function rowToAwareness(row: Record<string, unknown>): AwarenessRow {
  const stateRaw = typeof row.awareness_state === 'string' ? row.awareness_state : 'unknown';
  const state: AwarenessState = KNOWN_AWARENESS_STATES.has(stateRaw as AwarenessState)
    ? (stateRaw as AwarenessState)
    : 'unknown';
  return {
    capability_key: String(row.capability_key ?? ''),
    awareness_state: state,
    first_introduced_at: asStringOrNull(row.first_introduced_at),
    last_introduced_at: asStringOrNull(row.last_introduced_at),
    first_used_at: asStringOrNull(row.first_used_at),
    last_used_at: asStringOrNull(row.last_used_at),
    use_count: typeof row.use_count === 'number' ? row.use_count : 0,
    dismiss_count: typeof row.dismiss_count === 'number' ? row.dismiss_count : 0,
    mastery_confidence: asNumberOrNull(row.mastery_confidence),
    last_surface: asStringOrNull(row.last_surface),
  };
}
