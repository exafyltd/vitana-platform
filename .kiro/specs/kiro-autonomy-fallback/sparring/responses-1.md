# Responses to sparring round 1

Session `697e758a-de29-42e1-831b-b85c35bae398`. Planner: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610201618-c018`.
Every premise was re-checked against `exafyltd/vitana-platform@01ed2b5b5` before answering.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Premise corrected, suggestion adopted. The pm_lease table does exist on main: it is created by the file the finding names as 'the only 20261015 migration', supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql:222-240 (CREATE TABLE IF NOT EXISTS public.pm_lease; seed row :227; RLS + service_role grants :232-240), asserted by supabase/tests/vtid_05214_policy_approval.test.sql:13 ('one lease row') and services/gateway/test/vtid-05214-policy-approval-migration.test.ts:59. lease.ts:12-19,38-52 still says 'P1 not merged' because it predates that merge. Plan changes: §5 C6 now cites the full file name and line range and states no new migration is needed; PgLeaseManager keeps the fail-safe (missing relation -> table_absent, error -> error, both no-op ticks) and exposes the last outcome as /status last_lease (§3, C7), so a non-acting PM is visible; new test T26 covers acquired / held_by_other / table_absent / error. Lane F gains the precondition the finding asks for: the driver reads staging /status once, read-only, with the service token and requires mode live and last_lease acquired; otherwise the proof is reported blocked ('PM not acting on staging'), never claimed. tasks.md C8/F1 updated."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Merge authority is now one table in §6. (1) The PM merges only non-workflow lanes through safe-merge; its .github/workflows refusal (github-service.ts:709-748) is final for the PM and never worked around. (2) The Kiro land step merges any lane of this plan, including workflow-file lanes D and H, with plain `gh pr merge` (no --admin) under the recorded §7b owner instruction when every check run on the current head is green. (3) `gh pr merge --admin` only when the single red check is Lane scope and its log shows solely the executor/governance/reviewer rule (queue.mjs:180,471,479) or 'lane file not found' because the spec is not on main; run log linked in merges.md. Clarified that --admin is a branch-protection override and does not call or bypass safe-merge, so it is never 'used for a workflow-file refusal' (the PM simply never merges D/H). Listed explicitly what --admin never overrides: failing test, build, typecheck, PR-GATE verdict, TEST-SUITE shard/union, STAGING-VERIFY, a Lane scope error naming a path outside the lane or a §4.3 file without the owner instruction. The Lane-scope false-positive row stays available to D/H because the owner's instruction of 2026-10-20 names every lane PR of this plan and those lanes carry executor: claude only to satisfy today's validator (§6). Risk 10 rewritten to match."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Adopted the suggested shape. Public /mode now returns only {ok, enabled, mode, executor_mode}; claude_available and claude_reason (with the 4 h evidence) stay behind the auth-gated /status (requireServiceOrAdmin, routes/project-manager.ts:25) as claude: {available, reason}. §3 records the deliberate decision on persistent disclosure: an anonymous caller can see one enum (claude_primary | kiro_fallback), nothing about why, and it grants no capability (merges still need the §4.1 review on the current head, green checks and §4.3). Updated consistently: §3, §5 C7, T24 (exact key set, no claude_* keys), F's staging-tests.json expect_json (claude_available removed), tasks.md C acceptance."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Cutover pinned. §4.9 now fixes the measured window start and the trailer cutover to this plan PR's first commit 70d6af4010251d7f08bfba395bccde0c0f5e5a4e (2026-10-20T17:30:55Z). Verified with `git log --format=%(trailers)`: 70d6af401 and ba3d3ee98 (author kiro-agent[bot]) carry only Collab-Session/Collab-Lane, no Co-Authored-By, so no pre-change trailer falls inside the window. F's zero-claude-proof.md asserts both (a) actor ids per step (no session_… id, no Claude mergedBy) and (b) zero Co-Authored-By: Claude lines over the window on main and every lane branch; a hit is listed and the proof marked incomplete, never rewritten (no history rewrite, no force-push)."
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Made unambiguous and deterministic. The test is stale, the served pin is correct: index.html:32 was bumped to app.js?v=20261121-vtid-05082 by VTID-05082 (80e2b3553, 2026-10-20), after vtid-05077-planner-fallback-and-thinking.test.ts was last edited by VTID-05148 (e7a4c90fb, 2026-10-13); four other suites already expect the served pin (test/command-hub/vtid-05067-kiro-console.test.ts:567, vtid-05069-pipeline-tree.test.ts:184, vtid-05071-kiro-approval-visibility.test.ts:182, vtid-05084-loops-screen.test.ts:148). H0 changes the literal at :212 to the served pin, adds one assertion that app.js contains the chip markup, never touches index.html, drops/loosens nothing. The conditional is removed: H owns the file unconditionally (the only lane listing it, consistent with §5/§7 single ownership); if main already carries the identical fix, H0 is a recorded no-op, so H's file set is fixed at plan time. tasks.md H0 and acceptance updated."
  },
  {
    "finding_id": "R1-F6",
    "disposition": "accepted",
    "rationale": "Verified: the required status checks on main are only `validate` (GET repos/exafyltd/vitana-platform/branches/main/protection/required_status_checks -> contexts ['validate']), so no TEST-SUITE job name is required and the matrix rename cannot open a required-check gap. Plan §5 H now states: the existing rollup keeps its name `Test Suite Summary` (TEST-SUITE.yml:97-99), its needs become [gateway, gateway-shard-union, services] and it fails unless all are success (skipped/cancelled shard or union = failure); required set unchanged; and the merge rule (§7b, C, land step) treats 'checks green' as every check run on the head (four shards, union, summary), not only required ones. tasks.md H acceptance updated."
  },
  {
    "finding_id": "R1-F7",
    "disposition": "accepted",
    "rationale": "Both suggestions were already structurally in the plan (C has depends_on scope-check, §5 C and §7), now made explicit. §5 C1: PROTECTED_GATE_GLOBS is a compiled-in constant literal equal to §4.3; the runtime never reads protected-gate-files.json, so a missing/empty JSON can never empty the list; only parity test T25 reads the JSON and fails when it is absent or differs; an empty constant fails M1. §7: pm-fallback -> scope-check means the JSON, the Collab handoff check and the pm-agent exemption are on main before C's governanceMergeAllowed can merge, and until C is on main the old claude-only guard (act.ts:170-173) stays in force. The --admin row of §6 never applies to a §4.3 file without the owner instruction. tasks.md C acceptance updated."
  }
]
```
