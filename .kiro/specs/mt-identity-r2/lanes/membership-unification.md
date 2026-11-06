---
lane: membership-unification
state: done
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/migrations/20261102031000_vtid_*_user_tenants_canonical.sql
  - supabase/migrations/20261102031100_vtid_*_memberships_view_dualwrite.sql
  - supabase/migrations/20261102031200_vtid_*_membership_drift_report.sql
  - supabase/migrations/20261102031000_vtid_*_membership_unification_rollback.sql
  - supabase/tests/mt_identity_membership_*.sql
updated: 2026-11-05T20:11Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05466
branch: kiro/mt-identity-r2/membership-unification
pr: https://github.com/exafyltd/vitana-platform/pull/4626
claimed_by: kiro-hotmail-202611011452-6d16
---
# membership-unification — user_tenants canonical, memberships → view, dual-write + drift report (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `membership-unification` group of `tasks.md`
(M1–M3, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence.

Scope:
- `user_tenants` becomes canonical (`20251231000000_vtid_01101_phase_a_bootstrap.sql:90`, `UNIQUE (tenant_id,
  user_id)` `:98`).
- Backfill the drifted `memberships`-only rows with `membership_side_effects_suppressed()` true, so the four AFTER
  INSERT triggers (`20261010180000_vtid_05043_…:46-70`) do not fire.
- `memberships` (a table, vitana-v1 `20250831074859_…:32`) becomes a view with a dual-write trigger
  (`ON CONFLICT (tenant_id, user_id) DO NOTHING`).
- A nightly drift report reads 0 when the two are converged.
- The bot user `…0001` and every `service_bot_accounts` user are excluded from the backfill and from the counts.
- Expand/contract, snapshot first.

Rules (§7a): migration files in this PR, and no live write. After merge, Kiro applies them only on the owner's
approval of the files and the target database (§7d). Branch `kiro/mt-identity-r2/membership-unification`. PR title
`VTID-xxxxx (mt-identity-r2/membership-unification): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/membership-unification`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/membership-unification`. The trigger names and suppression guard were re-verified on
`62990ce285`.

### 2026-11-02T13:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05466 allocated after policy approval (converged-auto-v1).
### 2026-11-02T15:38Z · kiro-hotmail-202611011452-6d16 · ready → executing
Built in platform PR #4626 (`kiro/mt-identity-r2/membership-unification`). The lane's files and evidence were committed on the lane branch.

### 2026-11-02T15:38Z · kiro-hotmail-202611011452-6d16 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4626 (created 2026-11-02T15:38Z). Reviewed on head `c8458b6271cd10ebdea8107b567aef6149be26d5`, see the review entry below.
### 2026-11-05T19:52Z · agent-vitana-lane-reviewer-202611051952-21e4 · review
review: accept
head: c8458b6271cd10ebdea8107b567aef6149be26d5
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4626
Findings:
- [non-blocking] .kiro/specs/mt-identity-r2/lanes/membership-unification.md. Requested checks 1 to 3 pass. (1) git diff --name-status origin/main...c8458b6271 lists 20 added files (1663 insertions): the 4 migrations (three forward files and the rollback), the 3 supabase/tests files and 13 files under docs/validation/VTID-05466. All 20 sit inside the lane's path globs or its own validation folder. The merge-base of origin/main (ec7f45ccb7, fetched at the start of this review) and the head is ec7f45ccb7 itself, so the head is up to date with main, and git diff origin/main c8458b6271 over the whole tree lists the same 20 files and no others. (2) git diff --name-only 933bade4a0 c8458b6271 lists 176 files (21027 insertions, 25 deletions): 38 .github/workflows files, 47 files under .kiro (other plans' specs and lanes), 2 docs/programs files, the evidence folders of VTID-05513, 05528, 05539 and 05551, infra/gitlab-engineering, scripts/eng, scripts/ci/staging-verify and gateway files (approvals.ts, orb-live.ts, orb-tool.ts, developer-tools.ts, domain-atlas.ts and three tests). git diff origin/main c8458b6271 limited to exactly those paths prints nothing and exits 0. The same pathspecs reproduce the 176-file count, so they cover the whole delta. (3) git diff 933bade4a0 c8458b6271 limited to supabase, docs/validation/VTID-05466 and .kiro/specs/mt-identity-r2 prints nothing and exits 0, so the migrations, tests, evidence and lane files are byte-identical to the head I accepted. Between the two heads the first-parent history is the merge commit alone (parents 933bade4a0 and ec7f45ccb7), and git show --cc c8458b6271 prints no hunk, so no conflict was resolved by hand. The merge brought in eight origin/main commits (VTID-05513, 05528, 05537, 05539, 05551 and three plan PRs). My accept on 933bade4a0 stands for the lane's own code.
- [non-blocking] scripts/collab/protected-gate-files.json. Protected gate files (checklist item 9): none of the 20 files in the PR diff and none of the 176 delta paths matches a glob of this file. A diff of the delta limited to supabase, scripts/collab, CLAUDE.md, .claude, .kiro/steering, .kiro/agents, .kiro/pipeline, services/gateway/src/services/plan-sparring, services/gateway/src/services/project-manager, .github/workflows/PLAN-SPAR.yml and .github/workflows/PR-GATE.yml prints nothing, and the 38 workflow files in the delta include no AWS-PROD-* file. The workflow files are governance paths that came in with main and equal main byte for byte, so this PR changes no governance file. The PR diff only adds files, so no test is deleted, skipped or loosened. The merge commit carries the Collab-Session and Collab-Lane trailers under the kiro-agent[bot] identity and has no Co-Authored-By trailer. Checklist items 2, 5, 6 and 9 show no finding.
- [non-blocking] supabase/migrations/20261102031000_vtid_05466_user_tenants_canonical.sql. No effect from the merged main on the lane's migrations. git diff --stat b5544e37dd ec7f45ccb7 -- supabase prints nothing (b5544e37dd is the merge-base of the old head and current main), so main added, changed or removed no migration or supabase test since the base the lane was built on, and nothing sorts ahead of or between the lane's timestamps 20261102031000, 20261102031100 and 20261102031200. The delta has no supabase path. A search of the newly merged specs finds none of the three timestamps, and the migration declared by the live-room-edit-cohost db lane (20261105170000_live_room_cohost_authz.sql) sorts after all of them. None of the five gateway source files in the delta (approvals.ts, orb-live.ts, orb-tool.ts, developer-tools.ts, domain-atlas.ts) mentions memberships, and a search of scripts/eng, scripts/ci/staging-verify and infra/gitlab-engineering finds neither memberships nor user_tenants. The only user_tenants references are the existing reads in orb-live.ts (:676 and :688, outside every hunk of the merge) and table names in domain-atlas.ts (:126 and :185), and user_tenants stays a table under this lane.
- [non-blocking] docs/validation/VTID-05466/staging-tests.json. CI is not evaluated on this head. gh pr view and gh pr checks both failed with HTTP 400 (the GitHub gateway answers 'GraphQL pass-through is not supported'), and my shell has no REST reader for check runs, so I saw no check run on c8458b6271. After git fetch origin, origin/kiro/mt-identity-r2/membership-unification reads c8458b6271 and origin/main has no commit that the head lacks, but that is a view of local refs. This accept does not confirm any check. The land step waits for every required check's latest attempt to be finished and green on this head, and land-guard compares Collab-Reviewed-Head with the PR's current head.
- [non-blocking] docs/validation/VTID-05466/commands.log:55. Still open from my review of 933bade4a0 (file unchanged). The 'Not run here' section (:55-64) records that pgTAP ran only through the shim (no Docker in the sandbox), that supabase db reset on the D11 stack has not run, and that the live recount is live-before.sql in the RUN-MIGRATION pre-check. The migration apply needs the owner's approval of the files and the target database (§7d) or a D11 run on the local stack with real pgTAP. That does not block the merge. The eight non-blocking notes of that review stand as recorded there. This merge changes none of them, because the lane's files are byte-identical.
Next: the land step merges under §7b once every check on this head is green and the PR is up to date with main. The lane is accepted for merging files only. The merge applies no migration; the apply needs the owner's approval of the files and the target database (§7d) or a D11 run. The commit that appends this entry touches only the lane file, so this accept stays valid for it (land-guard rule b). Another merge of main is not covered by rule b and needs a new review, which can be limited to the three checks above. I judged the evidence from read-only git reads and file reads of the lane worktree at this head, and gh pr view failed (GraphQL), so land-guard must still compare Collab-Reviewed-Head with the PR's current head.
### 2026-11-05T20:11Z · kiro-hotmail-202611011452-6d16 · in-review → verified
merge: 27de7a98d121201f5c6de2798e49c27820af9902 (exafyltd/vitana-platform#4626)
authority: §7b PM rule. Merged by kiro-hotmail-202611011452-6d16 on the reviewed head `c8458b6271cd10ebdea8107b567aef6149be26d5`, which was the PR head at merge.

### 2026-11-05T20:11Z · kiro-hotmail-202611011452-6d16 · verified → done
Closing record: the code and evidence are on main from merge 27de7a98d121201f5c6de2798e49c27820af9902. The lane claim is released once this record is on main.
