/**
 * VTID-04667 (P4.1 of docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md):
 * per-scanner / per-rule circuit breaker.
 *
 * Live, last 30 days: the todo, safety-gap, npm-audit, missing-tests,
 * schema-drift, route-auth, stale-flag and dead-code scanners produced 74
 * executions and 0 completions, while the agent executor spent 641 M input
 * tokens. The per-finding retry breaker (VTID-04243 / VTID-04368) bounds one
 * finding; nothing stopped a scanner whose findings never land from feeding
 * the loop a fresh finding every day. This module does that:
 *
 *   key      = spec_snapshot.scanner (impact findings carry `impact:<rule>`;
 *              a rule without a scanner becomes `impact:<rule>`), else the
 *              recommendation's source_type.
 *   success  = execution completed / self_healed
 *   failure  = failed / failed_escalated / reverted — EXCEPT outage-class
 *              failures (isProviderOutageFailure, VTID-04368): a provider
 *              outage is not the scanner's fault and is ignored, like
 *              cancelled / rejected.
 *   open     = at least MIN_SAMPLES decided executions among the newest
 *              WINDOW, and success rate < MIN_SUCCESS_RATE.
 *
 * While open, autoApproveTick and lazyPlanTick skip that scanner's findings
 * (no execution, and no planner LLM spend either). A human Activate is never
 * blocked. One OASIS event per transition (opened / closed), latched per
 * process like the VTID-04368 outage gate.
 */
import { emitOasisEvent } from './oasis-event-service';
import { isProviderOutageFailure } from './dev-autopilot-retry-breaker';
import { chunkIds } from './dev-autopilot-pipeline-guards';

export const DEFAULT_BREAKER_MIN_SAMPLES = 5;
export const DEFAULT_BREAKER_WINDOW = 10;
export const DEFAULT_BREAKER_MIN_SUCCESS_RATE = 0.2;
/** How far back executions are read when computing breaker state. */
export const BREAKER_LOOKBACK_DAYS = 30;
/** Loader cache so both ticks (and the supervisor) do not re-read every 30 s. */
export const BREAKER_CACHE_MS = 60_000;

export interface BreakerThresholds {
  min_samples: number;
  window: number;
  min_success_rate: number;
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** Thresholds, env-overridable (DEV_AUTOPILOT_BREAKER_MIN_SAMPLES / _WINDOW / _MIN_SUCCESS_RATE). */
export function resolveBreakerThresholds(env: NodeJS.ProcessEnv = process.env): BreakerThresholds {
  const window = Math.floor(num(env.DEV_AUTOPILOT_BREAKER_WINDOW, DEFAULT_BREAKER_WINDOW, 1, 1000));
  const minSamples = Math.floor(num(env.DEV_AUTOPILOT_BREAKER_MIN_SAMPLES, DEFAULT_BREAKER_MIN_SAMPLES, 1, 1000));
  return {
    window,
    min_samples: Math.min(minSamples, window),
    min_success_rate: num(env.DEV_AUTOPILOT_BREAKER_MIN_SUCCESS_RATE, DEFAULT_BREAKER_MIN_SUCCESS_RATE, 0, 1),
  };
}

export interface BreakerFindingShape {
  source_type?: string | null;
  spec_snapshot?: { scanner?: unknown; rule?: unknown } | null;
  /** Flattened forms (supervisor / PostgREST json-path selects). */
  scanner?: string | null;
  rule?: string | null;
}

/** The breaker key for a finding, or null when nothing identifies its producer. */
export function breakerKeyFor(f: BreakerFindingShape | null | undefined): string | null {
  if (!f) return null;
  const scanner = f.spec_snapshot?.scanner ?? f.scanner;
  if (typeof scanner === 'string' && scanner.trim()) return scanner.trim();
  const rule = f.spec_snapshot?.rule ?? f.rule;
  if (typeof rule === 'string' && rule.trim()) return `impact:${rule.trim()}`;
  return typeof f.source_type === 'string' && f.source_type.trim() ? f.source_type.trim() : null;
}

/**
 * Human-requested lanes are never paused by a scanner breaker: an operator
 * on-ramp finding exists because a person asked for that exact work.
 */
export function isBreakerEnforcedFor(f: BreakerFindingShape | null | undefined): boolean {
  return !!f && f.source_type !== 'operator_onramp';
}

export type ExecutionVerdict = 'success' | 'failure' | null;

const SUCCESS = new Set(['completed', 'self_healed']);
const FAILURE = new Set(['failed', 'failed_escalated', 'reverted']);

/** success / failure / null (ignored: cancelled, rejected, in-flight, outage-class failures). */
export function classifyExecution(status: string | null | undefined, metadata?: Record<string, unknown> | null): ExecutionVerdict {
  if (!status) return null;
  if (SUCCESS.has(status)) return 'success';
  if (FAILURE.has(status) || status.startsWith('failed')) {
    return isProviderOutageFailure(metadata) ? null : 'failure';
  }
  return null;
}

export interface BreakerState {
  key: string;
  samples: number;
  successes: number;
  failures: number;
  success_rate: number | null;
  open: boolean;
  last_decided_at: string | null;
}

export interface BreakerExecutionInput {
  key: string | null;
  status: string;
  updated_at: string;
  metadata?: Record<string, unknown> | null;
}

/** Pure: breaker state per key from executions (any order). */
export function computeBreakerStates(
  rows: BreakerExecutionInput[] | null | undefined,
  thresholds: BreakerThresholds = resolveBreakerThresholds(),
): Map<string, BreakerState> {
  const byKey = new Map<string, Array<{ verdict: 'success' | 'failure'; at: string }>>();
  const sorted = [...(rows || [])].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  for (const r of sorted) {
    if (!r.key) continue;
    const verdict = classifyExecution(r.status, r.metadata);
    if (!verdict) continue;
    const arr = byKey.get(r.key) || [];
    if (arr.length >= thresholds.window) continue;
    arr.push({ verdict, at: r.updated_at });
    byKey.set(r.key, arr);
  }
  const out = new Map<string, BreakerState>();
  for (const [key, arr] of byKey) {
    const successes = arr.filter((x) => x.verdict === 'success').length;
    const samples = arr.length;
    const rate = samples > 0 ? successes / samples : null;
    out.set(key, {
      key,
      samples,
      successes,
      failures: samples - successes,
      success_rate: rate === null ? null : Math.round(rate * 1000) / 1000,
      open: samples >= thresholds.min_samples && rate !== null && rate < thresholds.min_success_rate,
      last_decided_at: arr[0]?.at ?? null,
    });
  }
  return out;
}

export type BreakerQuery = <T>(path: string) => Promise<{ ok: boolean; data?: T }>;

export interface LoadedBreakers {
  ok: boolean;
  thresholds: BreakerThresholds;
  states: Map<string, BreakerState>;
}

let cached: { at: number; value: LoadedBreakers } | null = null;
/** Keys whose breaker was open at the last evaluation (per process). */
const lastOpen = new Set<string>();

/** Test hook. */
export function resetScannerBreakerCache(): void {
  cached = null;
  lastOpen.clear();
}

/**
 * Reads the last BREAKER_LOOKBACK_DAYS of decided executions and the
 * producing finding of each, then computes breaker state. A read failure
 * returns ok:false with no states — callers fail OPEN (the pre-VTID-04667
 * behaviour), never freeze the loop on a DB blip.
 */
export async function loadScannerBreakers(
  query: BreakerQuery,
  opts: { emitTransitions?: boolean; nowMs?: number; useCache?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedBreakers> {
  const nowMs = opts.nowMs ?? Date.now();
  const useCache = opts.useCache !== false;
  if (useCache && cached && nowMs - cached.at < BREAKER_CACHE_MS) return cached.value;
  const thresholds = resolveBreakerThresholds(opts.env);
  const since = new Date(nowMs - BREAKER_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  const execR = await query<Array<{ finding_id: string | null; status: string; updated_at: string; metadata: Record<string, unknown> | null }>>(
    `/rest/v1/dev_autopilot_executions?status=in.(completed,self_healed,failed,failed_escalated,reverted)`
    + `&updated_at=gte.${encodeURIComponent(since)}`
    + `&order=updated_at.desc&limit=1000&select=finding_id,status,updated_at,metadata`,
  );
  if (!execR.ok || !Array.isArray(execR.data)) {
    return { ok: false, thresholds, states: new Map() };
  }
  const ids = Array.from(new Set(execR.data.map((e) => e.finding_id).filter((x): x is string => !!x)));
  const keyByFinding = new Map<string, string | null>();
  for (const chunk of chunkIds(ids)) {
    if (chunk.length === 0) continue;
    const recR = await query<Array<{ id: string; source_type: string | null; scanner: string | null; rule: string | null }>>(
      `/rest/v1/autopilot_recommendations?id=in.(${chunk.join(',')})`
      + `&select=id,source_type,scanner:spec_snapshot->>scanner,rule:spec_snapshot->>rule`,
    );
    if (!recR.ok || !Array.isArray(recR.data)) return { ok: false, thresholds, states: new Map() };
    for (const r of recR.data) keyByFinding.set(r.id, breakerKeyFor(r));
  }
  const states = computeBreakerStates(
    execR.data.map((e) => ({ key: e.finding_id ? keyByFinding.get(e.finding_id) ?? null : null, status: e.status, updated_at: e.updated_at, metadata: e.metadata })),
    thresholds,
  );
  const value: LoadedBreakers = { ok: true, thresholds, states };
  if (opts.emitTransitions) await emitBreakerTransitions(states, thresholds);
  if (useCache) cached = { at: nowMs, value };
  return value;
}

/** One OASIS event per open/close transition (per process latch). */
export async function emitBreakerTransitions(states: Map<string, BreakerState>, thresholds: BreakerThresholds): Promise<void> {
  const nowOpen = new Set<string>();
  for (const st of states.values()) if (st.open) nowOpen.add(st.key);
  const opened = [...nowOpen].filter((k) => !lastOpen.has(k));
  const closed = [...lastOpen].filter((k) => !nowOpen.has(k));
  for (const key of opened) {
    const st = states.get(key)!;
    lastOpen.add(key);
    await emitOasisEvent({
      vtid: 'VTID-04667',
      type: 'dev_autopilot.scanner_breaker.opened',
      source: 'dev-autopilot',
      status: 'warning',
      message: `Scanner breaker OPEN for ${key}: ${st.successes}/${st.samples} recent executions landed — auto-approve and lazy planning paused for it`,
      payload: { key, samples: st.samples, successes: st.successes, success_rate: st.success_rate, thresholds },
    });
  }
  for (const key of closed) {
    lastOpen.delete(key);
    const st = states.get(key);
    await emitOasisEvent({
      vtid: 'VTID-04667',
      type: 'dev_autopilot.scanner_breaker.closed',
      source: 'dev-autopilot',
      status: 'info',
      message: `Scanner breaker closed for ${key} — auto-approve and lazy planning resume`,
      payload: { key, samples: st?.samples ?? 0, successes: st?.successes ?? 0, success_rate: st?.success_rate ?? null, thresholds },
    });
  }
}

/** True when the finding's scanner breaker is open (and enforced for it). */
export function isFindingBreakerOpen(loaded: LoadedBreakers | null | undefined, f: BreakerFindingShape): boolean {
  if (!loaded || !loaded.ok || !isBreakerEnforcedFor(f)) return false;
  const key = breakerKeyFor(f);
  return !!key && loaded.states.get(key)?.open === true;
}

/** Supervisor payload: every known breaker, open ones first. */
export function summarizeBreakers(loaded: LoadedBreakers): {
  ok: boolean;
  thresholds: BreakerThresholds;
  open: string[];
  items: BreakerState[];
} {
  const items = [...loaded.states.values()].sort((a, b) =>
    Number(b.open) - Number(a.open) || (a.success_rate ?? 1) - (b.success_rate ?? 1) || a.key.localeCompare(b.key));
  return { ok: loaded.ok, thresholds: loaded.thresholds, open: items.filter((i) => i.open).map((i) => i.key), items };
}
