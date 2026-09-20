# VTID-04196 — Cap operator chat message length at the input boundary

## Report

Found while investigating recurring executor failures during a batch of
Operator Console improvement tasks: `OperatorChatMessageSchema.message`
(`services/gateway/src/types/operator-chat.ts`, shared by both
`POST /api/v1/operator/chat` and `POST /api/v1/operator/chat/stream` via
`runOperatorChatTurn`) had `z.string().min(1, ...)` with **no upper bound**.

`services/gateway/src/services/operator-threads.ts` already has a
`clipMessage()` helper and a `MESSAGE_MAX_CHARS = 6_000` constant — but it
is only applied when the message is **persisted** to `operator_messages`
(`appendThreadMessages`, `input.userText` → `clipMessage(input.userText)`),
*after* the full, unbounded text has already been sent to the LLM via
`processWithGemini`/`callViaRouter`. Two real consequences: (1) an
arbitrarily large message reaches the model with no protection at the one
place it actually costs money/quality, and (2) the persisted copy can
silently diverge from what was truly sent, since only storage clips it.

## Fix

Reused the existing `MESSAGE_MAX_CHARS` constant (not a new, second
constant for the same concept — this codebase has been burned before by
diverged copies of the same value, e.g. VTID-03644) as a `.max()` bound
on the Zod schema's `message` field. A message at or under the cap is
unaffected; over the cap, the request is rejected with a 400 *before*
`processWithGemini` is ever called, on both routes, since both share the
same `OperatorChatMessageSchema.safeParse` validation in
`runOperatorChatTurn`.

## Acceptance Criteria

AC-1 — `OperatorChatMessageSchema` accepts a message of exactly
`MESSAGE_MAX_CHARS` and rejects one character over it; `min(1)` (empty
message rejection) is unchanged.
TEST: services/gateway/test/vtid-04196-operator-chat-message-cap.test.ts

AC-2 — `POST /api/v1/operator/chat` and `POST /api/v1/operator/chat/stream`
both reject an over-cap message with a 400 and never call
`processWithGemini` (proven against the real mounted app with the model
call mocked — a call would fail the test).
TEST: services/gateway/test/vtid-04196-operator-chat-message-cap.test.ts

AC-3 — The cap reuses `operator-threads.ts`'s existing `MESSAGE_MAX_CHARS`
rather than introducing a second constant.
TEST: services/gateway/test/vtid-04196-operator-chat-message-cap.test.ts
("the cap is exactly operator-threads.ts's own MESSAGE_MAX_CHARS")

## Verification

- `tsc --noEmit` (services/gateway): clean, zero output.
- New suite: 8/8 tests passing.
- Regression sweep, every test file referencing operator chat /
  `OperatorChatMessageSchema` / the on-ramp: 20 suites / 255 tests, 0
  failures, 0 regressions (full list in commands.log).
- No import cycle introduced: `operator-threads.ts` imports only
  `./llm-router`, which does not import `types/operator-chat.ts`.

## Not done / explicitly out of scope

- `context[].content` (the optional prior-turn array on the same schema)
  is not capped by this change — it is a separate field with its own
  existing size discipline further down the pipeline
  (`operator-turn-memory.ts`'s `TRANSCRIPT_MAX_CHARS`), and capping it
  was not part of the observed gap (an oversized top-level `message`).
- No live/staging verification — this ships as a validation-boundary
  change with no flag; the next real signal is CI on the opened PR.
