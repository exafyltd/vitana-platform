---
lane: tenant-lifecycle-db
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102070300_vtid_*_mt_tenant_deactivate.sql
  - supabase/migrations/20261102070350_vtid_*_mt_tenant_archive_switch.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-07T13:35Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05493
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-tenant-admin-r2/tenant-lifecycle-db
pr: https://github.com/exafyltd/vitana-platform/pull/4788
---
# Tenant lifecycle DB — deactivate/archive + closing switch RPC (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin-r2/plan.md` (authoritative) and the `tenant-lifecycle-db` section of `tasks.md`.
Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Owns deactivate/archive end to end at the DB layer (CROSS-SPEC O2): `deactivate_tenant(slug)` / `archive_tenant(slug)`
RPCs and the **closing switch RPC** change so a deactivated tenant's members resolve to the default tenant (never a
hard lockout — the gateway reads `is_active` at `services/gateway/src/routes/admin-tenants.ts:253` and already excludes
inactive tenants from switch targets; this lane makes the member-resolution side safe). Migrations `070300`/`070350`,
sorting after mt-community-isolation-r2 C3 (`070160`) and after P2/P3. Each ships a rollback under
`docs/validation/<vtid>/`, read-only pre/post checks, a MIGRATION-QUEUE row in the same PR; expand/contract only,
`lock_timeout` + retries, snapshot before any data move. The lane adds its own `docs/validation/<vtid>/` in the PR.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, **no Supabase or AWS writes** — a DB change is a migration file applied later
by Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d). Work only inside the allowed paths. Branch `kiro/mt-tenant-admin-r2/tenant-lifecycle-db`;
PR title `VTID-xxxxx (mt-tenant-admin-r2/tenant-lifecycle-db): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-tenant-admin-r2/tenant-lifecycle-db`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:50Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-tenant-admin/tenant-lifecycle-db`. Versions day-shifted to `20261102070*`. Executor and reviewer follow today's §3a/§7 rules.

### 2026-11-02T16:20Z · ci-plan-spar · ready (VTID allocated)
VTID-05493 allocated after policy approval (converged-auto-v1).

### 2026-11-07T12:45Z · agent-vitana-lane-reviewer-202611071241-c2a8 · review
review: accept
head: 1eb7538e52067114364359b8184231cef8b0ed68
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4788
Findings: non-blocking: default-tenant fallback depends on open_signup (owner to confirm); non-blocking: queue rows 30-31 collide with PR #4787, renumber on second landing; non-blocking: current_tenant_id() unchanged by design; non-blocking: migrations need owner approval before apply, CI result taken from the caller
Next: the land step merges under §7b

### 2026-11-07T13:20:00Z · agent-vitana-lane-reviewer-202611071317-ab43 · review
review: accept
head: c8d8327c8c7e604e5e70b2c1a05581f5c1c47ea2
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4788
Findings: non-blocking: acceptance.md still says queue rows 30-31 and count 113 (now 32-33 and 119); MIGRATION-QUEUE note says "Row 30 creates the snapshot table" (should be row 32); route 401 not independently confirmed by me (shell blocked the grep), relying on the caller's account, validator output and green CI; pgTAP and static pins sit under docs/validation/ and are not run by CI (recorded deviation); nothing applied, migrations need owner approval (section 7d)
Next: the land step merges under §7b

### 2026-11-07T13:30Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-tenant-admin-r2/tenant-lifecycle-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T13:30Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4788. Reviewed on head `c8d8327c8c` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T13:30Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 9d4aa61c2434b54e989c333b1563d9c94b1829f5 (exafyltd/vitana-platform#4788)
authority: §7b PM rule. Squash merge by land-guard on head `f375fee508`: the reviewed head `c8d8327c8c` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T13:35Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record: merge 9d4aa61c2434b54e989c333b1563d9c94b1829f5 (#4788) changes no path under services/gateway or the stage deploy workflow (supabase migrations, tests, docs and the drift baseline only), so AWS-STAGE-DEPLOY-GATEWAY and STAGING-VERIFY did not run for it: this change deploys nothing. It is done at merge with green checks (12/12 on the final head). The migrations 20261102070300 and 20261102070350 are on main and NOT applied; applying them needs the owner's approval per file and database (collaboration.md §7d). The lane claim is released once this record is on main.

### 2026-11-10T09:45Z · kiro-hotmail-202611061752-cc1f · audit
Suites ran 6/6 pass (pgTAP 72 ok, 72 ok applied twice, read-only checks and rollback, node static-pins 25 pass, bare-policy-lint 0, drift test 8) on origin/main 6dc6e1ba0c; flag gate: no MT_RESOLUTION_V2 or feature_flags.mt.* read inside the migrations (only the comment at 070300:22 says the gateway routes that call deactivate_tenant/archive_tenant stay behind MT_RESOLUTION_V2); those two functions have no caller yet; FINDING: 070350 replaces the live switch_to_tenant_by_slug body (a deactivated-tenant fallback, unflagged) and v1 src/hooks/useTenant.tsx calls it; pre-migration safe: yes, no gateway or v1 code changed; 070350 refuses unless the VTID-05043 open_signup body is present (070350:38-39); evidence: docs/validation/VTID-05493/audit-m0/run.txt (command and exit code per suite).
