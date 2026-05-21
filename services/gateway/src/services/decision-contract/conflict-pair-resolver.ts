// Phase D42 (decision-contract refactor) — VTID-03142.
//
// Sync-cached, never-throws accessor for the `decision_conflict_pair`
// table. Replaces the hardcoded `CONFLICT_TYPE_MAP` constant in
// `d42-context-fusion-engine.ts` (6 conflict types covering 9 pairs).
//
// Why a dedicated table (not JSONB on decision_policy):
//   The user-approved schema is one row per (conflict_type, domain_a,
//   domain_b) tuple so an analyst can grep `decision_conflict_pair`
//   and see exactly which domain pairs the fusion engine treats as
//   conflicting. JSONB would compress the audit trail.
//
// Resolver contract (mirrors PolicyResolver):
//   - Cache TTL: 15s.
//   - Never throws. Cold-cache or DB error → fallback to the literals
//     baked into this module (byte-identical to the pre-D42 constant).
//   - getConflictPairs(opts?) returns a Record<conflict_type,
//     [PriorityDomain, PriorityDomain][]> matching the existing
//     consumer shape in d42-context-fusion-engine.ts.
//   - Tenant-specific rows override the global (`tenant_id IS NULL`)
//     defaults per conflict_type — i.e. a tenant can replace one
//     conflict_type's pair list entirely; missing tenant rows fall
//     back to global.

import { getSupabase } from '../../lib/supabase';
import type { PriorityDomain } from '../../types/context-fusion';

const CACHE_TTL_MS = 15_000;
const TELEMETRY_PREFIX =
  '[ConflictPairResolver][decision_contract.conflict_pair.miss]';

interface ConflictPairRow {
  conflict_type: string;
  domain_a: string;
  domain_b: string;
  tenant_id: string | null;
  version: number;
  effective_from: string;
  effective_until: string | null;
}

export type ConflictPairMap = Record<string, [PriorityDomain, PriorityDomain][]>;

interface CacheSnapshot {
  // Map of (tenant_id|'GLOBAL') → conflict_type → ordered pair list
  byTenant: Map<string, ConflictPairMap>;
  warmedAt: number;
}

let cache: CacheSnapshot | null = null;
let refreshInflight: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let loggedMiss = false;

// Cold-cache fallback — pre-D42 `CONFLICT_TYPE_MAP` from
// d42-context-fusion-engine.ts:76-89. Behaviourally byte-identical to
// the original literal: the consumer at line 869 handles pair order
// either way (`domain1 === 'health_wellbeing' ? domain2 : domain1`)
// and the lookup at line 667 is `find` on each side, so alphabetizing
// within each pair (to match the seeded-row representation) does NOT
// change runtime behaviour. 6 conflict types, 8 pairs total.
const FALLBACK_MAP: ConflictPairMap = {
  health_vs_monetization: [['commerce_monetization', 'health_wellbeing']],
  rest_vs_social: [['health_wellbeing', 'social_relationships']],
  learning_vs_availability: [['health_wellbeing', 'learning_growth']],
  goals_vs_desire: [['exploration_discovery', 'learning_growth']],
  boundaries_vs_optimization: [
    ['commerce_monetization', 'health_wellbeing'],
    ['commerce_monetization', 'social_relationships'],
  ],
  capacity_vs_demand: [
    ['health_wellbeing', 'learning_growth'],
    ['health_wellbeing', 'social_relationships'],
  ],
};

const GLOBAL_TENANT_TAG = 'GLOBAL';

function tenantKey(tenantId: string | null | undefined): string {
  return tenantId ?? GLOBAL_TENANT_TAG;
}

function emptySnapshot(): CacheSnapshot {
  return { byTenant: new Map(), warmedAt: Date.now() };
}

function isEffectiveAt(row: ConflictPairRow, nowMs: number): boolean {
  const fromMs = Date.parse(row.effective_from);
  if (Number.isNaN(fromMs) || fromMs > nowMs) return false;
  if (row.effective_until) {
    const untilMs = Date.parse(row.effective_until);
    if (!Number.isNaN(untilMs) && untilMs <= nowMs) return false;
  }
  return true;
}

function groupRowsIntoMap(
  rows: ConflictPairRow[],
  tenantId: string | null,
  nowMs: number,
): ConflictPairMap {
  // For each conflict_type, pick the rows scoped to this tenant (or
  // global when no tenant-specific rows exist), at the highest
  // currently-effective version. Pair list = all such rows ordered by
  // (domain_a, domain_b) for determinism.
  const out: ConflictPairMap = {};

  // Group all rows by conflict_type.
  const byType = new Map<string, ConflictPairRow[]>();
  for (const r of rows) {
    if (!isEffectiveAt(r, nowMs)) continue;
    const list = byType.get(r.conflict_type);
    if (list) list.push(r);
    else byType.set(r.conflict_type, [r]);
  }

  for (const [conflictType, list] of byType) {
    // Per-conflict-type, prefer tenant-specific rows; if none exist for
    // this tenant, fall back to global. Take the highest version among
    // the chosen scope (so an admin bump to v2 supersedes v1 entirely).
    const tenantRows = tenantId
      ? list.filter((r) => r.tenant_id === tenantId)
      : [];
    const scopeRows = tenantRows.length > 0
      ? tenantRows
      : list.filter((r) => r.tenant_id === null);
    if (scopeRows.length === 0) continue;
    const maxVersion = Math.max(...scopeRows.map((r) => r.version));
    const winning = scopeRows.filter((r) => r.version === maxVersion);
    const pairs = winning
      .map((r): [PriorityDomain, PriorityDomain] => [
        r.domain_a as PriorityDomain,
        r.domain_b as PriorityDomain,
      ])
      .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    out[conflictType] = pairs;
  }
  return out;
}

async function fetchAll(): Promise<CacheSnapshot> {
  const snap = emptySnapshot();
  const supa = getSupabase();
  if (!supa) {
    return snap; // Will fall through to FALLBACK_MAP at read time.
  }
  try {
    const { data, error } = await supa
      .from('decision_conflict_pair')
      .select(
        'conflict_type, domain_a, domain_b, tenant_id, version, effective_from, effective_until',
      );
    if (error) {
      if (
        !/relation .*decision_conflict_pair.* does not exist/i.test(error.message)
      ) {
        console.warn(
          `${TELEMETRY_PREFIX} decision_conflict_pair fetch failed: ${error.message}`,
        );
      }
      return snap;
    }
    if (!Array.isArray(data)) return snap;
    const rows = data as ConflictPairRow[];
    const nowMs = Date.now();
    // Pre-compute the global map once; per-tenant maps are computed
    // on demand at read time because we don't know which tenants are
    // active. Cache stores the raw rows for re-grouping.
    snap.byTenant.set(GLOBAL_TENANT_TAG, groupRowsIntoMap(rows, null, nowMs));
    // Store raw rows under a sentinel for tenant-specific re-grouping.
    (snap as CacheSnapshot & { rawRows: ConflictPairRow[] }).rawRows = rows;
  } catch (e: any) {
    console.warn(
      `${TELEMETRY_PREFIX} decision_conflict_pair fetch threw: ${e?.message ?? e}`,
    );
  }
  return snap;
}

async function refreshImpl(): Promise<void> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      const next = await fetchAll();
      cache = next;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

/**
 * Boot warmer. Block until the first fetch resolves; start a 15s
 * background refresh. Never throws.
 */
export async function warmConflictPairCache(): Promise<void> {
  await refreshImpl();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshImpl();
    }, CACHE_TTL_MS);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }
}

function logMissOnce(message: string): void {
  if (loggedMiss) return;
  loggedMiss = true;
  console.warn(`${TELEMETRY_PREFIX} ${message}`);
}

export interface ConflictPairResolver {
  getConflictPairs(opts?: { tenantId?: string | null }): ConflictPairMap;
  refresh(): Promise<void>;
}

function getConflictPairsImpl(opts?: {
  tenantId?: string | null;
}): ConflictPairMap {
  const tenantId = opts?.tenantId ?? null;
  if (!cache) {
    logMissOnce(
      `cache cold for conflict pairs (tenant=${tenantKey(tenantId)}) — using fallback literals`,
    );
    return FALLBACK_MAP;
  }
  const raw = (cache as CacheSnapshot & { rawRows?: ConflictPairRow[] })
    .rawRows;
  // Distinguish "table missing / unmigrated" (no rows ever loaded) from
  // "table populated but admin disabled / time-filtered" (rows exist
  // but none currently match). Only the former falls back to literals.
  if (!raw || raw.length === 0) {
    return FALLBACK_MAP;
  }
  if (tenantId === null) {
    return cache.byTenant.get(GLOBAL_TENANT_TAG) ?? {};
  }
  // Per-tenant: merge tenant rows over global so a tenant only has to
  // override the conflict_types it cares about; the rest fall back to
  // global. Cache the merged result for the TTL.
  const cached = cache.byTenant.get(tenantId);
  if (cached) return cached;
  const tenantMap = groupRowsIntoMap(raw, tenantId, Date.now());
  const global = cache.byTenant.get(GLOBAL_TENANT_TAG) ?? {};
  const merged: ConflictPairMap = { ...global, ...tenantMap };
  cache.byTenant.set(tenantId, merged);
  return merged;
}

const resolverSingleton: ConflictPairResolver = {
  getConflictPairs(opts?: { tenantId?: string | null }): ConflictPairMap {
    return getConflictPairsImpl(opts);
  },
  refresh: refreshImpl,
};

export function getConflictPairResolver(): ConflictPairResolver {
  return resolverSingleton;
}

// ---- test support ------------------------------------------------------
export interface ConflictPairResolverTestSeed {
  rows?: ConflictPairRow[];
}

export function configureConflictPairResolverForTests(
  seed: ConflictPairResolverTestSeed,
): void {
  const snap = emptySnapshot();
  const rows = seed.rows ?? [];
  const nowMs = Date.now();
  snap.byTenant.set(GLOBAL_TENANT_TAG, groupRowsIntoMap(rows, null, nowMs));
  (snap as CacheSnapshot & { rawRows: ConflictPairRow[] }).rawRows = rows;
  cache = snap;
  loggedMiss = false;
}

export function __resetConflictPairResolverForTests(): void {
  cache = null;
  refreshInflight = null;
  loggedMiss = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
