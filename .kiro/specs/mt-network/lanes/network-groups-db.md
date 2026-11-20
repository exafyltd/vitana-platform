---
lane: network-groups-db
state: ready
next_actor: owner
depends_on: [messaging-send-db, legacy-messages-migration-db]
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101054***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-groups-db.pgtap.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/network-groups-db — chat_groups scope + add_group_member (M3, flagged) (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `network-groups-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. No `area`; DB seat `hotmail`. **M3 lane — the LAST DB lane of this spec; flagged `mt.network_groups`.** mt-network OWNS Network groups (CROSS-SPEC "Network groups"); mt-m3 only references them.

DB lane (§4.7): add `chat_groups.scope`/`chat_group_members.scope`, participant-only RLS, `add_group_member()` DEFINER (≤20, invite-only between connections, creator tenant as context, no system fan-out — D27). Rollback + pre/post checks + MIGRATION-QUEUE row (LAST) in this PR; own `docs/validation/<vtid>/`. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Depends on `messaging-send-db` and `legacy-messages-migration-db` (legacy group threads already migrated into `chat_groups`). Work only inside the allowed paths.

Branch `kiro/mt-network/network-groups-db`; PR title `VTID-xxxxx (mt-network/network-groups-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/network-groups-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101054000`–`20261101054959`. Held until the VTID is allocated.
