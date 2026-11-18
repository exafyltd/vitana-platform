# D11 local stack on PGlite (VTID-05520)

The local stack for the multi-tenant guard rails (plan `mt-guardrails-r2`, Amendments 2 and 3). It runs in-process on
[PGlite](https://pglite.dev) (`@electric-sql/pglite`, exact version in `package.json` and `pnpm-lock.yaml`: 0.5.15; Amendment 3 cites 0.5.14, the lane pins the newer patch release), one database per
test file. It needs no Docker, no network, no secret and no production dump. **Real pgTAP is not used**: the suites run through
a pgTAP-compatible assertion shim, which is the test harness. This departs from the pgTAP wording of
`docs/MULTI-TENANT-PLAN.md` §4.2 and §4.9 on purpose (Amendment 2, decision 7).

## Run it
```
pnpm install --frozen-lockfile --ignore-scripts
npm run mt-stack:report     # build the stack the way CI does, print PASS/SKIP per required table
npm run test:mt-stack       # the lane's node tests
node scripts/mt/stack/run-tap.mjs supabase/tests/local-stack/smoke.tap.sql   # one pgTAP-style file through the shim
```
CI runs the same through `.github/workflows/MT-LOCAL-STACK.yml` (job "MT local stack (PGlite)") on `ubuntu-latest` with Node 22.x
(the runner image is not pinned to a version). It runs on every push to `main` and to `kiro/mt-guardrails-r2/**` branches, so each
update merge on a lane head gets its own run, and on `workflow_dispatch`. It is a `push` trigger, not a path-filtered
`pull_request`, so it needs no service entry in `config/delivery/services.json`.

## Inputs and outputs (the contract)
| Input | File | What it holds |
|---|---|---|
| migrations | `supabase/migrations/*.sql` (top level only) | applied in name (= timestamp) order, one pass, on an empty database |
| skips | `supabase/tests/local-stack/replay-skip.json` | `{ skips: [{ file, reason, error }] }`: migrations that fail on PGlite, each with its reason and first error line |
| required tables | `supabase/tests/local-stack/required-tables.txt` | the 24 tables the guard-rail lanes need |
| not replayable | `supabase/tests/local-stack/not-replayable.txt` | `table \| reason \| lanes`: required tables the replay cannot create |
| fixtures | `supabase/tests/fixtures/*.sql` | synthetic, idempotent, name order |

Outputs: the stack (`createStack()` returns the database and a report) or a `StackGateError` whose message names the
failing migration file or table; `check-stack.mjs` prints `PASS`/`SKIP` per required table and exits 1 on a failure;
`run-tap.mjs` prints TAP and `PASS local-stack <file>` / `FAIL local-stack <file>` and exits 1 on any `not ok`, plan
mismatch or SQL error.

The gate (Amendment 3):
- a required table that exists after the replay: PASS;
- a required table that is missing and listed in `not-replayable.txt`: SKIP, reported as **unverified** with its reason and lanes;
- a listed table that exists (stale listing), a listing of a table that is not required, a missing table that is not listed,
  a migration that fails and is not in `replay-skip.json`, a skip that now applies or names a file that is gone: the gate FAILS and names the file or table.

Loader code: `openDb` (`scripts/mt/stack/stack.mjs:41`), `replay` (`scripts/mt/stack/stack.mjs:85`),
`checkRequiredTables` (`scripts/mt/stack/stack.mjs:115`), `loadFixtures` (`scripts/mt/stack/stack.mjs:143`),
`createStack` (`scripts/mt/stack/stack.mjs:168`), `runTapFile` (`scripts/mt/stack/stack.mjs:205`). The stub auth schema is
`scripts/mt/stack/stub-auth.sql`, the shim `scripts/mt/stack/tap-shim.sql`. `node scripts/mt/stack/discover-skips.mjs --write`
regenerates `replay-skip.json` when a migration is added that PGlite cannot apply.

## What the stub provides
Schema `auth` holds `auth.users`, `auth.uid()`, `auth.jwt()` and nothing else; the roles `anon`, `authenticated`,
`service_role` exist (Amendment 2, decision 4). A test sets the caller with
`SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', false); SET ROLE authenticated;`.
Like Supabase, the three roles get ALL on tables, sequences and functions created in `public`, so RLS policies, not missing grants,
decide a result. PGlite's bundled `uuid-ossp`, `pgcrypto` and `pg_trgm` are loaded.

## Fixtures
Tenants `T_A` and `T_B`; users `a_member`, `a_admin`, `b_member`, `b_admin`, `ab_dual` (in the stub `auth.users`, with
`user_tenants` rows; `ab_dual` is in both tenants); `CANARY_A_<uuid>` markers in T_A rows of `community_groups`,
`community_meetups`, `services_catalog` and `health_features_daily`, and `CANARY_B_<uuid>` rows in T_B. Ids are in
`scripts/mt/stack/fixture-ids.mjs`. Fixtures load with triggers off so the welcome-chat and notification fan-out triggers never fire.

## The shim
`plan`, `ok`, `is`, `isnt`, `matches`, `doesnt_match`, `lives_ok`, `throws_ok`, `is_empty`, `results_eq`, `set_eq`, `diag`,
`finish` and `require_table(name)`. `require_table` **fails** (it never passes) on a table listed in `not-replayable.txt`
and says it is unverified, so an isolation suite cannot go green over a table the stack does not have. Not covered: pgTAP
catalog assertions (`has_table`, `policies_are`, ...), skip/todo, any TAP protocol beyond plain lines.

## What this stack does not cover
Every isolation claim made on it shows the policy on the tables that were loaded, not the production auth path.
It does not cover:
- Supabase Auth itself (JWT issuing, sessions, the access-token hook, `auth.role()`), Realtime, Storage (5 migrations that need the storage schema are skipped), pg_cron, or pgvector (PGlite does not bundle them);
- the migrations in `replay-skip.json`: they are not applied, so their tables, functions and policies are absent from this stack. That includes tenant resolution and policies on the tables that ARE present: see "Isolation gap on the present tables" below, where every isolation claim on them is unverified;
- any behaviour of the tables below.

## Unverified tables (not replayable on PGlite, Amendment 3)
Any claim that touches one of these is **unverified** here. The isolation suite fails on them, it does not pass. To close one: a
committed migration that creates it (an owner decision, the plan calls these tables live), removal from the required list (a plan
change through sparring), or a replay fix inside a lane of this plan.

| Table | Why it is unverified | Lanes that need it |
|---|---|---|
| `access_audit_log` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `consents` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `retrieval_traces` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `role_sessions` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `user_roles` | no migration in either repository creates it | isolation-suite, generated-inventories |
| `live_rooms` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` fails on a fresh replay (column "source_type" does not exist) | isolation-suite, generated-inventories |
| `live_highlights` | same migration | isolation-suite, generated-inventories |
| `live_room_attendance` | same migration | isolation-suite, generated-inventories |
| `event_attendance` | same migration | isolation-suite, generated-inventories |
| `community_listings` | `20260727090000_bootstrap_community_marketplace.sql` fails on a fresh replay (column "tenant_id" referenced in foreign key constraint does not exist) | isolation-suite, generated-inventories |
| `tenant_catalog_overrides` | `20260416120000_vtid_02000_marketplace_foundation.sql` needs pgvector | isolation-suite, generated-inventories |
| `partner_health_test_orders` | `20260914090000_vtid_03885_partner_health_test_integration.sql` needs `public.product_orders` from the pgvector-dependent marketplace foundation | isolation-suite, generated-inventories |
| `data_sharing_consents` | same migration | isolation-suite, generated-inventories |

A test (`supabase/tests/local-stack/repo-gate.test.mjs`) fails when this table and `not-replayable.txt` disagree.

## Isolation gap on the present tables
11 required tables are present after the replay: `community_groups`, `community_meetups`, `d42_domain_weights`, `products_catalog`, `relationship_edges`, `services_catalog`, `tenants`, `health_features_daily`, `biomarker_results`, `wearable_samples`, `user_tenants`. "Present" does not mean "verified". Every claim on the present tables about tenant isolation is unverified against production.
The migrations below are **skipped** (not applied) and each one redefines tenant resolution or a policy that production has on
a present table. So **every isolation claim on the present tables runs on non-production tenant resolution and policies and
is unverified against production**: the replayed `current_tenant_id()`, signup and membership functions and policies are
the ones from the migrations that did apply, not the final production ones. A green isolation test here shows the tables'
shape and the policies that were replayed; it does not show that production isolates tenants.

The four that matter most:
- `20260218000000_fix_maxina_signup_tenant_association.sql` redefines `current_tenant_id()`. The stack uses an earlier body.
- `20261102030100_vtid_05465_bare_policy_rewrite.sql` rewrites the bare policies on `community_groups`, `community_meetups` and other tables.
  Its own guard refuses the replayed `current_tenant_id()`, because that body is not the one production has.
- `20261102031000_vtid_05466_user_tenants_canonical.sql` makes `user_tenants` canonical (backfill from memberships).
- `20261014000200_vtid_05149_signup_default_tenant.sql` changes signup (`handle_new_user`, `provision_platform_user`) and the default tenant.

The list is generated, not hand-picked: `scripts/mt/stack/skipped-isolation.mjs` scans every skip for a policy or trigger on a
present table, a function whose name has "tenant", or a function that reads or writes `user_tenants`/`tenants`.
`supabase/tests/local-stack/skipped-isolation.test.mjs` fails when this table and the scan disagree. It is a lower bound for
function bodies it cannot parse (dynamic SQL). To close the gap: make those migrations replayable (a fix inside a lane of
this plan) or prove the claim on a real database.

| Skipped migration | What it changes on a present table |
|---|---|
| `20251231000000_vtid_01103_health_compute_engine.sql` | policy on biomarker_results; policy on health_features_daily; policy on wearable_samples |
| `20251231000001_vtid_01088_matchmaking_engine.sql` | policy on relationship_edges |
| `20251231000001_vtid_01090_live_rooms_events_graph.sql` | policy on relationship_edges |
| `20251231000001_vtid_01091_locations_memory_graph.sql` | policy on relationship_edges |
| `20251231000001_vtid_01094_match_feedback_loop.sql` | policy on relationship_edges |
| `20260210100000_vtid_01228_live_room_session_mgmt.sql` | trigger on user_tenants |
| `20260218000000_fix_maxina_signup_tenant_association.sql` | function current_tenant_id; function provision_platform_user (reads or writes tenant membership) |
| `20260227000000_admin_rls_policies.sql` | policy on community_groups; policy on community_meetups; policy on relationship_edges; policy on user_tenants |
| `20260318100000_role_admission_system.sql` | function provision_platform_user (reads or writes tenant membership) |
| `20260428100000_vtid_02007_phase_5c_legacy_backfill.sql` | trigger on relationship_edges |
| `20260501150000_vtid_02652_phase6_tenant_overrides.sql` | function pick_specialist_for_text_tenant |
| `20260625000000_alle_beisammen_chat_group.sql` | function fire_welcome_chat_on_membership (reads or writes tenant membership) |
| `20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql` | function me_set_active_role (reads or writes tenant membership) |
| `20260926190000_vtid_04674_notification_type_controls.sql` | function _notif_enforce_type_controls (reads or writes tenant membership) |
| `20260928200400_vtid_04717_risk_mitigations.sql` | function caller_is_tenant_member |
| `20261003100000_vtid_04859_founding_1000.sql` | function claim_founding_seat (reads or writes tenant membership); trigger on user_tenants |
| `20261005100000_vtid_04878_claim_capped_reward.sql` | function reward_sweep_members (reads or writes tenant membership) |
| `20261010160000_vtid_05038_welcome_trigger_enrollment_restore.sql` | function fire_welcome_chat_on_membership (reads or writes tenant membership) |
| `20261010180000_vtid_05043_s3_membership_side_effect_guard.sql` | trigger on user_tenants |
| `20261010190000_vtid_05055_partner_health_member_link_confirmation.sql` | function fn_confirm_partner_link_request (reads or writes tenant membership) |
| `20261013233000_vtid_05147_s_m_membership_role_lockdown.sql` | function set_role_preference (reads or writes tenant membership); policy on user_tenants |
| `20261014000100_vtid_05149_tenants_default_platform_flags.sql` | function tenants_assert_one_default; trigger on tenants |
| `20261014000200_vtid_05149_signup_default_tenant.sql` | function handle_new_user (reads or writes tenant membership); function provision_platform_user (reads or writes tenant membership) |
| `20261014000400_vtid_05150_tenant_brand_pack.sql` | function tenant_settings_brand_pack_validate; function tenant_settings_merge_feature_flags |
| `20261014000500_vtid_05150_provision_tenant.sql` | function provision_tenant |
| `20261014000600_vtid_05151_public_tenant_registry.sql` | function _tenant_public_registry; function list_public_tenants; function resolve_tenant |
| `20261101110100_mt_launch_tenant_content_pipeline.sql` | function get_tenant_launch_readiness |
| `20261102030100_vtid_05465_bare_policy_rewrite.sql` | policy on community_groups; policy on community_meetups; policy on d42_domain_weights; policy on products_catalog; policy on services_catalog |
| `20261102031000_vtid_05466_user_tenants_canonical.sql` | function mt_backfill_memberships_to_user_tenants |
| `20261102031100_vtid_05466_memberships_view_dualwrite.sql` | function memberships_dualwrite_user_tenants |
| `20261102033000_vtid_05467_single_role_source.sql` | function me_set_active_role (reads or writes tenant membership); function set_role_preference (reads or writes tenant membership); function user_tenants_derive_role_preference; trigger on user_tenants |
| `20261102040100_vtid_05571_orphan_quarantine_snapshots.sql` | function mt_orphan_snapshot (reads or writes tenant membership) |
| `20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql` | function mt_profiles_tenant_backfill_run; function mt_profiles_tenant_restore |
| `20261102050100_vtid_05576_send_message_rpcs.sql` | function chat_send_message_core (reads or writes tenant membership) |
| `20261102052100_vtid_05573_legacy_messages_functions.sql` | function mt_legacy_common_tenant; function mt_legacy_context_tenant; function mt_legacy_messages_migrate (reads or writes tenant membership) |
| `20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql` | function content_reports_stamp_tenant; function is_tenant_moderator; function moderation_home_tenant |
| `20261102070300_vtid_05493_mt_tenant_deactivate.sql` | function deactivate_tenant |
| `20261102070350_vtid_05493_mt_tenant_archive_switch.sql` | function archive_tenant; function switch_to_tenant_by_slug |
| `20261102070600_vtid_05491_mt_moderator_tenant_scope.sql` | function moderator_tenant_scope_enabled |
| `20261102120300_vtid_05488_products_merchants_tenant_rls.sql` | function discover_tenant_gate_enabled |
| `20261102140000_vtid_05507_mt_tenant_domains.sql` | function tenant_domains_reject_reserved |
| `20261102140100_vtid_05507_mt_resolve_tenant_host.sql` | function resolve_tenant |
| `20261102141000_vtid_05506_mt_provision_erp_request.sql` | function provision_tenant; function tenant_settings_merge_feature_flags |
| `20261105170000_live_room_cohost_authz.sql` | function live_room_filter_co_hosts (reads or writes tenant membership); function live_room_is_host (reads or writes tenant membership) |
