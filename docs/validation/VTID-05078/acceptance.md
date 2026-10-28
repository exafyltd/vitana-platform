# VTID-05078 — Dev Autopilot autonomy, Phase B: the planner reads both repositories and the codebase index

Owner approval 2026-10-12 (Gate 1 on the sparred master plan; "start Phase B"). Sparring: `plan-sparring.md` (master plan of VTID-05077).

Problem: the planner saw one pre-fetched file of `exafyltd/vitana-platform` and nothing else — no callers, no tests, no index, no `exafyltd/vitana-v1` — and was told "Do NOT ask to see other files". Plans named non-existent or denied paths (e.g. a new migration and a `services/gateway/tests/` file on 2026-10-11).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route; the Dev Autopilot planner (`services/gateway/src/services/dev-autopilot-planning.ts`) runs inside the staging-owned autopilot loop.

FINAL_URL: not applicable (no new surface); `dev_autopilot.plan.generated` payloads carry `tool_stats`.

OASIS_PROOF: `dev_autopilot.plan.generated|version_added` payloads gain `tool_stats { tool_calls, tool_errors, tool_names, budget_exhausted, stalled }`; new `dev_autopilot.plan.needs_human` (status info) for a plan that changes `exafyltd/vitana-v1`; `dev_autopilot.plan.failed` carries `path_problems` when path validation fails.

CURL_PROOF: not applicable (no endpoint); staging probes in `staging-tests.json`.

## Acceptance criteria

AC-1: The planner runs as a bounded read-only tool loop (`runStageToolLoop`, at most 12 tool calls, 90 s) with read_file/list_dir/search on both repos pinned to each repo's `main` commit, and dev_index_query/dev_graph_path/dev_get_risk on the code index; the Phase A model choice (DeepSeek primary, thinking off, Opus 4.6 fallback) is kept.
  TEST: services/gateway/test/vtid-05078-planner-tools.test.ts
AC-2: The tools use PLAN_SPARRING_GITHUB_TOKEN only; without it (even with the merge token present) they are off and the planner works as before; DEV_PLANNER_TOOLS_ENABLED=false switches them off.
  TEST: services/gateway/test/vtid-05078-planner-tools.test.ts
AC-3: A repo outside the allowlist is refused; an unpublished code index is a tool error, never a failed plan.
  TEST: services/gateway/test/vtid-05078-planner-tools.test.ts
AC-4: Every "Files to modify" path must exist at main or be marked "(new)" and must not be denied (scanner overrides applied); one revision round with the reasons, then `plan.failed` with `path_problems`; an unanswerable existence check never fails a plan.
  TEST: services/gateway/test/vtid-05078-planner-tools.test.ts
AC-5: A plan that names `exafyltd/vitana-v1:<path>` is stored with a "Needs a human" note and no executable files, so the safety gate keeps it in the human queue; `dev_autopilot.plan.needs_human` fires.
  TEST: services/gateway/test/vtid-05078-planner-tools.test.ts
AC-6: With tools on, the prompt explains them and drops "Do NOT ask to see other files"; without, it is unchanged apart from the "(new)" marker rule.
  TEST: services/gateway/test/vtid-05078-planner-tools.test.ts

## Decisions taken
- PLAN_SPARRING_GITHUB_TOKEN is not wired into any gateway workflow and no session can create the secret: Phase B ships with the tools off (plan B1a). Wiring follows only after the owner provisions the token, because the staging deploy hard-fails on a listed secret that does not exist.
- The server-side existence check for plan paths uses the read-only token when present, else the existing gateway token (the model never sees it); a GitHub error answers "unknown" and never fails a plan.
- Two source-text pins followed the change on purpose: VTID-03854's "stub returns before any model call" now finds the call at `let call = toolsOn` (same ordering guarantee); VTID-04806's "outcome on every exit" counts 4 exits (the new path-validation exit records its outcome too).
- DeepSeek with tools requires thinking off (with thinking on, its API demands `reasoning_content` back on every tool turn); Phase A already sends thinking disabled on every planner turn.

## Limits
Local: `tsc` clean; vtid-05078 13/13; planning/stub-gate/plannability suites 49/49; `npm run test:operator` 64/64; full gateway jest green. B4a (≥ 80 % of plans use a tool, < 5 % parse failures) is measured on staging once the token exists.
