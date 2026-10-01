/**
 * VTID-04665 — Service Health Phase 4: make "ok" mean the dependency answers.
 *
 * About a third of the per-router /health routes returned `{ ok: true }`
 * without touching anything, so the panel showed them green as long as the
 * route existed. Measured 2026-09-26 against the live database, five of those
 * green routes had no data layer at all: `autopilot_prompts` and
 * `risk_mitigations` do not exist, and none of the `overload_*`, `taste_*`
 * or `preference_*` functions the Overload, Taste and User Preference engines
 * call exist either.
 *
 * `probeDependencies()` checks each declared dependency without side effects:
 *
 *   table  a head-only select (`select … limit 1`, head: true) — no rows read
 *   rpc    presence in PostgREST's own schema listing — the function is never
 *          called, because several (preference_set, overload_detect) write
 *   file   the file exists and is non-empty (static assets)
 *
 * Results are cached for CACHE_MS; the schema listing for SCHEMA_CACHE_MS.
 * Status: every dependency answers → ok; any missing → down; a probe that
 * could not run (Supabase unconfigured) → not_configured. Never throws.
 */

import { promises as fs } from 'fs';
import { getSupabase } from '../lib/supabase';

export type Dependency = { table: string } | { rpc: string } | { file: string };

export interface DependencyResult {
  kind: 'table' | 'rpc' | 'file';
  name: string;
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export interface DependencyHealth {
  status: 'ok' | 'down' | 'not_configured';
  dependencies: DependencyResult[];
}

const CACHE_MS = 60_000;
const SCHEMA_CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;
const SCHEMA_TIMEOUT_MS = 3_000;

const resultCache = new Map<string, { at: number; value: DependencyResult }>();
let schemaCache: { at: number; rpcs: Set<string> } | null = null;
let schemaInflight: Promise<Set<string>> | null = null;

export function resetDependencyProbeForTests(): void {
  resultCache.clear();
  schemaCache = null;
  schemaInflight = null;
}

function describe(dep: Dependency): { kind: DependencyResult['kind']; name: string } {
  if ('table' in dep) return { kind: 'table', name: dep.table };
  if ('rpc' in dep) return { kind: 'rpc', name: dep.rpc };
  return { kind: 'file', name: dep.file };
}

/** Names of every RPC PostgREST exposes, from its OpenAPI root. */
async function loadRpcNames(): Promise<Set<string>> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_CACHE_MS) return schemaCache.rpcs;
  if (schemaInflight) return schemaInflight;
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
  if (!url || !key) throw new Error('supabase_unconfigured');
  schemaInflight = (async () => {
    const controller = new AbortController();
    // Below the summary's 5 s loopback deadline (SUMMARY_PROBE_TIMEOUT_MS).
    const timer = setTimeout(() => controller.abort(), SCHEMA_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`schema listing HTTP ${res.status}`);
      const spec = (await res.json()) as { paths?: Record<string, unknown> };
      const rpcs = new Set(
        Object.keys(spec.paths || {})
          .filter((p) => p.startsWith('/rpc/'))
          .map((p) => p.slice('/rpc/'.length)),
      );
      schemaCache = { at: Date.now(), rpcs };
      return rpcs;
    } finally {
      clearTimeout(timer);
      schemaInflight = null;
    }
  })();
  return schemaInflight;
}

async function probeOne(dep: Dependency): Promise<DependencyResult> {
  const { kind, name } = describe(dep);
  const key = `${kind}:${name}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const start = Date.now();
  let result: DependencyResult;
  try {
    if (kind === 'file') {
      const stat = await fs.stat(name);
      result = { kind, name, ok: stat.size > 0, latency_ms: Date.now() - start, ...(stat.size > 0 ? {} : { error: 'empty' }) };
    } else if (kind === 'rpc') {
      const rpcs = await loadRpcNames();
      const ok = rpcs.has(name);
      result = { kind, name, ok, latency_ms: Date.now() - start, ...(ok ? {} : { error: 'function_missing' }) };
    } else {
      const sb = getSupabase();
      if (!sb) throw new Error('supabase_unconfigured');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        // VTID-04698: a GET with limit(0), never head:true. supabase-js answers a
        // HEAD on a missing table with status 204 and error null (PostgREST's
        // 404 has no body to read), so a head-only probe reported every missing
        // table healthy. limit(0) still reads no rows and gets the real 404.
        const { error, status } = await sb.from(name).select('*').limit(0).abortSignal(controller.signal);
        result = error
          ? { kind, name, ok: false, latency_ms: Date.now() - start, error: /does not exist|schema cache|PGRST205|42P01/i.test(`${error.code} ${error.message}`) ? 'table_missing' : error.message.slice(0, 160) }
          : status === 404
            ? { kind, name, ok: false, latency_ms: Date.now() - start, error: 'table_missing' }
            : { kind, name, ok: true, latency_ms: Date.now() - start };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { kind, name, ok: false, latency_ms: Date.now() - start, error: message === 'supabase_unconfigured' ? 'supabase_unconfigured' : message.slice(0, 160) };
  }
  resultCache.set(key, { at: Date.now(), value: result });
  return result;
}

export async function probeDependencies(deps: Dependency[]): Promise<DependencyHealth> {
  const dependencies = await Promise.all(deps.map(probeOne));
  if (dependencies.length > 0 && dependencies.every((d) => d.error === 'supabase_unconfigured')) {
    return { status: 'not_configured', dependencies };
  }
  return { status: dependencies.every((d) => d.ok) ? 'ok' : 'down', dependencies };
}

/**
 * Merges a route's existing health body with the dependency probe: the body's
 * own fields stay; `status` becomes the probe's when it is not ok, `ok` turns
 * false when a dependency is down, and `dependencies` lists what was checked.
 */
export async function withDependencyHealth<T extends Record<string, unknown>>(
  deps: Dependency[],
  body: T,
): Promise<T & { status: string; dependencies: DependencyResult[] }> {
  const health = await probeDependencies(deps);
  const status = health.status === 'ok' ? (typeof body.status === 'string' ? body.status : 'ok') : health.status;
  const ok = health.status === 'down' ? false : body.ok;
  return { ...body, ...(ok === undefined ? {} : { ok }), status, dependencies: health.dependencies };
}
