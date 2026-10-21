# VTID-05146 — Dev Autopilot autonomy, Phase C: no collisions with people

Phase C of the master plan sparred under VTID-05077 (`plan-sparring.md`, standard class, 3 rounds, CONVERGED), approved by the owner at Gate 1 on 2026-10-12. Phases A (VTID-05077) and B (VTID-05078) are live in production.

Problem (plan, verified fact 6): the watcher compared an autopilot PR only with main before auto-merging; nothing looked at the other open pull requests, so a green autopilot PR could merge over a file a person (Claude Code, Kiro, the Operator Console) was changing in an open PR. The PR-clash gate is observe-only and compares autopilot PRs only with each other. The pre-merge LLM review let the merge through whenever the review itself failed.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /api/v1/dev-autopilot/executions/:id/release-hold` in `services/gateway/src/routes/dev-autopilot.ts` (router already mounted at `/api/v1/dev-autopilot`; `requireDevRole`).

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/dev-autopilot/executions/<id>/release-hold` (staging; developer role). Command Hub: Autonomy → Autopilot Live (held rows), Dev Autopilot → Advanced config (frozen scope, hold limit).

OASIS_PROOF: `dev_autopilot.execution.held_overlap`, `.overlap_released`, `.overlap_hold_timeout`, `.llm_review_unavailable` (asserted in the operator pipeline regression suite over the fake database).

CURL_PROOF: staging-tests.json — the release-hold route answers an invalid caller with 401 JSON (read-only probe, no write reaches a handler).

## Acceptance criteria

AC-1: Before the claim, a plan whose files an open PR (any author, any branch, drafts included) changes is held (`held_overlap`, `overlap_hold.from = 'cooling'`, blocking PR numbers and shared files recorded) and does not run; it returns to `cooling` when the PR closes.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts ("before the claim: a plan whose files an open PR changes is held, not run")
AC-2: Before the auto-merge, a green autopilot PR that shares a file with another open PR is held, never merged; when the blocking PR closes it is released, its branch is updated from main, and the normal CI path re-validates it before it merges. A PR on other files is not held.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts ("overlap hold entry and release", "an open PR on other files does not hold the merge")
AC-3: A hold older than `overlap_hold_max_hours` (default 72) ends the execution as `failed` / `overlap_hold_timeout`; its PR is closed with a comment; nothing merges; the finding stays `new` (back in the queue).
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts ("overlap hold timeout")
AC-4: `frozen_scope`: a plan touching it is never approved; an open autopilot PR touching it is held, and merges only after the freeze is lifted. Writable via the config route (developer role), validated (repo-relative globs, at most 50); allow_scope/deny_scope stay unwritable.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts ("frozen_scope rejection at approval", "frozen_scope block at merge")
  TEST: services/gateway/test/vtid-04268-dev-autopilot-config-writable.test.ts
AC-5: The pre-merge LLM review fails closed: a review that could not run (diff fetch, LLM call, unparseable verdict) is retried once; if it still cannot run, the merge is blocked, the execution fails with `llm_review_unavailable`, the PR stays open for a person.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts ("pre-merge LLM review fail-closed")
  TEST: services/gateway/test/vtid-03853-llm-merge-review.test.ts
AC-6: The overlap guard never reads a GitHub failure, an incomplete PR list or a capped file list as "no overlap"; a PR's own number never blocks itself; a PR whose file list is incomplete blocks.
  TEST: services/gateway/test/vtid-05146-overlap-guard.test.ts
AC-7: A held execution still owns its finding: the same-finding in-flight guards and the one-in-flight unique index cover `held_overlap`; the active executions list shows it.
  TEST: services/gateway/test/vtid-04293-approve-inflight-guard.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts ("Contract: the emulated one-in-flight-execution index matches the migration")
AC-8: The staging "ready for production" message lists Dev Autopilot merges and auto-reverts in their own section.
  TEST: scripts/ci/staging-verify/lib.test.cjs ("VTID-05146 (C4)")
AC-9: The Command Hub lists held executions with their blocking PRs and a developer-role "Re-check & release" action that re-runs the check (never skips it); the frozen scope and the hold limit are editable under Advanced config.
  CURL: docs/validation/VTID-05146/staging-tests.json (app.js served with the release action)

## Mutation check
Disabling the merge-time hold turns 2 scenarios red; disabling the claim-time hold turns "before the claim" red; disabling the review fail-closed turns "pre-merge LLM review fail-closed" red (`commands.log`).

## Decisions taken
- **Review infra failure.** A review that cannot run twice ends the execution `failed` without a self-heal child (it is not the change's fault) and closes its ledger row as failed; the PR is left open for a person. A real "block" verdict still bridges to self-healing as before.
- **GitHub or config unreadable.** No claim and no merge that tick (retried next tick); never a hold, never a "no overlap".
- **`frozen_scope` initial value.** Set by the migration to the Command Hub frontend (plan C2) only when the column still holds its default.
- **Plan hash.** Recorded on the master sparring record as sha256 of the raw marker text (`2c184d7b…`); the canonical algorithm gives `286c96ec…` for the same, unchanged text. Kept as recorded; noted in `plan-sparring.md`.
- **Asset bump.** app.js and styles.css move to `?v=20261120-vtid-05146`; every staging suite and test that pinned the previous version follows (VTID-04696 rule).
