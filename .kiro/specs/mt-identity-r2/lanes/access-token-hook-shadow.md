---
lane: access-token-hook-shadow
state: done
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/migrations/20261102032000_vtid_*_access_token_hook_shadow.sql
  - supabase/migrations/20261102032100_vtid_*_tenant_claim_mismatch_log.sql
  - supabase/migrations/20261102032000_vtid_*_access_token_hook_shadow_rollback.sql
  - supabase/tests/mt_identity_hook_*.sql
updated: 2026-11-10T09:50Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05464
branch: kiro/mt-identity-r2/access-token-hook-shadow
pr: https://github.com/exafyltd/vitana-platform/pull/4627
claimed_by: kiro-hotmail-202611061752-cc1f
---
# access-token-hook-shadow — custom access-token hook in SHADOW only (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `access-token-hook-shadow` group of `tasks.md`
(S1–S3, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence.

Scope:
- The hook function reads the active `user_tenants` membership and treats `app_metadata.active_tenant_id` as a
  preference only.
- It emits `tenant_id_shadow` ONLY and fails open: `EXCEPTION WHEN OTHERS` returns the original claims. It does a
  single indexed lookup under a short statement timeout.
- Add the `tenant_claim_mismatch_log` table for the 7-day soak. It is service-role-only: REVOKE from PUBLIC, anon
  and authenticated, RLS on, no policy.
- Migrations only. No access-token hook exists in `supabase/migrations/**` on `62990ce285`.

Out of scope here: the hook GO-LIVE (emitting a real `tenant_id`) and its Supabase auth-config enablement. That is a
separate later lane, applied by the owner per D14.

Rules (§7a): migration files in this PR, and no live write. After merge, Kiro applies them only on the owner's
approval of the files and the target database (§7d). Branch `kiro/mt-identity-r2/access-token-hook-shadow`. PR
title `VTID-xxxxx (mt-identity-r2/access-token-hook-shadow): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/access-token-hook-shadow`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/access-token-hook-shadow`. Re-verified that no hook exists in the current migrations.

### 2026-11-02T13:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05464 allocated after policy approval (converged-auto-v1).

### 2026-11-02T15:39Z · kiro-hotmail-202611011452-6d16 · ready → executing
Built in platform PR #4627 (`kiro/mt-identity-r2/access-token-hook-shadow`). The lane's files and evidence were committed on the lane branch.

### 2026-11-02T15:39Z · kiro-hotmail-202611011452-6d16 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4627 (created 2026-11-02T15:39Z). Reviewed on head `e7c8b183e00b3c4de01c6b38e1910f12c4d18e7f`, see the review entry below.

### 2026-11-05T22:15Z · agent-vitana-lane-reviewer-202611052012-d125 · review
review: accept
head: e7c8b183e00b3c4de01c6b38e1910f12c4d18e7f
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4627
Scope: requested head d9db1fd228de6adb8f55d5863e757c29685282ac is the first parent of this head. The PR head moved to e7c8b183e0 (a second merge of origin/main 0f45367bb6) during the review, so it is recorded here and d9db1fd228 is covered.
Check 1: the lane diff against origin/main is 16 added files, all under supabase/ and docs/validation/VTID-05464/, none modified or deleted, all inside the lane paths. A whole-tree diff of origin/main against the head lists only those 16 files, on d9db1fd228 (against 27de7a98d1) and on e7c8b183e0 (against 0f45367bb6).
Check 2: the governance files that e98617340b..d9db1fd228 brings in are 38 .github/workflows/*.yml files, each +6 lines. They equal origin/main byte for byte: the trees of .github, .kiro, scripts, services, infra and docs/programs have identical ids on origin/main and on the head, and the same holds for e7c8b183e0 against 0f45367bb6. The second merge adds no file under any governance or protected glob, and none under supabase/.
Check 3: the three migrations, the two test files and the docs/validation/VTID-05464 tree have identical blob and tree ids at e98617340b, d9db1fd228 and e7c8b183e0. The first-parent chain from e98617340b is the two merge commits and nothing else.
Check 4: git show --cc is empty for both merges. Git's automatic merge gives the same tree: the lane side changed only its 16 paths since the merge base, and origin/main changed none of them.
Also checked: the merged VTID-05466 migrations (031000 to 031200) do not alter user_tenants or idx_user_tenants_user. None defines or references the hook or tenant_claim_mismatch_log, and the lane's 032000 and 032100 versions sort after them.
Findings:
- non-blocking: the PR head moved to e7c8b183e0 while this review ran; recorded on the current head, d9db1fd228 covered as its first parent.
- non-blocking: 38 governance files come in with the merge, not 39 by my count; all additive concurrency blocks, none a protected gate file.
- non-blocking: CI state on the current head was not read from this seat (gh pr view and gh pr checks fail through the gateway). This accept does not certify check status.
Carried: the accept on e98617340b (no blocking findings, nine non-blocking notes) stands unchanged for the lane's own files, which are byte-identical.
Next: the land step merges under §7b after land-guard confirms every required check green on this head. A further clean merge of main that brings in no governance file keeps this review only in land-guard's --repo walk.

### 2026-11-05T22:31Z · kiro-hotmail-202611011452-6d16 · in-review → verified
merge: 78bb4b3969982bfb71f2a3d412447ac5088056e6 (exafyltd/vitana-platform#4627)
authority: §7b PM rule. Merged by kiro-hotmail-202611011452-6d16 on the reviewed head `e7c8b183e00b3c4de01c6b38e1910f12c4d18e7f`, which was the PR head at merge.

### 2026-11-05T22:31Z · kiro-hotmail-202611011452-6d16 · verified → done
Closing record: the code and evidence are on main from merge 78bb4b3969982bfb71f2a3d412447ac5088056e6. The lane claim is released once this record is on main.

### 2026-11-10T09:50Z · kiro-hotmail-202611061752-cc1f · done → done
Docs-only follow-up, no code change: owner packet for queue rows 17-18 at `docs/validation/VTID-05464/owner-packet.md`
(M0 directive stream S1). The previous claim of `kiro-hotmail-202611011452-6d16` was stale metadata on a `done` lane (no claim
ref existed); this session claimed the lane ref and took over `claimed_by` so Collab handoff matches the commits. Nothing applied,
no RUN-MIGRATION dispatch, no live database or Auth config contacted. Dry-run output: `docs/validation/VTID-05464/owner-packet-outputs/`.
