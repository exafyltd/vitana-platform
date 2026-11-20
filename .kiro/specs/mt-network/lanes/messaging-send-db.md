---
lane: messaging-send-db
state: ready
next_actor: owner
depends_on: [network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101050***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/messaging-send-db — scope column, send/connection RPCs, client-write revokes (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `messaging-send-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID and flips it to `kiro` — do not start before then. No `area` entry: `supabase/migrations/**` is not in `areas.yaml`, so the planner assigned the DB seat `hotmail` per the brief's uncovered-platform rule (supabase/migrations + DB lanes → hotmail).

DB lane (§4.7), **platform** `chat_messages` only: adds `chat_messages.scope` (expand/contract), **DROPs the catch-all `service_role_manage_chat` policy (`20260225200000_chat_messages.sql:35-36`) and replaces it with narrow SELECT + `read_at`-UPDATE policies** so a service-role client can no longer direct-INSERT arbitrary scope/tenant (R1-F3; SECURITY DEFINER RPCs bypass RLS as owner for INSERT), revokes the authenticated client INSERT on `chat_messages`, and creates `send_message()` + `send_message_as()`. **The `connection_requests` RPCs/revokes moved to `network-visibility-db` and the `global_messages` revoke to `legacy-messages-migration-db` — both are vitana-v1 tables (R1-F4/F5), not this platform lane.** Migration + rollback + read-only pre/post checks + MIGRATION-QUEUE row, all in this PR; own `docs/validation/<vtid>/`. Kiro never applies — Claude via RUN-MIGRATION after merge.

§7a rules: no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another lane file, no merge/approve/deploy/workflow dispatch, no Supabase/AWS writes. Depends on `network-visibility-db` — `send_message`'s network branch reads `global_community_profiles.network_visible`/`messaging_preference` and `connection_requests` state (all added by that v1 lane). Work only inside the allowed paths.

Branch `kiro/mt-network/messaging-send-db`; PR title `VTID-xxxxx (mt-network/messaging-send-db): …`; commit trailers `Collab-Session: <your kiro session id>`, `Collab-Lane: mt-network/messaging-send-db`. When the PR is open: `state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Owns the platform `chat_messages.scope` expand/contract, `send_message()`/`send_message_as()`, the client-INSERT revoke and the `service_role_manage_chat` policy swap on `chat_messages`. Migration range `20261101050000`–`20261101050959`; executor renumbers if a later migration exists and inserts the MIGRATION-QUEUE rows at the WS3/M1 position. Held until the VTID is allocated.
### 2026-10-18T19:40Z · kiro-hotmail-202610151618-b437 · replan (s2-round-1 R1-F3/F4/F5)
Narrowed to the platform `chat_messages` table: added the DROP of the catch-all `service_role_manage_chat` RLS policy (R1-F3). Moved the `connection_requests` RPCs/revokes to `network-visibility-db` and the `global_messages` revoke to `legacy-messages-migration-db` — both are vitana-v1 tables. Stays platform (seat `hotmail`, reviewer `jtadic`).
