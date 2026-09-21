# VTID-04231 — Validator tools: `read_file` (PR head), `ci_evidence`, `dev_get_risk` on the `validator` stage

Build plan item 4, `docs/AGENT-REGISTRY.md` §4 finding 3 (validator half).
`runLlmMergeReview()` — the ONLY gate a Dev Autopilot diff's content passes
through before an autonomous merge (VTID-03853) — asked the `validator`
stage one question over a bounded diff bundle. It could not read the rest of
a changed file, could not see what CI said about the head commit, and had no
change-risk signal. It now runs a bounded, provider-neutral tool loop
(`services/llm-stage-tool-loop.ts`, new, shared with VTID-04232/04233) with
three read-only tools pinned to the PR head sha
(`services/dev-autopilot-llm-review-tools.ts`). Fail-open posture unchanged.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — The review runs on the `validator` stage with `service:'dev-autopilot-llm-review'`, the incident VTID, `allowFallback:true`, `maxTokens:1000`, the three tools declared (`read_file`, `ci_evidence`, `dev_get_risk`) and the prompt naming them.
TEST: `services/gateway/test/vtid-04231-validator-tools.test.ts` — "runs the validator stage with the three tools …".

AC-2 — `read_file` reads at the PR HEAD sha (never `main`), numbers and windows lines (≤400 lines / ≤20 KB per call), lists a directory, and refuses a missing path with an error result.
TEST: same suite — "read_file reads at the PR head sha …" and "read_file lists a directory and refuses a missing path".

AC-3 — `ci_evidence` lists the head commit's check-runs and fetches bounded job-log excerpts (VTID-04005 `collectCiFailureEvidence`) ONLY for failing ones; all-green fetches no logs.
TEST: same suite — "ci_evidence lists the head check-runs …" and "ci_evidence with all-green checks fetches no logs".

AC-4 — `dev_get_risk` loads the VTID-04229 code index once per review and answers from it; an index load failure is an error result fed back to the model, never a thrown review.
TEST: same suite — "dev_get_risk loads the code index once …".

AC-5 — The loop is bounded: at most `REVIEW_MAX_TURNS` (6) model turns and `REVIEW_MAX_TOOL_CALLS` (8) tool calls, then one tool-less call for the verdict; a tool result is clipped to 20 KB and the resent history to 90 KB.
TEST: same suite — "bounds the loop …"; `services/gateway/test/vtid-04231-llm-stage-tool-loop.test.ts` — turn budget, tool-call cap, deadline, clip/trim tests.

AC-6 — Fail-open is unchanged: a router failure mid-loop, an unparseable verdict, a PR-head lookup failure (falls back to the diff-only single shot) and `DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED=false` all pass the merge and never throw; only a parsed `block` verdict blocks.
TEST: same suite — "fails open when the router fails mid-loop …", "reviews single-shot with no tools when …"; the pre-existing `vtid-03853-llm-merge-review.test.ts` suite (two assertions widened for the additive telemetry fields) still green.

AC-7 — The watcher forwards provider/model/tool telemetry on its `llm_review_passed`/`llm_review_blocked` OASIS event.
TEST: same suite — "source contract: the watcher forwards the review telemetry …".

AC-8 — Type-check and the neighbouring suites are green.
TEST: `outputs/tsc-noEmit.log` (`exit=0`); `outputs/jest-vtid-04231.log` — 8 suites / 121 tests (watcher, CI-logs, review, code-index, stage loop, validator tools).

AC-9 — Live: the first `dev_autopilot.execution.llm_review_passed` event on staging after this deploys carries `tool_calls`/`tools_used` and an `llm.call.completed` row with `stage=validator`, `service=dev-autopilot-llm-review`.
TEST: not run in this session — needs a Dev Autopilot PR reaching the CI-green merge gate on staging; recorded as the post-merge exercise, not claimed.

OASIS_PROOF: the existing `dev_autopilot.execution.llm_review_passed` / `llm_review_blocked` events (source `dev-autopilot-watcher`) are unchanged in name and gain `provider`, `model`, `tool_calls`, `tools_used` in their payload — pinned by AC-7's source contract. No new topic.
