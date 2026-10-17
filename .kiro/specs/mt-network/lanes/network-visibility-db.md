---
lane: network-visibility-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101051***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-visibility-db.pgtap.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/network-visibility-db — network_visible column + rule-45 trigger (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `network-visibility-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. No `area` (supabase/migrations not in `areas.yaml`); DB seat `hotmail`.

DB lane (§4.7): migration + rollback + pre/post checks + MIGRATION-QUEUE row in this PR; own `docs/validation/<vtid>/`. Adds `global_community_profiles.network_visible` (default false) + `network_visible_decided_at` and the rule-45 BEFORE INSERT/UPDATE trigger. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Work only inside the allowed paths.

Branch `kiro/mt-network/network-visibility-db`; PR title `VTID-xxxxx (mt-network/network-visibility-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/network-visibility-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101051000`–`20261101051959`. Held until the VTID is allocated.
