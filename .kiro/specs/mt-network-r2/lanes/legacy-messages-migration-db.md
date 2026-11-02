---
lane: legacy-messages-migration-db
state: ready
next_actor: kiro
depends_on: [messaging-send-db, network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102052***_*.sql
  - supabase/tests/mt-network-legacy-migration.pgtap.sql
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/legacy-messages-migration-db — migrate & retire legacy message tables (repo vitana-platform (one tree per object, re-plan R1-F1))

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `legacy-messages-migration-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7) with a data move: snapshot `bak_*` (retain 30 days) before freezing + migrating the 12 `messages` / 5 `message_threads` rows and the `global_message_threads`/`global_messages` (60/379) into `chat_messages`/`chat_groups` per the D15 single rule (shared tenant → Community, else Network), then drop the legacy tables. Pre-approved rollback restores from `bak_*`; read-only pre/post row-count checks in the PR; own `docs/validation/<vtid>/`. **The platform MIGRATION-QUEUE row + drift-baseline are a platform-side follow-up, not this v1 PR** — note the queue position (after `network-visibility-db`) in the PR body. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `messaging-send-db` (the platform `chat_messages.scope` column) and `network-visibility-db`. Work only inside the allowed paths.

Branch `kiro/mt-network-r2/legacy-messages-migration-db`; PR title `VTID-xxxxx (mt-network-r2/legacy-messages-migration-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/legacy-messages-migration-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/legacy-messages-migration-db`. Moved to the vitana-platform migration tree (one tree per object, R1-F1), seat `hotmail`. Versions day-shifted to `20261102050*`. Reviewer agent.
