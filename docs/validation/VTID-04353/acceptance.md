# VTID-04353 — Conversation rebuild WS-0.4: one finalize step for every ORB session end path

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.4.
Ships in PR #3614 as a companion to VTID-04339 (one VTID per PR gate;
VTID-04246 precedent).

## What was wrong (read from the code, file:line on the pre-change tree)

- **No live voice session wrote a session summary.** `recordSessionSummary`
  was only reached from the legacy `POST /end-session`, which reads the
  `orbTranscripts` map filled by the old `/chat` and `/session/append` routes —
  never by a live WebSocket/SSE turn. The next session's "since we last spoke"
  context therefore had nothing from voice.
- **End-of-session memory extraction was copy-pasted across end paths, each
  with `force: true`** (which bypasses the extraction dedup):
  - WS socket cleanup (controller `cleanupWsSession`)
  - `POST /live/session/stop` (controller `handleLiveSessionStop`)
  - SSE `req.on('close')` on `/live/stream`
  - Vertex genuine upstream disconnect
- **Resulting double and missing work:**
  - A clean SSE stop raced the close handler against the stop POST and extracted twice.
  - A Vertex disconnect followed by the client stop extracted twice.
  - The WS stop frame nulled `clientSession.liveSession`, so the socket
    cleanup never saw the transcript; memory then depended on a fire-and-forget POST.
  - When that POST was lost, the idle sweep reaped the session with no extraction at all.

## Fix

New `orb/live/session/finalize-live-session.ts` — `finalizeLiveSession(session, {sessionId, reason})`:
- **Memory:** commits through the existing `commitSessionMemory()`, the same helper
  LiveKit already used (Cognee when enabled, plus deduplicated extraction, forced).
- **Summary:** writes the voice summary through the existing `recordSessionSummary()`
  (`memory` routing stage, upsert on user_id + session_id).
  - Only for a real user and at least one user turn.
  - `ORB_VOICE_SESSION_SUMMARY_ENABLED=false` turns the summary off; the memory commit stays on.
- **Idempotency:** the session records `finalizedTurnCount`.
  - Same transcript again: no-op.
  - More turns since the last finalize (the Vertex disconnect branch keeps the
    session alive): runs again on the longer transcript. The summary upsert
    updates the same row.
- **Never throws and never awaits the model call.**

### Added after the first review against Plan v1

Plan v1 WS-0.4 also asks for open threads and promises, and for one
`conversation.session.finalized` event. Both were missing from the first commit:

- **Open threads and promises.** `user_open_threads` and `assistant_promises`
  (VTID-02932) are read by the continuity compiler on every session start, but
  nothing in the codebase wrote either table. New
  `services/continuity/session-continuity-writer.ts`:
  - One `memory`-stage call returns JSON with at most 3 open threads and 3
    promises. Routing decides the provider, which is never named in code.
  - The reply is parsed tolerantly, clamped, and deduplicated by normalized topic.
  - A topic the user already has open is touched (`session_id_last`,
    `last_mentioned_at`, summary) rather than duplicated.
  - Promises are inserted as `owed`, with any spoken time hint kept in the text
    rather than guessed into a timestamp.
  - Never throws.
  - `ORB_SESSION_CONTINUITY_WRITE_ENABLED=false` turns off only this write.
- **`conversation.session.finalized`.** Exactly one event per finalize run,
  emitted after the summary and continuity writes settle. It carries turns,
  user turns, duration, `memory_committed`, `summary_written`, and the thread
  and promise counts. A skipped finalize (empty or already finalized) emits
  nothing. `finalizeLiveSession()` returns a `settled` promise so tests can
  observe the event; the end paths never await it.

Wired into: WS stop frame, WS socket cleanup, `POST /live/session/stop`
(transcript branch; the `memory_items` fallback for an empty transcript is
unchanged), SSE close, the idle sweep, the Vertex genuine disconnect.
`POST /end-session`, `/session/finalize` and the LiveKit commit route are unchanged.

## Deliberately not changed here

- **Duplicate `vtid.live.session.stop` events.** The WS stop frame emits under
  the socket id and `/live/session/stop` under the live id, and the idle sweep
  ignores the latch.
  - `fetchLastSessionInfo` reads these events, so changing them moves the next
    session's greeting.
  - This needs its own VTID with a before/after check of the greeting ledger.
- **Per-turn unforced extraction** (the last 4 turns) is untouched.

## Behaviour notes

- **Short transcripts:** the WS-cleanup and SSE-close paths used to extract
  regardless of length. They now follow `commitSessionMemory`'s 50-character
  minimum, the rule `/live/session/stop` already applied.
- **Cognee on WS/SSE:** those paths also reach Cognee when it is enabled. It is
  off by default (`cognee_extraction_enabled`).
- **New LLM call:** one `memory`-stage call per finished voice session with a
  user turn (Bedrock, per policy v17). Before this there were none for live voice.

## Acceptance criteria

AC-1: A finished session commits memory once and queues one voice summary with the full transcript.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts

AC-2: A second end path on the same transcript does nothing; a longer transcript runs again.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts

AC-3: Empty, greeting-only and anonymous sessions write no summary; the kill switch disables only the summary.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts

AC-4: A throwing commit or a rejecting summary never propagates.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts

AC-5: All six end paths call finalizeLiveSession; the controller no longer carries its own forced transcript extraction.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts

AC-7: A finalized session writes its open threads and promises and emits exactly one `conversation.session.finalized` event reporting what was written; failures are reported as false/0, never thrown; the continuity kill switch turns off only that write.
TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts

AC-8: The continuity writer parses the model reply tolerantly, dedupes topics, touches an existing open thread instead of duplicating it, inserts promises as owed, and refuses (without a model call) when identity, a user turn or storage is missing.
TEST: services/gateway/test/services/continuity/vtid-04353-session-continuity-writer.test.ts

AC-6 (post-deploy, staging): after a real voice session ends on staging, a `user_session_summaries` row with `channel='voice'` and the live session id exists, and the gateway log shows exactly one `[VTID-04353] finalized` line with `ran` for that session; one `conversation.session.finalized` OASIS event exists for it.
UI: staging voice session by the owner (this session does not write as the test account — CLAUDE.md rule 31).
