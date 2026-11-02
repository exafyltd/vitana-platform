---
lane: messaging-send-db
state: ready
next_actor: kiro
depends_on: [network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102050***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/messaging-send-db — scope column, send/connection RPCs, client-write revokes (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `messaging-send-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7), **platform** `chat_messages` only: adds `chat_messages.scope` (expand/contract), **asserts the catch-all `service_role_manage_chat` policy stays gone (created `20260225200000_chat_messages.sql:35-38`, already DROPPED by `20260608120000_phase_a_security_hotfix.sql:25`; re-plan R1-F4) and replaces it with narrow SELECT + `read_at`-UPDATE policies** so a service-role client can no longer direct-INSERT arbitrary scope/tenant (R1-F3; SECURITY DEFINER RPCs bypass RLS as owner for INSERT), revokes the authenticated client INSERT on `chat_messages`, and creates `send_message()` + `send_message_as()`. **The `connection_requests` RPCs/revokes moved to `network-visibility-db` and the `global_messages` revoke to `legacy-messages-migration-db` — both are vitana-v1 tables (R1-F4/F5), not this platform lane.** Migration + rollback + read-only pre/post checks + MIGRATION-QUEUE row, all in this PR; own `docs/validation/<vtid>/`. Kiro never applies on its own — Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d), after merge.

§7a rules: no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another lane file, no merge/approve/deploy/workflow dispatch, no Supabase/AWS writes. Depends on `network-visibility-db` — `send_message`'s network branch reads `global_community_profiles.network_visible`/`messaging_preference` and `connection_requests` state (all added by that v1 lane). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/messaging-send-db`; PR title `VTID-xxxxx (mt-network-r2/messaging-send-db): …`; commit trailers `Collab-Session: <your kiro session id>`, `Collab-Lane: mt-network-r2/messaging-send-db`. When the PR is open: `state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/messaging-send-db`. Versions day-shifted to `20261102050*`. Reviewer agent.
