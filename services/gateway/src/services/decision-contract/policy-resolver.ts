// Phase B.3 (decision-contract refactor) — PolicyResolver service.
//
// VTID-03116. Sync-cached, never-throws resolver for the two Phase B tables:
//   - decision_policy        (numeric / enum / small-JSON policy values)
//   - policy_render_block    (localized prompt fragments)
//
// Resolution rules (identical for both tables):
//   For a given (key, [language,] tenant_id, now), pick the highest
//   `version` row where:
//     effective_from <= now
//     AND (effective_until IS NULL OR effective_until > now)
//   A tenant-specific row wins over `tenant_id IS NULL` (global default).
//
// Discipline (per `docs/decision-contract/phase-b-brief.md`):
//   - Cache TTL: 15s (matches `livekit-canary-config`).
//   - Never throws on resolution miss — falls back to `tenant_id IS NULL`
//     first, then to the caller-provided `defaultValue` (logged once at
//     boot when used). A miss must NOT crash a voice session.
//   - `getValue` returns the unwrapped JSONB value via TypeScript generics.
//   - Telemetry: structured console.warn on every fallback fire under the
//     `[PolicyResolver][decision_contract.policy.miss]` prefix. Routing to
//     OASIS is a Phase B follow-up (requires extending CicdEventType, which
//     is out of B.3 scope).
//
// API surface mirrors the brief:
//   getValue<T>(key, opts?) -> T
//   getRenderBlock(key, language, opts?) -> string
//   refresh() -> Promise<void>
//   warmPolicyResolverCache() -> Promise<void>   (boot hook)
//   getPolicyResolver() -> PolicyResolver         (singleton)
//   configurePolicyResolverForTests(seed) -> void
//   __resetPolicyResolverForTests() -> void

import { getSupabase } from '../../lib/supabase';

const CACHE_TTL_MS = 15_000;
const TELEMETRY_PREFIX = '[PolicyResolver][decision_contract.policy.miss]';

interface DecisionPolicyRow {
  policy_key: string;
  tenant_id: string | null;
  version: number;
  value_json: unknown;
  effective_from: string; // ISO timestamp
  effective_until: string | null;
}

interface PolicyRenderBlockRow {
  block_key: string;
  language: string;
  tenant_id: string | null;
  version: number;
  content: string;
  effective_from: string;
  effective_until: string | null;
}

// Cache shape: maps keyed by (key[, language]) → all rows for that key
// (both global and per-tenant). Resolution walks the candidate list to
// pick the winner for a given (tenant_id, now).
type DecisionPolicyCache = Map<string, DecisionPolicyRow[]>;
type PolicyRenderBlockCache = Map<string, PolicyRenderBlockRow[]>;

interface CacheSnapshot {
  decisionPolicy: DecisionPolicyCache;
  policyRenderBlock: PolicyRenderBlockCache;
  warmedAt: number;
}

let cache: CacheSnapshot | null = null;
let refreshInflight: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
// Track which (key, defaultUsed) pairs have already logged a miss, so a
// hot loop doesn't spam the logger.
const loggedMisses = new Set<string>();

export interface PolicyResolver {
  getValue<T>(
    key: string,
    opts?: { tenantId?: string | null; defaultValue?: T },
  ): T;
  getRenderBlock(
    key: string,
    language: string,
    opts?: { tenantId?: string | null; defaultValue?: string },
  ): string;
  refresh(): Promise<void>;
}

function blockMapKey(blockKey: string, language: string): string {
  return `${blockKey}${language}`;
}

function isEffective(
  row: { effective_from: string; effective_until: string | null },
  nowMs: number,
): boolean {
  const fromMs = Date.parse(row.effective_from);
  if (Number.isFinite(fromMs) && fromMs > nowMs) return false;
  if (row.effective_until == null) return true;
  const untilMs = Date.parse(row.effective_until);
  return Number.isFinite(untilMs) ? untilMs > nowMs : true;
}

// Pick the winner across candidate rows: prefer tenant-specific over
// global, then highest `version`. Caller guarantees `candidates` are all
// for the same logical key (e.g. same `policy_key`).
function pickWinner<
  R extends {
    tenant_id: string | null;
    version: number;
    effective_from: string;
    effective_until: string | null;
  },
>(
  candidates: R[],
  tenantId: string | null | undefined,
  nowMs: number,
): R | null {
  let bestTenant: R | null = null;
  let bestGlobal: R | null = null;
  for (const row of candidates) {
    if (!isEffective(row, nowMs)) continue;
    if (tenantId && row.tenant_id === tenantId) {
      if (!bestTenant || row.version > bestTenant.version) bestTenant = row;
    } else if (row.tenant_id === null) {
      if (!bestGlobal || row.version > bestGlobal.version) bestGlobal = row;
    }
  }
  return bestTenant ?? bestGlobal;
}

function logMissOnce(tag: string, message: string): void {
  if (loggedMisses.has(tag)) return;
  loggedMisses.add(tag);
  console.warn(`${TELEMETRY_PREFIX} ${message}`);
}

function getValueImpl<T>(
  key: string,
  opts?: { tenantId?: string | null; defaultValue?: T },
): T {
  const tenantId = opts?.tenantId ?? null;
  const fallback = opts?.defaultValue;
  const nowMs = Date.now();
  const rows = cache?.decisionPolicy.get(key);
  if (!rows || rows.length === 0) {
    logMissOnce(
      `value:${key}:${tenantId ?? 'GLOBAL'}:no-cache`,
      `no cached rows for policy_key="${key}" tenant_id="${tenantId ?? 'GLOBAL'}" — using defaultValue`,
    );
    return fallback as T;
  }
  const winner = pickWinner(rows, tenantId, nowMs);
  if (!winner) {
    logMissOnce(
      `value:${key}:${tenantId ?? 'GLOBAL'}:no-effective`,
      `no effective row for policy_key="${key}" tenant_id="${tenantId ?? 'GLOBAL'}" — using defaultValue`,
    );
    return fallback as T;
  }
  return winner.value_json as T;
}

function getRenderBlockImpl(
  key: string,
  language: string,
  opts?: { tenantId?: string | null; defaultValue?: string },
): string {
  const tenantId = opts?.tenantId ?? null;
  const fallback = opts?.defaultValue ?? '';
  const nowMs = Date.now();
  // Try (key, language) first; fall back to (key, 'en') if requested
  // language has no rows so the consumer still gets a sensible string.
  const primary = cache?.policyRenderBlock.get(blockMapKey(key, language));
  const winner = primary ? pickWinner(primary, tenantId, nowMs) : null;
  if (winner) return winner.content;

  if (language !== 'en') {
    const enRows = cache?.policyRenderBlock.get(blockMapKey(key, 'en'));
    const enWinner = enRows ? pickWinner(enRows, tenantId, nowMs) : null;
    if (enWinner) {
      logMissOnce(
        `block:${key}:${language}:${tenantId ?? 'GLOBAL'}:fallback-en`,
        `no row for block_key="${key}" language="${language}" — falling back to en`,
      );
      return enWinner.content;
    }
  }
  logMissOnce(
    `block:${key}:${language}:${tenantId ?? 'GLOBAL'}:no-cache`,
    `no cached row for block_key="${key}" language="${language}" tenant_id="${tenantId ?? 'GLOBAL'}" — using defaultValue`,
  );
  return fallback;
}

async function fetchAll(): Promise<CacheSnapshot> {
  const supa = getSupabase();
  const snap: CacheSnapshot = {
    decisionPolicy: new Map(),
    policyRenderBlock: new Map(),
    warmedAt: Date.now(),
  };
  if (!supa) {
    return snap;
  }
  try {
    const { data: pol, error: polErr } = await supa
      .from('decision_policy')
      .select('policy_key, tenant_id, version, value_json, effective_from, effective_until');
    if (polErr) {
      // Table missing pre-migration is normal in early environments; treat
      // any error as "no rows" so the resolver degrades to defaults rather
      // than throwing.
      if (!/relation .*decision_policy.* does not exist/i.test(polErr.message)) {
        console.warn(`${TELEMETRY_PREFIX} decision_policy fetch failed: ${polErr.message}`);
      }
    } else if (Array.isArray(pol)) {
      for (const row of pol as DecisionPolicyRow[]) {
        const list = snap.decisionPolicy.get(row.policy_key);
        if (list) list.push(row);
        else snap.decisionPolicy.set(row.policy_key, [row]);
      }
    }
  } catch (e: any) {
    console.warn(`${TELEMETRY_PREFIX} decision_policy fetch threw: ${e?.message ?? e}`);
  }
  try {
    const { data: blk, error: blkErr } = await supa
      .from('policy_render_block')
      .select('block_key, language, tenant_id, version, content, effective_from, effective_until');
    if (blkErr) {
      if (!/relation .*policy_render_block.* does not exist/i.test(blkErr.message)) {
        console.warn(`${TELEMETRY_PREFIX} policy_render_block fetch failed: ${blkErr.message}`);
      }
    } else if (Array.isArray(blk)) {
      for (const row of blk as PolicyRenderBlockRow[]) {
        const k = blockMapKey(row.block_key, row.language);
        const list = snap.policyRenderBlock.get(k);
        if (list) list.push(row);
        else snap.policyRenderBlock.set(k, [row]);
      }
    }
  } catch (e: any) {
    console.warn(`${TELEMETRY_PREFIX} policy_render_block fetch threw: ${e?.message ?? e}`);
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
 * Block at boot until the first fetch resolves so the first inbound
 * request sees populated caches. Never throws.
 *
 * Also starts a 15s background refresh timer if not already running.
 */
export async function warmPolicyResolverCache(): Promise<void> {
  await refreshImpl();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      // Fire-and-forget background refresh; any error is logged inside.
      void refreshImpl();
    }, CACHE_TTL_MS);
    // Don't keep the event loop alive solely for this timer (matches the
    // "non-fatal background warmers" pattern used elsewhere in index.ts).
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }
}

const resolverSingleton: PolicyResolver = {
  getValue<T>(
    key: string,
    opts?: { tenantId?: string | null; defaultValue?: T },
  ): T {
    return getValueImpl<T>(key, opts);
  },
  getRenderBlock(
    key: string,
    language: string,
    opts?: { tenantId?: string | null; defaultValue?: string },
  ): string {
    return getRenderBlockImpl(key, language, opts);
  },
  refresh: refreshImpl,
};

export function getPolicyResolver(): PolicyResolver {
  return resolverSingleton;
}

// ---- test support ------------------------------------------------------
// Tests can prime the cache directly so they don't have to spin up
// Supabase. The shape matches what `fetchAll` would produce.

export interface PolicyResolverTestSeed {
  decisionPolicy?: DecisionPolicyRow[];
  policyRenderBlock?: PolicyRenderBlockRow[];
}

export function configurePolicyResolverForTests(seed: PolicyResolverTestSeed): void {
  const snap: CacheSnapshot = {
    decisionPolicy: new Map(),
    policyRenderBlock: new Map(),
    warmedAt: Date.now(),
  };
  for (const row of seed.decisionPolicy ?? []) {
    const list = snap.decisionPolicy.get(row.policy_key);
    if (list) list.push(row);
    else snap.decisionPolicy.set(row.policy_key, [row]);
  }
  for (const row of seed.policyRenderBlock ?? []) {
    const k = blockMapKey(row.block_key, row.language);
    const list = snap.policyRenderBlock.get(k);
    if (list) list.push(row);
    else snap.policyRenderBlock.set(k, [row]);
  }
  cache = snap;
  loggedMisses.clear();
}

export function __resetPolicyResolverForTests(): void {
  cache = null;
  refreshInflight = null;
  loggedMisses.clear();
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
