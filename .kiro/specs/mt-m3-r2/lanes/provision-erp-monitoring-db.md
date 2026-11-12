---
lane: provision-erp-monitoring-db
state: done
next_actor: kiro
depends_on: [tenant-domains-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102141000_vtid_*_mt_provision_erp_request.sql
  - supabase/migrations/20261102141000_vtid_*_mt_provision_erp_request_rollback.sql
  - supabase/migrations/20261102141100_vtid_*_mt_isolation_health_by_tenant.sql
  - supabase/migrations/20261102141100_vtid_*_mt_isolation_health_by_tenant_rollback.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-07T19:30Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05506
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-m3-r2/provision-erp-monitoring-db
pr: https://github.com/exafyltd/vitana-platform/pull/4839
---
# ERP bootstrap request + per-tenant isolation health — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks E1–E4 in `tasks.md`; design in `design.md`. Extends `provision_tenant()` to
idempotently record the §4.6 ERP bootstrap request (`tenant_settings.feature_flags.erp.bootstrap_requested`) — because
the `tenant_settings` INSERT is `ON CONFLICT (tenant_id) DO NOTHING`, the flag is set by a guarded `UPDATE ...
jsonb_set(...)` AFTER the INSERT so a re-run on an already-provisioned tenant still records it; `erp` becomes a governed
key in `tenant_settings_merge_feature_flags()` (`- 'jev' - 'erp'` for non-exafy-admin callers) — and adds
`ci_tenant_isolation_health_by_tenant()` (same counts per tenant, summing to the unchanged `ci_tenant_isolation_health()`).
Expand/contract; rollbacks + read-only pre/post checks; MIGRATION-QUEUE rows after `tenant-domains-db`. depends_on
`tenant-domains-db` only for queue ordering (shares `MIGRATION-QUEUE.md` / `migration-drift-baseline.json`); the two DB
lanes are serialised so their queue edits do not conflict. The lane adds its own `docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes (DB applies are Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database, §7d). Work only inside the allowed paths. Branch
`kiro/mt-m3-r2/provision-erp-monitoring-db`; PR title `VTID-xxxxx (mt-m3-r2/provision-erp-monitoring-db): …`; trailers
`Collab-Session` / `Collab-Lane: mt-m3-r2/provision-erp-monitoring-db`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.


## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/provision-erp-monitoring-db`. Versions day-shifted to `20261102140*`. Executor and reviewer follow today's §3a/§7 rules.

### 2026-11-02T16:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05506 allocated after policy approval (converged-auto-v1).

### 2026-11-07T18:45:00Z · agent-vitana-lane-reviewer-202611071840-75fe · review
review: accept
head: 892925c24e2d532e55a657fea07201a22bf5354e
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4839
Findings:
- none blocking. E1, E2 and E4 are met; all 27 files are in paths; the IS DISTINCT FROM 'true'::jsonb guard is correct; 'erp' is a governed key as tasked; the per-tenant isolation-health function is read-only and sums to the single-number function; the rollbacks restore the VTID-05150 bodies; queue rows 61-62; drift baseline unchanged.
- non-blocking: check runs unreadable by the reviewer, so the land step must confirm green.
- non-blocking: the pgTAP under docs/validation/VTID-05506/pgtap is not CI-run; proof is local PGlite plus six mutations.
- non-blocking: supabase/tests/vtid_05150_provision_tenant.test.sql:144 is not broken today (no workflow runs it), but its feature_flags equality would not hold on a full replay with 20261102141000. It is outside the lane paths and needs a follow-up.
- non-blocking: the migrations need owner approval per file and database (§7d).
Next: the land step merges under §7b

### 2026-11-07T18:58:00Z · agent-vitana-lane-reviewer-202611071857-4144 · review
review: accept
head: ae78da26583d119e15f5fd71705ab0a708b7079a
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4839
Findings:
- none blocking. The PR diff against origin/main (1327a3d99c) is still only this lane's 28 files; nothing under docs/validation/VTID-05506/** or the 05506 migrations changed since the accepted 892925c. MIGRATION-QUEUE.md conflict resolution is correct: main's rows 47, 51-52 and its note are untouched, rows 61-62 and their note are appended, no duplicate numbering. The prior accept's findings (E1, E2, E4, paths, guards, rollbacks, drift baseline) still hold.
- non-blocking: check runs unreadable by the reviewer (gh GraphQL unsupported); the land step must confirm the builder's 12 green checks on ae78da2658.
- non-blocking: the pgTAP under docs/validation/VTID-05506/pgtap is not CI-run; proof is local PGlite plus six mutations.
- non-blocking: supabase/tests/vtid_05150_provision_tenant.test.sql:144 is outside the lane paths and its feature_flags equality would not hold on a full replay with 20261102141000; needs a follow-up.
- non-blocking: the migrations need owner approval per file and database (§7d).
Next: the land step merges under §7b

### 2026-11-07T19:20Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-m3-r2/provision-erp-monitoring-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T19:20Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4839. Reviewed on head `ae78da2658` (accept entry above, reviewer agent claude-sonnet-5.5); an earlier accept is on `892925c24e`.

### 2026-11-07T19:20Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 32737c613234e16e8ca79aee751b9059b91c52b2 (exafyltd/vitana-platform#4839)
authority: §7b PM rule. Squash merge by land-guard on head `028391679c`: the reviewed head `ae78da2658` plus the review-entry commit and clean merges of main. `land-guard review` ok, `land-guard checks` green (12 checks), PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: the `done` record.

### 2026-11-07T19:30Z · kiro-hotmail-202611061752-cc1f · verified → done
This lane deploys nothing: it adds two migrations (20261102141000 ERP bootstrap request in provision_tenant, 20261102141100 per-tenant isolation health) with rollbacks, pgTAP and validation evidence, and MIGRATION-QUEUE rows 61-62, none applied. No staging deploy follows from the merge (32737c6132), so there is no STAGING-VERIFY run for it; it is done at merge with green checks (12 green on head 028391679c). Applying the migrations needs the owner's approval of the files and the target database (collaboration.md §7d). Non-blocking review notes carried forward: the pgTAP under docs/validation/VTID-05506/pgtap is not CI-run (proof is local PGlite plus six mutations), and supabase/tests/vtid_05150_provision_tenant.test.sql:144 is outside the lane paths and its feature_flags equality would not hold on a full replay with 20261102141000 (needs a follow-up).
