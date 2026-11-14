---
lane: matching-intent-scope-db
state: ready
next_actor: owner
depends_on: [network-visibility-db]
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
paths:
  - supabase/migrations/20261101053***_*.sql
  - supabase/tests/mt-network-matching-scope.pgtap.sql
updated: 2026-10-18T19:40Z
---
# mt-network/matching-intent-scope-db — daily_matches/intent scope + Vitana Index removal (repo vitana-v1)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `matching-intent-scope-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. **This is a vitana-v1 migration** — `daily_matches` (v1 `20251111124306`), `intent_matches`/`compute_intent_matches` (v1 `20260501*`) and the `generate-daily-matches` Edge Function all live in vitana-v1, not platform (R1-F1/F2/F5). Seat `exafyltd` (v1), reviewer `hotmail`.

DB lane (§4.7): add `daily_matches.scope` (+ tenant context) and backfill per D15, respecting the existing unique key `(tenant_id,user_id,match_date,match_type,target_id)`; change the intent matchers' `p_visibility` default from `'public'` to the caller scope; remove Vitana Index inputs from matching so `daily_matches.match_reasons` carries no health-derived code (D25); register the v1 recompute + intent matchers in the lineage-guard inventory (mt-guardrails — stated dependency, do not duplicate the list). Rollback + read-only pre/post checks in the PR; own `docs/validation/<vtid>/`. **The MIGRATION-QUEUE row (platform `docs/multitenancy/MIGRATION-QUEUE.md`) and drift-baseline are added by a platform-side step, not this v1 PR** — note the queue position (after `network-visibility-db`) in the PR body for the queue owner. `resolve_recipient_candidates` scope lives in `orb-recipient-scope-gateway`, not here. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Depends on `network-visibility-db` (network pool = `network_visible`). Work only inside the allowed paths.

Branch `kiro/mt-network/matching-intent-scope-db`; PR title `VTID-xxxxx (mt-network/matching-intent-scope-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/matching-intent-scope-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101053000`–`20261101053959`. Held until the VTID is allocated.
### 2026-10-18T19:40Z · kiro-hotmail-202610151618-b437 · replan (s2-round-1 R1-F1/F2/F5)
Reassigned to vitana-v1: the matching tables and the `generate-daily-matches` Edge Function are v1, not platform. Seat `hotmail`→`exafyltd`, reviewer `jtadic`→`hotmail`; dropped the platform-only `services/gateway/test` + MIGRATION-QUEUE + drift-baseline paths (v1 has none); pgTAP now `supabase/tests/`. The queue row is a platform follow-up.
