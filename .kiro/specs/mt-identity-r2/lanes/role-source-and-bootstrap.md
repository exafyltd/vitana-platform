---
lane: role-source-and-bootstrap
state: done
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on:
  - membership-unification
paths:
  - supabase/migrations/20261102033000_vtid_*_single_role_source.sql
  - supabase/migrations/20261102033100_vtid_*_fix_bootstrap_admin_user.sql
  - supabase/migrations/20261102033000_vtid_*_role_source_rollback.sql
  - supabase/tests/mt_identity_roles_*.sql
updated: 2026-11-06T10:26Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05467
branch: kiro/mt-identity-r2/role-source-and-bootstrap
claimed_by: kiro-hotmail-202611011452-6d16
pr: https://github.com/exafyltd/vitana-platform/pull/4723
---
# role-source-and-bootstrap — one role source + fix bootstrap_admin_user (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `role-source-and-bootstrap` group of `tasks.md`
(R1–R3, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence.

Scope:
- `user_tenants.active_role` becomes the one role source of truth, and the others derive from it.
- Redefine `bootstrap_admin_user`. Its last definition is vitana-v1 `20250915132930_…:166`, which keys on
  `tenants.name IN ('Maxina','Alkalma','Earthlings')` (`:236`) and `name = 'Maxina'` (`:246`, `:254`) and writes
  `memberships` (`:233`). The new body keys on `tenants.is_default`, writes `user_tenants` through the dual-write
  path and keeps the signature.
- Expand/contract, snapshot first.
- Depends on `membership-unification`.

Rules (§7a): migration files in this PR, and no live write. After merge, Kiro applies them only on the owner's
approval of the files and the target database (§7d). Branch `kiro/mt-identity-r2/role-source-and-bootstrap`. PR
title `VTID-xxxxx (mt-identity-r2/role-source-and-bootstrap): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/role-source-and-bootstrap`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/role-source-and-bootstrap`. Corrected the `bootstrap_admin_user` source to its last
definition (vitana-v1 `20250915132930`).

### 2026-11-02T13:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05467 allocated after policy approval (converged-auto-v1).
### 2026-11-05T22:37Z · kiro-hotmail-202611011452-6d16 · ready → executing
Built on `8d7b8d57fc` and `61be2d39f2` (migrations, pgTAP, evidence, sparring record). Merged `origin/main`
(`78bb4b3969`) into the lane branch in merge commit `d9b4d37398`. Preflight passed on that merge. The PGlite check
was rerun on it and passed (`docs/validation/VTID-05467/commands.log`, section 9). Nothing is applied: migrations
wait for the owner's approval of the files and the target database (§7d).

### 2026-11-05T22:41Z · kiro-hotmail-202611011452-6d16 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4723 opened from `7d83282b310` (not a draft). The reviewer agent
runs next, on the current head. Merge waits for an accept on that head and green checks (§7b).

### 2026-11-06T09:21Z · agent-vitana-lane-reviewer-202611060921-19cf · review
review: accept
head: cd02d2d43a6a56b5342d56f7609b3eaea027d909
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4723
Findings:
- [non-blocking] docs/validation/VTID-05467/acceptance.md. Checks (a) and (c) pass; (a) needs a wording note. The head commit changes one file: git diff --name-only ee71c7f773 cd02d2d43a lists docs/validation/VTID-05467/acceptance.md only (7 lines added under Decisions taken, no AC- entry touched). Over the whole range, git diff --name-only 2cf34ffae8 cd02d2d43a lists 38 files (+3826 -11), including 10 services/gateway files and .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, so (a) read literally does not hold. Those files come from main through merge ee71c7f773: git diff 7ec024340a 84a488d282 (fork point to main's parent) is 37 files (+3819 -11), and 37 plus acceptance.md (+7) is the 38. None is PR-own: the same range limited to supabase, docs/validation/VTID-05467 and the lane file lists acceptance.md only, and the PR's own diff against the merge-base 84a488d282 under services, .github and scripts is empty. For (c), git diff --name-only origin/main...cd02d2d43a lists the same 28 files as before (the lane file, 22 files under docs/validation/VTID-05467, three migrations, two pgTAP files; supabase is 5 files, +1200). The PR's own diff grew from 3044 to 3051 insertions (2 deletions both times), the 7 being acceptance.md (170 to 177 lines).
- [non-blocking] .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml. Check (b) passes; I proved it by disjoint file sets because git merge-tree is outside my command set. Merge ee71c7f773 has parents 2cf34ffae8 (my previous head) and 84a488d282 (VTID-05479 lane-record close, an ancestor of origin/main and the merge-base of the head with main). git show --cc ee71c7f773 prints no combined diff. From the fork point 7ec024340a the branch side changed 28 files (the lane) and main's side 37; neither side touched the other's paths (both scoped diffs print nothing). The merge equals 2cf34ffae8 on every lane path and 84a488d282 on every main-side path, and differs from 2cf34ffae8 by exactly the 37 main-side files (+3819 -11) and from 84a488d282 by exactly the 28 lane files (+3044 -2). So no conflict was resolved by hand and nothing else was edited. The merge brings one governance path, this workflow file (VTID-05541, 9069accecc). It is not a protected gate file and it equals main byte for byte (git diff origin/main cd02d2d43a over .github is empty). land-guard mergeKeepsReview does not carry a review across a merge that brings a governance path, which is why this review was needed.
- [non-blocking] docs/validation/VTID-05467/acceptance.md:141. Check (d) passes: decision 11 (acceptance.md:135-147, new text :141-147) is true against the files at this head. The body refuses a caller whose JWT lacks app_metadata.exafy_admin (20261102033100:46-48). The forward file runs REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated (:155) and GRANT EXECUTE ... TO service_role (:156), and its self-check raises if anon or authenticated can still execute. The bootstrap pgTAP sets request.jwt.claims itself (mt_identity_roles_bootstrap.test.sql:62,68) and asserts anon, authenticated and PUBLIC cannot execute and service_role can (:145-158; 24 of 24 in outputs/pgtap-after-apply.txt). The rollback has no GRANT or REVOKE statement and keeps the ACL through CREATE OR REPLACE (role_source_rollback.sql:19-22; a case-insensitive search for grant|revoke finds only that comment and an error string at :240). docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:151 asks for the PostgREST access-log check before any REVOKE and lists bootstrap_admin_user at :140. No caller exists: no hit in services/, scripts/ or supabase/functions/ here, none in vitana-v1 supabase/functions, and in vitana-v1 src only the generated type (src/integrations/supabase/types.ts:13161); the vitana-v1 edge function bootstrap_admin calls auth.admin.listUsers, not the RPC; git log -S in vitana-v1 over 58c76c956..origin/main finds no commit that changes the name. A search of services/gateway/src for jwt.sign(, SignJWT and signJwt finds only the GitHub App and LiveKit tokens. That a service-role key carries no app_metadata is a property of the Supabase key; the text hedges it with 'normally' and I could not check it from the repo.
- [non-blocking] supabase/tests/mt_identity_roles_bootstrap.test.sql:15. Check (e) holds; the earlier findings stand. Forward file: REVOKE from PUBLIC, anon, authenticated (20261102033100:155) and GRANT to service_role (:156), so the S2 rule (vtid-05041-definer-lockdown.test.ts, the 'newer than S2' case) is met; outputs/jest-vtid-05041.txt reads 7 passed, 1 skipped, and outputs/jest-vtid-05041-before-fix.txt records the 1 failure before the fix. Rollback: the '-- definer-public:' reason at role_source_rollback.sql:19 and no GRANT or REVOKE statement. pgTAP: bootstrap plan(24) here at :15 with 24 assertions, ran 24 failed 0 after apply and after re-apply; single-source plan(28), ran 28 failed 0. outputs/jest-test-roles.txt:166 reads 'Tests: 105 passed, 105 total'. Red to green (items 4 and 5): outputs/pglite-red-base.txt shows R1 13 of 28 and R2 16 of 24 failing on the previous bodies, assertions 21 to 23 included; pglite-negative-control.txt shows 8 failures without the trigger; pglite-rollback.txt shows the catalog restored except the pinned bootstrap ACL. The PR adds files and deletes none (two lane-file lines aside), so no test is removed, skipped or loosened.
- [non-blocking] .kiro/specs/mt-identity-r2/lanes/role-source-and-bootstrap.md. Check (f): CI is not evaluated on this head. gh pr view 4723 and gh pr checks 4723 both fail with HTTP 400 ('GraphQL pass-through is not supported'), and no run id exists in the lane file, the evidence folder or the run logs for gh run view, so I saw no check run, red, pending or green. For the head I used git rev-parse HEAD in the checkout (cd02d2d43a); after git fetch origin, origin/kiro/mt-identity-r2/role-source-and-bootstrap still reads cd02d2d43a. This accept confirms no check. The land step must see every required check's latest attempt finished and green on this head (collaboration.md §7b, land-guard checks). The lane's AC-22 cites a green drift check only for the earlier head 9487f8fa8c6, and the 105 of 105 in jest-test-roles.txt was recorded on the fix head 60a165ade0, before the two later merges of main; I did not re-run it. The atlas claim for the new gitlab route is in the tree (services/gateway/src/orb/developer/domain-atlas.ts:88).
- [non-blocking] scripts/collab/protected-gate-files.json. Protected gate files (item 9): none of the 28 PR files matches a glob of this file, and the three migration names match neither supabase/migrations glob. The PR changes no governance path: git diff --name-only origin/main cd02d2d43a over .github, .claude, .kiro/steering, .kiro/automations, .kiro/agents, scripts, CLAUDE.md, docs/programs/areas.yaml and services prints nothing. The merge commit and the head commit carry Collab-Session and Collab-Lane trailers under kiro-agent[bot] and no Co-Authored-By trailer. Items 2 and 6 to 8: all 28 paths sit inside the lane globs or its validation folder; docs/validation/VTID-05467/pglite-check.mjs has no network call, env read or connection string, live-before.sql and post-apply-checks.sql hold no write statement, and the VTID came from CI PLAN-SPAR (lane file log); no spoken string or UI is touched.
- [non-blocking] docs/validation/VTID-05467/acceptance.md:20. Stale text; no test or check depends on it. acceptance.md:20 says 'pgTAP, bootstrap (20 assertions)' and commands.log:42 and :104 say 'bootstrap 20/20', but the file has plan(24) (mt_identity_roles_bootstrap.test.sql:15) and the recorded runs read planned=24 ran=24 failed=0; the 20 figures predate the fix round of commands.log section 10. Premise 4 (acceptance.md:163) says the dual-write trigger 'is not on origin/main yet', but 20261102031100 is on main (27de7a98d1) and was in 2cf34ffa too. It does not double-write: the bootstrap's own user_tenants row exists before the deferred trigger runs, and the trigger returns when that row exists (20261102031100:58-59). Correct both lines in the closing record or at the next edit of the file.
- [non-blocking] supabase/migrations/20261102033100_vtid_05467_fix_bootstrap_admin_user.sql:121. The explicit user_tenants insert (:121-127) does not set vitana.suppress_membership_side_effects, which the membership dual-write sets around the same kind of insert (20261102031100:61-70). When the target user has no primary membership, v_is_primary is true and the four AFTER INSERT triggers guarded by NOT membership_side_effects_suppressed() (20261010180000:46-71: welcome chat, founding seat, onboarding autopilot seed, personal live room) fire inside the bootstrap. The previous body never wrote user_tenants, so this is new, and nothing tests it: docs/validation/VTID-05467/fixture-stub.sql has no match for the four triggers or the guard, and neither pgTAP file nor acceptance.md mentions them. Reach is small: after this lane only a database-owner or service_role session that sets request.jwt.claims itself can call the function (decision 11), and a target that already has a primary row, the usual case, gets a non-primary row or none. It does not block, because no migration is applied from the PR and the owner approves each file first (§7d). Either wrap the insert in the same transaction-local set_config and restore, or add the first-primary-membership side effects to 'Decisions taken' for the apply request.
- [non-blocking] .kiro/specs/mt-identity-r2/lanes/role-source-and-bootstrap.md. origin/main is now ed1b4e7388, four commits past this head's merge-base 84a488d282 (c0080572d3, d476df9f86, 51a4741e0e, ed1b4e7388). They change only lane and plan files under .kiro/specs (mt-guardrails-r2, mt-track-s-authz, mt-track-s-r2) and docs/validation/VTID-05463; none touches supabase/, services, scripts or a governance path. The PR is therefore behind main, and §7b needs it up to date and re-checked on its head before the merge. land-guard keeps this accept across a further merge of main only if that merge is clean, brings no governance or protected file and leaves the PR's own diff unchanged; otherwise a new review is needed.
- [non-blocking] docs/validation/VTID-05467/commands.log. Carried over, unchanged since my earlier accept: pgTAP ran only through the PGlite shim (no Docker, so no supabase test db, supabase db reset or pg_prove); the SQL harness case of the two guard suites skipped (no local PostgreSQL binary); apply and rollback on the local stack did not run. The live tenants key column (tenant_id or id) and the live bootstrap_admin_user body are unverified (acceptance.md premises 2, 3 and 6, and 'Not run here'). None blocks merging the files. The apply needs the owner's approval of the files and the target database (§7d) and the owner's confirmation of decisions 1, 2, 6 and 11 and premise 3.
Next: the land step merges under §7b once every required check on cd02d2d43a is finished and green and the PR is up to date with main (origin/main is ed1b4e7388 now; land-guard decides whether a further clean merge of main keeps this accept). This accept covers merge ee71c7f773 and the decision 11 text, and it confirms no check, because CI could not be read. The commit that appends this entry touches only the lane file, so this accept stays valid for it (land-guard rule b). The accept is for merging the files only: no migration is applied from the PR, and the apply needs the owner's approval of the files and the target database (§7d).

### 2026-11-06T10:26Z · kiro-hotmail-202611011452-6d16 · in-review → verified
merge: 0f3374e470 (exafyltd/vitana-platform#4723)
authority: §7b PM rule. Merged by kiro-hotmail-202611011452-6d16 on head `89ee8f5658`: the reviewed head `cd02d2d43a`, the review-entry commit `2cb034fd75` (lane file only), and a clean merge of `origin/main` (`ed1b4e7388`). The 11 files that merge brought are spec and evidence files: no governance or protected file, no overlap with this lane. All 12 checks green on `89ee8f5658` (land-guard checks). The land guard found the review current, the checks green, and the branch up to date.

### 2026-11-06T10:26Z · kiro-hotmail-202611011452-6d16 · verified → done
Closed. The migrations are on `main` and not applied. The apply waits for the owner's approval of each file and of the target database (collaboration.md §7d), and for the owner's confirmation of decisions 1, 2, 6 and 11 and premise 3. Reviewer notes carried to the apply request: the explicit `user_tenants` insert in `20261102033100` (:121-127) does not set `vitana.suppress_membership_side_effects`, so the four AFTER INSERT triggers can fire inside the bootstrap when the target user has no primary membership (record it under Decisions taken, or wrap the insert before apply). Stale text in `docs/validation/VTID-05467/acceptance.md` (line 20 says 20 assertions; the file has 24, and premise 4 at line 163 is out of date) is corrected at the next edit of that file.
