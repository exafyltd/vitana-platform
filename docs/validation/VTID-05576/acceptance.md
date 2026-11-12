# VTID-05576 - mt-network-r2 / messaging-send-db

Plan: `.kiro/specs/mt-network-r2/plan.md` and the `messaging-send-db` group of `tasks.md` (tasks 1-5). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, Jest source check, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md section 7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| 1 expand: `chat_messages.scope`, CHECK, backfill, scope guard trigger | `supabase/migrations/20261102050000_vtid_05576_chat_messages_scope.sql` |
| 2 `send_message()` / `send_message_as()` and the shared core | `supabase/migrations/20261102050100_vtid_05576_send_message_rpcs.sql` |
| 1 contract + 3 lockdown: drop default, narrow policies, revoke client INSERT/UPDATE | `supabase/migrations/20261102050200_vtid_05576_chat_messages_lockdown.sql` |
| 4 rollbacks | `rollback-050200-chat-messages-lockdown.sql`, `rollback-050100-send-message-rpcs.sql`, `rollback-050000-chat-messages-scope.sql` (this order) |
| 4 read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| 4 queue + drift | `docs/multitenancy/MIGRATION-QUEUE.md` rows 45-47, `scripts/ci/migration-drift-baseline.json` comment (no table is created) |
| 5 pgTAP (62 cases) | `pgtap/mt-network-messaging-send-db.pgtap.sql` + `pgtap/vtid_05576_fixture.sql`; Jest wrapper `services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts` |

Apply order: 050000, 050100, then 050200 only after the gateway lane `messaging-send-gateway` is deployed. Rollback order:
050200, 050100, 050000 (the scope rollback refuses while the RPCs or any network message exist).

## Acceptance

AC-1 `chat_messages.scope text NOT NULL` with a CHECK limited to community and network; the migration default is dropped in
the contract file; every pre-existing row (DM and group message) is backfilled to community.
TEST: pgTAP cases 1-5 (services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts "task 1" group).

AC-2 A bare authenticated INSERT fails, an anon INSERT fails, and a direct service-role INSERT fails once it names scope
network or no scope; a direct service-role UPDATE of scope fails; a system writer can still INSERT an explicit community row.
TEST: pgTAP cases 6-11.

AC-3 The catch-all service_role_manage_chat policy stays gone (catalog check), no allow-all, ALL or INSERT policy remains, and
the client policies are the narrow participant SELECT, the group-member SELECT and a recipient-only read marker; a recipient
can set read_at but cannot rewrite content or scope; a participant still reads, a non-participant reads nothing.
TEST: pgTAP cases 12-23 (and the "task 3" group of the Jest wrapper).

AC-4 `send_message()`, `send_message_as()` and the shared core are SECURITY DEFINER with a pinned search_path;
`send_message` takes no sender and uses `auth.uid()`; `send_message_as` is EXECUTE for service_role only; the core for nobody;
unauthenticated, bad scope, blank body, self, neither-or-both targets all fail.
TEST: pgTAP cases 24-37 (and the "task 2" group of the Jest wrapper).

AC-5 A community send needs a shared non-platform tenant and derives tenant_id from it; a send with no shared tenant fails; a
group send needs membership and uses the group's tenant; a network group send is refused; a repeated client_message_id returns
the stored row.
TEST: pgTAP cases 38-46.

AC-6 A network send needs both members network_visible; refuses a "nobody" recipient, a "connections" recipient without an
accepted connection (either direction), a block in either direction, a service/test account, and the 21st new contact in 24
hours; the row carries scope network and the sender's context tenant; `send_message_as` applies the same checks and trusts
`p_sender`.
TEST: pgTAP cases 47-62.

AC-7 Rollbacks restore the previous grants and policies and drop the objects; the scope rollback refuses to destroy network
messages; all three migrations re-apply cleanly and apply twice.
TEST: pglite-harness/checks.sh (outputs/checks.txt) and lane.sh --twice (outputs/green-run2-twice.txt).

## Evidence (all in-process PGlite, PostgreSQL 18 wasm, with a pgTAP-compatible shim)

- RED on `origin/main` state (fixture only, no migrations): `outputs/red-origin-main.txt` (`column "scope" does not exist`);
  Jest wrapper on a clean `origin/main` checkout: `outputs/red-jest-origin-main.txt` (17 of 19 fail).
- RED with only the first two files (no contract): `outputs/red-expand-only.txt`.
- GREEN: `outputs/green-run1.txt` (62 ok), `outputs/green-run2-twice.txt` (applied twice, 62 ok), `outputs/green-jest.txt` (19 pass).
- Four mutations each turn the file red; restored -> 62 ok: `outputs/mutations.txt`.
- Read-only checks, rollbacks, refused rollbacks and re-apply: `outputs/checks.txt`.
- `node scripts/ci/bare-policy-lint.mjs`: 0 bare policies; jest `mt-identity-bare-policy-lint` 8 pass;
  `node --test scripts/ci/check-migration-drift.test.cjs` 8 pass.
- NOT run here: real pgTAP on a Supabase stack and the full production schema (no docker/psql/supabase CLI). CI is authoritative.

## Decisions taken (most conservative option inside the plan)

- Expand/contract is split across two files: 050000 keeps `DEFAULT 'community'` so today's gateway writers keep working; the
  default drop, policy replacement and INSERT/UPDATE revoke are in 050200, to be applied only after `messaging-send-gateway`
  is deployed (stated in the file header and the queue row).
- "A direct service-role INSERT fails": service_role bypasses RLS, so the policy drop alone cannot stop it. Two mechanisms do:
  a BEFORE INSERT/UPDATE OF scope guard trigger (only the RPCs, which set the transaction-local flag `vitana.chat_send_rpc`, can
  write or change a non-community scope) and the dropped default (an insert that names no scope fails 23502). System writers
  that name `scope = 'community'` keep working; service_role keeps its table privileges.
- The rate limit counts distinct NEW network recipients in 24 hours from `chat_messages` itself (ceiling 20); no
  `message_first_contact_log` table is added (design.md open question answered: reuse `chat_messages`), so no drift-baseline table entry.
- The shared-tenant test ignores the platform tenant (`tenants.is_platform`); of several shared tenants the sender's primary one wins.
- Network sends are refused for service_bot_accounts / notification_test_actors / platform_only_accounts (rules 43-45) on
  either side, in addition to the network_visible flag; platform_only_accounts is read dynamically only when it exists.
- The senders' per-request UPDATE column grant is `read_at`, `delivered_at` only (the two columns the gateway read paths set).
- The shared core returns the full `chat_messages` row so the gateway needs no second read.
