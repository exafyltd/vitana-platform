/**
 * VTID-05084 — Loop Engineering catalog (Phase 1, read-only).
 *
 * The catalog (specs/loop-catalog-v1.json) lists the 14 loops that make
 * Vitanaland self-healing and self-improving, the shared engine they run on,
 * and the overlaps the Simplify loop works through. Doctrine:
 * docs/autonomy/LOOP-ENGINEERING.md.
 *
 * A check is not a loop. Sensors (health checks, routines, scheduled
 * workflows, test contracts) stay in their own registries; each loop names
 * the sensors it owns, and every sensor must be owned by exactly one loop.
 *
 * Coverage at runtime: the health-check groups and the test-contract keys are
 * compiled into the gateway, so they are checked live here. Routines
 * (routines/*.md) and scheduled workflows (.github/workflows) are not in the
 * gateway image; their ownership is enforced in CI by
 * test/loop-catalog.test.ts against the repo checkout.
 *
 * The live signal is plane-level: 7-day run counts from the existing
 * agent_runs_unified view for the loops that declare a run_plane. It never
 * fails the catalog — a view error degrades the signal to `unavailable`.
 */

import fs from 'fs';
import path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SERVICE_HEALTH_GROUPS } from '../constants/service-health-registry';
import { listAllowlistedKeys } from './test-contract-commands';

const LOG_PREFIX = '[loop-catalog]';

export const RISKS = ['R0', 'R1', 'R2', 'R3'] as const;
export const AUTONOMY = ['L0', 'L1', 'L2', 'L3'] as const;
export const STATUSES = ['LIVE', 'PARTIAL', 'PLANNED'] as const;
export const RUN_PLANES = ['dev_autopilot', 'community_autopilot', 'self_healing'] as const;
export const SHARED_VERIFIERS = ['claim_verifier', 'red_flag_rules'] as const;
/** VTID-05098: what the Simplify loop did with each known overlap. */
export const OVERLAP_STATUSES = ['open', 'resolved', 'partly_resolved', 'not_a_duplicate'] as const;
export const CONTRACT_FIELDS = [
  'trigger', 'goal', 'act', 'verifier', 'stop', 'human_gate', 'budget', 'metrics',
] as const;

export type SensorKind = 'health_groups' | 'routines' | 'workflows' | 'test_contracts';
export const SENSOR_KINDS: SensorKind[] = ['health_groups', 'routines', 'workflows', 'test_contracts'];

export interface Ref { repo: string; kind: 'file' | 'glob' | 'workflow' | 'routine' | 'table'; ref: string }
export interface LoopCase { id: string; title: string }

export interface Loop {
  id: string;
  name: string;
  group: 'platform' | 'product';
  risk: typeof RISKS[number];
  autonomy: typeof AUTONOMY[number];
  status: typeof STATUSES[number];
  gap: string;
  trigger: string;
  goal: string;
  act: string;
  verifier: string;
  stop: string;
  human_gate: string;
  budget: string;
  metrics: string;
  existing_ref: Ref | null;
  run_plane: typeof RUN_PLANES[number] | null;
  uses_shared_verifiers: string[];
  sensors: Record<SensorKind, string[]>;
  cases: LoopCase[];
}

export interface LoopCatalog {
  version: string;
  vtid: string;
  doctrine: string;
  principle: string;
  loops: Loop[];
  components: Array<{ id: string; name: string; what: string; existing_ref: Ref | null; cases?: LoopCase[] }>;
  overlaps: Array<{
    id: string;
    title: string;
    items: string[];
    note?: string;
    status: typeof OVERLAP_STATUSES[number];
    resolution?: string;
  }>;
  retire_candidates: Array<{ kind: SensorKind; ref: string; reason: string }>;
}

export function catalogPath(): string {
  // dist/services/loop-catalog.js and src/services/loop-catalog.ts both sit two
  // levels below services/gateway/, where specs/ lives (same as oasis-specs.ts).
  return path.resolve(__dirname, '..', '..', 'specs', 'loop-catalog-v1.json');
}

/** Returns the list of contract violations; empty means valid. */
export function validateCatalog(c: LoopCatalog): string[] {
  const errors: string[] = [];
  if (!c || !Array.isArray(c.loops)) return ['catalog has no loops array'];
  const ids = new Set<string>();
  for (const l of c.loops) {
    const at = `loop ${l.id || '?'}`;
    if (!l.id || ids.has(l.id)) errors.push(`${at}: missing or duplicate id`);
    ids.add(l.id);
    if (!l.name) errors.push(`${at}: missing name`);
    if (l.group !== 'platform' && l.group !== 'product') errors.push(`${at}: bad group`);
    for (const f of CONTRACT_FIELDS) {
      if (typeof l[f] !== 'string' || !l[f].trim()) errors.push(`${at}: missing contract field ${f}`);
    }
    if (!RISKS.includes(l.risk)) errors.push(`${at}: bad risk ${l.risk}`);
    if (!AUTONOMY.includes(l.autonomy)) errors.push(`${at}: bad autonomy ${l.autonomy}`);
    if (!STATUSES.includes(l.status)) errors.push(`${at}: bad status ${l.status}`);
    if (l.status !== 'LIVE' && !l.gap) errors.push(`${at}: ${l.status} loop must name its gap`);
    if (l.status !== 'PLANNED' && !l.existing_ref) errors.push(`${at}: ${l.status} loop must have existing_ref`);
    if (l.run_plane !== null && !RUN_PLANES.includes(l.run_plane)) errors.push(`${at}: bad run_plane ${l.run_plane}`);
    // R2/R3 never run without a human gate; R3 never executes on its own.
    if ((l.risk === 'R2' || l.risk === 'R3') && /^none\b/i.test(l.human_gate)) {
      errors.push(`${at}: ${l.risk} loop needs a human gate`);
    }
    if (l.risk === 'R3' && (l.autonomy === 'L3')) errors.push(`${at}: R3 loop may not exceed L2`);
    for (const v of l.uses_shared_verifiers || []) {
      if (!SHARED_VERIFIERS.includes(v as any)) errors.push(`${at}: unknown shared verifier ${v}`);
    }
    if (!l.sensors) errors.push(`${at}: missing sensors`);
    else for (const k of SENSOR_KINDS) {
      if (!Array.isArray(l.sensors[k])) errors.push(`${at}: sensors.${k} must be an array`);
    }
    if (!Array.isArray(l.cases)) errors.push(`${at}: missing cases`);
  }
  for (const o of c.overlaps || []) {
    if (!OVERLAP_STATUSES.includes(o.status)) errors.push(`overlap ${o.id || '?'}: bad status ${o.status}`);
    if (o.status !== 'open' && !o.resolution) errors.push(`overlap ${o.id || '?'}: ${o.status} needs a resolution`);
  }
  return errors;
}

let cached: LoopCatalog | null = null;

export function loadCatalog(read: (file: string) => string = (f) => fs.readFileSync(f, 'utf-8')): LoopCatalog {
  if (cached) return cached;
  const raw = read(catalogPath());
  const parsed = JSON.parse(raw) as LoopCatalog;
  const errors = validateCatalog(parsed);
  if (errors.length) {
    console.error(`${LOG_PREFIX} invalid catalog:`, errors);
    throw new Error(`loop catalog invalid: ${errors.join('; ')}`);
  }
  cached = parsed;
  return cached;
}

/** Test hook. */
export function resetCatalogCache(): void {
  cached = null;
  signalCache.clear();
}

export interface CoverageReport {
  /** Registries the gateway can read itself (compiled in). */
  live: Record<'health_groups' | 'test_contracts', {
    total: number; owned: number; orphans: string[]; double_owned: string[]; unknown: string[];
  }>;
  /** Registries outside the gateway image; enforced by the CI coverage test. */
  ci_enforced: Record<'routines' | 'workflows', { owned: number }>;
  retire_candidates: number;
}

function ownership(c: LoopCatalog, kind: SensorKind): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const l of c.loops) {
    for (const s of l.sensors[kind] || []) owners.set(s, [...(owners.get(s) || []), l.id]);
  }
  return owners;
}

export function computeCoverage(
  c: LoopCatalog,
  registries: { health_groups: string[]; test_contracts: string[] } = {
    health_groups: SERVICE_HEALTH_GROUPS,
    test_contracts: listAllowlistedKeys(),
  },
): CoverageReport {
  const retired = new Set(c.retire_candidates.map((r) => `${r.kind}:${r.ref}`));
  const live = {} as CoverageReport['live'];
  for (const kind of ['health_groups', 'test_contracts'] as const) {
    const owners = ownership(c, kind);
    const known = new Set(registries[kind]);
    live[kind] = {
      total: known.size,
      owned: [...known].filter((s) => (owners.get(s) || []).length === 1).length,
      orphans: [...known].filter((s) => !owners.has(s) && !retired.has(`${kind}:${s}`)),
      double_owned: [...owners.entries()].filter(([, o]) => o.length > 1).map(([s]) => s),
      unknown: [...owners.keys()].filter((s) => !known.has(s)),
    };
  }
  return {
    live,
    ci_enforced: {
      routines: { owned: ownership(c, 'routines').size },
      workflows: { owned: ownership(c, 'workflows').size },
    },
    retire_candidates: c.retire_candidates.length,
  };
}

export type PlaneSignal =
  | { state: 'ok'; window_days: 7; total: number; by_status: Record<string, number>; last_run_at: string | null; capped: boolean }
  | { state: 'unavailable' };

export const SIGNAL_ROW_CAP = 5000;
const SIGNAL_TTL_MS = 60_000;
const signalCache = new Map<string, { at: number; value: PlaneSignal }>();

export async function planeSignal(sb: SupabaseClient | null, plane: string, now = Date.now()): Promise<PlaneSignal> {
  const hit = signalCache.get(plane);
  if (hit && now - hit.at < SIGNAL_TTL_MS) return hit.value;
  let value: PlaneSignal = { state: 'unavailable' };
  if (sb) {
    try {
      const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await sb
        .from('agent_runs_unified')
        .select('status, created_at')
        .eq('plane', plane)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(SIGNAL_ROW_CAP);
      if (error) throw new Error(error.message);
      const rows = (data || []) as Array<{ status: string; created_at: string }>;
      const by_status: Record<string, number> = {};
      for (const r of rows) by_status[r.status] = (by_status[r.status] || 0) + 1;
      value = {
        state: 'ok',
        window_days: 7,
        total: rows.length,
        by_status,
        last_run_at: rows[0]?.created_at ?? null,
        capped: rows.length >= SIGNAL_ROW_CAP,
      };
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} signal for plane ${plane} unavailable: ${err?.message}`);
    }
  }
  signalCache.set(plane, { at: now, value });
  return value;
}

/**
 * VTID-05148: the latest run's measured numbers for a loop that has a metrics
 * routine, read from routine_runs: L3 (learn-outcomes) and, since VTID-05153,
 * L9 (supplier-catalog-check).
 */
export const METRICS_ROUTINES: Record<string, string> = { L3: 'learn-outcomes', L9: 'supplier-catalog-check' };

export type LoopMetrics =
  | { state: 'ok'; routine: string; run_at: string; status: string; metrics: Record<string, unknown> }
  | { state: 'no_run_yet'; routine: string }
  | { state: 'unavailable'; routine: string };

export async function latestLoopMetrics(sb: SupabaseClient | null, routine: string): Promise<LoopMetrics> {
  if (!sb) return { state: 'unavailable', routine };
  try {
    const { data, error } = await sb
      .from('routine_runs')
      .select('started_at, status, findings')
      .eq('routine_name', routine)
      .in('status', ['success', 'partial'])
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = ((data || []) as Array<{ started_at: string; status: string; findings: Record<string, unknown> | null }>)[0];
    const metrics = row?.findings && (row.findings as Record<string, unknown>).metrics;
    if (!row || !metrics || typeof metrics !== 'object') return { state: 'no_run_yet', routine };
    return { state: 'ok', routine, run_at: row.started_at, status: row.status, metrics: metrics as Record<string, unknown> };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} metrics for ${routine} unavailable: ${err?.message}`);
    return { state: 'unavailable', routine };
  }
}

export interface CatalogResponse {
  catalog: LoopCatalog;
  coverage: CoverageReport;
  signals: Record<string, PlaneSignal>;
  /** VTID-05148: per loop id, the latest metrics routine run (L3; L9 since VTID-05153). */
  metrics_latest: Record<string, LoopMetrics>;
  totals: { loops: number; by_status: Record<string, number>; by_group: Record<string, number>; cases: number };
}

export async function buildCatalogResponse(sb: SupabaseClient | null): Promise<CatalogResponse> {
  const catalog = loadCatalog();
  const planes = [...new Set(catalog.loops.map((l) => l.run_plane).filter((p): p is NonNullable<typeof p> => !!p))];
  const signals: Record<string, PlaneSignal> = {};
  await Promise.all(planes.map(async (p) => { signals[p] = await planeSignal(sb, p); }));
  const metrics_latest: Record<string, LoopMetrics> = {};
  await Promise.all(Object.entries(METRICS_ROUTINES).map(async ([loop, routine]) => {
    metrics_latest[loop] = await latestLoopMetrics(sb, routine);
  }));
  const by_status: Record<string, number> = {};
  const by_group: Record<string, number> = {};
  let cases = 0;
  for (const l of catalog.loops) {
    by_status[l.status] = (by_status[l.status] || 0) + 1;
    by_group[l.group] = (by_group[l.group] || 0) + 1;
    cases += l.cases.length;
  }
  for (const comp of catalog.components) cases += comp.cases?.length || 0;
  return {
    catalog,
    coverage: computeCoverage(catalog),
    signals,
    metrics_latest,
    totals: { loops: catalog.loops.length, by_status, by_group, cases },
  };
}
