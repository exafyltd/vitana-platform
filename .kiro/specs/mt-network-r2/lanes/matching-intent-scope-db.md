---
lane: matching-intent-scope-db
state: ready
next_actor: kiro
depends_on: [network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102053***_*.sql
  - supabase/tests/mt-network-matching-scope.pgtap.sql
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/matching-intent-scope-db — daily_matches/intent scope + Vitana Index removal (repo vitana-platform (one tree per object, re-plan R1-F1))

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `matching-intent-scope-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): add `daily_matches.scope` (+ tenant context) and backfill per D15, respecting the existing unique key `(tenant_id,user_id,match_date,match_type,target_id)`; change the intent matchers' `p_visibility` default from `'public'` to the caller scope; remove Vitana Index inputs from matching so `daily_matches.match_reasons` carries no health-derived code (D25); register the v1 recompute + intent matchers in the lineage-guard inventory (mt-guardrails — stated dependency, do not duplicate the list). Rollback + read-only pre/post checks in the PR; own `docs/validation/<vtid>/`. **The MIGRATION-QUEUE row (platform `docs/multitenancy/MIGRATION-QUEUE.md`) and drift-baseline are added by a platform-side step, not this v1 PR** — note the queue position (after `network-visibility-db`) in the PR body for the queue owner. `resolve_recipient_candidates` scope lives in `orb-recipient-scope-gateway`, not here. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `network-visibility-db` (network pool = `network_visible`). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/matching-intent-scope-db`; PR title `VTID-xxxxx (mt-network-r2/matching-intent-scope-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/matching-intent-scope-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/matching-intent-scope-db`. Moved to the vitana-platform migration tree (one tree per object, R1-F1), seat `hotmail`. Versions day-shifted to `20261102050*`. Reviewer agent.
