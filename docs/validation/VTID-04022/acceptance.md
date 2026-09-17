# VTID-04022 — W4b: server-side Operator Console threads + rolling summaries (gap analysis §4.3)

Context: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §4.3 — the console's transcript lives in the browser (`localStorage`, VTID-03822) and its `dev_agent_memory` recall (VTID-03892) runs against the raw current message only, so a turn like "now rebuild the image" retrieves nothing about the thread it belongs to. This VTID gives every `/api/v1/operator/chat` turn a server-side record, every thread a rolling summary, and the recall a query built from summary + current message.

What ships: migration `supabase/migrations/20260917230000_vtid_04022_operator_threads.sql` (`operator_threads`, `operator_messages`, indexes, service-role-only RLS — **shipped as a file, NOT applied**); `services/gateway/src/services/operator-threads.ts` (`recordOperatorTurn`, `getThreadSummary`, `maybeSummarizeThread`, `buildRecallQuery` + pure helpers); wiring in `routes/operator.ts` (summary read before the model call; fire-and-forget record + summarise after) and `gemini-operator.ts` (`processWithGemini` gains `threadSummary`; recall query = `buildRecallQuery(threadSummary, text)`). Gated on `OPERATOR_THREADS_ENABLED=true` (default off, not pinned on any deploy workflow yet). Summaries go through `callViaRouter('memory', …)` — the routing policy's own provider order (Bedrock primary / DeepSeek fallback), never Google.

AC-1 — `buildRecallQuery` returns the raw message when there is no summary and `Conversation so far: <summary>\n\nCurrent message: <text>` (summary bounded) otherwise; `shouldSummarize` fires only on the cadence and only past the last summarised turn; `summaryEvery` reads the env with a floor of 2 and the documented default; the kill switch is the exact string `true`; `deriveThreadTitle`/`clipMessage` bound their output; `buildSummaryPrompt` is English model instruction carrying the prior summary and a flattened transcript.
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts

AC-2 — `recordOperatorTurn` creates the thread on the first turn (id, user, role, derived title, turns=1), appends user + tool + assistant messages with the turn's meta, and increments `turns` on the next turn (one POST, then PATCH).
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts

AC-3 — Fail-open: with the kill switch off nothing is fetched and every function returns its no-op value; with the tables absent (PostgREST 404/PGRST205) the module warns once naming the migration and returns `recorded:false`; a rejecting `fetch` never throws.
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts

AC-4 — `getThreadSummary` returns the stored summary and `null` for blank/absent; `maybeSummarizeThread` rewrites the summary on the cadence from the recent messages + prior summary via the injected summariser, records `summary_turns`, skips off-cadence and already-summarised turns, keeps the old summary when the summariser returns nothing, and the default summariser calls the `memory` routing stage and clips to `SUMMARY_MAX_CHARS`.
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts

AC-5 — `processWithGemini` passes `buildRecallQuery(threadSummary, text)` to `recallDevMemory` (the VTID-03892 recall path), and the pre-existing operator-chat suites (VTID-03822 threads, VTID-03851 authz, VTID-03892 memory wiring, VTID-03926 role, VTID-04007 open-ended intake, operator-chat OASIS) still pass with the route wiring in place.
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts
TEST: services/gateway/test/vtid-03892-operator-dev-memory-wiring.test.ts
TEST: services/gateway/test/vtid-03822-operator-chat-threads.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer changes — the per-message `operator.*` audit rows `routes/operator.ts` already emits are untouched; the new tables are a separate store read and written only by the gateway service role. Pinned by the operator-chat OASIS suite above still passing unmodified. Live check once the migration is applied and the flag is on: `select id, turns, summary_turns, length(summary) from operator_threads order by updated_at desc limit 5;`.

Not verified here: a live turn on staging — the migration is not applied (owner's go), the flag is not pinned, and this session does not test against production. The first real signal is `[operator-threads] thread … summarised at turn 10` in the staging gateway log once both are in place.
