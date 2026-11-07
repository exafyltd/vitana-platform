# VTID-05579 - mt-network-r2 / network-groups-db

Plan: `.kiro/specs/mt-network-r2/plan.md` and the `network-groups-db` group of `tasks.md` (tasks 1-3). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, Jest source check, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md section 7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Acceptance

AC-1 `chat_groups.scope` and `chat_group_members.scope` exist (`text NOT NULL DEFAULT 'community'`, CHECK community | network).
Every group the legacy migration (VTID-05573) flagged `metadata.legacy_scope = 'network'` is backfilled to `network`, its members
with it; every other group and member stays `community`. A member row can never carry another scope than its group.
TEST: pgTAP cases 1-9, 14-15, 17; jest `scope columns, backfill, guards`.

AC-2 Only the functions write a network scope: a direct INSERT or UPDATE of a network group, a direct INSERT of a member into a
network group (service_role included) and a change of a group's scope all fail 42501. A network group is never a system group
and never holds a bot member (CHECK), so no system writer (welcome-chat, enrollment, proactive match) can target it. The
community writers keep working unchanged, and an idempotent re-run of the legacy migration over existing members stays a no-op.
TEST: pgTAP cases 10-13, 16, 18-20, 58; jest `only the RPCs write a non-community group scope`.

AC-3 `create_network_group()` (caller = `auth.uid()`) and `create_network_group_as()` (service_role, trusted `p_actor`) create a
network group whose tenant is the creator's primary non-platform tenant (context only) and make the creator its admin. A member who
is not network_visible, has no non-platform tenant, or is a service bot / notification test actor / platform-only account
(`is_network_excluded_account`, VTID-05582; rules 43-45) cannot create one. Blank or over-long names are refused.
TEST: pgTAP cases 21-32, 70.

AC-4 `add_group_member()` / `add_group_member_as()` on a Network group: the caller must be a member and the group's admin
(invite-only, no self-join); the invitee must be network_visible, not a rule 43-45 account, not blocked in either direction, and
connected to the inviter by an accepted `connection_requests` row in either direction; at most 20 members (the 21st fails 54000;
adding an existing member is a no-op); the member row carries the creator's tenant as context; nothing is written to
`chat_messages` (no system fan-out). The cap and the rule 43-45 exclusion also hold against a direct insert (table guard).
TEST: pgTAP cases 37-69, 71-72; jest `the network branch is admin-only, invite-only between accepted connections`.

AC-5 On a Community group `add_group_member()` needs a caller who is a member and an invitee who belongs to the group's tenant;
the 20 cap is a Network rule only. The four functions are SECURITY DEFINER with a pinned search_path; the callers are granted to
`authenticated`, the `_as` pair to `service_role` only, the two cores to nobody; `anon` gets none.
TEST: pgTAP cases 33-36, 73-77.

AC-6 RLS is participant-only on both tables: a non-participant (and anon) sees no row of a network group or its member list,
participants see theirs, service_role is unchanged. A client cannot insert, update or delete. No permissive `FOR ALL USING (true)`
policy exists for PUBLIC/authenticated on `chat_groups`, `chat_group_members` or `chat_messages` (the catch-alls were dropped by
`20260608120000:26-27`; the migration asserts it). No bare `current_tenant_id()` policy; `auth.uid()` is evaluated once per statement.
TEST: pgTAP cases 78-92; jest `participant-only RLS`; the bare-policy lint (jest `mt-identity-bare-policy-lint`).

AC-7 Each migration has a rollback in this PR (reverse order 054200, 054100, 054000; the scope rollback refuses while the
functions exist or while a network group created by the functions exists), read-only `live-before.sql`, `post-apply-checks.sql`,
`rollback-check.sql`, and the MIGRATION-QUEUE rows 63-65. `scripts/ci/migration-drift-baseline.json` count equals
`len(known_missing_tables)` (120): no table is created.
TEST: pglite-harness/checks.sh (outputs/checks.txt: apply, post-apply, refused rollbacks, rollbacks, rollback-check, re-apply);
jest `tasks 3-4: rollback, read-only checks, pgTAP, queue`.

## Files

| Task | File |
|---|---|
| 1 expand: both `scope` columns, CHECKs, backfill, scope guards, no-system/no-bot CHECKs | `supabase/migrations/20261102054000_vtid_05579_chat_groups_scope.sql` |
| 2 `create_network_group(_as)`, `add_group_member(_as)` and the two cores | `supabase/migrations/20261102054100_vtid_05579_network_group_rpcs.sql` |
| 1 participant-only read policies, allow-all assertion | `supabase/migrations/20261102054200_vtid_05579_chat_groups_rls.sql` |
| 3 rollbacks (this order) | `rollback-054200-chat-groups-rls.sql`, `rollback-054100-network-group-rpcs.sql`, `rollback-054000-chat-groups-scope.sql` |
| 3 read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| 3 queue + drift | `docs/multitenancy/MIGRATION-QUEUE.md` rows 63-65 (appended last), `scripts/ci/migration-drift-baseline.json` unchanged (120) |
| 3 pgTAP (92 cases) | `pgtap/mt-network-groups-db.pgtap.sql` + `pgtap/vtid_05579_fixture.sql`, `pgtap/vtid_05579_fixture_data.sql`; Jest wrapper `services/gateway/test/mt-network-groups-db.pgtap.test.ts` |

Apply order: 054000, 054100, 054200 (one RUN-MIGRATION dispatch per file). Prerequisites already on `main`: `20261102050000`
(chat_messages.scope, VTID-05576), `20261102051000` (`is_network_excluded_account`, VTID-05582), `20261102052100` (VTID-05573, which
writes `metadata.legacy_scope`); apply 054000 only after VTID-05573's rows are applied, otherwise the backfill finds nothing to
classify. Rollback order: 054200, 054100, 054000.

## Decisions taken (most conservative option inside the plan)

- **A creation function is part of the lane.** The scope guard stops every direct write of a network group, so
  `create_network_group()` is the only way a network group can exist; `add_group_member()` alone could not be exercised.
  It is expand only and dark (nothing calls it until `network-groups-gateway`, behind `mt.network_groups`).
- **Admin-only invites.** The plan says "invite-only between connections"; the function lets only the group's admin invite
  (the creator is the first admin; the legacy admin role is kept). A later lane can widen it.
- **Community branch kept minimal.** Caller must be a member, the invitee must belong to the group's tenant; no cap, no
  connection rule (those are Network rules). Today's direct community writers are untouched.
- **No contract step.** `scope` keeps `DEFAULT 'community'`: a missed writer cannot write `network` (the guard) and writes the
  community default the table has today, so there is no writer to chase (unlike `chat_messages`, whose default is dropped later).
- **No privilege revoke.** Both tables already have SELECT policies only (no client write policy), so a client write is denied
  by RLS; the grants are left as they are and the pgTAP proves the denial (cases 85-87).
- **Group messaging is not opened here.** `send_message` still refuses a network group (`network_group_not_supported`, VTID-05576);
  routing a group send is the gateway lane's work.
