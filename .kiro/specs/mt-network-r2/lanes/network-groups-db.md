---
lane: network-groups-db
state: ready
next_actor: kiro
depends_on: [messaging-send-db, legacy-messages-migration-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102054***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-groups-db.pgtap.test.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/network-groups-db — chat_groups scope + add_group_member (M3, flagged) (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-groups-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): add `chat_groups.scope`/`chat_group_members.scope`, participant-only RLS, `add_group_member()` DEFINER (≤20, invite-only between connections, creator tenant as context, no system fan-out — D27). Rollback + pre/post checks + MIGRATION-QUEUE row (LAST) in this PR; own `docs/validation/<vtid>/`. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `messaging-send-db` and `legacy-messages-migration-db` (legacy group threads already migrated into `chat_groups`). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-groups-db`; PR title `VTID-xxxxx (mt-network-r2/network-groups-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-groups-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-groups-db`. Versions day-shifted to `20261102050*`. Reviewer agent.
