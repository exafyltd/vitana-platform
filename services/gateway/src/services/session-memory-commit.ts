/**
 * Session-end memory commit — the SINGLE place a conversation is turned into
 * durable memory when it ends.
 *
 * VTID-04365 (defect D7): session end used to be handled in about ten places
 * (SSE stop, WS cleanup, the upstream close handler, the SSE stream close,
 * /end-session, /session/finalize, LiveKit's /session/commit-memory), each
 * calling the fact extractor on its own with slightly different guards, and
 * none of them left a record of what the session was about. Every one of them
 * now calls commitSessionMemory(), which does exactly two things:
 *
 *   1. facts — deduplicatedExtract({ force: true }) into memory_facts
 *      (through the shared rememberFact() write path, VTID-04364);
 *   2. one session-summary episode in memory_items
 *      (category_key 'session_summary'), written by the `memory` LLM stage.
 *      This is what the next session's greeting and recall read, so a user is
 *      met with "last time we talked about…" instead of a blank slate.
 *
 * Idempotent per session: an in-process guard stops a second commit from the
 * same instance, and the partial unique index uq_memory_items_session_summary
 * stops a second summary across instances (the losing insert is reported as
 * already committed, not as an error).
 *
 * Never throws and never awaits on the caller's path: the session-stop path
 * must not wait on an LLM call.
 */

import { deduplicatedExtract } from './extraction-dedup-manager';
import { callViaRouter } from './llm-router';
import { writeMemoryItemWithIdentity } from './orb-memory-bridge';
import { emitOasisEvent } from './oasis-event-service';

/** Minimum transcript length (chars) worth extracting facts from. */
export const MIN_COMMIT_TRANSCRIPT_CHARS = 50;
/** Minimum transcript length (chars) worth summarising. */
export const MIN_SUMMARY_TRANSCRIPT_CHARS = 200;
/** Minimum number of user turns worth summarising. */
export const MIN_SUMMARY_USER_TURNS = 2;
/** The summary prompt sees at most this much of the transcript (the tail). */
export const MAX_SUMMARY_INPUT_CHARS = 12_000;
/** A summary longer than this is truncated before it is stored. */
export const MAX_SUMMARY_CHARS = 800;

export type SessionChannel = 'orb_voice' | 'orb_text' | 'livekit' | 'operator' | string;

export interface CommitSessionMemoryArgs {
  transcript: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  activeRole?: string | null;
  /** Which surface the session ran on; recorded on the summary. */
  channel?: SessionChannel;
  /** Which code path ended the session; for telemetry only. */
  trigger?: string;
}

export interface CommitSessionMemoryResult {
  /** True when the commit was started (facts and, if eligible, a summary). */
  committed: boolean;
  /** True when a summary was queued for this session. */
  summary_queued?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// In-process idempotency
// ---------------------------------------------------------------------------

const COMMITTED_TTL_MS = 6 * 3600 * 1000;
const COMMITTED_MAX = 5000;
const committed = new Map<string, number>();

function markCommitted(sessionId: string): boolean {
  const now = Date.now();
  const at = committed.get(sessionId);
  if (at !== undefined && now - at < COMMITTED_TTL_MS) return false;
  committed.set(sessionId, now);
  if (committed.size > COMMITTED_MAX) {
    // Maps iterate in insertion order: drop the oldest entries.
    for (const key of committed.keys()) {
      committed.delete(key);
      if (committed.size <= COMMITTED_MAX) break;
    }
  }
  return true;
}

/** Test hook. */
export function resetSessionCommitState(): void {
  committed.clear();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export const SESSION_SUMMARY_SYSTEM_PROMPT = [
  'You write a short memory note about a conversation between a user and Vitana, a health and longevity assistant.',
  'Write 2 to 4 sentences about the user, in the third person ("The user ...").',
  'Keep only what is worth remembering next time: topics the user raised, how they felt, decisions, plans, and anything left open to follow up.',
  'Leave out greetings, small talk and what the assistant said unless the user agreed to it.',
  'Never invent anything that is not in the transcript.',
  'Write in the language the user spoke.',
  'If nothing is worth remembering, reply with exactly: NONE',
].join(' ');

export function countUserTurns(transcript: string): number {
  return (transcript.match(/^User:/gm) || []).length;
}

export function isSummaryEligible(transcript: string): boolean {
  return transcript.length >= MIN_SUMMARY_TRANSCRIPT_CHARS && countUserTurns(transcript) >= MIN_SUMMARY_USER_TURNS;
}

/** Normalise the model's reply; null when there is nothing to store. */
export function cleanSummary(text: string | undefined | null): string | null {
  const t = (text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (!t || /^none\.?$/i.test(t)) return null;
  return t.length > MAX_SUMMARY_CHARS ? `${t.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : t;
}

async function writeSessionSummary(args: CommitSessionMemoryArgs, transcript: string): Promise<void> {
  const input = transcript.length > MAX_SUMMARY_INPUT_CHARS
    ? transcript.slice(transcript.length - MAX_SUMMARY_INPUT_CHARS)
    : transcript;
  const r = await callViaRouter('memory', input, {
    service: 'session-memory-commit',
    systemPrompt: SESSION_SUMMARY_SYSTEM_PROMPT,
    maxTokens: 300,
  });
  if (!r.ok) {
    console.warn(`[VTID-04365] session summary failed for ${args.sessionId}: ${r.error ?? 'no text'}`);
    return;
  }
  const summary = cleanSummary(r.text);
  if (!summary) return;

  const written = await writeMemoryItemWithIdentity(
    { tenant_id: args.tenantId, user_id: args.userId, active_role: args.activeRole ?? null },
    {
      source: 'system',
      content: summary,
      category_key: 'session_summary',
      // <= 50: trg_notify_memory_garden notifies above 50; a summary per
      // session must not become a notification per session.
      importance: 50,
      skipFiltering: true,
      content_json: {
        kind: 'session_summary',
        session_id: args.sessionId,
        channel: args.channel ?? null,
        user_turns: countUserTurns(transcript),
        summary_provider: r.provider ?? null,
      },
    },
  );
  if (!written.ok) {
    if (/duplicate key|23505/i.test(written.error || '')) return; // another instance won
    console.warn(`[VTID-04365] session summary write failed for ${args.sessionId}: ${written.error}`);
    return;
  }
  void emitOasisEvent({
    vtid: 'VTID-04365',
    type: 'memory.session.summarized' as any,
    source: 'session-memory-commit',
    status: 'success',
    message: 'Session summary written',
    payload: {
      tenant_id: args.tenantId,
      user_id: args.userId,
      session_id: args.sessionId,
      channel: args.channel ?? null,
      trigger: args.trigger ?? null,
      memory_item_id: written.id ?? null,
      summary_chars: summary.length,
      provider: r.provider ?? null,
    },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Commit a finished session to memory. Fire-and-forget; returns what was
 * started so callers can record telemetry.
 */
export function commitSessionMemory(args: CommitSessionMemoryArgs): CommitSessionMemoryResult {
  const transcript = (args.transcript || '').trim();
  if (transcript.length <= MIN_COMMIT_TRANSCRIPT_CHARS) {
    return { committed: false, reason: 'transcript_too_short' };
  }
  if (!args.tenantId || !args.userId) {
    return { committed: false, reason: 'missing_identity' };
  }
  if (!args.sessionId) {
    return { committed: false, reason: 'missing_session_id' };
  }
  if (!markCommitted(args.sessionId)) {
    return { committed: false, reason: 'already_committed' };
  }

  try {
    deduplicatedExtract({
      conversationText: transcript,
      tenant_id: args.tenantId,
      user_id: args.userId,
      session_id: args.sessionId,
      force: true,
    });
  } catch (err) {
    console.warn(
      `[session-memory-commit] deduplicatedExtract threw (non-fatal) for ${args.userId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const summaryQueued = isSummaryEligible(transcript);
  if (summaryQueued) {
    void writeSessionSummary(args, transcript).catch((err) => {
      console.warn(`[VTID-04365] session summary error for ${args.sessionId}: ${err?.message ?? err}`);
    });
  }

  return { committed: true, summary_queued: summaryQueued };
}

/** Render transcript turns in the "User:/Assistant:" shape the commit reads. */
export function renderTranscript(turns: Array<{ role: string; text: string }>): string {
  return turns
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n');
}
