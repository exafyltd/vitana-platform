# VTID-04575 — a reopened voice conversation continues its thread

## Owner ask (2026-09-25)

> "when you reopen a session, Nova's content filter can block the first
> attempt. when retry then continuing where you left off."

## Evidence (read-only, `oasis_events`, last 7–14 days)

### Block rate on the first attempt

| Session kind | Production | Staging |
|---|---|---|
| Reopen carrying `transcript_history` | 23 / 28 (82%) | 5 / 5 |
| Fresh session | 1 / 153 (0.7%) | 2 / 337 |

### What the blocked attempt sent

Instruction dumps were compared for a blocked attempt and its retry
(`live-b95379be`).

- The system instructions barely differ. The blocked one is actually shorter
  (31,498 vs 32,328 bytes).
- The difference is the first message: a reopen (`resumedFromHistory`) was
  routed to `sendReconnectRecoveryPromptToLiveAPI`.
  - That function sends a long user-role prompt: "You are recovering from a
    brief connection blip…", `RECONNECT_STAGE`, and a stack of "Do NOT…"
    rules.
  - This is the injection-like shape Nova's guardrail reacts to (VTID-03797,
    VTID-04124).
- Its diag reports `stage` equal to the reconnect stage, which is why these
  events appear as `idle` in the logs.

### Recovery prompt outcomes (14 days)

- idle: 41 of 58 blocked.
- thinking / speaking / listening_user_speaking: 3 of 3 blocked.

### Retry outcomes

After a block, the zero-turn retry goes through the greeting ladder:

- 44 of 44 retried.
- 1 was blocked again.
- 38 spoke.

## Fix

- **Routing.**
  - A session the client restarted with the conversation's earlier turns,
    at zero turns and with no backend reconnect (predicate
    `shouldOpenReopenThroughGreetingLadder`), now opens through the greeting
    ladder instead of the recovery prompt.
  - A backend transparent reconnect (`_reconnectCount > 0`) keeps the
    recovery prompt.
- **Reopen flag in the greeting sender.**
  - `sendGreetingPromptToLiveAPI` marks the reopen as sticky for the
    session, so the retry after a block still continues the thread. It
    covers both SSE and WebSocket.
  - It also sets the one-shot that the proven zero-turn retry uses, so the
    reopen speaks instead of taking a silence rung.
- **New `resume_thread` rung.**
  - It is on both ladders, below support-report and guided-topic (both
    explicit member asks) and above day-close, briefings, resume-NBA and the
    wake-brief lead.
  - The directive is a positive English intent: continue the conversation
    from its history, name the topic, answer a still-open question or offer
    the next step and ask whether to go ahead.
  - It has no quoted sentence and no prohibition stack. The model composes
    the words (NEVER-rule 41).
- Since VTID-04534 is live, the earlier turns fit in the instruction budget.
  Staging and production diags show nothing trimmed.

## Acceptance criteria

AC-1: A reopen with history at zero turns opens through the greeting ladder, not the recovery prompt, on SSE and WS; a backend reconnect, a later turn or a fresh session does not.
TEST: services/gateway/test/services/conversation/vtid-04575-resume-thread-rung.test.ts

AC-2: On both ladders the resume_thread rung wins for a reopen, outranking day-close and the wake-brief lead, and yields to support-report and a tapped guided topic; never for anonymous sessions.
TEST: services/gateway/test/services/conversation/vtid-04575-resume-thread-rung.test.ts

AC-3: The resume_thread directive is a positive intent: no quoted sentence, no recitation wording, no prohibition words, no connection/reconnect framing.
TEST: services/gateway/test/services/conversation/vtid-04575-resume-thread-rung.test.ts

AC-4: The reopen flag is sticky for the session so the retry after a Nova block continues the thread too.
TEST: services/gateway/test/services/conversation/vtid-04575-resume-thread-rung.test.ts

## Mutation check

Forcing `shouldOpenReopenThroughGreetingLadder` to return false fails the
routing test.

## Not verified here

- This has not been tried in a live voice session. Success on staging would
  look like this:
  - a reopened session logs `greeting_sent` with `wake_opener: resume_thread`;
  - there is no `upstream_error` with "content filters" at turn 0;
  - the first reply continues the earlier topic.
- The expected block rate for reopens is the retry path's measured 1 in 44.
  It is not zero.
