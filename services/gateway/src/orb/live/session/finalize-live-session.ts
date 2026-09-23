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
 *  - commits memory through commitSessionMemory() (Cognee when enabled +
 *    deduplicated fact extraction, forced) — the same helper LiveKit uses;
 *  - writes the voice session summary through recordSessionSummary()
 *    (`memory` routing stage, upsert on user_id + session_id);
 *  - runs at most once per transcript length: the session records how many
 *    turns it last finalized, so a second end path on the same transcript is a
 *    no-op, while a session that gained turns after an earlier finalize (the
 *    Vertex disconnect branch does not tear the session down) is committed
 *    again with the longer transcript.
 *
 * Never throws and never awaits the model call — end paths are teardown code.
 */

import { commitSessionMemory } from '../../../services/session-memory-commit';

export interface FinalizableLiveSession {
  sessionId?: string;
  identity?: { tenant_id?: string | null; user_id?: string | null } | null;
  transcriptTurns: Array<{ role: 'user' | 'assistant'; text: string }>;
  active_role?: string | null;
  createdAt?: Date;
  /** Number of transcript turns covered by the last finalize (VTID-04353). */
  finalizedTurnCount?: number;
}

export type FinalizeSkipReason = 'empty_transcript' | 'already_finalized';

export interface FinalizeLiveSessionResult {
  ran: boolean;
  reason?: FinalizeSkipReason;
  turns: number;
  memory_committed: boolean;
  memory_skip_reason?: string;
  summary_queued: boolean;
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

export function finalizeLiveSession(
  session: FinalizableLiveSession,
  opts: {
    sessionId: string;
    reason: string;
    /** Test seams. */
    recordSummary?: RecordSummaryFn;
    commitMemory?: typeof commitSessionMemory;
    nowMs?: number;
  },
): FinalizeLiveSessionResult {
  const turns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns.length : 0;
  const base = { turns, memory_committed: false, summary_queued: false };

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
  let summaryQueued = false;
  const hasUserTurn = cleanTurns.some((t) => t.role === 'user');
  if (userId && hasUserTurn && isVoiceSessionSummaryEnabled()) {
    const durationMs = session.createdAt
      ? Math.max(0, (opts.nowMs ?? Date.now()) - session.createdAt.getTime())
      : null;
    summaryQueued = true;
    void (opts.recordSummary ?? defaultRecordSummary)({
      user_id: userId,
      session_id: opts.sessionId,
      channel: 'voice',
      transcript_turns: cleanTurns,
      duration_ms: durationMs,
    }).catch((err: unknown) => {
      console.warn(
        `[VTID-04353] voice session summary failed for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  console.log(
    `[VTID-04353] finalized ${opts.sessionId} (${opts.reason}): turns=${turns} memory=${memoryCommitted ? 'committed' : memorySkipReason} summary=${summaryQueued ? 'queued' : 'skipped'}`,
  );

  return {
    ...base,
    ran: true,
    memory_committed: memoryCommitted,
    memory_skip_reason: memorySkipReason,
    summary_queued: summaryQueued,
  };
}
