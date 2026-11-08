---
lane: matching-intent-scope-db
state: done
next_actor: kiro
depends_on: [network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102053***_*.sql
  - supabase/tests/mt-network-matching-scope.pgtap.sql
updated: 2026-11-07T18:31Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05575
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-network-r2/matching-intent-scope-db
pr: https://github.com/exafyltd/vitana-platform/pull/4833
---
# mt-network-r2/matching-intent-scope-db — daily_matches/intent scope + Vitana Index removal (repo vitana-platform (one tree per object, re-plan R1-F1))

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `matching-intent-scope-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): add `daily_matches.scope` (+ tenant context) and backfill per D15, respecting the existing unique key `(tenant_id,user_id,match_date,match_type,target_id)`; change the intent matchers' `p_visibility` default from `'public'` to the caller scope; remove Vitana Index inputs from matching so `daily_matches.match_reasons` carries no health-derived code (D25); register the v1 recompute + intent matchers in the lineage-guard inventory (mt-guardrails — stated dependency, do not duplicate the list). Rollback + read-only pre/post checks in the PR; own `docs/validation/<vtid>/`. **The MIGRATION-QUEUE row (platform `docs/multitenancy/MIGRATION-QUEUE.md`) and drift-baseline are added by a platform-side step, not this v1 PR** — note the queue position (after `network-visibility-db`) in the PR body for the queue owner. `resolve_recipient_candidates` scope lives in `orb-recipient-scope-gateway`, not here. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `network-visibility-db` (network pool = `network_visible`). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/matching-intent-scope-db`; PR title `VTID-xxxxx (mt-network-r2/matching-intent-scope-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/matching-intent-scope-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/matching-intent-scope-db`. Moved to the vitana-platform migration tree (one tree per object, R1-F1), seat `hotmail`. Versions day-shifted to `20261102050*`. Reviewer agent.

### 2026-11-06T10:10Z · ci-plan-spar · ready (VTID allocated)
VTID-05575 allocated after policy approval (converged-auto-v1).

### 2026-11-07T18:05Z · agent-vitana-lane-reviewer-202611071801-51ba · review
review: accept
head: 0d583d0f22ff988c5261533fb5f858017cba290b
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4833
Findings: non-blocking: (1) CI check runs on the head could not be read by the reviewer (sandbox denied gh api/run list; gh pr checks needs GraphQL), so the land step must confirm every required check is green on this head; (2) no MIGRATION-QUEUE.md rows (paths exclude the file; the queue position is in acceptance.md) and no DATABASE_SCHEMA.md update (paths exclude it), both must be added by the platform-side step before any RUN-MIGRATION dispatch (§7d); (3) migration-drift-baseline not touched (no new table), confirm the drift check is green; (4) community rows with no tenant_id still accepted and health-reason clean-up not archived, both documented and tracked until matching-discover-scope-v1; (5) evidence is in-process PGlite with a pgTAP shim, CI is authoritative for the real pgTAP run.
Next: the land step verifies all checks green on this head, then merges under §7b; the platform-side step adds the MIGRATION-QUEUE rows and DATABASE_SCHEMA.md entry before the owner approves the apply.

### 2026-11-07T18:25Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-network-r2/matching-intent-scope-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T18:25Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4833. Reviewed on head `0d583d0f22` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T18:25Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 5e5aa4859ded1253292f1b2242327ad32f90a353 (exafyltd/vitana-platform#4833)
authority: §7b PM rule. Squash merge by land-guard on head `bff1abf015`: the reviewed head `0d583d0f22` plus the review-entry commit and a clean merge of main (afeb5b7a81, #4832). `land-guard review` ok, `land-guard checks` green (12 checks), PR up to date. No lane code changed after the accept.
The migration in this lane is in the repository and NOT applied. Applying it needs the owner's approval per file and database (collaboration.md §7d). Next: the `done` record.

### 2026-11-07T18:31Z · kiro-hotmail-202611061752-cc1f · verified → done
This lane deploys nothing: it adds a migration file (20261102053*) with rollback and a pgTAP test, none applied. No staging deploy follows from the merge (5e5aa4859d), so there is no STAGING-VERIFY run for it; it is done at merge with green checks (12 green on head bff1abf015). Still owed before any apply (collaboration.md §7d): the MIGRATION-QUEUE.md rows and the DATABASE_SCHEMA.md entry, added by the platform-side step, then the owner's approval of the files and the target database. Non-blocking review notes carried forward: confirm the migration-drift check, community rows with no tenant_id still accepted and health-reason clean-up not archived (tracked until matching-discover-scope-v1), evidence is in-process PGlite so CI is authoritative for the real pgTAP run.
