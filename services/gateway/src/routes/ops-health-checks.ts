/**
 * VTID-04663 — Service Health Phase 2: checks the database already computes.
 *
 * The morning health check and the ALERT-* workflows read these once a day
 * (or every 20 minutes) from GitHub Actions; the Command Hub panel never saw
 * them. Each route turns one existing signal into a panel check with a
 * `status` field (ok / degraded / down) the panel classifier understands:
 *
 *   /llm-routing          no llm_routing_policy stage on anthropic/vertex (VTID-03563)
 *   /anthropic-credit     0 "credit balance too low" failures in 24 h
 *   /google-fallback      0 LLM completions served by Vertex/Gemini in 24 h
 *   /locale-coverage      every GA locale has full Journey + Navigator rows
 *   /test-actor-guard     the VTID-03506 notification guard is installed + enabled
 *   /vtid-ledger          ci_ledger_integrity_check() finds nothing (7 days)
 *   /orb-session-ledger   ci_orb_session_state_health(): table present, no failed acks
 *   /push-dispatch        no unsent push older than 15 min / backlog under 25 (48 h window);
 *                         active-member reach >= 90 % over 7 days (VTID-05027)
 *
 * Read-only. Public like the other health routes: aggregates only, no user
 * data. Every source is cached for CACHE_MS so a busy panel cannot turn into
 * database load, and every failure is reported as `down` with its reason —
 * never a silent green.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';

const router = Router();

export type OpsStatus = 'ok' | 'degraded' | 'down';
export interface OpsCheck {
  status: OpsStatus;
  reason?: string;
  [key: string]: unknown;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export function resetOpsHealthCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── Sources ─────────────────────────────────────────────────────────────────

export interface VitalSystems {
  llm_stages_on_forbidden_provider?: unknown[];
  llm_anthropic_credit_failures_24h?: number;
  llm_bedrock_completions_24h?: number;
  llm_vertex_completions_24h?: number;
  locales_ga?: number;
  journey_checklist_incomplete_ga_locales?: unknown[];
  notif_test_actor_guard_present?: boolean;
  notif_test_actor_trigger_enabled?: boolean;
}

async function loadVitals(): Promise<VitalSystems> {
  const sb = getSupabase();
  if (!sb) throw new Error('supabase_unconfigured');
  const { data, error } = await sb.rpc('ci_vital_systems_health');
  if (error) throw new Error(`ci_vital_systems_health: ${error.message}`);
  return (data ?? {}) as VitalSystems;
}

// ── Pure evaluators (unit-tested) ───────────────────────────────────────────

export function evalLlmRouting(v: VitalSystems): OpsCheck {
  const bad = v.llm_stages_on_forbidden_provider ?? [];
  return bad.length === 0
    ? { status: 'ok', bedrock_completions_24h: v.llm_bedrock_completions_24h ?? null }
    : { status: 'down', reason: 'stage_on_forbidden_provider', stages: bad };
}

export function evalAnthropicCredit(v: VitalSystems): OpsCheck {
  const n = v.llm_anthropic_credit_failures_24h ?? 0;
  return n === 0
    ? { status: 'ok', failures_24h: 0 }
    : { status: 'down', reason: 'anthropic_credit_failures', failures_24h: n };
}

export function evalGoogleFallback(v: VitalSystems): OpsCheck {
  const n = v.llm_vertex_completions_24h ?? 0;
  return n === 0
    ? { status: 'ok', vertex_completions_24h: 0 }
    : { status: 'degraded', reason: 'llm_served_by_google', vertex_completions_24h: n };
}

// VTID-04880: judged on the Guided Journey curriculum only. The Navigator
// catalog (nav_catalog_i18n) was retired with the legacy voice navigator — the
// screen registry's per-locale titles are checked by the vitana-v1 build — so
// its coverage is no longer a reason to call a locale degraded.
export function evalLocaleCoverage(v: VitalSystems): OpsCheck {
  const journey = v.journey_checklist_incomplete_ga_locales ?? [];
  return journey.length === 0
    ? { status: 'ok', ga_locales: v.locales_ga ?? null }
    : { status: 'degraded', reason: 'incomplete_ga_locale', journey_incomplete: journey };
}

export function evalTestActorGuard(v: VitalSystems): OpsCheck {
  const present = v.notif_test_actor_guard_present === true;
  const enabled = v.notif_test_actor_trigger_enabled === true;
  return present && enabled
    ? { status: 'ok' }
    : { status: 'down', reason: !present ? 'guard_function_missing' : 'guard_trigger_disabled' };
}

export function evalLedgerIntegrity(rows: Array<{ vtid?: string }>): OpsCheck {
  return rows.length === 0
    ? { status: 'ok', violations_7d: 0 }
    : {
        status: 'degraded',
        reason: 'ledger_integrity_violations',
        violations_7d: rows.length,
        vtids: rows.slice(0, 10).map((r) => r.vtid ?? null),
      };
}

export function evalOrbSessionLedger(h: {
  table_exists?: boolean;
  acks_failed_24h?: number;
  session_starts_24h?: number;
  acks_24h?: number;
  state_writes_24h?: number;
}): OpsCheck {
  if (h.table_exists === false) return { status: 'down', reason: 'orb_session_state_table_missing' };
  const failed = h.acks_failed_24h ?? 0;
  const starts = h.session_starts_24h ?? 0;
  const writes = h.state_writes_24h ?? null;
  const base = { session_starts_24h: h.session_starts_24h ?? null, state_writes_24h: writes, acks_24h: h.acks_24h ?? null, acks_failed_24h: failed };
  // Same rule as ALERT-ORB-SESSION-STATE-HEALTH.yml: the state helpers fail
  // silently, so real traffic with no writes is a failure on its own.
  if (starts >= 5 && writes === 0) return { status: 'down', reason: 'no_state_writes', ...base };
  return failed > 0 ? { status: 'degraded', reason: 'failed_acks', ...base } : { status: 'ok', ...base };
}

/** Same thresholds as ALERT-PUSH-DISPATCH-HEALTH.yml; window = the dispatcher's own 48 h lookback. */
export const PUSH_STALE_MIN = 15;
export const PUSH_DOWN_MIN = 60;
export const PUSH_BACKLOG_MAX = 25;
/**
 * VTID-04962: FCM error share over the outcome window. Only FCM attempts
 * count (delivered_fcm, delivered_both, fcm_error); rows with no recorded
 * outcome are ignored, never treated as failures.
 */
export const PUSH_FCM_ERROR_RATIO_MAX = 0.5;
export const PUSH_FCM_MIN_ATTEMPTS = 20;
/**
 * VTID-05027: share of ACTIVE members (last 7 days) whose push-eligible
 * notifications reached at least one device. Below this, with enough
 * eligible members to mean something, the check is degraded.
 */
export const PUSH_REACH_MIN_RATIO = 0.9;
export const PUSH_REACH_MIN_ELIGIBLE = 10;

export interface PushReach {
  active: number;
  eligible: number;
  reached: number;
}

export function evalPushDispatch(
  rows: Array<{ created_at: string }>,
  now = Date.now(),
  outcomes?: Record<string, number>,
  reach?: PushReach,
): OpsCheck {
  const oldestMin = rows.length ? Math.round((now - new Date(rows[0].created_at).getTime()) / 60000) : 0;
  const base: Record<string, unknown> = rows.length ? { unsent: rows.length, oldest_age_min: oldestMin } : { unsent: 0 };
  if (outcomes) base.outcomes = outcomes;
  const reachRatio = reach && reach.eligible > 0 ? Math.round((reach.reached / reach.eligible) * 100) / 100 : null;
  if (reach) base.active_reach_7d = { ...reach, ratio: reachRatio };
  if (rows.length && oldestMin > PUSH_DOWN_MIN) return { status: 'down', reason: 'push_dispatch_stalled', ...base };
  if (rows.length && (oldestMin > PUSH_STALE_MIN || rows.length > PUSH_BACKLOG_MAX)) {
    return { status: 'degraded', reason: 'push_backlog_growing', ...base };
  }
  if (outcomes) {
    const fcmErrors = outcomes.fcm_error ?? 0;
    const fcmAttempts = fcmErrors + (outcomes.delivered_fcm ?? 0) + (outcomes.delivered_both ?? 0);
    if (fcmAttempts >= PUSH_FCM_MIN_ATTEMPTS && fcmErrors / fcmAttempts > PUSH_FCM_ERROR_RATIO_MAX) {
      return { status: 'degraded', reason: 'fcm_send_errors', fcm_error_ratio: Math.round((fcmErrors / fcmAttempts) * 100) / 100, ...base };
    }
  }
  if (reach && reach.eligible >= PUSH_REACH_MIN_ELIGIBLE && reach.reached / reach.eligible < PUSH_REACH_MIN_RATIO) {
    return { status: 'degraded', reason: 'active_member_reach_low', ...base };
  }
  return { status: 'ok', ...base };
}

// ── Routes ──────────────────────────────────────────────────────────────────

function respond(res: Response, fn: () => Promise<OpsCheck>): void {
  fn()
    .then((check) => res.status(200).json({ ...check, checked_at: new Date().toISOString() }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(200).json({ status: 'down', reason: 'check_failed', detail: message.slice(0, 300) });
    });
}

const VITAL_ROUTES: Array<[string, (v: VitalSystems) => OpsCheck]> = [
  ['/llm-routing', evalLlmRouting],
  ['/anthropic-credit', evalAnthropicCredit],
  ['/google-fallback', evalGoogleFallback],
  ['/locale-coverage', evalLocaleCoverage],
  ['/test-actor-guard', evalTestActorGuard],
];
for (const [path, evaluate] of VITAL_ROUTES) {
  router.get(path, (_req: Request, res: Response) => { // public-route
    respond(res, async () => evaluate(await cached('vitals', loadVitals)));
  });
}

router.get('/vtid-ledger', (_req: Request, res: Response) => { // public-route
  respond(res, async () =>
    evalLedgerIntegrity(
      await cached('ledger', async () => {
        const sb = getSupabase();
        if (!sb) throw new Error('supabase_unconfigured');
        const { data, error } = await sb.rpc('ci_ledger_integrity_check', { p_lookback_days: 7 });
        if (error) throw new Error(`ci_ledger_integrity_check: ${error.message}`);
        return (data ?? []) as Array<{ vtid?: string }>;
      }),
    ),
  );
});

router.get('/orb-session-ledger', (_req: Request, res: Response) => { // public-route
  respond(res, async () =>
    evalOrbSessionLedger(
      await cached('orb', async () => {
        const sb = getSupabase();
        if (!sb) throw new Error('supabase_unconfigured');
        const { data, error } = await sb.rpc('ci_orb_session_state_health');
        if (error) throw new Error(`ci_orb_session_state_health: ${error.message}`);
        return (data ?? {}) as Record<string, number | boolean>;
      }),
    ),
  );
});

router.get('/push-dispatch', (_req: Request, res: Response) => { // public-route
  respond(res, async () =>
    evalPushDispatch(
      await cached('push', async () => {
        const sb = getSupabase();
        if (!sb) throw new Error('supabase_unconfigured');
        const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const { data, error } = await sb
          .from('user_notifications')
          .select('created_at')
          .is('push_sent_at', null)
          .in('channel', ['push', 'push_and_inapp'])
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .limit(1000);
        if (error) throw new Error(`user_notifications: ${error.message}`);
        return (data ?? []) as Array<{ created_at: string }>;
      }),
      Date.now(),
      await cached('push_outcomes', loadPushOutcomes),
      await cached('push_reach', loadPushReach),
    ),
  );
});

/**
 * VTID-04962: push_outcome counts over the last 6 hours. Returns undefined
 * when the counts cannot be read (e.g. the column is not migrated yet), so
 * the backlog check above still answers on its own.
 */
async function loadPushOutcomes(): Promise<Record<string, number> | undefined> {
  const sb = getSupabase();
  if (!sb) return undefined;
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('user_notifications')
      .select('push_outcome')
      .not('push_outcome', 'is', null)
      .gte('created_at', since)
      .limit(5000);
    if (error) return undefined;
    const counts: Record<string, number> = {};
    for (const r of (data ?? []) as Array<{ push_outcome: string }>) counts[r.push_outcome] = (counts[r.push_outcome] ?? 0) + 1;
    return counts;
  } catch {
    return undefined;
  }
}

/**
 * VTID-05027: active-member push reach over 7 days (push_reach_active RPC).
 * Undefined when it cannot be read (function not migrated yet, RPC error), so
 * the field is omitted and never raises a false alarm.
 */
async function loadPushReach(): Promise<PushReach | undefined> {
  const sb = getSupabase();
  if (!sb) return undefined;
  try {
    const { data, error } = await sb.rpc('push_reach_active', { p_days: 7 });
    if (error) return undefined;
    const row = (Array.isArray(data) ? data[0] : data) as Partial<Record<keyof PushReach, number | string>> | null;
    if (!row) return undefined;
    return { active: Number(row.active ?? 0), eligible: Number(row.eligible ?? 0), reached: Number(row.reached ?? 0) };
  } catch {
    return undefined;
  }
}

export { router as opsHealthChecksRouter };
