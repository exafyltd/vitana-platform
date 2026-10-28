# VTID-04628 — Operator console: several rounds of tools per turn

Live on staging 2026-09-26, after VTID-04624 gave the console live read-only
SQL: asked "how many registered users do we have in vitanaland", the model
(Bedrock Sonnet 4.6) called dev_run_sql_readonly with a wrong column
(`column "id" does not exist`) and then replied that it could not re-run a
corrected query. That was true: `processWithGemini` ran exactly one round —
plan call → tools → a tool-less final call — so a failed call could not be
corrected and a two-step question (look up a schema, then count) could not be
answered in one turn.

Now each round's tool calls and results go back to the model WITH the tools
(`gemini-operator-continue`), up to `OPERATOR_MAX_TOOL_ROUNDS` (default 4,
max 10, `1` = the old behaviour). The turn ends when the model answers in text;
when the budget runs out or a continuation call fails, the existing tool-less
final call answers from every result gathered. The common case (one round of
tools, then an answer) emits the same plan / tool / final event sequence the
Command Hub already renders; `meta.tool_rounds` is new.

## Acceptance criteria

AC-1: a failed tool call is corrected in the next round, the answer comes from the second result, and the tool-less final call is not used.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-2: OPERATOR_MAX_TOOL_ROUNDS=1 keeps the single-round behaviour; a model that keeps calling tools is stopped by the round budget and answered by the tool-less final call.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-3: the round budget, the tool-result transcript bound and the continuation prompt are pinned.
TEST: services/gateway/test/vtid-04628-operator-tool-rounds.test.ts

AC-4: every existing console suite is unchanged (38 suites, 562 tests) — the continuation service name is new, so scripted single-round scenarios keep working.
TEST: services/gateway/test/vtid-04028-operator-turn-stream.test.ts
