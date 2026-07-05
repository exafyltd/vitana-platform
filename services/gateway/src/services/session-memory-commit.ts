/**
 * Session-end memory commit — the SINGLE place a voice conversation is turned
 * into durable memory (extraction → memory_facts / memory_items /
 * relationship_nodes).
 *
 * Both voice transports MUST route here so extraction can never fork again:
 *   - Vertex (orb-live.ts / live-session-controller) calls it inline at session
 *     stop (it already holds the transcript).
 *   - LiveKit (services/agents/orb-agent) has the transcript in the agent
 *     process, so it POSTs it to `POST /api/v1/orb/session/commit-memory`
 *     (orb-livekit.ts) on teardown, which calls this function.
 *
 * Before this existed, the LiveKit agent's teardown extracted NOTHING — every
 * LiveKit conversation was heard and thrown away, so cross-session memory never
 * accumulated on the pipeline real users are on. See
 * docs/CONVERSATION_FLOW_ARCHITECTURE.md §11.
 */

import { cogneeExtractorClient } from './cognee-extractor-client';
import { deduplicatedExtract } from './extraction-dedup-manager';

/** Minimum transcript length (chars) worth extracting from. Mirrors the Vertex
 *  session-stop guard so both transports behave identically. */
export const MIN_COMMIT_TRANSCRIPT_CHARS = 50;

export interface CommitSessionMemoryArgs {
  transcript: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  activeRole?: string | null;
}

export interface CommitSessionMemoryResult {
  /** True when at least the deduplicated extractor was fired. */
  committed: boolean;
  /** True when the Cognee extractor was also queued (it is gated by a flag). */
  cognee_queued: boolean;
  reason?: string;
}

/**
 * Fire-and-forget the session-end extraction (Cognee + deduplicated inline
 * facts). Never throws — extraction failures must never block the session-stop
 * path. Returns what was fired so callers can record telemetry.
 */
export function commitSessionMemory(args: CommitSessionMemoryArgs): CommitSessionMemoryResult {
  const transcript = (args.transcript || '').trim();
  if (transcript.length <= MIN_COMMIT_TRANSCRIPT_CHARS) {
    return { committed: false, cognee_queued: false, reason: 'transcript_too_short' };
  }
  if (!args.tenantId || !args.userId) {
    return { committed: false, cognee_queued: false, reason: 'missing_identity' };
  }

  let cogneeQueued = false;
  try {
    if (cogneeExtractorClient.isEnabled()) {
      cogneeExtractorClient.extractAsync({
        transcript,
        tenant_id: args.tenantId,
        user_id: args.userId,
        session_id: args.sessionId,
        active_role: args.activeRole || 'community',
      });
      cogneeQueued = true;
    }
  } catch (err) {
    console.warn(
      `[session-memory-commit] cognee extractAsync threw (non-fatal) for ${args.userId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // VTID-01230: deduplicated inline-fact extraction (force on session end).
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

  return { committed: true, cognee_queued: cogneeQueued };
}
