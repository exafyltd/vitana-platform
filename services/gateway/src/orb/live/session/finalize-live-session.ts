/**
 * VTID-04353 — one finalize step for every ORB live-session end path.
 *
 * Before this, each end path (WS stop frame, WS close, POST /live/session/stop,
 * SSE close, the idle sweep, the Vertex genuine-disconnect branch) carried its
 * own copy of the end-of-session extraction, each with `force: true`, which
 * bypasses the extraction dedup. A clean stop therefore extracted the same
 * transcript twice, a lost stop POST extracted nothing at all, and no live
 * path wrote a session summary — only the legacy POST /end-session did, from
 * a transcript store the live widget never fills.
 *
 * finalizeLiveSession():
 *  - commits memory through commitSessionMemory() (forced fact extraction
 *    plus the memory_items session_summary episode, VTID-04365) — the same
 *    helper LiveKit and the text-session end endpoints use;
 *  - writes the voice session summary through recordSessionSummary()
 *    (`memory` routing stage, upsert on user_id + session_id);
 *  - writes the open threads and promises the session left behind through
 *    recordSessionContinuity() (user_open_threads / assistant_promises);
 *  - emits exactly one `conversation.session.finalized` OASIS event per run,
 *    after the summary and continuity writes settle, with what they produced;
 *  - runs at most once per transcript length: the session records how many
 *    turns it last finalized, so a second end path on the same transcript is a
 *    no-op, while a session that gained turns after an earlier finalize (the
 *    Vertex disconnect branch does not tear the session down) is committed
 *    again with the longer transcript.
 *
 * Never throws and never awaits the model call — end paths are teardown code.
 */

import { commitSessionMemory } from '../../../services/session-memory-commit';
import { contextUpdateSummary, type ContextUpdateStats } from './context-update';
import { isSessionContinuityWriteEnabled } from '../../../services/continuity/session-continuity-writer';

export interface FinalizableLiveSession {
  sessionId?: string;
  identity?: { tenant_id?: string | null; user_id?: string | null } | null;
  transcriptTurns: Array<{ role: 'user' | 'assistant'; text: string }>;
  active_role?: string | null;
  createdAt?: Date;
  /** Number of transcript turns covered by the last finalize (VTID-04353). */
  finalizedTurnCount?: number;
  lang?: string | null;
  clientContext?: { timezone?: string | null } | null;
  /** VTID-04425: mid-session context_update counters, when any arrived. */
  contextUpdateStats?: ContextUpdateStats;
}

type ScheduleRefreshFn = (input: {
  tenantId: string;
  userId: string;
  role?: string | null;
  lang?: string | null;
  timezone?: string | null;
}) => unknown;

async function defaultScheduleRefresh(input: Parameters<ScheduleRefreshFn>[0]): Promise<unknown> {
  const { scheduleSnapshotRefresh } = await import('../../../services/conversation/brain-core-snapshot');
  return scheduleSnapshotRefresh(input);
}

export type FinalizeSkipReason = 'empty_transcript' | 'already_finalized';

export interface FinalizeLiveSessionResult {
  ran: boolean;
  reason?: FinalizeSkipReason;
  turns: number;
  memory_committed: boolean;
  memory_skip_reason?: string;
  summary_queued: boolean;
  continuity_queued: boolean;
  /** Settles after the async writes and the finalized event; tests await it. */
  settled: Promise<FinalizedEventPayload | null>;
}

export interface FinalizedEventPayload {
  session_id: string;
  reason: string;
  turns: number;
  user_turns: number;
  duration_ms: number | null;
  memory_committed: boolean;
  memory_skip_reason?: string;
  summary_written: boolean;
  threads_written: number;
  threads_touched: number;
  promises_written: number;
  /** VTID-04425: context_update counters for this session (absent when none arrived). */
  context_updates?: { received: number; applied: number; route_changes: number; ignored: number };
}

type RecordContinuityFn = (input: {
  tenant_id: string;
  user_id: string;
  session_id: string;
  transcript_turns: Array<{ role: 'user' | 'assistant'; text: string }>;
}) => Promise<{ ok: boolean; threads_written: number; threads_touched: number; promises_written: number }>;

async function defaultRecordContinuity(input: Parameters<RecordContinuityFn>[0]) {
  const { recordSessionContinuity } = await import('../../../services/continuity/session-continuity-writer');
  return recordSessionContinuity(input);
}

type EmitFinalizedFn = (payload: FinalizedEventPayload, actorId: string | null) => Promise<unknown>;

async function defaultEmitFinalized(payload: FinalizedEventPayload, actorId: string | null): Promise<unknown> {
  const { emitOasisEvent } = await import('../../../services/oasis-event-service');
  return emitOasisEvent({
    vtid: 'VTID-04353',
    type: 'conversation.session.finalized',
    source: 'orb-live',
    status: 'info',
    message: `ORB session finalized (${payload.reason})`,
    payload: payload as unknown as Record<string, unknown>,
    actor_id: actorId ?? undefined,
    actor_role: actorId ? 'user' : 'system',
    surface: 'orb',
  });
}

export function isVoiceSessionSummaryEnabled(
  raw: string | undefined = process.env.ORB_VOICE_SESSION_SUMMARY_ENABLED,
): boolean {
  return raw !== 'false';
}

type RecordSummaryFn = (input: {
  user_id: string;
  session_id: string;
  channel: 'voice' | 'text';
  transcript_turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  duration_ms?: number | null;
}) => Promise<unknown>;

async function defaultRecordSummary(input: Parameters<RecordSummaryFn>[0]): Promise<unknown> {
  const { recordSessionSummary } = await import('../../../services/guide/session-summaries');
  return recordSessionSummary(input);
}

/** Start an async write synchronously; a synchronous throw becomes a rejection. */
function startNow<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}

export function finalizeLiveSession(
  session: FinalizableLiveSession,
  opts: {
    sessionId: string;
    reason: string;
    /** Test seams. */
    recordSummary?: RecordSummaryFn;
    recordContinuity?: RecordContinuityFn;
    emitFinalized?: EmitFinalizedFn;
    commitMemory?: typeof commitSessionMemory;
    scheduleRefresh?: ScheduleRefreshFn;
    nowMs?: number;
  },
): FinalizeLiveSessionResult {
  const turns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns.length : 0;
  const base = {
    turns,
    memory_committed: false,
    summary_queued: false,
    continuity_queued: false,
    settled: Promise.resolve(null) as Promise<FinalizedEventPayload | null>,
  };

  if (turns === 0) return { ...base, ran: false, reason: 'empty_transcript' };
  if ((session.finalizedTurnCount ?? 0) >= turns) {
    return { ...base, ran: false, reason: 'already_finalized' };
  }
  // Latch before any async work so a concurrent end path sees it.
  session.finalizedTurnCount = turns;

  const cleanTurns = session.transcriptTurns
    .map((t) => ({
      role: (t.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      text: String(t.text || '').trim(),
    }))
    .filter((t) => t.text.length > 0);
  const transcript = cleanTurns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n');

  const tenantId = session.identity?.tenant_id || '';
  const userId = session.identity?.user_id || '';

  let memoryCommitted = false;
  let memorySkipReason: string | undefined;
  try {
    const commit = (opts.commitMemory ?? commitSessionMemory)({
      transcript,
      tenantId,
      userId,
      sessionId: opts.sessionId,
      activeRole: session.active_role || 'community',
      // VTID-04365 (main): recorded on the memory-system summary.
      channel: 'orb_voice',
      trigger: opts.reason,
    });
    memoryCommitted = commit.committed;
    memorySkipReason = commit.reason;
  } catch (err) {
    memorySkipReason = 'commit_threw';
    console.warn(
      `[VTID-04353] memory commit threw for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A summary needs a real user and at least one thing the user said —
  // a greeting-only session has nothing to summarize.
  const hasUserTurn = cleanTurns.some((t) => t.role === 'user');
  const userTurns = cleanTurns.filter((t) => t.role === 'user').length;
  const durationMs = session.createdAt
    ? Math.max(0, (opts.nowMs ?? Date.now()) - session.createdAt.getTime())
    : null;

  let summaryQueued = false;
  let summaryPromise: Promise<boolean> = Promise.resolve(false);
  if (userId && hasUserTurn && isVoiceSessionSummaryEnabled()) {
    summaryQueued = true;
    summaryPromise = startNow(() =>
      (opts.recordSummary ?? defaultRecordSummary)({
        user_id: userId,
        session_id: opts.sessionId,
        channel: 'voice',
        transcript_turns: cleanTurns,
        duration_ms: durationMs,
      }),
    )
      .then((r: any) => !!(r && (r.success === true || r.success === undefined)))
      .catch((err: unknown) => {
        console.warn(
          `[VTID-04353] voice session summary failed for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      });
  }

  let continuityQueued = false;
  let continuityPromise: Promise<{ threads_written: number; threads_touched: number; promises_written: number }> =
    Promise.resolve({ threads_written: 0, threads_touched: 0, promises_written: 0 });
  if (userId && tenantId && hasUserTurn && isSessionContinuityWriteEnabled()) {
    continuityQueued = true;
    continuityPromise = startNow(() =>
      (opts.recordContinuity ?? defaultRecordContinuity)({
        tenant_id: tenantId,
        user_id: userId,
        session_id: opts.sessionId,
        transcript_turns: cleanTurns,
      }),
    )
      .catch((err: unknown) => {
        console.warn(
          `[VTID-04353] continuity write failed for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { threads_written: 0, threads_touched: 0, promises_written: 0 };
      });
  }

  const settled: Promise<FinalizedEventPayload | null> = Promise.all([summaryPromise, continuityPromise])
    .then(async ([summaryWritten, continuity]) => {
      const payload: FinalizedEventPayload = {
        session_id: opts.sessionId,
        reason: opts.reason,
        turns,
        user_turns: userTurns,
        duration_ms: durationMs,
        memory_committed: memoryCommitted,
        memory_skip_reason: memorySkipReason,
        summary_written: summaryWritten,
        threads_written: continuity.threads_written,
        threads_touched: continuity.threads_touched,
        promises_written: continuity.promises_written,
      };
      const contextUpdates = contextUpdateSummary(session);
      if (contextUpdates) payload.context_updates = contextUpdates;
      try {
        await (opts.emitFinalized ?? defaultEmitFinalized)(payload, userId || null);
      } catch (err) {
        console.warn(
          `[VTID-04353] finalized event failed for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // VTID-04399 (WS-1.2): rebuild the user's core context snapshot a little
      // later, once this session's memory commit has written its facts, so
      // the next session start carries them even when its own build is slow.
      if (userId && tenantId && hasUserTurn) {
        try {
          await (opts.scheduleRefresh ?? defaultScheduleRefresh)({
            tenantId,
            userId,
            role: session.active_role ?? null,
            lang: session.lang ?? null,
            timezone: session.clientContext?.timezone ?? null,
          });
        } catch (err) {
          console.warn(
            `[VTID-04399] snapshot refresh scheduling failed for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return payload;
    })
    .catch(() => null);

  console.log(
    `[VTID-04353] finalized ${opts.sessionId} (${opts.reason}): turns=${turns} memory=${memoryCommitted ? 'committed' : memorySkipReason} summary=${summaryQueued ? 'queued' : 'skipped'} continuity=${continuityQueued ? 'queued' : 'skipped'}`,
  );

  return {
    ...base,
    ran: true,
    memory_committed: memoryCommitted,
    memory_skip_reason: memorySkipReason,
    summary_queued: summaryQueued,
    continuity_queued: continuityQueued,
    settled,
  };
}
