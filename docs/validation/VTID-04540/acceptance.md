# VTID-04540 — typed conversation turns learn facts

Found in the staging end-to-end memory test (2026-09-25, test user, `POST /api/v1/conversation/turn`):
the turn was answered and the raw message was stored in `memory_items`, but no `memory_facts`
row was written. With the brain flag on, `/turn` returns through `processConversationTurn`, which
never called fact extraction; the extraction in `routes/conversation.ts` is unreachable on that path,
and its guard (`MIN_NEW_TURNS: 3`) skipped the first two turns of every thread anyway. The reply
metadata also reported `gemini-2.5-pro` while DeepSeek served the turn.

AC-1: a typed turn runs fact extraction on the first turn of a thread, bypassing the voice throttle.
TEST: services/gateway/test/vtid-04540-typed-turn-fact-extraction.test.ts

AC-2: the canned error reply and an empty message are never extracted from; the helper never throws.
TEST: services/gateway/test/vtid-04540-typed-turn-fact-extraction.test.ts

AC-3: `meta.model_used` reports the provider/model the router served, never a hardcoded label.
TEST: services/gateway/test/vtid-04540-typed-turn-fact-extraction.test.ts

AC-4 (live, after the staging deploy): a typed turn stating facts produces `memory_facts` rows for
the test user, and a new thread recalls them. Recorded in outputs/ after the deploy.
TEST: services/gateway/test/vtid-04540-typed-turn-fact-extraction.test.ts (live evidence in outputs/)

## Follow-up from the Codex review of #3697

AC-5: a forced extraction is not skipped by the 50-char dedup minimum ("I'm vegan" + a short reply is learned); the unforced voice path keeps the minimum.
TEST: services/gateway/test/vtid-04540-dedup-force-short-text.test.ts

AC-6: forced typed-turn extraction runs for typed turns only; a voice transcript routed through the conversation client keeps the voice cadence.
TEST: services/gateway/test/vtid-04540-typed-turn-fact-extraction.test.ts

AC-7: on a tool-assisted turn `meta.model_used` names the call that wrote the reply (`reply_provider` / `reply_model`), not the planning call.
TEST: services/gateway/test/vtid-04540-typed-turn-fact-extraction.test.ts
