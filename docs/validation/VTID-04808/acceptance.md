# VTID-04808 — Jev P2 A7: clash check between parallel green Dev Autopilot PRs, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A7 (P2).

The watcher merges each green PR on its own. With several executions open at once, merging one can leave
another un-mergeable or broken: in the 60 days to 2026-10-01, 18 Dev Autopilot CI failures were
`mergeable_state: dirty`, 13 of them on 2026-09-21 alone.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `pr_clash` (`pii: 'redact'`, planes internal + system_autopilot, engineering roles): "if the first change is merged now, is the second likely to conflict or break", from both changes' titles and planned files and their shared files and directories.
  TEST: services/gateway/test/vtid-04808-pr-clash.test.ts
AC-2: The other open changes judged are those sharing a file or a directory with the merging one, shared files first, at most 3; the merging execution itself and unrelated ones are left out; nothing to judge → no call, no row.
  TEST: services/gateway/test/vtid-04808-pr-clash.test.ts
AC-3: Gate `pr_clash` (`JEV_PR_CLASH_MODE`, exact values; anything else off). Off loads, asks and writes nothing. In shadow, right before the watcher merges, one `jev_shadow_decisions` row per merge (`system_action = merged`) listing each other execution and Jev's call; never awaited; the merge is unchanged; Jev unavailable → a fallback row; never throws.
  TEST: services/gateway/test/vtid-04808-pr-clash.test.ts
AC-4: When an execution named in an open row reports — CI failed with `mergeable_state: dirty` (first check or the 30 s recheck) or CI passed — the row records `other_conflicted` / `other_merged_clean` and whether Jev's call for it was right (null when Jev did not decide); other CI failures record nothing.
  TEST: services/gateway/test/vtid-04808-pr-clash.test.ts
AC-5: Watcher behaviour is unchanged (watcher and operator pipeline suites green); both gateways pin `JEV_PR_CLASH_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04808-pr-clash.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/jev-repository.ts (one read)
- services/gateway/src/services/jev/gates/pr-clash-gate.ts (new)
- services/gateway/src/services/dev-autopilot-watcher.ts (one fire-and-forget check before merge, three outcome calls)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04808-pr-clash.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04808/**

## OASIS

OASIS_IMPACT: none new. Each judged pair emits the existing `jev.decision.*` event (source `jev:gate:pr_clash`), at most 3 per merge.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_PR_CLASH_MODE=shadow`. The watcher merges exactly as before.

## Not in this PR

Enforce (holding the second PR, or merging in a safer order) comes after the data.
