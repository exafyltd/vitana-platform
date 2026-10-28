# VTID-04376 — Acceptance (Dev Autopilot pipeline batch)

Companion VTIDs in this PR: VTID-04377, VTID-04378, VTID-04379, VTID-04380, VTID-04381.
All six come from the ranked list in `docs/OPERATOR-CONSOLE-E2E-RECOVERY-2026-09-21.md`.

## Context

- **04376.** The concurrency cap counted `ci/merging/deploying/verifying` rows as if they were running agents. A slow post-merge tail therefore blocked every new claim, even with no agent running.
- **04377.** `analyzeVerificationWindow` failed (and reverted) a correct, merged PR for any tenant-wide `status=error` event in its 5-minute window. That included errors already firing before the merge, the execution's own ledger VTID, `BOOTSTRAP-*` rows and deploy results.
- **04378.** Some terminal writes never closed the finding's `vtid_ledger` row, so the task stayed IN PROGRESS for good:
  - the bridge's `failed_escalated` PATCHes (4 sites);
  - the reject of a held execution.
- **04379.** The watcher merged a PR as soon as its own CI was green. Two PRs green on their own broke `main` together (VTID-04219). A PR GitHub reported as `behind` was waited on forever.
- **04380.** The staging task def had no `GATEWAY_URL`, so these fell back to production or to a decommissioned GCP appspot host:
  - self-healing snapshots;
  - autopilot verification;
  - the event loop.
- **04381.** The router dropped the provider's stop reason, and DeepSeek read `tool_calls[0]` only. A reply cut off at the output limit then either ran a partial set of calls or was read as "answered with text only", burning the nudge budget under a misleading error.

## Acceptance Criteria

AC-1: The claim tick counts only running agents. Auto-approve also counts the cooling queue. A separate tail cap (`DEV_AUTOPILOT_TAIL_CAP`, default 8) bounds PRs in the post-merge tail. A human hold (`awaiting_approval`) is still not counted.
TEST: services/gateway/test/vtid-04376-concurrency-cap.test.ts — "a full post-merge tail below the tail cap no longer blocks claiming", "claim counts only running agents; approve also counts the cooling queue", "the tail cap bounds both ticks", "the claim tick and auto-approve both size themselves with pipelineSlots"
TEST: services/gateway/test/vtid-04029-dev-autopilot-pr-approval.test.ts — "the active list, the same-finding inflight guards and the stream terminal topics know the status"

AC-2: An error type counts as blast radius only when it rises above its count in the same-length span before the window. The execution's own ledger VTID, `BOOTSTRAP-*` rows and deploy topics are never counted. The VTID-02699 and VTID-04043 exclusions still hold.
TEST: services/gateway/test/vtid-04377-verification-baseline.test.ts — "an error type already firing before the merge at the same rate is not blast radius", "the same type above its baseline fails", "a type that is new after the merge fails even when others were noisy before", "the execution's own ledger VTID is never blast radius", "BOOTSTRAP-* rows and deploy topics are ignored"
TEST: services/gateway/test/dev-autopilot-watcher.test.ts — "flags blast radius for unrelated error events during the window"

AC-3: These terminal writes close the ledger:
- `failed_escalated` closes it as failed;
- a rejected hold closes it as cancelled;
- `reverted` stays open, because a self-heal child continues the same VTID.

A failed ledger write is logged as an error.
TEST: services/gateway/test/vtid-04378-ledger-terminalization.test.ts — "maps terminal execution statuses to a ledger outcome", "leaves non-terminal states and `reverted` (a child continues the VTID) alone", "every failed_escalated PATCH in the bridge is followed by a ledger close", "reject closes the ledger as cancelled"

AC-4: When a clean or `behind` PR is behind `main`, the watcher merges `main` into it before merging:
- it uses GitHub update-branch (a merge, pinned with `expected_head_sha`, never a rebase), then waits for CI on the new head;
- it gives up after 5 updates;
- a compare failure blocks the merge for that tick.
TEST: services/gateway/test/vtid-04379-branch-up-to-date.test.ts — "merges when up to date", "updates a behind branch, up to the cap", "the compare/update step runs before the merge gate and before the `behind` wait", "update-branch is a merge pinned to the head we judged, never a rebase", "a compare failure refuses the merge this tick"

AC-5: The staging task def pins `GATEWAY_URL` to the staging host, and prod does not. Autopilot verification no longer defaults to decommissioned GCP hosts.
TEST: services/gateway/test/vtid-04380-staging-gateway-url-pinned.test.ts — "is stripped then re-added with the staging host", "is not pinned to the staging host on prod", "gateway and oasis-operator default to AWS hosts"
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-6: The router returns `stopReason` and `truncated`, and DeepSeek returns every tool call with its id. The agent loop does not run a cut-off turn's calls: it tells the model to make smaller moves, and three cut turns in a row end the run with the real reason.
TEST: services/gateway/test/vtid-04381-truncation.test.ts — "matches both provider spellings of \"ran out of output tokens\"", "keeps every call with its id, in order", "counts a half-written call instead of dropping it silently; empty args are {}", "does not execute the cut turn's calls, tells the model why, and continues", "ends the run with the real reason after repeated truncation"

AC-7 (post-deploy, live, blocked while the AWS account block holds): on staging, the next held execution that the owner approves should do all of the following:
- enter `ci`;
- if `main` moved, produce one `dev_autopilot.execution.branch_updated` row;
- merge only on a head that carries `main`;
- terminalize its VTID.
CURL: curl -s https://preview-aws-gateway.vitanaland.com/api/v1/dev-autopilot/supervisor

## OASIS evidence

OASIS_PROOF: one new event type, `dev_autopilot.execution.branch_updated`, registered in `CicdEventType` (services/gateway/src/types/cicd.ts). The CI watcher emits it once per update-branch call, with `behind_by`, `from_head` and `update_number` in the payload. Its wiring is pinned by services/gateway/test/vtid-04379-branch-up-to-date.test.ts.

`vtid.lifecycle.completed` / `vtid.lifecycle.failed` (existing) now also fire when an execution escalates or a hold is rejected. They come from the existing `terminalizeVtidLedgerForExecution` path.

The live proof is AC-7.
