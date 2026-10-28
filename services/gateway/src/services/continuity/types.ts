/**
 * VTID-02932 (B2) — conversation continuity types.
 *
 * These shapes drive signals 40–45 of the AssistantDecisionContext:
 *   #40 last_session_topic_summary
 *   #41 recurring_topics_last_30d
 *   #42 open_threads
 *   #43 vitana_promises
 *   #44 last_unresolved_intent       (deferred — needs intents table read)
 *   #45 topics_discussed_today
 *
 * Wall: pure types. No IO, no mutation. The fetcher is read-only;
 * state advancement (creating threads / marking promises) lives in
 * a follow-up slice and never goes through this module.
 */

export type OpenThreadStatus = 'open' | 'resolved' | 'abandoned';
export type PromiseStatus = 'owed' | 'kept' | 'broken' | 'cancelled';

export interface OpenThreadRow {
  thread_id: string;
  topic: string;
  summary: string | null;
  status: OpenThreadStatus;
  session_id_first: string | null;
  session_id_last: string | null;
  last_mentioned_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantPromiseRow {
  promise_id: string;
  thread_id: string | null;
  session_id: string | null;
  promise_text: string;
  due_at: string | null;
  status: PromiseStatus;
  decision_id: string | null;
  kept_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Compiled continuity context — what the assistant decision layer
 * consumes. Distilled from the raw rows; never carries the rows
 * themselves.
 *
 * Mirrors the AssistantDecisionContext spirit from B0b: the prompt
 * sees the distilled view, never the raw DB rows.
 */
export interface ContinuityContext {
  /** Signal #42 (open) — most recently-touched first, capped. */
  open_threads: Array<{
    thread_id: string;
    topic: string;
    summary: string | null;
    last_mentioned_at: string;
    days_since_last_mention: number | null;
  }>;
  /** Signal #43 — owed promises, oldest-due first. */
  promises_owed: Array<{
    promise_id: string;
    promise_text: string;
    due_at: string | null;
    days_overdue: number | null;
    decision_id: string | null;
  }>;
  /** Recently-kept promises (for credit acknowledgement). Capped. */
  promises_kept_recently: Array<{
    promise_id: string;
    promise_text: string;
    kept_at: string;
  }>;
  /** Counts the assistant uses for cadence decisions. */
  counts: {
    open_threads_total: number;
    promises_owed_total: number;
    promises_overdue: number;
    threads_mentioned_today: number;
  };
  /**
   * Source-health view — empty arrays + a `reason` is "user has no
   * continuity state yet", not a failure. Failures surface here.
   */
  source_health: {
    user_open_threads: { ok: boolean; reason?: string };
    assistant_promises: { ok: boolean; reason?: string };
  };
}
