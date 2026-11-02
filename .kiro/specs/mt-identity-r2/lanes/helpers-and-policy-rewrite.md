---
lane: helpers-and-policy-rewrite
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/migrations/20261102030000_vtid_*_tenant_id_for_policies_is_member.sql
  - supabase/migrations/20261102030100_vtid_*_bare_policy_rewrite.sql
  - supabase/migrations/20261102030100_vtid_*_bare_policy_rewrite_rollback.sql
  - scripts/ci/bare-policy-lint.mjs
  - services/gateway/test/mt-identity-bare-policy-lint.test.ts
  - supabase/tests/mt_identity_helpers_*.sql
updated: 2026-11-02T13:05Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05465
---
# helpers-and-policy-rewrite — tenant_id_for_policies() + is_member() + the bare-policy rewrite (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `helpers-and-policy-rewrite` group of `tasks.md`
(H1–H4, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence, never by hand.

Scope: the N3 ordering gate.
- Ship `tenant_id_for_policies()` and `is_member(tenant_id)` as a STABLE SECURITY DEFINER pair over the unique
  `(tenant_id, user_id)` index, with the N2 degraded path. `tenant_id_for_policies()` is a new name, not a redefine
  of `current_tenant_id()`.
- Rewrite every bare `tenant_id = current_tenant_id()` policy. The recount on 2026-11-01 found 32 policies on 15
  tables, including `match_targets`, `relationship_nodes`, `social_alignment_signals` and `topic_registry`, which
  the old count missed.
  - A table with a `user_id` owner column is user-private; any other table is tenant-shared (`is_member`).
  - Keep the extra predicates of `community_listings_select_public` and `d42_domain_weights_select`.
  - Keep today's write audience (any member of the tenant).
- Add the bare-policy lint; it must read ZERO.
- Re-run the recount at implementation and record the set, the classification and the column evidence in the PR.
- No policy on the 5 no-policy tables.
- This lane does not redefine `current_tenant_id()` and does not enable the hook.

Rules (`collaboration.md` §7a):
- No VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge outside §7b, and no Supabase or AWS write.
- A DB change is a migration file in this PR. After merge, Kiro applies it through `RUN-MIGRATION.yml` only on the
  owner's approval of the files and the target database (§7d).
- Branch `kiro/mt-identity-r2/helpers-and-policy-rewrite`. PR title
  `VTID-xxxxx (mt-identity-r2/helpers-and-policy-rewrite): …`. Trailers `Collab-Session` +
  `Collab-Lane: mt-identity-r2/helpers-and-policy-rewrite`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/helpers-and-policy-rewrite`. The bare-policy set was re-counted on `62990ce285` (32 on 15
tables). Executor and reviewer follow today's §3a and §7 rules.

### 2026-11-02T13:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05465 allocated after policy approval (converged-auto-v1).

### 2026-11-02T17:50Z · agent-vitana-lane-reviewer-202611021750-55cc · review
review: changes
head: 28232f2bb7c2271aac8ec357059a0b3722b19b90
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4625
Findings:
- [blocking] supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:55. The diff matches amendment 1 exactly (32 policies on tenant_id = (select public.tenant_id_for_policies()), extra predicates kept, no user_id term, no is_member() in a policy), but its premise rests on migration text only. MULTI-TENANT-PLAN.md:24 (verified 2026-10-06), DATABASE_SCHEMA.md:3320-3322 and :3646-3647, and CHANGELOG.md:30 say the live current_tenant_id() returns NULL for browser JWTs and the 20260218 fix was never applied live. If so, the rewrite turns no browser access into every-tenant-member access (attendance reads, writes on groups, meetups, live rooms, catalogs). AC-4 and AC-5, proven on a fixture with the 20260218 body, cannot show it. Add a live-body guard in the DO $pre$ block, print the markers in pre-check.sql:64, test the guard red on this head, and correct acceptance.md (:31, :34, :63, :121-122). If the old body is live, park the lane for a plan decision before any apply.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:122. tenant_id_for_policies() ignores request.tenant_id, the 'tenant' claim and app_metadata.active_tenant_id, so multi-tenant members with a non-primary active tenant, and callers whose app_metadata tenant has no user_tenants row, resolve differently after the rewrite. It cannot widen to a non-member tenant, but it is not 'no visible change'. Add a read-only count of both groups to pre-check.sql before the apply request.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:43. AC-8 is partly met: PGlite with a pgTAP shim, not the D11 stack with real pgTAP, and no CI runner for the pgTAP files. Run on the D11 stack or real pgTAP, or record the owner's waiver, before the apply approval is requested.
- [non-blocking] docs/validation/VTID-05465/post-check.sql:10. Check 2 (0 rows on all public tables) can return live bare policies this lane leaves alone, and check 3 (32 rows) ignores skipped absent tables. Scope check 2 to the 32 rewrite-set policies and derive check 3's count from pre-check 1.
- [non-blocking] services/gateway/test/mt-identity-bare-policy-lint.test.ts. Gateway Jest shards 1-4, oasis-projector, vcaop and openclaw-bridge are still queued, and the 16 completed checks are green. I could not confirm the earlier autopilot-event-loop failure from the evidence. The land step waits for the shards on the final head.
Next: the lane's seat fixes the blocking finding and asks for review of the new head. If the guard shows the 20251229 body is live, the seat parks the lane with the five-part stop message for a plan decision on amendment 1. The amendment 1 conformance, the acceptance mapping (AC-1 to AC-11) and the red-on-base evidence (Jest 7/7 red alone, 4 red and 3 green with the lint script, 4 structural pgTAP reds on main's policies) need no rework.

### 2026-11-02T19:09Z · agent-vitana-lane-reviewer-202611021909-98c9 · review
review: changes
head: 84b49fccb1eb007f7535cc8d4d8385b00a703433
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4625
Findings:
- [blocking] docs/validation/VTID-05465/acceptance.md:67. AC-12 has no line starting with TEST:, CURL: or UI: within the 12 lines after it. Its 'Test:' sits mid-sentence, and the gate matches ^(TEST:|CURL:|UI:) case-sensitively on stripped lines. The Acceptance Mapping Gate in VALIDATOR-CHECK.yml (job validate-pr, queued on this head, triggered because the PR touches docs/validation/** and services/gateway/test/**) has no if: or continue-on-error, so it will exit 41 with 'AC at line 67 has no TEST:/CURL:/UI: mapping within 12 lines'. node scripts/ci/validate-pr-locally.cjs, which AC-11's TEST line says passes, returns 41 as well. Commit 28232f2b added TEST: lines to AC-1 to AC-11 for this gate. AC-12 was added later in fix-forward 1, and the fix-forward 1 section of commands.log shows no validate-pr-locally run. Fix: add a line starting with 'TEST:' directly under AC-12 (the guard pgTAP file 5 of 5, the Jest 'live-body guard' test 8 of 8, and the outputs/ files), run validate-pr-locally.cjs with the PR title and body, and log the run in commands.log. This is the only blocking item.
- [non-blocking] supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:90. Previous blocking finding resolved. DO $pre$ reads the live definition with pg_get_functiondef (:90) and raises before the policy loop (:98-100, loop at :102) unless three markers match, and prints the first 200 characters and each marker as NOTICE lines. All three markers appear verbatim in the 20260218 body (20260218000000_fix_maxina_signup_tenant_association.sql:69, :81-82, :91-92). The 20251229 file has no app_metadata or user_tenants text at all, and these two are the only current_tenant_id() definitions in supabase/migrations on the checkout I read. pre-check.sql section 5 (:75) runs the same three tests. Red then green is recorded: the unguarded migration commits on the old-body fixture ('have 0, want 32', outputs/live-body-guard-red.txt), the guarded one refuses ('markers f, f, f', pgTAP 5 of 5, outputs/live-body-guard-green.txt), and the Jest guard test goes from 7 passed and 1 failed to 8 of 8. acceptance.md now calls the premise unverified (AC-4, AC-5, AC-12, premises table) and parks the lane for an owner decision if section 5 shows a false marker. A refusal shows as a red RUN-MIGRATION run (the Supabase path needs a 2xx and no error payload, the Aurora path exits 1 on a failed statement) and the BEGIN/COMMIT block rolls back. Nothing is applied, no live system is contacted, and checklist items 2, 5, 6 and 9 (paths, test weakening, live writes, protected gate files) show no finding.
- [non-blocking] docs/validation/VTID-05465/pre-check.sql:75. The guard and section 5 test function text only. The 20260218 current_tenant_id() is not SECURITY DEFINER (20260218000000_fix_maxina_signup_tenant_association.sql:33-36), so its user_tenants fallback runs with the caller's rights and resolves a tenant only while the live policy user_tenants_select_own exists (20251231000000_vtid_01101_phase_a_bootstrap.sql:111). tenant_id_for_policies() is SECURITY DEFINER and does not need it. If that policy is missing or narrower on the target, today's bare policies resolve no tenant for members whose JWT has no app_metadata.active_tenant_id, and the rewrite would give them their primary tenant. Add a read-only query to pre-check.sql that lists the live SELECT policies on public.user_tenants and the prosecdef of current_tenant_id(), and quote it in the apply request.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:53. AC-7's TEST line says 7 of 7 and cites outputs/jest-green.txt (run at 3e787184e4), and green.txt shows the same run. The test file now has 8 tests. Point AC-7 at outputs/jest-live-body-guard-green.txt (8 of 8) in the same commit as the AC-12 fix.
- [non-blocking] services/gateway/test/mt-identity-bare-policy-lint.test.ts. Every check on this head except 'wake' is queued (checks.txt), so none confirms the head yet. The land step waits for all of them on the final head: validate-pr (see the blocking finding), pr-gate, Lane scope, Collab handoff, Gateway Service Tests and every gateway test job that runs the 8-test lint file.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:55. AC-8 is unchanged and correctly recorded as partly met: PGlite with a pgTAP shim, and no CI runner for the pgTAP files. Apply stays blocked until the owner has read pre-check.sql sections 5, 6 and 6b on the target, and has either waived AC-8 or seen the files run on the D11 stack with real pgTAP (section 7d). The helpers migration 20261102030000 is additive and does not depend on the live body; only 20261102030100 is guarded.
Next: the lane's seat adds a TEST: line under AC-12, corrects the AC-7 count, runs validate-pr-locally.cjs and asks for review of the new head. The guard fix needs no rework, so that review can be limited to the acceptance.md delta and the CI results. No apply before the owner has read pre-check.sql sections 5, 6 and 6b on the target database (§7d). If section 5 shows a false marker, the seat parks the lane with the five-part stop message for a plan decision on amendment 1.

### 2026-11-02T19:30Z · agent-vitana-lane-reviewer-202611021930-5ffc · review
review: accept
head: 8468187bcc9b33c73240ccdaca7dea9e8c392c47
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4625
Findings:
- [non-blocking] docs/validation/VTID-05465/acceptance.md:79. Previous blocking finding resolved. AC-12 is at :67 and its TEST: line is at :79, the last line of the gate window (VALIDATOR-CHECK.yml:192 reads txt[i+1:i+13] and validate-pr-locally.cjs:120 reads txt.slice(i+1, i+13), so lines :68 to :79). The patch hunk (+1,174) puts the same two lines at :67 and :79. AC-1 to AC-11 each have a TEST: on the next line, there is no AC-13 and no other line that begins with AC-, and the file has no CR or Unicode line separators that could move the window. The gate prints 'Acceptance mapping OK'. This commit does not affect the earlier validate-pr steps: the in-remit paths (services/gateway/test, docs/validation) are in the gateway_backend allowlist of validator-path-guard.cjs, and the evidence directory has acceptance.md, commands.log and outputs/. Checklist items 2, 5, 6 and 9 (paths, test weakening, live writes, protected gate files) show no finding.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:79. The new TEST: line cites two files that predate the guard. outputs/pglite-apply-rollback-reapply.txt was run at 3e787184e4 and has no guard-refusal line, and outputs/jest-green.txt is the 7-test run without the 'live-body guard' test. The guard evidence is outputs/live-body-guard-green.txt (refused, markers f, f, f; pgTAP 5 of 5), outputs/pglite-run-after-guard.txt and outputs/jest-live-body-guard-green.txt (8 of 8). The AC-12 paragraph already cites live-body-guard-green.txt and jest-live-body-guard-green.txt. AC-7 at :53 still says 7 of 7. Correct the citations and the count with the next change to this folder, and keep the TEST: line within 12 lines of the AC-12 line, because it is on the last line the gate reads now. This is not a reason to hold the merge: another push needs a new review of the head.
- [non-blocking] docs/validation/VTID-05465/commands.log. commands.log ends with the fix-forward 1 section. It has no entry for commit 8468187bcc and no validate-pr-locally.cjs run on this head, which my earlier entry asked for. I checked the gate logic in both implementations instead, and the validate-pr job on this head decides. Add the entry with the next change to this folder.
- [non-blocking] docs/validation/VTID-05465/pre-check.sql:59. Still open from my earlier entry. No read-only query lists the live SELECT policies on public.user_tenants or the prosecdef of current_tenant_id() (section 3 at :59 reads only md5(prosrc), section 5 at :75 reads the function text). The 20260218 body is not SECURITY DEFINER (20260218000000_fix_maxina_signup_tenant_association.sql:33-36), so today's bare policies resolve a tenant for members without app_metadata.active_tenant_id only while user_tenants_select_own exists (20251231000000_vtid_01101_phase_a_bootstrap.sql:111). Add the query before the apply request and quote its result there.
- [non-blocking] services/gateway/test/mt-identity-bare-policy-lint.test.ts. Every check on this head except 'wake' is queued or running (checks.txt), so none confirms the head yet. The land step waits for all required checks on the final head: validate-pr (Acceptance Mapping Gate), pr-gate, Lane scope, Collab handoff, Gateway Service Tests and the gateway test jobs that run the 8-test lint file.
Next: the land step merges under §7b once every check on this head is green. The lane is accepted for merging files only. No apply before the owner has read pre-check.sql sections 5, 6 and 6b on the target database and has either waived AC-8 (PGlite with a pgTAP shim, no CI runner) or seen the files run on the D11 stack with real pgTAP (§7d). If section 5 shows a false marker, the seat parks the lane with the five-part stop message for a plan decision on amendment 1. I reviewed the evidence the caller collected at this head and did not run gh pr view (my shell was limited to the session-id command), so land-guard must still compare Collab-Reviewed-Head with the PR's current head.

### 2026-11-02T21:54Z · agent-vitana-lane-reviewer-202611022154-b605 · review
review: accept
head: 03945dad9a192e125cdf0bc5aa60a22576065074
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4625
Findings:
- [non-blocking] .kiro/specs/mt-identity-r2/lanes/helpers-and-policy-rewrite.md. The merge changed none of the lane's own lines. Against the patch I accepted on 8468187b, all 29 non-lane files have identical git blob IDs (rewrite migration a35cbd223f with the guard at :90 and :98-102, acceptance.md 81bab3cff7 with AC-12 at :67 and its TEST: at :79, pre-check.sql 4cf4550952, post-check.sql 747c716108, Jest file 5de230aff2). The lane file differs only by the 13 lines of the 8468187b accept entry (base blob 209aaf2007 unchanged, insertions 4289 to 4302). The builder's reflog shows 03945dad as an ort merge of origin/main on top of db538376. At the merged head supabase/migrations holds the same 673 pre-lane files (newest 20261101110100), no other file defines is_member, tenant_id_for_policies or current_tenant_id() beyond the 20251229 and 20260218 definitions, and the gate window is unchanged (VALIDATOR-CHECK.yml:192, validate-pr-locally.cjs:120). Checklist items 2, 5, 6 and 9 (paths, test weakening, live writes, protected gate files) show no finding.
- [non-blocking] services/gateway/test/mt-identity-bare-policy-lint.test.ts. No check-run list for 03945dad was in the evidence folder and my shell was limited to the session-id command, so I saw no check run on this head. The builder's local preflight on 03945dad against base b0450c97 passed all eight checks (pf-h5.txt: Collab tests, Collab handoff, Lane scope, four PR-GATE checks, Kiro steering). The land step waits for every required check on this head (validate-pr with the Acceptance Mapping Gate, pr-gate, Lane scope, Collab handoff, Gateway Service Tests and the gateway jobs that run the 8-test lint file).
- [non-blocking] docs/validation/VTID-05465/migration-queue-rows.md:10. The rows are numbered #11 and #12 after '#10', but docs/multitenancy/MIGRATION-QUEUE.md on main now has a row #11 (the vitana-v1 migration 20261101090000_vtid_05245_tenant_email_branding.sql, status queued). Whoever adds these rows to the queue file (it is outside this lane's paths) numbers them #12 and #13 and keeps them after #11. No effect on the files in this PR.
- [non-blocking] docs/validation/VTID-05465/pre-check.sql:59. Still open from my earlier entries (file unchanged, blob 4cf4550952). No read-only query lists the live SELECT policies on public.user_tenants or the prosecdef of current_tenant_id() (section 3 at :59 reads md5(prosrc) of current_tenant_id(), section 5 at :75 reads the function text). The 20260218 body is not SECURITY DEFINER (20260218000000_fix_maxina_signup_tenant_association.sql:33-36), so today's bare policies resolve a tenant for members without app_metadata.active_tenant_id only while user_tenants_select_own exists (20251231000000_vtid_01101_phase_a_bootstrap.sql:111), and the rewrite would give those members their primary tenant. Add the query before the apply request and quote its result there.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:79. Still open from my earlier entry (file unchanged, blob 81bab3cff7). AC-12's TEST: line cites outputs/pglite-apply-rollback-reapply.txt (run at 3e787184e4, no guard-refusal line) and outputs/jest-green.txt (the 7-test run), and AC-7 at :53 says 7 of 7. The guard evidence is outputs/live-body-guard-green.txt, outputs/pglite-run-after-guard.txt and outputs/jest-live-body-guard-green.txt (8 of 8). Correct the citations and the count with the next change to this folder, and keep AC-12's TEST: line within 12 lines of the AC-12 line. This is not a reason to hold the merge, because another push needs a new review of the head.
- [non-blocking] docs/validation/VTID-05465/commands.log. Still open from my earlier entry (file unchanged, blob fa8e30640f). commands.log ends with the fix-forward 1 section: no entry for commits 8468187bcc, db538376 and 03945dad (the merge of main), and no validate-pr-locally.cjs run. Add the entry with the next change to this folder. Until then the validate-pr job on the head decides.
Next: the land step merges under §7b once every check on this head is green. The lane is accepted for merging files only. No apply before the owner has read pre-check.sql sections 5, 6 and 6b on the target database and has either waived AC-8 (PGlite with a pgTAP shim, no CI runner) or seen the files run on the D11 stack with real pgTAP (§7d). If section 5 shows a false marker, the seat parks the lane with the five-part stop message for a plan decision on amendment 1. The commit that appends this entry touches only the lane file, so this accept stays valid for it (land-guard rule b). A further merge of main is not covered by rule b and needs a new review. I judged the evidence the caller collected plus read-only reads of the lane checkout at this head, and did not run gh pr view (my shell was limited to the session-id command). The checkout's local and remote-tracking branch refs both read 03945dad, but land-guard must still compare Collab-Reviewed-Head with the PR's current head.
