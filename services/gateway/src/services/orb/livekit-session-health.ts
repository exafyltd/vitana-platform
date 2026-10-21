/**
 * BOOTSTRAP-LIVEKIT-CONTROL — LiveKit control-plane session-health summary.
 *
 * Pure, side-effect-free logic that turns a snapshot of `orb_session_state`
 * `continuity` rows into a read-only health summary for the gateway-side
 * LiveKit control plane:
 *
 *   - active_sessions    — rows whose TTL has not yet elapsed
 *   - expired_sessions   — rows that are past expires_at (GC will reap them)
 *   - stuck_sessions     — active rows that look wedged: the last turn (or, if
 *     no turn yet, the greeting) is older than a staleness threshold while the
 *     row is still inside its TTL window. These are sessions the client never
 *     closed cleanly — a useful operator signal for "phantom" rooms.
 *
 * This module reads NOTHING and writes NOTHING. The route handler fetches the
 * rows (service-role) and hands them here. Keeping the math pure makes it
 * trivially unit-testable without a live DB, mirroring orb-session-state.ts.
 *
 * It deliberately does NOT touch the voice hot path: no token mint, no
 * provider flip, no continuity write. Read-only diagnostics only.
 */

/** One `orb_session_state` row as fetched by the control-plane health route. */
export interface OrbSessionStateRow {
  user_id: string;
  key: string;
  /** The continuity value blob (see OrbContinuityValue). May be partial. */
  value: {
    conversation_id?: string | null;
    last_turn_at?: string | null;
    last_greeting_at?: string | null;
    reason?: string | null;
    transcript_history?: Array<unknown> | null;
  } | null;
  expires_at: string;
  updated_at: string;
}

/** Per-session classification surfaced for the stuck list. */
export interface StuckSessionSummary {
  user_id: string;
  conversation_id: string | null;
  /** Whichever of last_turn_at / last_greeting_at / updated_at was newest. */
  last_activity_at: string | null;
  idle_ms: number;
  expires_in_ms: number;
}

export interface LiveKitSessionHealthSummary {
  total_rows: number;
  active_sessions: number;
  expired_sessions: number;
  stuck_sessions: number;
  /** Capped list (default 20) of the worst-offending stuck sessions. */
  stuck_session_details: StuckSessionSummary[];
  /** Threshold used for staleness, echoed for observability. */
  stale_after_ms: number;
  computed_at: string;
}

export interface SummariseOptions {
  /** Treat an active session as stuck when idle longer than this. */
  staleAfterMs?: number;
  /** Wall clock; injectable for deterministic tests. */
  nowMs?: number;
  /** Cap on stuck_session_details length. */
  maxDetails?: number;
}

const DEFAULT_STALE_AFTER_MS = 10 * 60_000; // 10 minutes idle inside TTL
const DEFAULT_MAX_DETAILS = 20;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Most-recent activity timestamp for a continuity row. Prefers last_turn_at,
 * then last_greeting_at, then the row's updated_at as a floor.
 */
function lastActivityMs(row: OrbSessionStateRow): number | null {
  const turn = parseMs(row.value?.last_turn_at ?? null);
  const greet = parseMs(row.value?.last_greeting_at ?? null);
  const updated = parseMs(row.updated_at);
  const candidates = [turn, greet, updated].filter(
    (n): n is number => n !== null,
  );
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/**
 * Summarise a snapshot of continuity rows into a health report. Pure.
 */
export function summariseLiveKitSessionHealth(
  rows: OrbSessionStateRow[],
  opts: SummariseOptions = {},
): LiveKitSessionHealthSummary {
  const nowMs = opts.nowMs ?? Date.now();
  const staleAfterMs =
    Number.isFinite(opts.staleAfterMs) && (opts.staleAfterMs as number) > 0
      ? (opts.staleAfterMs as number)
      : DEFAULT_STALE_AFTER_MS;
  const maxDetails =
    Number.isFinite(opts.maxDetails) && (opts.maxDetails as number) > 0
      ? Math.floor(opts.maxDetails as number)
      : DEFAULT_MAX_DETAILS;

  let active = 0;
  let expired = 0;
  const stuck: StuckSessionSummary[] = [];

  for (const row of rows) {
    const expiresMs = parseMs(row.expires_at);
    const isExpired = expiresMs === null || expiresMs <= nowMs;
    if (isExpired) {
      expired += 1;
      continue;
    }
    active += 1;

    const lastMs = lastActivityMs(row);
    const idleMs = lastMs === null ? Number.POSITIVE_INFINITY : nowMs - lastMs;
    if (idleMs > staleAfterMs) {
      stuck.push({
        user_id: row.user_id,
        conversation_id: row.value?.conversation_id ?? null,
        last_activity_at: lastMs === null ? null : new Date(lastMs).toISOString(),
        idle_ms: Number.isFinite(idleMs) ? Math.round(idleMs) : -1,
        expires_in_ms: (expiresMs as number) - nowMs,
      });
    }
  }

  // Worst (most idle) first; -1 (unknown idle) sorts to the top as most suspect.
  stuck.sort((a, b) => {
    const av = a.idle_ms < 0 ? Number.POSITIVE_INFINITY : a.idle_ms;
    const bv = b.idle_ms < 0 ? Number.POSITIVE_INFINITY : b.idle_ms;
    return bv - av;
  });

  return {
    total_rows: rows.length,
    active_sessions: active,
    expired_sessions: expired,
    stuck_sessions: stuck.length,
    stuck_session_details: stuck.slice(0, maxDetails),
    stale_after_ms: staleAfterMs,
    computed_at: new Date(nowMs).toISOString(),
  };
}
