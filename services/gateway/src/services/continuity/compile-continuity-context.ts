/**
 * VTID-02932 (B2) — compileContinuityContext.
 *
 * Pure function over raw rows. Produces the distilled
 * ContinuityContext the assistant decision layer reads from:
 *
 *   open_threads          — top-N open threads, oldest-touched-first cap
 *   promises_owed         — owed promises, due-soonest first
 *   promises_kept_recently — last 7 days of kept promises (for credit)
 *   counts                — aggregate signals the cadence layer uses
 *   source_health         — per-table read status
 *
 * No IO. No mutation. No clock side-effects (now is injected).
 */

import type {
  AssistantPromiseRow,
  ContinuityContext,
  OpenThreadRow,
} from './types';

export interface CompileContinuityContextInputs {
  threadsResult: { ok: boolean; rows: OpenThreadRow[]; reason?: string };
  promisesResult: { ok: boolean; rows: AssistantPromiseRow[]; reason?: string };
  /** Injected for testability. Production passes Date.now(). */
  nowMs?: number;
  /** Max open threads to surface to the assistant. Default 5. */
  openThreadLimit?: number;
  /** Max owed promises to surface. Default 5. */
  promisesOwedLimit?: number;
  /** Max recently-kept promises to surface. Default 3. */
  promisesKeptLimit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_KEPT_WINDOW_MS = 7 * DAY_MS;

export function compileContinuityContext(
  input: CompileContinuityContextInputs,
): ContinuityContext {
  const now = input.nowMs ?? Date.now();
  const openLimit = input.openThreadLimit ?? 5;
  const owedLimit = input.promisesOwedLimit ?? 5;
  const keptLimit = input.promisesKeptLimit ?? 3;

  const threadsRows = input.threadsResult.ok ? input.threadsResult.rows : [];
  const promisesRows = input.promisesResult.ok ? input.promisesResult.rows : [];

  const openThreads = threadsRows
    .filter((t) => t.status === 'open')
    .sort((a, b) => Date.parse(b.last_mentioned_at) - Date.parse(a.last_mentioned_at))
    .slice(0, openLimit)
    .map((t) => ({
      thread_id: t.thread_id,
      topic: t.topic,
      summary: t.summary,
      last_mentioned_at: t.last_mentioned_at,
      days_since_last_mention: daysBetween(now, Date.parse(t.last_mentioned_at)),
    }));

  const owed = promisesRows.filter((p) => p.status === 'owed');
  const promises_owed = [...owed]
    .sort((a, b) => sortByDueAtAsc(a.due_at, b.due_at))
    .slice(0, owedLimit)
    .map((p) => ({
      promise_id: p.promise_id,
      promise_text: p.promise_text,
      due_at: p.due_at,
      days_overdue: p.due_at ? daysBetween(now, Date.parse(p.due_at), 'overdue') : null,
      decision_id: p.decision_id,
    }));

  const promises_kept_recently = promisesRows
    .filter((p) => p.status === 'kept' && p.kept_at)
    .filter((p) => {
      const t = Date.parse(p.kept_at as string);
      return Number.isFinite(t) && now - t <= RECENT_KEPT_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.kept_at as string) - Date.parse(a.kept_at as string))
    .slice(0, keptLimit)
    .map((p) => ({
      promise_id: p.promise_id,
      promise_text: p.promise_text,
      kept_at: p.kept_at as string,
    }));

  // Counts.
  const todayStart = startOfUtcDay(now);
  const threads_mentioned_today = threadsRows.filter((t) => {
    const at = Date.parse(t.last_mentioned_at);
    return Number.isFinite(at) && at >= todayStart;
  }).length;
  const promises_overdue = owed.filter((p) => {
    if (!p.due_at) return false;
    const t = Date.parse(p.due_at);
    return Number.isFinite(t) && t < now;
  }).length;

  return {
    open_threads: openThreads,
    promises_owed,
    promises_kept_recently,
    counts: {
      open_threads_total: threadsRows.filter((t) => t.status === 'open').length,
      promises_owed_total: owed.length,
      promises_overdue,
      threads_mentioned_today,
    },
    source_health: {
      user_open_threads: input.threadsResult.ok
        ? { ok: true }
        : { ok: false, reason: input.threadsResult.reason ?? 'unknown_failure' },
      assistant_promises: input.promisesResult.ok
        ? { ok: true }
        : { ok: false, reason: input.promisesResult.reason ?? 'unknown_failure' },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

function daysBetween(nowMs: number, thenMs: number, mode: 'ago' | 'overdue' = 'ago'): number | null {
  if (!Number.isFinite(thenMs)) return null;
  const diffMs = mode === 'overdue' ? nowMs - thenMs : nowMs - thenMs;
  if (diffMs < 0) {
    // For "overdue" semantics, a future due_at means NOT overdue → return negative
    // days (caller can render "due in N days"). For "ago", a future "then"
    // shouldn't happen but we still return a negative count rather than crash.
    return Math.ceil(diffMs / DAY_MS);
  }
  return Math.floor(diffMs / DAY_MS);
}

function sortByDueAtAsc(a: string | null, b: string | null): number {
  // null due_at sorts AFTER any present due_at (less urgent).
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return Date.parse(a) - Date.parse(b);
}

function startOfUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
