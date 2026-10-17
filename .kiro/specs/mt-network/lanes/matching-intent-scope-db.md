---
lane: matching-intent-scope-db
state: ready
next_actor: owner
depends_on: [network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101053***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-matching-scope.pgtap.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/matching-intent-scope-db — daily_matches/intent scope + Vitana Index removal (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `matching-intent-scope-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. No `area`; DB seat `hotmail`.

DB lane (§4.7): add `daily_matches.scope` (+ tenant context) and backfill per D15; change the intent matchers' default from `'public'` to the caller scope; add a scope param to `resolve_recipient_candidates`; remove Vitana Index inputs from matching and keep `match_reasons` free of health-derived codes (D25); register the matchers in the lineage-guard inventory (mt-guardrails — stated dependency, do not duplicate the list). Rollback + pre/post checks + MIGRATION-QUEUE row in this PR; own `docs/validation/<vtid>/`. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Depends on `network-visibility-db` (network pool = `network_visible`). Work only inside the allowed paths.

Branch `kiro/mt-network/matching-intent-scope-db`; PR title `VTID-xxxxx (mt-network/matching-intent-scope-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/matching-intent-scope-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101053000`–`20261101053959`. Held until the VTID is allocated.
