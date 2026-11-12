# VTID-05582 - mt-network-r2 / network-visibility-db

Plan: `.kiro/specs/mt-network-r2/plan.md` and the `network-visibility-db` group of `tasks.md` (tasks 1-5). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md section 7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| 1, 2 columns, helper, rule-45 trigger | `supabase/migrations/20261102051000_vtid_05582_network_visible_profile.sql` |
| 3 revoke + `request_connection()` / `respond_connection()` | `supabase/migrations/20261102051100_vtid_05582_connection_rpcs.sql` |
| 4 rollbacks | `rollback-051100-connection-rpcs.sql` then `rollback-051000-network-visible-profile.sql` |
| 4 read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| 5 pgTAP (52 cases) | `supabase/tests/mt-network-visibility-db.pgtap.sql` + `pgtap/vtid_05582_fixture.sql` |

Apply order: 051000 then 051100. Rollback order: 051100 then 051000 (the profile rollback refuses while the RPC exists
and while any member has opted in).

## Acceptance

AC-1 `global_community_profiles` gains `network_visible boolean NOT NULL DEFAULT false`, `network_visible_decided_at
timestamptz NULL` and `messaging_preference text NOT NULL DEFAULT 'connections'` with an everyone/connections/nobody
CHECK; every existing row is false / connections.
TEST: pgTAP cases 1-7.

AC-2 A user_id in `service_bot_accounts`, `notification_test_actors` or `platform_only_accounts` cannot be set
`network_visible = true` on INSERT or UPDATE; a real member can opt in on their own row only; `network_visible_decided_at`
is stamped by the trigger and cannot be back-dated; clients cannot execute the exclusion helper.
TEST: pgTAP cases 8-17.

AC-3 `authenticated` and `anon` lose INSERT and UPDATE on `connection_requests` (table and column level); a
self-inserted `accepted` row fails; SELECT and service_role are unchanged.
TEST: pgTAP cases 18-24.

AC-4 `request_connection(p_to, p_scope, p_message)` is SECURITY DEFINER with a pinned search_path, binds the sender to
`auth.uid()`, refuses self and unknown scopes, requires a shared non-platform tenant for `community`, caps the message
at 500 characters, and is idempotent per (sender, recipient).
TEST: pgTAP cases 25-38.

AC-5 A `network` request requires both members `network_visible`, a recipient preference other than `nobody`, no
unexpired block in either direction and fewer than 20 requests by the sender in 24 hours; the free-text message is
dropped.
TEST: pgTAP cases 39-46.

AC-6 `respond_connection(p_request, p_accept)` lets only the recipient answer a still-pending request.
TEST: pgTAP cases 47-52.

AC-7 Rollbacks restore the previous grants and drop the objects; the profile rollback refuses to destroy opt-ins; both
migrations re-apply cleanly.
TEST: pglite-harness/checks.sh (outputs/checks.txt) and lane.sh --twice (outputs/green-run2-twice.txt).

## Evidence (all in-process PGlite, PostgreSQL 18 wasm, with a pgTAP-compatible shim)

- RED on `origin/main` state (fixture only, no migrations): `outputs/red-origin-main.txt` (`column "network_visible" does not exist`).
- RED with only the first migration: `outputs/red-columns-only.txt` (`request_connection` missing).
- GREEN: `outputs/green-run1.txt` (52 ok), `outputs/green-run2-twice.txt` (applied twice, 52 ok).
- Three mutations each turn the file red; restored -> 52 ok: `outputs/mutations.txt`.
- Read-only checks, rollback, refused rollback, re-apply: `outputs/checks.txt`.
- `node scripts/ci/bare-policy-lint.mjs`: 0 bare policies; jest `mt-identity-bare-policy-lint` 8 pass
  (`outputs/jest-bare-policy-lint.txt`); `node --test scripts/ci/check-migration-drift.test.cjs` 8 pass.
- NOT run here: real pgTAP on a Supabase stack and the full production schema (no docker/psql/supabase CLI). CI is authoritative.

## Decisions taken (most conservative option inside the plan)

- The rate limit counts all requests by the sender in 24 hours (ceiling 20) from `connection_requests` itself; no new log
  table, because `connection_requests` has no scope column and this lane adds none.
- A declined request is not re-opened by a repeated call (the existing row is returned).
- The shared-tenant test for `community` ignores the platform tenant (`tenants.is_platform`).
- The exclusion helper skips a list that does not exist yet (`platform_only_accounts` is created by another spec) and
  assumes a `user_id` column on each list.
- The queue row and drift baseline are not touched: no table is created, and the lane's allowed paths exclude them.
