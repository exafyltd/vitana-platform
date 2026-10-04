/**
 * VTID-04876 — Command Hub Overview Phase 1: the /ops/attention aggregator.
 *
 * Runs the seven adapters (services/ops-attention-adapters.ts) in parallel,
 * each bounded by ADAPTER_TIMEOUT_MS (3 s); a source that throws or times out
 * is UNKNOWN. Candidates become ranked items with env-scoped fingerprints and
 * time-based hysteresis:
 *
 *   - A candidate with a source timestamp (`since`) is stateless: it opens
 *     once `now - since >= hold_ms` (identical across tasks, plan N2).
 *   - A candidate without one uses `ops_attention_state` (env, fingerprint,
 *     first_seen, last_seen): first_seen is kept while the fingerprint keeps
 *     being observed, and reset when it was not seen for CLEAR_GRACE_MS
 *     (3 poll intervals) — so a flapping check does not restart its clock,
 *     and a cleared one does.
 *   - A state read or write failure never breaks the response: it is logged,
 *     the request falls back to "first seen at this request", and the
 *     `attention_state` source reports it (read failure = UNKNOWN, because a
 *     2-minute hold can then never open and that must not look green).
 *
 * Verdict: CRITICAL when any P1 item is shown; else UNKNOWN when any source
 * is unknown (never green on missing data); else ATTENTION when P2/P3 items
 * are shown; else OK.
 *
 * Computed on demand only while a viewer has the Overview open (plan F2): no
 * background loop. One computation per task at a time (single-flight) and a
 * CACHE_MS (25 s) cache. The env comes from VITANA_ENV (env.ts); staging
 * writes env='staging' state rows (owner decision 6, 2026-10-04) and the
 * status bar labels it "Staging build · production data".
 */

import { VITANA_ENV, type VitanaEnv } from '../env';
import {
  ATTENTION_ADAPTERS,
  type AdapterSpec,
  type AttentionReads,
  type AttentionSourceId,
  type Candidate,
  type Deeplink,
  type Severity,
} from './ops-attention-adapters';

export const ADAPTER_TIMEOUT_MS = 3_000;
export const CACHE_MS = 25_000;
export const CLEAR_GRACE_MS = 90_000;
export const MAX_ITEMS = 100;

export type Verdict = 'CRITICAL' | 'UNKNOWN' | 'ATTENTION' | 'OK';

export interface AttentionSource {
  id: AttentionSourceId | 'attention_state';
  status: 'ok' | 'unknown';
  fetched_at: string;
  error?: string;
}

export interface AttentionItem {
  id: string;
  fingerprint: string;
  domain: Candidate['domain'];
  severity: Severity;
  title: string;
  detail: string;
  since: string;
  count: number;
  source: AttentionSourceId;
  deeplink: Deeplink;
  evidence: Record<string, unknown>;
}

export interface AttentionData {
  generated_at: string;
  env: VitanaEnv;
  verdict: Verdict;
  counts: { p1: number; p2: number; p3: number };
  sources: AttentionSource[];
  items: AttentionItem[];
}

export interface StateRow {
  fingerprint: string;
  first_seen: string;
  last_seen: string;
}

/** ops_attention_state access (service role). */
export interface AttentionStateStore {
  load(env: VitanaEnv, fingerprints: string[]): Promise<StateRow[]>;
  save(env: VitanaEnv, rows: StateRow[]): Promise<void>;
}

export interface BuildAttentionInput {
  env: VitanaEnv;
  now: number;
  reads: AttentionReads;
  state: AttentionStateStore;
  adapters?: AdapterSpec[];
  adapterTimeoutMs?: number;
}

export function fingerprintOf(env: VitanaEnv, source: string, key: string): string {
  return `${env}:${source}:${key}`;
}

const SEVERITY_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function computeVerdict(counts: AttentionData['counts'], sources: AttentionSource[]): Verdict {
  if (counts.p1 > 0) return 'CRITICAL';
  if (sources.some((s) => s.status === 'unknown')) return 'UNKNOWN';
  if (counts.p2 + counts.p3 > 0) return 'ATTENTION';
  return 'OK';
}

/** One full computation, uncached. Never throws for an adapter or state failure. */
export async function buildOpsAttention(input: BuildAttentionInput): Promise<AttentionData> {
  const { env, now, reads, state } = input;
  const adapters = input.adapters ?? ATTENTION_ADAPTERS;
  const timeoutMs = input.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS;
  const nowIso = new Date(now).toISOString();

  const runs = await Promise.all(
    adapters.map(async (a) => {
      try {
        const out = await withTimeout(a.run(reads, { now }), timeoutMs);
        return { id: a.id, out, error: out.partial_error, fetched_at: new Date().toISOString() };
      } catch (err) {
        return { id: a.id, out: null, error: errMessage(err), fetched_at: new Date().toISOString() };
      }
    }),
  );

  const sources: AttentionSource[] = runs.map((r) => ({
    id: r.id,
    status: r.error ? 'unknown' : 'ok',
    fetched_at: r.fetched_at,
    ...(r.error ? { error: r.error } : {}),
  }));

  // Fingerprint every candidate; the ones without a source timestamp need state.
  const all = runs.flatMap((r) =>
    (r.out?.candidates ?? []).map((c) => ({ source: r.id, c, fingerprint: fingerprintOf(env, r.id, c.key) })),
  );
  const stateful = all.filter((x) => !x.c.since);

  const stateSource: AttentionSource = { id: 'attention_state', status: 'ok', fetched_at: nowIso };
  const prior = new Map<string, StateRow>();
  if (stateful.length) {
    try {
      for (const row of await state.load(env, stateful.map((x) => x.fingerprint))) prior.set(row.fingerprint, row);
    } catch (err) {
      console.error('[ops-attention] state read failed — falling back to first seen at this request:', errMessage(err));
      stateSource.status = 'unknown';
      stateSource.error = `state_read_failed: ${errMessage(err)}`;
    }
  }

  const firstSeen = new Map<string, string>();
  const writes: StateRow[] = [];
  for (const x of stateful) {
    const p = prior.get(x.fingerprint);
    const keep = p && now - Date.parse(p.last_seen) <= CLEAR_GRACE_MS;
    const fs = keep ? p!.first_seen : nowIso;
    firstSeen.set(x.fingerprint, fs);
    writes.push({ fingerprint: x.fingerprint, first_seen: fs, last_seen: nowIso });
  }
  if (writes.length && stateSource.status === 'ok') {
    try {
      await state.save(env, writes);
    } catch (err) {
      console.error('[ops-attention] state write failed (response unaffected):', errMessage(err));
      stateSource.error = `state_write_failed: ${errMessage(err)}`;
    }
  }
  sources.push(stateSource);

  const items: AttentionItem[] = [];
  for (const x of all) {
    const since = x.c.since ?? firstSeen.get(x.fingerprint) ?? nowIso;
    if (now - Date.parse(since) < x.c.hold_ms) continue; // not held long enough yet
    items.push({
      id: `${x.source}:${x.c.key}`,
      fingerprint: x.fingerprint,
      domain: x.c.domain,
      severity: x.c.severity,
      title: x.c.title,
      detail: x.c.detail,
      since,
      count: x.c.count,
      source: x.source,
      deeplink: x.c.deeplink,
      evidence: x.c.evidence,
    });
  }

  // Rank: severity, then the longest-standing first.
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Date.parse(a.since) - Date.parse(b.since));
  const counts = {
    p1: items.filter((i) => i.severity === 'P1').length,
    p2: items.filter((i) => i.severity === 'P2').length,
    p3: items.filter((i) => i.severity === 'P3').length,
  };
  return {
    generated_at: nowIso,
    env,
    verdict: computeVerdict(counts, sources),
    counts,
    sources,
    items: items.slice(0, MAX_ITEMS),
  };
}

// ── Cached, single-flight entry point used by the route ─────────────────────

let cache: { at: number; value: AttentionData } | null = null;
let inFlight: Promise<AttentionData> | null = null;
let depsOverride: { reads?: () => AttentionReads; state?: () => AttentionStateStore } | null = null;

export function resetOpsAttentionCacheForTests(): void {
  cache = null;
  inFlight = null;
}

/** Tests inject fake reads/state; production uses ops-attention-reads.ts. */
export function setOpsAttentionDepsForTests(
  deps: { reads?: () => AttentionReads; state?: () => AttentionStateStore } | null,
): void {
  depsOverride = deps;
  resetOpsAttentionCacheForTests();
}

export interface GetOpsAttentionOptions {
  /** The admin caller's Authorization header, forwarded to the health probes. */
  authHeader?: string;
  now?: number;
}

export async function getOpsAttention(opts: GetOpsAttentionOptions = {}): Promise<{ data: AttentionData; cached: boolean }> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < CACHE_MS) return { data: cache.value, cached: true };
  if (!inFlight) {
    // Lazy require keeps this module's import graph light for unit tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prod = depsOverride?.reads && depsOverride?.state ? null : require('./ops-attention-reads');
    const reads: AttentionReads = depsOverride?.reads
      ? depsOverride.reads()
      : prod.createAttentionReads({ authHeader: opts.authHeader });
    const state: AttentionStateStore = depsOverride?.state ? depsOverride.state() : prod.supabaseAttentionStateStore();
    inFlight = buildOpsAttention({ env: VITANA_ENV, now, reads, state })
      .then((value) => {
        cache = { at: now, value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return { data: await inFlight, cached: false };
}
