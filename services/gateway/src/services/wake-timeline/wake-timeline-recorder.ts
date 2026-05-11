/**
 * VTID-02917 (B0d.3) — Wake timeline recorder.
 *
 * Records events into an in-memory queue per session and flushes to
 * `orb_wake_timelines` on session-end (or on demand). Reads serve from
 * memory first, then DB.
 *
 * Design choices:
 *   - PER-SESSION ROW. The events JSONB column is mutated in place at
 *     session-end with the full event array + computed aggregates. We
 *     do NOT write per-event rows — the Apr 2026 disk-IO crisis lesson
 *     applies: chatty writes dominate cost, retention is harder.
 *   - IN-MEMORY FIRST. Active sessions live in a `Map<sessionId, …>`.
 *     The read API merges in-memory state + DB row so an in-flight
 *     session is visible sub-second.
 *   - BEST-EFFORT PERSISTENCE. A crash before flush loses the
 *     in-memory tail; that is acceptable for a debugging tool. We do
 *     NOT block the wake path on DB writes.
 *   - SUPABASE OPTIONAL. If `getSupabase()` returns null, the recorder
 *     still works in memory (tests + offline dev) — only the DB
 *     persistence + cross-process visibility degrades.
 */

import { getSupabase } from '../../lib/supabase';
import {
  isWakeTimelineEventName,
  type WakeTimelineEvent,
  type WakeTimelineEventName,
  type WakeTimelineRow,
  type WakeTransport,
} from './timeline-events';
import { aggregateTimeline } from './aggregate-timeline';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string;
  tenantId: string | null;
  userId: string | null;
  surface: string;
  transport: WakeTransport;
  startedAt: string;
  startedAtMs: number;
  endedAt: string | null;
  events: WakeTimelineEvent[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Recorder API
// ---------------------------------------------------------------------------

export interface RecordEventArgs {
  sessionId: string;
  name: WakeTimelineEventName;
  metadata?: Record<string, unknown>;
  /** ISO 8601; defaults to now. Injection point for tests. */
  at?: string;
}

export interface StartSessionArgs {
  sessionId: string;
  tenantId?: string | null;
  userId?: string | null;
  surface?: string;
  transport?: WakeTransport;
  /** ISO 8601; defaults to now. */
  startedAt?: string;
}

export interface WakeTimelineRecorder {
  /** Create an in-memory session row. Idempotent: re-calls update. */
  startSession(args: StartSessionArgs): void;
  /** Append one event. Skips silently if session is unknown — see policy below. */
  recordEvent(args: RecordEventArgs): void;
  /** Mark session ended + compute aggregates + flush. Idempotent. */
  endSession(sessionId: string, endedAt?: string): Promise<void>;
  /** Get the current timeline for one session (in-memory ⊕ DB). */
  getTimeline(sessionId: string): Promise<WakeTimelineRow | null>;
  /** List recent timelines (most-recent-first). Used by the Command Hub panel. */
  listRecent(opts?: { userId?: string; tenantId?: string; limit?: number }): Promise<WakeTimelineRow[]>;
  /** Clear in-memory state for tests. */
  reset(): void;
}

export interface RecorderOptions {
  /** Injected for tests. Defaults to wall-clock now. */
  now?: () => Date;
  /** Override the supabase getter (tests). */
  getDb?: typeof getSupabase;
}

export function createWakeTimelineRecorder(
  opts: RecorderOptions = {},
): WakeTimelineRecorder {
  const sessions = new Map<string, SessionState>();
  const now = opts.now ?? (() => new Date());
  const getDb = opts.getDb ?? getSupabase;

  /**
   * Auto-start policy: if `recordEvent` is called before `startSession`,
   * we auto-create the session row using the event's timestamp as
   * `startedAt`. This makes orb-live.ts instrumentation safe: not every
   * call site needs to remember to call startSession first.
   */
  function ensureSession(sessionId: string, atIso: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const startedAtMs = Date.parse(atIso);
    const state: SessionState = {
      sessionId,
      tenantId: null,
      userId: null,
      surface: 'orb_wake',
      transport: null,
      startedAt: atIso,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
      endedAt: null,
      events: [],
      updatedAt: atIso,
    };
    sessions.set(sessionId, state);
    return state;
  }

  return {
    startSession(args) {
      const startedAt = args.startedAt ?? now().toISOString();
      const startedAtMs = Date.parse(startedAt);
      const existing = sessions.get(args.sessionId);
      if (existing) {
        // Re-call: update identity / transport but preserve event history.
        if (args.tenantId !== undefined) existing.tenantId = args.tenantId;
        if (args.userId !== undefined) existing.userId = args.userId;
        if (args.surface !== undefined) existing.surface = args.surface;
        if (args.transport !== undefined) existing.transport = args.transport;
        existing.updatedAt = startedAt;
        return;
      }
      sessions.set(args.sessionId, {
        sessionId: args.sessionId,
        tenantId: args.tenantId ?? null,
        userId: args.userId ?? null,
        surface: args.surface ?? 'orb_wake',
        transport: args.transport ?? null,
        startedAt,
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
        endedAt: null,
        events: [],
        updatedAt: startedAt,
      });
    },

    recordEvent(args) {
      if (!isWakeTimelineEventName(args.name)) {
        // Should not happen with TS types; defensive against JS callers.
        return;
      }
      const atIso = args.at ?? now().toISOString();
      const state = ensureSession(args.sessionId, atIso);
      const atMs = Date.parse(atIso);
      const tSessionMs = Number.isFinite(atMs)
        ? Math.max(0, atMs - state.startedAtMs)
        : 0;
      const event: WakeTimelineEvent = {
        name: args.name,
        at: atIso,
        tSessionMs,
      };
      if (args.metadata && typeof args.metadata === 'object') {
        event.metadata = args.metadata;
      }
      state.events.push(event);
      state.updatedAt = atIso;
    },

    async endSession(sessionId, endedAt) {
      const state = sessions.get(sessionId);
      if (!state) return;
      const finalEndedAt = endedAt ?? now().toISOString();
      state.endedAt = finalEndedAt;
      state.updatedAt = finalEndedAt;

      const aggregates = aggregateTimeline({
        events: state.events,
        startedAt: state.startedAt,
        transport: state.transport,
      });

      // Best-effort DB persistence.
      const sb = getDb();
      if (sb) {
        try {
          await sb.from('orb_wake_timelines').upsert(
            {
              session_id: state.sessionId,
              tenant_id: state.tenantId,
              user_id: state.userId,
              surface: state.surface,
              events: state.events,
              aggregates,
              transport: state.transport,
              started_at: state.startedAt,
              ended_at: state.endedAt,
            },
            { onConflict: 'session_id' },
          );
        } catch {
          // Swallow — debugging tool must not break the wake path.
        }
      }
    },

    async getTimeline(sessionId) {
      const state = sessions.get(sessionId);
      if (state) {
        return stateToRow(state);
      }
      const sb = getDb();
      if (!sb) return null;
      const { data, error } = await sb
        .from('orb_wake_timelines')
        .select('*')
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error || !data) return null;
      return rowFromDb(data);
    },

    async listRecent(listOpts = {}) {
      const limit = Math.max(1, Math.min(100, listOpts.limit ?? 20));
      const fromMemory: WakeTimelineRow[] = [];
      for (const state of sessions.values()) {
        if (listOpts.userId && state.userId !== listOpts.userId) continue;
        if (listOpts.tenantId && state.tenantId !== listOpts.tenantId) continue;
        fromMemory.push(stateToRow(state));
      }
      fromMemory.sort((a, b) => b.started_at.localeCompare(a.started_at));

      const sb = getDb();
      const fromDb: WakeTimelineRow[] = [];
      if (sb) {
        try {
          let q = sb
            .from('orb_wake_timelines')
            .select('*')
            .order('started_at', { ascending: false })
            .limit(limit);
          if (listOpts.userId) q = q.eq('user_id', listOpts.userId);
          if (listOpts.tenantId) q = q.eq('tenant_id', listOpts.tenantId);
          const { data } = await q;
          if (Array.isArray(data)) {
            for (const r of data) fromDb.push(rowFromDb(r));
          }
        } catch {
          // ignore DB errors — return what we have in-memory.
        }
      }

      // Dedupe by session_id, prefer in-memory (most recent state).
      const byId = new Map<string, WakeTimelineRow>();
      for (const r of fromDb) byId.set(r.session_id, r);
      for (const r of fromMemory) byId.set(r.session_id, r);
      return Array.from(byId.values())
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, limit);
    },

    reset() {
      sessions.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton — production callers use this.
// Tests prefer `createWakeTimelineRecorder()` for isolation.
// ---------------------------------------------------------------------------

export const defaultWakeTimelineRecorder: WakeTimelineRecorder =
  createWakeTimelineRecorder();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateToRow(state: SessionState): WakeTimelineRow {
  const aggregates = state.endedAt
    ? aggregateTimeline({
        events: state.events,
        startedAt: state.startedAt,
        transport: state.transport,
      })
    : aggregateTimeline({
        events: state.events,
        startedAt: state.startedAt,
        transport: state.transport,
      });
  return {
    session_id: state.sessionId,
    tenant_id: state.tenantId,
    user_id: state.userId,
    surface: state.surface,
    events: [...state.events],
    aggregates,
    transport: state.transport,
    started_at: state.startedAt,
    ended_at: state.endedAt,
    updated_at: state.updatedAt,
  };
}

function rowFromDb(data: Record<string, unknown>): WakeTimelineRow {
  return {
    session_id: String(data.session_id ?? ''),
    tenant_id: (data.tenant_id as string | null) ?? null,
    user_id: (data.user_id as string | null) ?? null,
    surface: String(data.surface ?? 'orb_wake'),
    events: Array.isArray(data.events) ? (data.events as WakeTimelineEvent[]) : [],
    aggregates:
      data.aggregates && typeof data.aggregates === 'object'
        ? (data.aggregates as WakeTimelineRow['aggregates'])
        : null,
    transport: (data.transport as WakeTransport) ?? null,
    started_at: String(data.started_at ?? ''),
    ended_at: (data.ended_at as string | null) ?? null,
    updated_at: String(data.updated_at ?? data.started_at ?? ''),
  };
}
