# VTID-03902 — Operator title-mangling fix + operator-chat planner sweep

Found by holding a real, live multi-turn conversation with the Command Hub
Operator Console (`POST /api/v1/operator/chat` against
`preview-aws-gateway.vitanaland.com`, maintaining `threadId`/`conversation_id`
across turns exactly like the real Command Hub UI), rather than reading the
code in isolation.

## Root cause 1 — title mangling

`extractTitle()` (`operator-service.ts`) never recognized a user-supplied
`"TITLE: ..."` line. `validateTaskTitle()` rejected `"TITLE"` as an unknown
area, area auto-detection re-guessed one from keywords elsewhere in the
text, and the literal `"TITLE: ..."` text got swept up as "the description"
and re-prefixed, then hard-truncated at 60 chars. Observed live on
VTID-03900: `"Frontend: TITLE: Fix — Unfollow button pushed off-screen in"`.

## Root cause 2 — no path from "task created" to "plan generated"

`autopilot_create_task`'s own code comment admits *"planner agents will
pick it up"* — but no such consumer exists anywhere in this codebase.
`GET /api/v1/autopilot/tasks/pending-plan` (VTID-0532) has exactly one
caller in the whole repo: its own test. Confirmed live: VTID-03900 sat at
`status=scheduled`/`spec_status=missing` with zero rows in `oasis_specs`
and no state change since creation; Operator's own honest chat reply was
*"I don't have a tool available that can trigger plan generation."*

## Fix

1. `extractTitle()` strips a leading `TITLE:` line before area-detection
   and truncation run, and the first-sentence match now stops at a
   newline too.
2. New `services/gateway/src/services/operator-planner.ts` — a
   narrowly-scoped background sweep (`OPERATOR_PLANNER_ENABLED`, default
   off) that finds `metadata.source='operator-chat'` tasks stuck at
   `status=scheduled`/`spec_status=missing` and generates a draft spec via
   the existing, already-governed `POST /api/v1/specs/:vtid/generate`
   pipeline (VTID-01188, Bedrock Claude) — reusing the same internal
   self-fetch pattern `executeDevGenerateSpec` already uses for the
   `dev_generate_spec` chat tool. Deliberately scoped away from the
   autonomous-execution allowlist (`isAutonomousExecutionTask()`,
   VTID-03516): never touches code, never opens a PR, stops at
   `spec_status='draft'` for human/Operator review.

---

AC-1 — a description with a leading `TITLE:` line no longer produces a
doubled, truncated title

TEST: `test/operator-service.extract-title.test.ts` — "strips a leading
'TITLE:' line instead of double-prefixing it" (pins the exact VTID-03900
reproduction), "is case-insensitive and tolerates surrounding whitespace",
"does not let a multi-line description without early punctuation drag
later lines into the title"
Output: outputs/targeted-tests.txt

AC-2 — existing title-extraction behavior (real "Area: description"
input, keyword auto-detection, empty input) is unchanged

TEST: `test/operator-service.extract-title.test.ts` — "still normalizes a
real 'Area: description' title unchanged", "still auto-detects a valid
area...", "falls back to 'Gateway: Untitled task' for empty input"
TEST: `test/task-extractor.test.ts` — pre-existing "title extraction"
suite (5 tests), unmodified, still passing
Output: outputs/targeted-tests.txt

AC-3 — the planner sweep finds only operator-chat tasks stuck at
scheduled/missing, and never touches self-healing/autonomous-execution
rows (VTID-03516 boundary)

TEST: `test/operator-planner.test.ts` — "queries vtid_ledger scoped to
operator-chat, scheduled, missing spec, no prior error" (asserts every
filter clause is present in the query)
Output: outputs/targeted-tests.txt

AC-4 — a found task gets a spec-generation call through the existing
`POST /api/v1/specs/:vtid/generate` pipeline, not a reimplementation, and
failures/network errors never throw

TEST: `test/operator-planner.test.ts` — "calls the existing internal
spec-generation endpoint, not a reimplementation", "surfaces the error and
does not throw when spec generation fails", "returns [] on a network
error, never throws"
Output: outputs/targeted-tests.txt

AC-5 — a quiet sweep (nothing to plan) emits no OASIS event; a real sweep
emits exactly one summary event, marked success or warning by outcome

TEST: `test/operator-planner.test.ts` — "emits no OASIS event on a quiet
sweep (polling is not progress)", "generates a spec for each found task
and emits one summary event", "marks the sweep event as a warning when at
least one task fails"
Output: outputs/targeted-tests.txt
OASIS_PROOF: new `operator.planner.sweep_completed` event type added to
`CicdEventType` (`services/gateway/src/types/cicd.ts`); shape and
success/warning status verified by the three tests above against the real
(mocked-fetch) `emitOasisEvent` call site in `operator-planner.ts`.

AC-6 — the `OPERATOR_PLANNER_ENABLED` kill switch defaults off, so
shipping this code does not silently start mutating the ledger

TEST: `test/operator-planner.test.ts` — "defaults to disabled", "is
enabled only by the exact string 'true'"
Output: outputs/targeted-tests.txt

AC-7 — no regression to the existing gateway test suite, type-checking, or
build

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
TEST: `npm run build`
Output: outputs/commands.log (build ran clean, see Verification section)

## Staging enablement (platform-owner decision, this PR)

`OPERATOR_PLANNER_ENABLED=true` is upserted onto the AWS staging gateway
task definition in `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (staging
only — not added to `AWS-PROD-DEPLOY-GATEWAY.yml`). This file falls outside
the `gateway_backend` profile's REMIT trees (VTID-03696), so it is reported
by the path-ownership guard, not gated by it. Once this PR merges and the
staging auto-deploy completes, the planner runs its first sweep immediately
at boot (`initializeOperatorPlanner()`) — the next real signal is a draft
spec appearing in `oasis_specs` for VTID-03900.
