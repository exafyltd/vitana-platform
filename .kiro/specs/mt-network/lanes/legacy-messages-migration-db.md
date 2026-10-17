---
lane: legacy-messages-migration-db
state: ready
next_actor: owner
depends_on: [messaging-send-db, network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101052***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-legacy-migration.pgtap.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/legacy-messages-migration-db — migrate & retire legacy message tables (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `legacy-messages-migration-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. No `area`; DB seat `hotmail`.

DB lane (§4.7) with a data move: snapshot `bak_*` (retain 30 days) before migrating the 12 `messages` / 5 `message_threads` rows and the `global_message_threads`/`global_messages` into `chat_messages`/`chat_groups` per the D15 single rule, then drop the legacy tables. Pre-approved rollback restores from `bak_*`; read-only pre/post row-count checks; MIGRATION-QUEUE row in this PR; own `docs/validation/<vtid>/`. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Depends on `messaging-send-db` (the `scope` column) and `network-visibility-db`. Work only inside the allowed paths.

Branch `kiro/mt-network/legacy-messages-migration-db`; PR title `VTID-xxxxx (mt-network/legacy-messages-migration-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/legacy-messages-migration-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101052000`–`20261101052959`. Held until the VTID is allocated.
