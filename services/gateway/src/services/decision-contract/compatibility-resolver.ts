// Phase D39 PR 5c (decision-contract refactor) — VTID-03171.
//
// Sync-cached, never-throws accessor for the `decision_compatibility_score`
// table that PR 5a created and PR 5b seeded with 138 cells. CPB-style
// boundary: the table name is named here only, and consumers in
// `d39-taste-alignment-service.ts` will reach this module through the
// barrel export in PR 5d/5e. No D39 service code consumes this resolver
// yet (the structural test in
// `test/services/decision-contract/compatibility-resolver-boundary.test.ts`
// asserts that no D39 service file references it).
//
// Why a dedicated table (not JSONB on decision_policy):
//   D39's 9 alignment dimensions are (profile_value, candidate_value)
//   compatibility grids — 138 cells total. JSONB would compress the
//   audit trail; a row per cell lets analysts grep + diff over time
//   and lets a future admin UI tune one cell without rewriting a blob.
//
// Resolver contract (mirrors PolicyResolver + ConflictPairResolver):
//   - Cache TTL: 15s (matches `policy-resolver` + `conflict-pair-resolver`).
//   - Never throws. Cold-cache or DB error → fallback to the literals
//     baked into this module (byte-identical to the inline d39
//     scoreMap / compatibilityMap constants at rev 01bc6fd9).
//   - `getCompatibilityScore(dim, profile, candidate, opts?) → number`
//     returns the cell value; falls back to 0.5 ("neutral") when the
//     cell is missing from BOTH the DB grid and the literal grid.
//   - `getCompatibilityMatrix(dim, opts?) → Record<profile, Record<
//     candidate, number>>` returns the full 2-D grid for a dimension
//     for the caller's tenant scope.
//   - Tenant-specific rows override global per
//     `(dimension, profile_value, candidate_value)` — a tenant can
//     override one cell without redefining the whole grid; missing
//     cells fall back to the global cell, then to the literal.
//   - Malformed-row guard: rows with non-string keys, out-of-[0,1]
//     scores, or unparseable timestamps are dropped at fetch time so
//     a bad seed can't crash the engine.

import { getSupabase } from '../../lib/supabase';

const CACHE_TTL_MS = 15_000;
const TELEMETRY_PREFIX =
  '[CompatibilityResolver][decision_contract.compatibility_score.miss]';
const NEUTRAL_DEFAULT = 0.5;

// ---------------------------------------------------------------------------
// Row + cache types
// ---------------------------------------------------------------------------

interface CompatibilityScoreRow {
  dimension: string;
  profile_value: string;
  candidate_value: string;
  score: number;
  tenant_id: string | null;
  version: number;
  effective_from: string;
  effective_until: string | null;
}

/** Nested matrix: dimension → profile_value → candidate_value → score. */
export type CompatibilityMatrix = Record<string, Record<string, number>>;
export type CompatibilityMatrices = Record<string, CompatibilityMatrix>;

interface CacheSnapshot {
  /**
   * Materialised matrices per tenant. Key is the literal tenant_id
   * string or the GLOBAL sentinel for `tenant_id IS NULL`. Per-tenant
   * matrices are computed lazily on demand at read time and cached
   * here for the TTL.
   */
  byTenant: Map<string, CompatibilityMatrices>;
  /**
   * Raw rows kept so we can re-group when a previously-unseen tenant
   * asks for a matrix. Mirrors the `rawRows` sentinel pattern used by
   * `conflict-pair-resolver`.
   */
  rawRows: CompatibilityScoreRow[];
  warmedAt: number;
}

let cache: CacheSnapshot | null = null;
let refreshInflight: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let loggedMiss = false;

const GLOBAL_TENANT_TAG = 'GLOBAL';

// ---------------------------------------------------------------------------
// Cold-cache fallback — byte-identical to the inline d39 literals at rev
// 01bc6fd9 of services/gateway/src/services/d39-taste-alignment-service.ts.
//
// Seven of the nine dimensions are direct transcriptions of `scoreMap`.
// Aesthetic + tone are materialised from the if-cascade
// (perfect=1.0, compatibilityMap=0.7, neutral row/col=0.5, else=0.3)
// at module load so runtime is pure lookup.
// ---------------------------------------------------------------------------

const SCORE_FALLBACK_SIMPLICITY: CompatibilityMatrix = {
  minimalist:    { simple: 1.0, moderate: 0.6, complex: 0.2 },
  balanced:      { simple: 0.7, moderate: 1.0, complex: 0.7 },
  comprehensive: { simple: 0.4, moderate: 0.7, complex: 1.0 },
};

const SCORE_FALLBACK_PREMIUM: CompatibilityMatrix = {
  value_focused:    { budget: 1.0, mid: 0.8, premium: 0.4, luxury: 0.2 },
  quality_balanced: { budget: 0.6, mid: 1.0, premium: 0.8, luxury: 0.5 },
  premium_oriented: { budget: 0.2, mid: 0.5, premium: 1.0, luxury: 0.9 },
};

const SCORE_FALLBACK_ROUTINE: CompatibilityMatrix = {
  structured: { fixed: 1.0, flexible: 0.4 },
  flexible:   { fixed: 0.4, flexible: 1.0 },
  hybrid:     { fixed: 0.7, flexible: 0.7 },
};

const SCORE_FALLBACK_SOCIAL: CompatibilityMatrix = {
  solo_focused:    { solo: 1.0, small_group: 0.5, large_group: 0.2 },
  small_groups:    { solo: 0.5, small_group: 1.0, large_group: 0.5 },
  social_oriented: { solo: 0.3, small_group: 0.7, large_group: 1.0 },
  adaptive:        { solo: 0.5, small_group: 0.5, large_group: 0.5 },
};

const SCORE_FALLBACK_CONVENIENCE: CompatibilityMatrix = {
  convenience_first:  { low: 0.2, medium: 0.6, high: 1.0 },
  balanced:           { low: 0.5, medium: 1.0, high: 0.7 },
  intentional_living: { low: 0.8, medium: 0.7, high: 0.4 },
};

const SCORE_FALLBACK_EXPERIENCE: CompatibilityMatrix = {
  digital_native:   { digital: 1.0, hybrid: 0.7, physical: 0.3 },
  physical_focused: { digital: 0.3, hybrid: 0.6, physical: 1.0 },
  blended:          { digital: 0.6, hybrid: 1.0, physical: 0.6 },
};

const SCORE_FALLBACK_NOVELTY: CompatibilityMatrix = {
  conservative: { familiar: 1.0, moderate: 0.6, novel: 0.2 },
  moderate:     { familiar: 0.6, moderate: 1.0, novel: 0.6 },
  explorer:     { familiar: 0.4, moderate: 0.7, novel: 1.0 },
};

// Aesthetic + tone: materialise from compatibility lists + rules.
const AESTHETIC_VALUES = [
  'modern', 'classic', 'eclectic', 'natural', 'functional', 'neutral',
] as const;
const AESTHETIC_COMPATIBILITY: Record<string, readonly string[]> = {
  modern:     ['functional', 'eclectic'],
  classic:    ['natural', 'functional'],
  eclectic:   ['modern', 'natural'],
  natural:    ['classic', 'functional'],
  functional: ['modern', 'classic', 'natural'],
  neutral:    [],
};

const TONE_VALUES = [
  'technical', 'expressive', 'casual', 'professional', 'minimalist', 'neutral',
] as const;
const TONE_COMPATIBILITY: Record<string, readonly string[]> = {
  technical:    ['professional', 'minimalist'],
  expressive:   ['casual'],
  casual:       ['expressive'],
  professional: ['technical', 'minimalist'],
  minimalist:   ['technical', 'professional'],
  neutral:      [],
};

function materialiseAdjacencyGrid(
  values: readonly string[],
  compat: Record<string, readonly string[]>,
): CompatibilityMatrix {
  const out: CompatibilityMatrix = {};
  for (const profile of values) {
    out[profile] = {};
    for (const candidate of values) {
      let score: number;
      if (profile === 'neutral' || candidate === 'neutral') {
        // d39 service: anything touching `neutral` returns 0.5.
        score = 0.5;
      } else if (profile === candidate) {
        // d39 service: perfect match.
        score = 1.0;
      } else if (compat[profile]?.includes(candidate)) {
        // d39 service: in the compatibility list.
        score = 0.7;
      } else {
        // d39 service: else branch.
        score = 0.3;
      }
      out[profile][candidate] = score;
    }
  }
  return out;
}

const SCORE_FALLBACK_AESTHETIC = materialiseAdjacencyGrid(
  AESTHETIC_VALUES, AESTHETIC_COMPATIBILITY,
);
const SCORE_FALLBACK_TONE = materialiseAdjacencyGrid(
  TONE_VALUES, TONE_COMPATIBILITY,
);

export const FALLBACK_MATRICES: Readonly<CompatibilityMatrices> = Object.freeze({
  simplicity:  SCORE_FALLBACK_SIMPLICITY,
  premium:     SCORE_FALLBACK_PREMIUM,
  aesthetic:   SCORE_FALLBACK_AESTHETIC,
  tone:        SCORE_FALLBACK_TONE,
  routine:     SCORE_FALLBACK_ROUTINE,
  social:      SCORE_FALLBACK_SOCIAL,
  convenience: SCORE_FALLBACK_CONVENIENCE,
  experience:  SCORE_FALLBACK_EXPERIENCE,
  novelty:     SCORE_FALLBACK_NOVELTY,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantKey(tenantId: string | null | undefined): string {
  return tenantId ?? GLOBAL_TENANT_TAG;
}

function emptySnapshot(): CacheSnapshot {
  return { byTenant: new Map(), rawRows: [], warmedAt: Date.now() };
}

function isEffectiveAt(row: CompatibilityScoreRow, nowMs: number): boolean {
  const fromMs = Date.parse(row.effective_from);
  if (Number.isNaN(fromMs) || fromMs > nowMs) return false;
  if (row.effective_until) {
    const untilMs = Date.parse(row.effective_until);
    if (!Number.isNaN(untilMs) && untilMs <= nowMs) return false;
  }
  return true;
}

/**
 * Defensive row validator. Bad seeds, half-finished migrations, or
 * future cells with surprising shapes get dropped silently instead
 * of crashing the engine. Mirrors the PolicyResolver malformed-policy
 * guard pattern.
 */
function isValidRow(row: unknown): row is CompatibilityScoreRow {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  if (typeof r.dimension !== 'string' || r.dimension.length === 0) return false;
  if (typeof r.profile_value !== 'string' || r.profile_value.length === 0) return false;
  if (typeof r.candidate_value !== 'string' || r.candidate_value.length === 0) return false;
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return false;
  if (r.score < 0 || r.score > 1) return false;
  if (r.tenant_id !== null && typeof r.tenant_id !== 'string') return false;
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return false;
  if (typeof r.effective_from !== 'string' || Number.isNaN(Date.parse(r.effective_from))) return false;
  if (
    r.effective_until !== null &&
    (typeof r.effective_until !== 'string' || Number.isNaN(Date.parse(r.effective_until)))
  ) {
    return false;
  }
  return true;
}

/**
 * Group rows into the nested matrix for one tenant scope.
 *
 * Per (dimension, profile_value, candidate_value):
 *   1. Prefer rows scoped to this tenant_id.
 *   2. If none exist, fall back to global (tenant_id IS NULL).
 *   3. Take the highest version among the chosen scope; ties broken
 *      by the latest effective_from.
 */
function groupRowsIntoMatrices(
  rows: CompatibilityScoreRow[],
  tenantId: string | null,
  nowMs: number,
): CompatibilityMatrices {
  // Bucket by (dim, profile, candidate) → row list.
  const byCell = new Map<string, CompatibilityScoreRow[]>();
  for (const r of rows) {
    if (!isEffectiveAt(r, nowMs)) continue;
    const key = `${r.dimension}|${r.profile_value}|${r.candidate_value}`;
    const list = byCell.get(key);
    if (list) list.push(r);
    else byCell.set(key, [r]);
  }

  const out: CompatibilityMatrices = {};
  for (const [, list] of byCell) {
    const tenantRows = tenantId
      ? list.filter((r) => r.tenant_id === tenantId)
      : [];
    const scope = tenantRows.length > 0
      ? tenantRows
      : list.filter((r) => r.tenant_id === null);
    if (scope.length === 0) continue;

    const maxVersion = Math.max(...scope.map((r) => r.version));
    const versioned = scope.filter((r) => r.version === maxVersion);
    // Tie-break by effective_from desc.
    versioned.sort(
      (a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from),
    );
    const winner = versioned[0];

    if (!out[winner.dimension]) out[winner.dimension] = {};
    if (!out[winner.dimension][winner.profile_value]) {
      out[winner.dimension][winner.profile_value] = {};
    }
    out[winner.dimension][winner.profile_value][winner.candidate_value] =
      winner.score;
  }
  return out;
}

async function fetchAll(): Promise<CacheSnapshot> {
  const snap = emptySnapshot();
  const supa = getSupabase();
  if (!supa) {
    return snap; // Cold — read-time fallback kicks in.
  }
  try {
    const { data, error } = await supa
      .from('decision_compatibility_score')
      .select(
        'dimension, profile_value, candidate_value, score, tenant_id, ' +
          'version, effective_from, effective_until',
      );
    if (error) {
      if (
        !/relation .*decision_compatibility_score.* does not exist/i.test(error.message)
      ) {
        console.warn(
          `${TELEMETRY_PREFIX} decision_compatibility_score fetch failed: ${error.message}`,
        );
      }
      return snap;
    }
    if (!Array.isArray(data)) return snap;
    // Drop malformed rows defensively.
    const rows = (data as unknown[]).filter(isValidRow) as CompatibilityScoreRow[];
    snap.rawRows = rows;
    snap.byTenant.set(
      GLOBAL_TENANT_TAG,
      groupRowsIntoMatrices(rows, null, Date.now()),
    );
  } catch (e: any) {
    console.warn(
      `${TELEMETRY_PREFIX} decision_compatibility_score fetch threw: ${e?.message ?? e}`,
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
 * Boot warmer. Block until the first fetch resolves, then start a
 * 15s background refresh. Never throws.
 */
export async function warmCompatibilityCache(): Promise<void> {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompatibilityResolver {
  /**
   * Look up the compatibility score for a single (dim, profile,
   * candidate) tuple. Returns the literal fallback when the cache
   * is cold OR when neither the DB nor the literal grid carries
   * the cell.
   */
  getCompatibilityScore(
    dimension: string,
    profileValue: string,
    candidateValue: string,
    opts?: { tenantId?: string | null },
  ): number;
  /**
   * Return the full 2-D grid for a dimension in the caller's tenant
   * scope: tenant overrides merged over global, then merged over the
   * literal fallback. Missing dimensions return an empty record.
   */
  getCompatibilityMatrix(
    dimension: string,
    opts?: { tenantId?: string | null },
  ): CompatibilityMatrix;
  refresh(): Promise<void>;
}

function matricesForScope(tenantId: string | null): CompatibilityMatrices {
  if (!cache) {
    logMissOnce(
      `cache cold for compatibility scores (tenant=${tenantKey(tenantId)}) — using fallback literals`,
    );
    return FALLBACK_MATRICES;
  }
  // No rows ever loaded (table missing / unmigrated / DB unavailable)
  // → still use literals. Distinguish from "rows exist but the cell
  // is filtered out", which returns the per-scope matrix even if
  // empty for some dimensions.
  if (cache.rawRows.length === 0) return FALLBACK_MATRICES;

  if (tenantId === null) {
    return cache.byTenant.get(GLOBAL_TENANT_TAG) ?? {};
  }
  const cached = cache.byTenant.get(tenantId);
  if (cached) return cached;
  const tenantMatrices = groupRowsIntoMatrices(
    cache.rawRows, tenantId, Date.now(),
  );
  cache.byTenant.set(tenantId, tenantMatrices);
  return tenantMatrices;
}

function getCompatibilityScoreImpl(
  dimension: string,
  profileValue: string,
  candidateValue: string,
  opts?: { tenantId?: string | null },
): number {
  const tenantId = opts?.tenantId ?? null;
  const scope = matricesForScope(tenantId);

  // Tenant scope first (the merged matrix already overlays tenant
  // over global). If that has the cell, use it.
  const fromScope = scope[dimension]?.[profileValue]?.[candidateValue];
  if (typeof fromScope === 'number') return fromScope;

  // For non-global tenants the merged matrix only contains tenant
  // overrides; fall through to global next.
  if (tenantId !== null) {
    const fromGlobal = cache?.byTenant.get(GLOBAL_TENANT_TAG)?.[dimension]?.[profileValue]?.[candidateValue];
    if (typeof fromGlobal === 'number') return fromGlobal;
  }

  // Then literal fallback.
  const fromLiteral = FALLBACK_MATRICES[dimension]?.[profileValue]?.[candidateValue];
  if (typeof fromLiteral === 'number') return fromLiteral;

  // Truly unknown cell → neutral default (mirrors the
  // `?? 0.5` tail in every d39 scoreMap lookup).
  return NEUTRAL_DEFAULT;
}

function getCompatibilityMatrixImpl(
  dimension: string,
  opts?: { tenantId?: string | null },
): CompatibilityMatrix {
  const tenantId = opts?.tenantId ?? null;
  const scope = matricesForScope(tenantId);

  // Build the merged matrix: literal < global < tenant (highest
  // precedence wins). Keys preserved per-tier.
  const literal = FALLBACK_MATRICES[dimension] ?? {};
  const global = (tenantId !== null
    ? cache?.byTenant.get(GLOBAL_TENANT_TAG)?.[dimension]
    : scope[dimension]) ?? {};
  const tenant = (tenantId !== null
    ? scope[dimension]
    : {}) ?? {};

  const merged: CompatibilityMatrix = {};
  const profiles = new Set<string>([
    ...Object.keys(literal),
    ...Object.keys(global),
    ...Object.keys(tenant),
  ]);
  for (const profile of profiles) {
    const candidates = new Set<string>([
      ...Object.keys(literal[profile] ?? {}),
      ...Object.keys(global[profile] ?? {}),
      ...Object.keys(tenant[profile] ?? {}),
    ]);
    merged[profile] = {};
    for (const candidate of candidates) {
      merged[profile][candidate] =
        tenant[profile]?.[candidate] ??
        global[profile]?.[candidate] ??
        literal[profile]?.[candidate] ??
        NEUTRAL_DEFAULT;
    }
  }
  return merged;
}

const resolverSingleton: CompatibilityResolver = {
  getCompatibilityScore: getCompatibilityScoreImpl,
  getCompatibilityMatrix: getCompatibilityMatrixImpl,
  refresh: refreshImpl,
};

export function getCompatibilityResolver(): CompatibilityResolver {
  return resolverSingleton;
}

// ---- test support ------------------------------------------------------
export interface CompatibilityResolverTestSeed {
  rows?: CompatibilityScoreRow[];
}

export function configureCompatibilityResolverForTests(
  seed: CompatibilityResolverTestSeed,
): void {
  const snap = emptySnapshot();
  const rows = (seed.rows ?? []).filter(isValidRow) as CompatibilityScoreRow[];
  snap.rawRows = rows;
  snap.byTenant.set(
    GLOBAL_TENANT_TAG,
    groupRowsIntoMatrices(rows, null, Date.now()),
  );
  cache = snap;
  loggedMiss = false;
}

export function __resetCompatibilityResolverForTests(): void {
  cache = null;
  refreshInflight = null;
  loggedMiss = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
