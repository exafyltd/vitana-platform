---
lane: legacy-messages-migration-db
state: ready
next_actor: owner
depends_on: [messaging-send-db, network-visibility-db]
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
paths:
  - supabase/migrations/20261101052***_*.sql
  - supabase/tests/mt-network-legacy-migration.pgtap.sql
updated: 2026-10-18T19:40Z
---
# mt-network/legacy-messages-migration-db — migrate & retire legacy message tables (repo vitana-v1)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `legacy-messages-migration-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. **This is a vitana-v1 migration** — `messages`/`message_threads` (v1 `20250917143525`) and `global_messages`/`global_message_threads` (v1 `20250917153624`) all live in vitana-v1, not platform (R1-F4). The `chat_messages`/`chat_groups` targets are platform tables in the same single Supabase project, so this v1 migration writes those already-created rows. Seat `exafyltd` (v1), reviewer `hotmail`.

DB lane (§4.7) with a data move: snapshot `bak_*` (retain 30 days) before freezing + migrating the 12 `messages` / 5 `message_threads` rows and the `global_message_threads`/`global_messages` (60/379) into `chat_messages`/`chat_groups` per the D15 single rule (shared tenant → Community, else Network), then drop the legacy tables. Pre-approved rollback restores from `bak_*`; read-only pre/post row-count checks in the PR; own `docs/validation/<vtid>/`. **The platform MIGRATION-QUEUE row + drift-baseline are a platform-side follow-up, not this v1 PR** — note the queue position (after `network-visibility-db`) in the PR body. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Depends on `messaging-send-db` (the platform `chat_messages.scope` column) and `network-visibility-db`. Work only inside the allowed paths.

Branch `kiro/mt-network/legacy-messages-migration-db`; PR title `VTID-xxxxx (mt-network/legacy-messages-migration-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/legacy-messages-migration-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101052000`–`20261101052959`. Held until the VTID is allocated.
### 2026-10-18T19:40Z · kiro-hotmail-202610151618-b437 · replan (s2-round-1 R1-F4)
Reassigned to vitana-v1 (all legacy source tables are v1). Seat `hotmail`→`exafyltd`, reviewer `jtadic`→`hotmail`; dropped platform-only paths; pgTAP now `supabase/tests/`. Queue row is a platform follow-up.
