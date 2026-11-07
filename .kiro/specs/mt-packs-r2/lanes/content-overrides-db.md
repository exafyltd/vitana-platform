---
lane: content-overrides-db
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261101100000_mt_packs_tenant_content_overrides.sql
  - supabase/tests/mt/mt_packs_tenant_content_overrides.sql
  - scripts/ci/migration-drift-baseline.json
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-07T15:23Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05495
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-packs-r2/content-overrides-db
pr: https://github.com/exafyltd/vitana-platform/pull/4789
---
# content-overrides-db — WS5 `tenant_content_overrides` (DB) — mt-packs-r2

Plan: `../plan.md` (Re-plan answers, Fix, Migrations). Tasks, paths and acceptance are in `../tasks.md`
(`<!-- lane: content-overrides-db -->`). The VTID comes from PLAN-SPAR on convergence, never by hand.

Scope:
- Create `tenant_content_overrides(tenant_id, locale, key, value, updated_by, updated_at)`, with PK
  `(tenant_id, locale, key)` and an FK to `tenants`.
- It is service-role-only: RLS on, client privileges revoked, the same pattern as the `mt-launch` tables.
- Version `20261101100000`, so it sorts before `mt-launch`'s `20261101110000`.
- Its MIGRATION-QUEUE row goes directly before row 9. `mt-launch` rows 9–10 (VTID-05324) wait for this apply.
- No reader in this spec.

Rules (§7a): a migration file in this PR, and no live write. After merge, Kiro applies it through `RUN-MIGRATION.yml`
only when the owner approves the file and the target database (§7d). Branch `kiro/mt-packs-r2/content-overrides-db`.
PR title `VTID-xxxxx (mt-packs-r2/content-overrides-db): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-packs-r2/content-overrides-db`.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
New lane in the re-plan. It creates the WS5 publish target that `mt-launch` depends on.

### 2026-11-02T16:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05495 allocated after policy approval (converged-auto-v1).

### 2026-11-07T13:20:00Z · agent-vitana-lane-reviewer-202611071317-7d7e · review
review: accept
head: ff0a96b626e57715d1dbc7f4e7e1d7fb75f3db34
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4789
Findings: non-blocking: baseline on this head is stale against origin/main 83f0e0603c (118 without tenant_domains; correct after re-resolve is 119 with both tenant_domains and tenant_content_overrides, plus #4788/#4791 additions); non-blocking: MIGRATION-QUEUE.md row 8a will conflict with #4788/#4791, re-resolve at landing; non-blocking: staging probe GET /api/v1/admin/moderation/reports expecting 401 is valid and read-only but generic, and no table-specific read-only route exists because nothing reads the new table; non-blocking: EXISTING_REF finding from de2209b8fc resolved; non-blocking: CI not independently verifiable here (gh pr checks unavailable), relies on caller's all-green report
Next: the land step merges under §7b after updating to latest main, re-resolving the baseline (count 119, tenant_domains kept) and the queue, re-running checks on that head, and confirming no new conflict; a re-resolve that adds more than these lines needs a fresh review

### 2026-11-07T13:40:00Z · agent-vitana-lane-reviewer-202611071337-ca35 · review
review: accept
head: 9aacc66fbe7b96583ab98c8737401792204e4c37
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4789
Findings: (1) non-blocking: baseline count 120 equals len(known_missing_tables), and the checker ignores count. (2) non-blocking: the lane diff is unchanged, and CI 12/12 green is the caller's report. Baseline resolution verified: all of main's entries and comments are kept (tenant_domains, bak_vtid_05493_tenant_lifecycle, bak_vtid_05488_partner_tenant, _comment_vtid_05507). Against main the only baseline changes are the tenant_content_overrides entry, _comment_vtid_05495 and the count. MIGRATION-QUEUE adds one row, 8a, next to main's rows, with no removals. The JSON reads as well-formed at the head.
Next: the land step merges under §7b after re-resolving the baseline against latest main if #4791 lands first

### 2026-11-07T14:25:00Z · agent-vitana-lane-reviewer-202611071422-9943 · review
review: accept
head: 9af114c29ba97673e8a738fdcf6cc0dfffbfb82d
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4789
Findings: non-blocking: migration-drift-baseline.json main had count 118 vs 119 entries, PR now 120 == 120; non-blocking: origin/main moved to 335b615 (specs-only, no hot files of this lane), land-guard re-checks up-to-date; CI 12/12 taken from the caller
Next: the land step merges under §7b

### 2026-11-07T15:20Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-packs-r2/content-overrides-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T15:20Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4789. Reviewed on head `9af114c29b` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T15:20Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 30b453aa7ab5b4f6201262f52fc414ef3fadafe5 (exafyltd/vitana-platform#4789)
authority: §7b PM rule. Squash merge by land-guard on head `474c4099c4`: the reviewed head `9af114c29b` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T15:23Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record: merge 30b453aa7ab5b4f6201262f52fc414ef3fadafe5 (#4789) changes no path under services/gateway or the stage deploy workflow (supabase migrations, tests, docs and the drift baseline only), so AWS-STAGE-DEPLOY-GATEWAY and STAGING-VERIFY did not run for it: this change deploys nothing. It is done at merge with green checks (12/12 on the final head). The migration in this lane is on main and NOT applied; applying it needs the owner's approval per file and database (collaboration.md §7d). The lane claim is released once this record is on main.
