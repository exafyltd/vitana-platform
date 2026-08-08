/**
 * DEV-COMHU-0503 — ORB Recovery 2+3: typed read/write helper for the shared
 * cross-transport `orb_session_state` table (see migration
 * 20260606000000_DEV_COMHU_0503_orb_session_state.sql).
 *
 * Used by:
 *   - ORB-2+3: 'continuity' — conversation_id + compact transcript + last-turn
 *     / last-greeting timestamps, so close+reopen within the TTL resumes
 *     instead of looking "first-time".
 *   - ORB-4:   'audio_ready_ack' — client audio-pipeline-ready signal.
 *   - ORB-5:   'pending_cta'     — the executable autopilot CTA awaiting "yes".
 *
 * All reads fail-open (return null on any error) — session state is an
 * optimization, never a hard dependency. Writes never throw.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type OrbSessionStateKey =
  | 'continuity'
  | 'audio_ready_ack'
  | 'pending_cta'
  // VTID-03301 — rolling list of recently-served opener dedupe keys
  // (most-recent first), used to rotate the wake-brief opener across sessions
  // so users don't hear the same "complete your profile" line every time.
  | 'recent_openers';

export interface OrbSessionStateRecord<T = unknown> {
  value: T;
  expiresAtMs: number;
}

const TABLE = 'orb_session_state';

// ---------------------------------------------------------------------------
// VTID-03485 — write/read health tracking.
//
// Why this exists: every helper in this module fails soft. Reads return null,
// writes return { ok: false }, nothing throws. That is the correct behaviour
// (session state is an optimization, never a hard dependency) but it made a
// total outage invisible — under VTID-03480 this table did not exist in
// production for ~2 months and four ORB features were silently inert, because
// `ok:false` in a payload nobody alerts on is not detection.
//
// The counters below live here rather than at the call sites deliberately:
// every read/write/clear funnels through these three functions, so no existing
// caller has to opt in and no future caller can bypass it.
//
// Loudness is deliberately rationed. A single failed write is a blip; the
// signal worth alarming on is *persistence*, so we log on the healthy→unhealthy
// transition (not per failure — "repetition ≠ signal", CLAUDE.md §6) and then
// at most once per re-alert interval while it stays broken.
// ---------------------------------------------------------------------------

export type OrbSessionStateOp = 'read' | 'write' | 'clear';

export interface OrbSessionStateOpHealth {
  attempts: number;
  failures: number;
  consecutive_failures: number;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  last_success_at: string | null;
}

export interface OrbSessionStateHealth {
  ok: boolean;
  /** True once an error looked like the table/schema itself is missing. */
  schema_missing: boolean;
  schema_missing_detail: string | null;
  /** Ops whose consecutive-failure count is at or past the alert threshold. */
  degraded_ops: OrbSessionStateOp[];
  ops: Record<OrbSessionStateOp, OrbSessionStateOpHealth>;
  since: string;
}

/** Consecutive failures before an op counts as degraded. One blip is not news. */
const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 3;

/** While still unhealthy, re-log no more often than this. */
const REALERT_INTERVAL_MS = 15 * 60_000;

/**
 * Grep-able marker. Log-based alerting (CloudWatch metric filter / GCP log
 * sink) keys on this exact string — do not reword it without updating the
 * alarm that consumes it.
 */
const ALERT_MARKER = 'ORB_SESSION_STATE_UNHEALTHY';

/**
 * Postgres/PostgREST phrasings that mean "the relation isn't there", as opposed
 * to a transient failure. This is the VTID-03480 signature and it does not
 * deserve three strikes — one is conclusive.
 */
const SCHEMA_MISSING_PATTERNS = [
  /relation .* does not exist/i,
  /could not find the table/i,
  /schema cache/i,
  /undefined_table/i,
];

const TRACKER_SINCE = new Date().toISOString();

function freshOpStats(): OrbSessionStateOpHealth {
  return {
    attempts: 0,
    failures: 0,
    consecutive_failures: 0,
    last_failure_at: null,
    last_failure_reason: null,
    last_success_at: null,
  };
}

const opStats: Record<OrbSessionStateOp, OrbSessionStateOpHealth> = {
  read: freshOpStats(),
  write: freshOpStats(),
  clear: freshOpStats(),
};

let schemaMissing = false;
let schemaMissingDetail: string | null = null;
let lastAlertAtMs = 0;

function isDegraded(op: OrbSessionStateOp): boolean {
  return opStats[op].consecutive_failures >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD;
}

function currentlyUnhealthy(): boolean {
  return schemaMissing || (['read', 'write', 'clear'] as const).some(isDegraded);
}

/**
 * Emit the loud line, but only on a transition into unhealthy or after the
 * re-alert interval. Never throws — health tracking must not be able to break
 * the very calls it observes.
 */
function maybeAlert(op: OrbSessionStateOp, reason: string, nowMs: number): void {
  try {
    if (!currentlyUnhealthy()) return;
    if (lastAlertAtMs !== 0 && nowMs - lastAlertAtMs < REALERT_INTERVAL_MS) return;
    lastAlertAtMs = nowMs;
    const stats = opStats[op];
    console.error(
      `[${ALERT_MARKER}] orb_session_state ${op} failing persistently — ` +
        `${stats.consecutive_failures} consecutive failures ` +
        `(${stats.failures}/${stats.attempts} lifetime)` +
        (schemaMissing ? ' — TABLE/RELATION APPEARS MISSING (unapplied migration?)' : '') +
        `. Last reason: ${reason}. ` +
        'ORB continuity, audio-ready handshake, pending CTA and opener rotation are degraded.',
    );
  } catch {
    /* never let telemetry break the caller */
  }
}

function recordSuccess(op: OrbSessionStateOp, nowMs: number): void {
  try {
    const stats = opStats[op];
    stats.attempts += 1;
    stats.consecutive_failures = 0;
    stats.last_success_at = new Date(nowMs).toISOString();
    // A success proves the relation resolves; clear the sticky schema flag so
    // applying the missing migration recovers health without a redeploy (this
    // is exactly how VTID-03480 was confirmed fixed).
    if (schemaMissing) {
      schemaMissing = false;
      schemaMissingDetail = null;
      lastAlertAtMs = 0;
      console.warn(
        `[${ALERT_MARKER}] recovered — orb_session_state ${op} succeeded; relation resolves again.`,
      );
    }
  } catch {
    /* ignore */
  }
}

function recordFailure(op: OrbSessionStateOp, reason: string, nowMs: number): void {
  try {
    const stats = opStats[op];
    stats.attempts += 1;
    stats.failures += 1;
    stats.consecutive_failures += 1;
    stats.last_failure_at = new Date(nowMs).toISOString();
    stats.last_failure_reason = reason;
    if (!schemaMissing && SCHEMA_MISSING_PATTERNS.some((re) => re.test(reason))) {
      schemaMissing = true;
      schemaMissingDetail = reason;
      lastAlertAtMs = 0; // conclusive — alert now, don't wait out the interval
    }
    maybeAlert(op, reason, nowMs);
  } catch {
    /* ignore */
  }
}

/** Current health snapshot. Read by GET /api/v1/admin/orb-session-state-health. */
export function getOrbSessionStateHealth(): OrbSessionStateHealth {
  const degraded = (['read', 'write', 'clear'] as const).filter(isDegraded);
  return {
    ok: !currentlyUnhealthy(),
    schema_missing: schemaMissing,
    schema_missing_detail: schemaMissingDetail,
    degraded_ops: degraded,
    ops: {
      read: { ...opStats.read },
      write: { ...opStats.write },
      clear: { ...opStats.clear },
    },
    since: TRACKER_SINCE,
  };
}

/** Test-only: reset all counters. */
export function __resetOrbSessionStateHealthForTest(): void {
  opStats.read = freshOpStats();
  opStats.write = freshOpStats();
  opStats.clear = freshOpStats();
  schemaMissing = false;
  schemaMissingDetail = null;
  lastAlertAtMs = 0;
}

/** Read a key for a user. Returns null when absent, expired, or on any error. */
export async function readOrbSessionState<T = unknown>(
  supabase: SupabaseClient,
  userId: string,
  key: OrbSessionStateKey,
  nowMs: number = Date.now(),
): Promise<OrbSessionStateRecord<T> | null> {
  if (!userId || !key) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('value, expires_at')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    // A genuine query error and a legitimately absent row both return null to
    // the caller, but they mean opposite things for health: "no row yet" is the
    // normal first-session case, "relation does not exist" is an outage. Only
    // the former should count as a healthy read.
    if (error) {
      recordFailure('read', error.message || 'unknown_read_error', nowMs);
      return null;
    }
    recordSuccess('read', nowMs);
    if (!data) return null;
    const expiresAtMs = Date.parse((data as { expires_at: string }).expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null; // expired
    return { value: (data as { value: T }).value, expiresAtMs };
  } catch (e) {
    recordFailure('read', e instanceof Error ? e.message : String(e), nowMs);
    return null;
  }
}

/** Upsert a key with a TTL (minutes). Never throws; returns ok=false on error. */
export async function writeOrbSessionState(
  supabase: SupabaseClient,
  userId: string,
  key: OrbSessionStateKey,
  value: unknown,
  ttlMinutes: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  if (!userId || !key) return { ok: false, reason: 'missing_identity_or_key' };
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 15;
  const expiresIso = new Date(nowMs + ttl * 60_000).toISOString();
  const updatedIso = new Date(nowMs).toISOString();
  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: userId, key, value, expires_at: expiresIso, updated_at: updatedIso },
        { onConflict: 'user_id,key' },
      );
    if (error) {
      recordFailure('write', error.message, nowMs);
      return { ok: false, reason: error.message };
    }
    recordSuccess('write', nowMs);
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    recordFailure('write', reason, nowMs);
    return { ok: false, reason };
  }
}

/** Delete a key (intentional forget — logout / account switch / reset). */
export async function clearOrbSessionState(
  supabase: SupabaseClient,
  userId: string,
  key: OrbSessionStateKey,
): Promise<{ ok: boolean; reason?: string }> {
  if (!userId || !key) return { ok: false, reason: 'missing_identity_or_key' };
  try {
    const nowMs = Date.now();
    const { error } = await supabase.from(TABLE).delete().eq('user_id', userId).eq('key', key);
    if (error) {
      recordFailure('clear', error.message, nowMs);
      return { ok: false, reason: error.message };
    }
    recordSuccess('clear', nowMs);
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    recordFailure('clear', reason, Date.now());
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Continuity value shape (ORB-2+3) — what _persistContinuity stores.
// ---------------------------------------------------------------------------

export interface OrbContinuityValue {
  conversation_id: string | null;
  transcript_history: Array<{ role: 'user' | 'assistant'; text: string }>;
  last_turn_at: string | null;
  last_greeting_at: string | null;
  reason: 'hide' | 'connection' | 'reconnect' | string;
}

/** Default TTLs (minutes) by close reason — short-lived continuity. */
export const CONTINUITY_TTL_MINUTES = { hide: 15, disconnect: 5 } as const;
