# VTID-05469 spike: replay failures on the local stack, categorised

Source: the MT-LOCAL-STACK job log of the first smoke run (`replay.sh --discover`, single pass, 673 migrations,
pinned `supabase/postgres:17.4.1.074`). Result of that run: 463 applied, **210 failed**, 13 required tables missing,
`seed.sh` failed, `pg_prove` 3 of 8 passed. The replay stays the only schema source: no dump, no live call, no secret.

## Method

Static, from each file's first `ERROR` line in the log, the committed `exafyltd/vitana-platform` migrations and the
committed `exafyltd/vitana-v1` migrations (`supabase/migrations/`, 391 files). For a missing object the creators are
looked up in both repos. A failure whose missing object is created only by another file that also failed is a
**cascade** and takes the category of the first blocking file (its root). This is a first-error attribution: a file
that gets past its first error in a later run may stop at a second one. The next CI run of the multi-pass replay
replaces these estimates with measured numbers (`replay-report.json`: `passes`, `applied_after_pass_1`).

## Counts

| Category | Failures | of which direct | of which cascade |
|---|---:|---:|---:|
| 1. Tooling, fixed by this commit (non-transactional CONCURRENTLY, multi-pass ordering) | 5 | 5 | 0 |
| 2. Missing schema owned by `exafyltd/vitana-v1` migrations | 60 | 58 | 2 |
| 3a. Genuinely broken or drifted platform migrations | 117 | 54 | 63 |
| 3b. Environment gap of the pinned image (stub `auth`/`storage` schemas, Aurora-only guard) | 28 | 8 | 20 |
| **Total** | **210** | 125 | 85 |

Category 3 (broken/drifted, as asked) is 3a + 3b = **145**. 3b is listed apart because its fix
is the stack (the auth/storage schemas a real Supabase project gets from GoTrue and storage-api, and the Aurora-only
health store), not a migration.

## Category 1: tooling (fixed by replay.sh in this commit)

- `20260119100000_vtid_01194_execution_trigger_semantics.sql`: could not find a function named "get_pending_worker_tasks". Cause: order: public.get_pending_worker_tasks created later by 20260121000000_vtid_01201_claim_scheduled_tasks.sql.
- `20260205000000_fix_oasis_events_disk_io_indexes.sql`: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Cause: non-transactional statement in a transaction.
- `20260502120000_vtid_02690_seed_orb_agent_google_cascade.sql`: relation "agent_voice_configs" does not exist. Cause: order: public.agent_voice_configs created later by 20260507100000_vtid_livekit_foundation_voice_tables.sql.
- `20260522010000_chat_group_members_recursion_fix.sql`: relation "public.chat_group_members" does not exist. Cause: order: public.chat_group_members created later by 20260525000000_VTID_03089_chat_groups.sql.
- `20260916150000_vtid_03972_widen_oasis_events_retention.sql`: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Cause: non-transactional statement in a transaction.

## Root causes behind categories 2 and 3 (direct failures)

| Category | Root cause | Direct failures |
|---|---|---:|
| 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it | 14 |
| 3a broken/drifted migration | column drift (table not identified by the static scan) | 4 |
| 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) | 3 |
| 3a broken/drifted migration | broken statement: ERROR:  generation expression is not immutable | 3 |
| 3a broken/drifted migration | broken statement: ERROR:  cannot change return type of existing function | 2 |
| 3a broken/drifted migration | public.VtidLedger created by no committed migration | 2 |
| 3a broken/drifted migration | column drift on public.agent_personas (table shape differs from the statement) | 2 |
| 3a broken/drifted migration | column drift on public.biomarker_results (table shape differs from the statement) | 1 |
| 3a broken/drifted migration | column drift on public.user_topic_profile (table shape differs from the statement) | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "window" | 1 |
| 3a broken/drifted migration | column drift on public.memory_garden_nodes (table shape differs from the statement) | 1 |
| 3a broken/drifted migration | column drift on public.overload_patterns (table shape differs from the statement) | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  functions in index predicate must be marked IMMUTABLE | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "NOT" | 1 |
| 3a broken/drifted migration | public.memory_facts_semantic_search created earlier by 20260220000001_memory_facts_embedding_support.sql but absent (dropped/renamed) | 1 |
| 3a broken/drifted migration | public.app_users created earlier by 20251231000000_vtid_01101_phase_a_bootstrap.sql but absent (dropped/renamed) | 1 |
| 3a broken/drifted migration | column drift on public.ai_provider_policies (table shape differs from the statement) | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "refresh" | 1 |
| 3a broken/drifted migration | column drift on public.awareness_config_audit (table shape differs from the statement) | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "DELETE" | 1 |
| 3a broken/drifted migration | public.oasis_events created earlier by 20251209000000_add_task_stage.sql but absent (dropped/renamed) | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  new row for relation "agents_registry" violates check constraint "agents | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  insert or update on table "agent_voice_configs" violates foreign key con | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "//" | 1 |
| 3a broken/drifted migration | public.autopilot_recs created by no committed migration | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  policy "Service role full access on automation_runs" for table "automati | 1 |
| 3a broken/drifted migration | public.wallet_transactions created earlier by 20260318000000_vtid_01250_autopilot_automations_engine.sql but absent (dropped/renamed) | 1 |
| 3a broken/drifted migration | public.vitana_role created by no committed migration | 1 |
| 3a broken/drifted migration | public.journey_checklist_translations created earlier by 20260610130000_BOOTSTRAP_journey_checklist_translations.sql but absent (dropped/renamed) | 1 |
| 3a broken/drifted migration | broken statement: ERROR:  VTID-05149 M1: expected exactly 2 tenants, one of them maxina; found 3 t | 1 |
| 3a broken/drifted migration | column drift on public.tenant_settings (table shape differs from the statement) | 1 |
| 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) | 6 |
| 3b environment gap (pinned image) | VTID-05158/05161 placement guard: health store is Aurora-only, refuses a Supabase-shaped database | 2 |
| 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql | 11 |
| 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql | 8 |
| 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql | 6 |
| 2 vitana-v1 schema | public.role_preferences created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql | 5 |
| 2 vitana-v1 schema | public.user_wallets created only by vitana-v1 20250921100510_89b3a262-2aa9-4f5f-9079-8d57ee4f19ba.sql | 4 |
| 2 vitana-v1 schema | public.user_intents created only by vitana-v1 20260501000100_user_intents.sql | 3 |
| 2 vitana-v1 schema | public.community_live_streams created only by vitana-v1 20251022080341_38ea1cf6-7460-47d3-b2c8-7ffebf4fcce5.sql | 3 |
| 2 vitana-v1 schema | public.user_activity_log created only by vitana-v1 20251006130209_27a3569f-f9ee-485e-95bb-b11db2d902a5.sql | 2 |
| 2 vitana-v1 schema | public.vitana_index_config created only by vitana-v1 20251010061200_e97c7e27-836f-4a63-92e1-9e90d1192ef0.sql | 2 |
| 2 vitana-v1 schema | public.global_community_events created only by vitana-v1 20250917153624_22b8e9be-eb29-477c-974b-87a609943321.sql | 2 |
| 2 vitana-v1 schema | public.contacts created only by vitana-v1 20251010130129_0f59d882-2e49-4bf6-9277-7a8429e92088.sql | 2 |
| 2 vitana-v1 schema | public.admin_user_analytics created only by vitana-v1 20251009220046_fad16004-69fc-4d32-9152-caa5b92c5747.sql | 1 |
| 2 vitana-v1 schema | public.diary_entries created only by vitana-v1 20250915104148_03887e4b-2d80-4694-ba6b-1bfa4e693385.sql | 1 |
| 2 vitana-v1 schema | public.user_follows created only by vitana-v1 20251001094733_dee87b34-674f-4b34-8ab6-b32b4eb68528.sql | 1 |
| 2 vitana-v1 schema | public.thread_participants created only by vitana-v1 20250917143525_40525d26-1b55-46b4-b66d-e3bf7367a440.sql | 1 |
| 2 vitana-v1 schema | public.checkout_sessions created only by vitana-v1 20251008220057_c9212d9f-901b-4584-a204-b1ad58cd4b04.sql | 1 |
| 2 vitana-v1 schema | public.handle_aliases created only by vitana-v1 20260427000300_vitana_id_schema.sql | 1 |
| 2 vitana-v1 schema | pg_trgm extension is enabled only by vitana-v1 20260427000000_vitana_id_extensions.sql | 1 |
| 2 vitana-v1 schema | public.tenant_role created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql | 1 |
| 2 vitana-v1 schema | public.ai_memory created only by vitana-v1 20251004102435_2abc2262-b1bf-455f-a954-26cb68538919.sql | 1 |
| 2 vitana-v1 schema | public.handle_new_user created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql | 1 |

Largest cascade roots (files whose failure blocks others):

- `20260416120000_vtid_02000_marketplace_foundation.sql` (3a broken/drifted migration): blocks 48 file(s). First error: `generation expression is not immutable`.
- `20260411000000_nav_catalog.sql` (3b environment gap (pinned image)): blocks 20 file(s). First error: `function auth.jwt() does not exist`.
- `20251231000001_vtid_01090_live_rooms_events_graph.sql` (3a broken/drifted migration): blocks 8 file(s). First error: `column "source_type" does not exist`.
- `20260419000000_vtid_02403_ai_assistants_phase1.sql` (3a broken/drifted migration): blocks 2 file(s). First error: `column ut.is_active does not exist`.
- `20251231000001_vtid_01088_matchmaking_engine.sql` (3a broken/drifted migration): blocks 1 file(s). First error: `column "is_active" does not exist`.
- `20260524000000_VTID_03036_bootstrap_cache.sql` (3a broken/drifted migration): blocks 1 file(s). First error: `syntax error at or near "||"`.

Drift findings that block most of the tenant work:

- **`public.tenants.tenant_id`.** `20251231000000_vtid_01101_phase_a_bootstrap.sql` creates `public.tenants (id, slug, name, …)`;
  no committed migration in either repo adds a `tenant_id` column, yet later platform migrations reference
  `public.tenants(tenant_id)` (foreign keys, `t.tenant_id`, the VTID-05324 guard). The live column exists only outside the
  committed migrations. This is also why `seed.sh` failed: `public.provision_platform_user()` (applied from
  `20260310000000_fix_memory_tenant_resolution.sql`) runs on the `auth.users` insert and selects `t.tenant_id`.
- **`public.relationship_edges`** is created by five files with the same timestamp prefix `20251231000001_` in different
  shapes (`CREATE TABLE IF NOT EXISTS`); the first one (`vtid_01087`) wins and the others fail on missing columns
  (`source_type`, `is_active`, `score`). `20251231000001_vtid_01090_live_rooms_events_graph.sql` is one of them, and it
  creates `live_rooms`, `live_room_attendance`, `live_highlights` and `event_attendance`.
- **`generation expression is not immutable`** (PostgreSQL 17): `20260416120000_vtid_02000_marketplace_foundation.sql`
  builds a `STORED` tsvector column with `array_to_string` (STABLE). The file creates the marketplace tables,
  including `tenant_catalog_overrides` and `product_orders`, and blocks 48 files.
- **`auth.jwt()`** is absent from the pinned image's stub `auth` schema; `20260411000000_nav_catalog.sql` uses it in a
  policy and blocks 20 files.
- **Tables no committed migration creates:** `access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`,
  `user_roles` (none of them is created in either repo; `retrieval_traces` is not even referenced).

## The 13 missing required tables

| Table | Created by (platform) | Blocked by | Category | Why |
|---|---|---|---|---|
| `public.access_audit_log` | — (no committed migration in either repo) | — | 3a broken/drifted migration | no committed migration creates it |
| `public.community_listings` | `20260727090000_bootstrap_community_marketplace.sql` | `20260727090000_bootstrap_community_marketplace.sql` | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `public.consents` | — (no committed migration in either repo) | — | 3a broken/drifted migration | no committed migration creates it |
| `public.event_attendance` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `public.live_highlights` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `public.live_room_attendance` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `public.live_rooms` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `public.retrieval_traces` | — (no committed migration in either repo) | — | 3a broken/drifted migration | no committed migration creates it |
| `public.role_sessions` | — (no committed migration in either repo) | — | 3a broken/drifted migration | no committed migration creates it |
| `public.tenant_catalog_overrides` | `20260416120000_vtid_02000_marketplace_foundation.sql` | `20260416120000_vtid_02000_marketplace_foundation.sql` | 3a broken/drifted migration | broken statement: ERROR:  generation expression is not immutable |
| `public.user_roles` | — (no committed migration in either repo) | — | 3a broken/drifted migration | no committed migration creates it |
| `public.partner_health_test_orders` | `20260914090000_vtid_03885_partner_health_test_integration.sql` | `20260914090000_vtid_03885_partner_health_test_integration.sql` | 3a broken/drifted migration | cascade: public.product_orders created by failed 20260416120000_vtid_02000_marketplace_foundation.sql; root `20260416120000_vtid_02000_marketplace_foundation.sql` |
| `public.data_sharing_consents` | `20260914090000_vtid_03885_partner_health_test_integration.sql` | `20260914090000_vtid_03885_partner_health_test_integration.sql` | 3a broken/drifted migration | cascade: public.product_orders created by failed 20260416120000_vtid_02000_marketplace_foundation.sql; root `20260416120000_vtid_02000_marketplace_foundation.sql` |

Blocking categories of the 13: 3a broken/drifted migration: 13. None is blocked by
tooling or by vitana-v1 schema, so this commit's replay changes do not make any of them appear; the required-tables
check in `smoke.sh` stays a FAIL (unchanged, not weakened) until the drift is fixed in its own plan.

## Seed and pg_prove

- `seed.sh`: the fixture now checks its tables with `to_regclass`: missing `public.tenants`, `public.user_tenants` or
  `auth.users` still fails the load; a missing optional table (`app_users`, `community_groups`) is skipped with a
  NOTICE. The first run's seed failure was not a missing table: it was the `provision_platform_user()` trigger
  reading the live-only `public.tenants.tenant_id` (category 3a above). The guards do not fix that, so the seed
  is expected to fail again until that drift is fixed.
- `pg_prove`: tests 3 to 6 and 8 failed only because the seed did not load; 1, 2 and 7 passed.

## All 210 failures

| File | First error | Category | Reason |
|---|---|---|---|
| `20251231000000_vtid_01103_health_compute_engine.sql` | column "recorded_at" does not exist | 3a broken/drifted migration | column drift on public.biomarker_results (table shape differs from the statement) |
| `20251231000001_vtid_01088_matchmaking_engine.sql` | column "is_active" does not exist | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `20251231000001_vtid_01090_live_rooms_events_graph.sql` | column "source_type" does not exist | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `20251231000001_vtid_01091_locations_memory_graph.sql` | column "source_type" does not exist | 3a broken/drifted migration | column drift on public.relationship_edges (table shape differs from the statement) |
| `20251231000001_vtid_01094_match_feedback_loop.sql` | column "score" does not exist | 3a broken/drifted migration | column drift on public.user_topic_profile (table shape differs from the statement) |
| `20251231000001_vtid_01098_memory_timeline_causality.sql` | syntax error at or near "window" | 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "window" |
| `20251231100000_vtid_01082_memory_garden_diary.sql` | column "domain" does not exist | 3a broken/drifted migration | column drift on public.memory_garden_nodes (table shape differs from the statement) |
| `20260102200000_vtid_01127_availability_readiness_engine.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20260103000000_vtid_01145_overload_detection.sql` | column "created_at" does not exist | 3a broken/drifted migration | column drift on public.overload_patterns (table shape differs from the statement) |
| `20260116000000_vtid_01179_autopilot_event_loop.sql` | functions in index predicate must be marked IMMUTABLE | 3a broken/drifted migration | broken statement: ERROR:  functions in index predicate must be marked IMMUTABLE |
| `20260117000000_vtid_01183_worker_agent_connector.sql` | syntax error at or near "NOT" | 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "NOT" |
| `20260119100000_vtid_01194_execution_trigger_semantics.sql` | could not find a function named "get_pending_worker_tasks" | 1 tooling | order: public.get_pending_worker_tasks created later by 20260121000000_vtid_01201_claim_scheduled_tasks.sql |
| `20260205000000_fix_oasis_events_disk_io_indexes.sql` | CREATE INDEX CONCURRENTLY cannot run inside a transaction block | 1 tooling | non-transactional statement in a transaction |
| `20260209_vtid_01228_daily_co_live_rooms.sql` | relation "live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260209_vtid_01228_daily_co_live_rooms_down.sql` | relation "live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260209_vtid_01228_daily_co_live_rooms_fixed.sql` | relation "live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260210000000_vtid_01090_fix_live_room_creation.sql` | relation "live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260210100000_vtid_01228_live_room_session_mgmt.sql` | relation "public.live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260211000000_fix_live_room_create_for_permanent_rooms.sql` | relation "public.live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260215000000_cleanup_stuck_live_sessions.sql` | relation "public.live_room_sessions" does not exist | 3a broken/drifted migration | cascade: public.live_room_sessions created by failed 20260210100000_vtid_01228_live_room_session_mgmt.sql |
| `20260216000000_security_linter_fixes.sql` | relation "public.admin_user_analytics" does not exist | 2 vitana-v1 schema | public.admin_user_analytics created only by vitana-v1 20251009220046_fad16004-69fc-4d32-9152-caa5b92c5747.sql |
| `20260218000000_fix_maxina_signup_tenant_association.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260221000000_fix_embedding_dimensions_768.sql` | function public.memory_facts_semantic_search(vector, integer, uuid, uuid, text, numeric) does not exist | 3a broken/drifted migration | public.memory_facts_semantic_search created earlier by 20260220000001_memory_facts_embedding_support.sql but absent (dropped/renamed) |
| `20260226000000_signup_funnel_tracking.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260226100000_backfill_app_users_from_auth.sql` | column "tenant_id" of relation "app_users" does not exist | 3a broken/drifted migration | public.app_users created earlier by 20251231000000_vtid_01101_phase_a_bootstrap.sql but absent (dropped/renamed) |
| `20260227000000_admin_rls_policies.sql` | function auth.jwt() does not exist | 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) |
| `20260227100000_user_feedback_reports.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260315000001_vitana_bot_user.sql` | column "email_confirmed_at" of relation "users" does not exist | 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) |
| `20260318100000_role_admission_system.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260321000000_community_user_analyzer.sql` | cannot change return type of existing function | 3a broken/drifted migration | broken statement: ERROR:  cannot change return type of existing function |
| `20260411000000_nav_catalog.sql` | function auth.jwt() does not exist | 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) |
| `20260411000100_nav_catalog_seed.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260413000000_intelligent_calendar.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260416120000_vtid_02000_marketplace_foundation.sql` | generation expression is not immutable | 3a broken/drifted migration | broken statement: ERROR:  generation expression is not immutable |
| `20260416120100_vtid_02000_marketplace_seed.sql` | relation "public.canonical_fact_keys" does not exist | 3a broken/drifted migration | cascade: public.canonical_fact_keys created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260416150000_nav_catalog_my_journey_news.sql` | relation "nav_catalog_i18n" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog_i18n created by failed 20260411000000_nav_catalog.sql |
| `20260416150000_vtid_02000_debug_products.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260416160000_nav_catalog_home_news_by_screen_id.sql` | relation "nav_catalog_i18n" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog_i18n created by failed 20260411000000_nav_catalog.sql |
| `20260416170000_vtid_02000_fix_products.sql` | generation expression is not immutable | 3a broken/drifted migration | broken statement: ERROR:  generation expression is not immutable |
| `20260416180000_nav_catalog_seed_fixed.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260416180000_vtid_02000_fix_products_v2.sql` | relation "public.merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260416200000_vtid_02000_seed_demo_catalog.sql` | relation "public.catalog_sources" does not exist | 3a broken/drifted migration | cascade: public.catalog_sources created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260416200100_nav_autopilot_priority_down.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260418010000_vtid_02200_seed_shopify_demo.sql` | relation "public.catalog_sources" does not exist | 3a broken/drifted migration | cascade: public.catalog_sources created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260418030000_vtid_02000_backfill_demo_images_descriptions.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260418040000_vtid_02000_product_detail_columns.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260418050000_vtid_02000_description_long.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260418060000_vtid_02000_demo_discounts.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260419000000_vtid_02403_ai_assistants_phase1.sql` | column ut.is_active does not exist | 3a broken/drifted migration | column drift on public.ai_provider_policies (table shape differs from the statement) |
| `20260420120000_BOOTSTRAP_history_aware_timeline.sql` | relation "public.user_activity_log" does not exist | 2 vitana-v1 schema | public.user_activity_log created only by vitana-v1 20251006130209_27a3569f-f9ee-485e-95bb-b11db2d902a5.sql |
| `20260420130000_BOOTSTRAP_ai_usage_log.sql` | syntax error at or near "refresh" | 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "refresh" |
| `20260420140000_BOOTSTRAP_seed_ai_policies_all_tenants.sql` | relation "public.ai_provider_policies" does not exist | 3a broken/drifted migration | cascade: public.ai_provider_policies created by failed 20260419000000_vtid_02403_ai_assistants_phase1.sql |
| `20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql` | relation "public.ai_provider_policies" does not exist | 3a broken/drifted migration | cascade: public.ai_provider_policies created by failed 20260419000000_vtid_02403_ai_assistants_phase1.sql |
| `20260421000000_add_account_profile_fields.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20260421140000_BOOTSTRAP_awareness_registry.sql` | column u.exafy_admin does not exist | 3a broken/drifted migration | column drift on public.awareness_config_audit (table shape differs from the statement) |
| `20260421220000_BOOTSTRAP_admin_kpi_surface.sql` | syntax error at or near "DELETE" | 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "DELETE" |
| `20260422150000_vitana_index_prosperity_and_weights.sql` | relation "public.vitana_index_config" does not exist | 2 vitana-v1 schema | public.vitana_index_config created only by vitana-v1 20251010061200_e97c7e27-836f-4a63-92e1-9e90d1192ef0.sql |
| `20260423110000_vitana_index_5pillar_cleanup.sql` | relation "public.vitana_index_config" does not exist | 2 vitana-v1 schema | public.vitana_index_config created only by vitana-v1 20251010061200_e97c7e27-836f-4a63-92e1-9e90d1192ef0.sql |
| `20260423150000_vitana_index_contribution_vector.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260424140000_user_pillar_recent_activity_view.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260426000000_vtid_01952_memory_provenance_columns.sql` | relation "public.live_rooms" does not exist | 3a broken/drifted migration | cascade: public.live_rooms created by failed 20251231000001_vtid_01090_live_rooms_events_graph.sql |
| `20260427090000_user_diary_streak_view.sql` | relation "public.diary_entries" does not exist | 2 vitana-v1 schema | public.diary_entries created only by vitana-v1 20250915104148_03887e4b-2d80-4694-ba6b-1bfa4e693385.sql |
| `20260427120000_vtid_01985_earthlinks_to_maxina_cleanup.sql` | column "tenant_id" does not exist | 3a broken/drifted migration | column drift (table not identified by the static scan) |
| `20260427121500_BOOTSTRAP_autopilot_enable_stale_flag.sql` | column "type" of relation "oasis_events" does not exist | 3a broken/drifted migration | public.oasis_events created earlier by 20251209000000_add_task_stage.sql but absent (dropped/renamed) |
| `20260427130000_vtid_01985_earthlinks_to_maxina_v2.sql` | column "tenant_id" does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260427140000_vtid_01985_earthlinks_to_maxina_v3.sql` | column "tenant_id" does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260427150000_vtid_01985_earthlinks_to_maxina_v4.sql` | column "tenant_id" does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260427200000_vtid_01992_intent_embedding_index.sql` | relation "public.user_intents" does not exist | 2 vitana-v1 schema | public.user_intents created only by vitana-v1 20260501000100_user_intents.sql |
| `20260427210000_vtid_01992_register_ledger.sql` | relation "VtidLedger" does not exist | 3a broken/drifted migration | public.VtidLedger created by no committed migration |
| `20260427220000_vtid_01992_register_ledger_v2.sql` | relation "VtidLedger" does not exist | 3a broken/drifted migration | public.VtidLedger created by no committed migration |
| `20260428000000_calendar_pillar_contribution_vector.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260428100000_vtid_02007_phase_5c_legacy_backfill.sql` | column re.source_type does not exist | 3a broken/drifted migration | column drift (table not identified by the static scan) |
| `20260502100000_forwarding_v2_phrase_expansion.sql` | column "stay_inline_phrases" does not exist | 3a broken/drifted migration | column drift on public.agent_personas (table shape differs from the statement) |
| `20260502120000_forwarding_v2c_coverage.sql` | column "forward_request_phrases" does not exist | 3a broken/drifted migration | column drift on public.agent_personas (table shape differs from the statement) |
| `20260502120000_vtid_02690_seed_orb_agent_google_cascade.sql` | relation "agent_voice_configs" does not exist | 1 tooling | order: public.agent_voice_configs created later by 20260507100000_vtid_livekit_foundation_voice_tables.sql |
| `20260507000100_account_visibility_helper_fns.sql` | relation "public.user_follows" does not exist | 2 vitana-v1 schema | public.user_follows created only by vitana-v1 20251001094733_dee87b34-674f-4b34-8ab6-b32b4eb68528.sql |
| `20260507000200_profile_partner_service_offerings.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20260508000000_forwarding_rules_two_gate.sql` | cannot change return type of existing function | 3a broken/drifted migration | broken statement: ERROR:  cannot change return type of existing function |
| `20260510000100_BOOTSTRAP_architecture_investigator.sql` | new row for relation "agents_registry" violates check constraint "agents_registry_llm_provider_check" | 3a broken/drifted migration | broken statement: ERROR:  new row for relation "agents_registry" violates check constraint "agents |
| `20260512000000_BOOTSTRAP_intent_cover_url.sql` | relation "user_intents" does not exist | 2 vitana-v1 schema | public.user_intents created only by vitana-v1 20260501000100_user_intents.sql |
| `20260513000000_VTID_02806_intent_cover_library.sql` | relation "profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20260521000000_VTID_02954_test_contracts.sql` | generation expression is not immutable | 3a broken/drifted migration | broken statement: ERROR:  generation expression is not immutable |
| `20260522000000_chat_attachments_rls_dm_and_groups.sql` | relation "public.thread_participants" does not exist | 2 vitana-v1 schema | public.thread_participants created only by vitana-v1 20250917143525_40525d26-1b55-46b4-b66d-e3bf7367a440.sql |
| `20260522010000_chat_group_members_recursion_fix.sql` | relation "public.chat_group_members" does not exist | 1 tooling | order: public.chat_group_members created later by 20260525000000_VTID_03089_chat_groups.sql |
| `20260523000000_VTID_03031_devon_male_voice.sql` | insert or update on table "agent_voice_configs" violates foreign key constraint "agent_voice_configs_agent_... | 3a broken/drifted migration | broken statement: ERROR:  insert or update on table "agent_voice_configs" violates foreign key con |
| `20260524000000_VTID_03036_bootstrap_cache.sql` | syntax error at or near "//" | 3a broken/drifted migration | broken statement: ERROR:  syntax error at or near "//" |
| `20260528220000_VTID_03180_community_cache_materialized_views.sql` | relation "autopilot_recs" does not exist | 3a broken/drifted migration | public.autopilot_recs created by no committed migration |
| `20260605000000_VTID_03186_universal_cart_schema.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260607000000_VTID_03237_video_shop_schema.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260608120000_phase_a_security_hotfix.sql` | relation "public.checkout_sessions" does not exist | 2 vitana-v1 schema | public.checkout_sessions created only by vitana-v1 20251008220057_c9212d9f-901b-4584-a204-b1ad58cd4b04.sql |
| `20260608140000_phase_b_enable_rls_42_tables.sql` | relation "public.handle_aliases" does not exist | 2 vitana-v1 schema | public.handle_aliases created only by vitana-v1 20260427000300_vitana_id_schema.sql |
| `20260610093000_nav_catalog_mobile.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260615120000_nav_catalog_platform.sql` | relation "public.nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260616120000_nav_catalog_desktop.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260616130000_nav_catalog_mobile_drift_fixes.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260616140000_nav_catalog_desktop_tabs.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260616150000_nav_catalog_desktop_tabs2.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260618000000_BOOTSTRAP_canonical_people_search.sql` | operator class "gin_trgm_ops" does not exist for access method "gin" | 2 vitana-v1 schema | pg_trgm extension is enabled only by vitana-v1 20260427000000_vitana_id_extensions.sql |
| `20260625120000_nav_catalog_role.sql` | relation "public.nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260629120000_vtid_02000_discover_admitad_real_catalog.sql` | relation "merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260629140000_vtid_02000_bodylab24_product_deeplinks.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260630120000_BOOTSTRAP_reap_stale_live_streams.sql` | relation "public.community_live_streams" does not exist | 2 vitana-v1 schema | public.community_live_streams created only by vitana-v1 20251022080341_38ea1cf6-7460-47d3-b2c8-7ffebf4fcce5.sql |
| `20260702120000_vtid_02000_amazon_ae_recommendations_seed.sql` | relation "merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260704060000_vtid_01250_automations_engine_safe_part.sql` | policy "Service role full access on automation_runs" for table "automation_runs" already exists | 3a broken/drifted migration | broken statement: ERROR:  policy "Service role full access on automation_runs" for table "automati |
| `20260704120000_nav_catalog_my_journey_sessions_disambiguation.sql` | relation "nav_catalog_i18n" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog_i18n created by failed 20260411000000_nav_catalog.sql |
| `20260705100000_vtid_01250_relationship_edges_allow_connected.sql` | constraint "relationship_edges_edge_type_check" of relation "relationship_edges" does not exist | 3a broken/drifted migration | cascade: public.relationship_edges created by failed 20251231000001_vtid_01088_matchmaking_engine.sql |
| `20260709120000_vtid_02000_bodylab24_real_deeplinks_admitad_cleanup.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260709140000_vtid_02000_amazon_ae_real_photos.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260709150000_vtid_02000_bodylab24_real_photos.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260712100000_SECURITY_fix_public_writable_wallet_and_cache_rls.sql` | relation "bootstrap_cache" does not exist | 3a broken/drifted migration | cascade: public.bootstrap_cache created by failed 20260524000000_VTID_03036_bootstrap_cache.sql |
| `20260712110000_SECURITY_revoke_anon_grants_vtid_ledger_marketplace.sql` | relation "public.merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260715120000_vtid_02950_recommendation_commissions.sql` | relation "public.merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql` | relation "public.user_wallets" does not exist | 2 vitana-v1 schema | public.user_wallets created only by vitana-v1 20250921100510_89b3a262-2aa9-4f5f-9079-8d57ee4f19ba.sql |
| `20260717120000_vtid_02000_discover_doctorbox_seed.sql` | relation "merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260717120100_reset_all_user_wallet_balances_to_zero.sql` | relation "public.user_wallets" does not exist | 2 vitana-v1 schema | public.user_wallets created only by vitana-v1 20250921100510_89b3a262-2aa9-4f5f-9079-8d57ee4f19ba.sql |
| `20260717121500_vtid_02000_doctorbox_feed_category_mix.sql` | relation "default_feed_config" does not exist | 3a broken/drifted migration | cascade: public.default_feed_config created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260720081500_vtid_02000_doctorbox_feed_featured.sql` | relation "default_feed_config" does not exist | 3a broken/drifted migration | cascade: public.default_feed_config created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260720190000_fix_wallet_rpc_atomicity_and_transaction_logging.sql` | constraint "wallet_transactions_transaction_type_check" of relation "wallet_transactions" does not exist | 3a broken/drifted migration | public.wallet_transactions created earlier by 20260318000000_vtid_01250_autopilot_automations_engine.sql but absent (dropped/renamed) |
| `20260720200000_fold_vtna_balance_into_credits.sql` | relation "public.user_wallets" does not exist | 2 vitana-v1 schema | public.user_wallets created only by vitana-v1 20250921100510_89b3a262-2aa9-4f5f-9079-8d57ee4f19ba.sql |
| `20260721000000_vtid_02000_doctorbox_real_photos.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260721180000_add_wallet_transactions_profile_fkeys.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20260723000000_vtid_02000_doctorbox_per_product_deeplinks.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260723010000_vtid_02000_doctorbox_new_products.sql` | relation "products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260727090000_bootstrap_community_marketplace.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260727170000_bootstrap_community_marketplace_storage.sql` | column "public" of relation "buckets" does not exist | 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) |
| `20260729120000_nav_catalog_settings_tenant_drift_fix.sql` | relation "nav_catalog" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog created by failed 20260411000000_nav_catalog.sql |
| `20260729150000_bootstrap_community_marketplace_seller_suspensions.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260804100000_vtid_03492_ci_health_rpcs_v2.sql` | column "claimed_by" does not exist | 3a broken/drifted migration | column drift (table not identified by the static scan) |
| `20260806090000_VTID_03515_db_i18n_locale_registry.sql` | relation "public.nav_catalog_i18n" does not exist | 3b environment gap (pinned image) | cascade: public.nav_catalog_i18n created by failed 20260411000000_nav_catalog.sql |
| `20260810160000_VTID_03575_zh_register_hint.sql` | relation "public.supported_locales" does not exist | 3b environment gap (pinned image) | cascade: public.supported_locales created by failed 20260806090000_VTID_03515_db_i18n_locale_registry.sql |
| `20260810230000_VTID_03580_promote_pt_ru_pl_ga.sql` | relation "public.supported_locales" does not exist | 3b environment gap (pinned image) | cascade: public.supported_locales created by failed 20260806090000_VTID_03515_db_i18n_locale_registry.sql |
| `20260818090000_vtid_03666_ci_vital_systems_health.sql` | relation "public.supported_locales" does not exist | 3b environment gap (pinned image) | cascade: public.supported_locales created by failed 20260806090000_VTID_03515_db_i18n_locale_registry.sql |
| `20260819085846_vtid_03679_fix_de_locale_journey_checklist_false_positive.sql` | relation "public.supported_locales" does not exist | 3b environment gap (pinned image) | cascade: public.supported_locales created by failed 20260806090000_VTID_03515_db_i18n_locale_registry.sql |
| `20260913000000_vtid_03832_vitana_role_add_values.sql` | type "public.vitana_role" does not exist | 3a broken/drifted migration | public.vitana_role created by no committed migration |
| `20260913000001_vtid_03832_tenant_role_add_values.sql` | type "public.tenant_role" does not exist | 2 vitana-v1 schema | public.tenant_role created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql |
| `20260914090000_vtid_03885_partner_health_test_integration.sql` | relation "public.product_orders" does not exist | 3a broken/drifted migration | cascade: public.product_orders created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260915100000_vtid_03894_supplier_verticals.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260915100100_vtid_03894_seed_verticals.sql` | relation "public.catalog_verticals" does not exist | 3a broken/drifted migration | cascade: public.catalog_verticals created by failed 20260915100000_vtid_03894_supplier_verticals.sql |
| `20260915103000_vtid_03894_supplier_affiliate_link.sql` | relation "public.merchants" does not exist | 3a broken/drifted migration | cascade: public.merchants created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260915120000_vtid_03932_partner_organizations.sql` | relation "public.partner_registry" does not exist | 3a broken/drifted migration | cascade: public.partner_registry created by failed 20260914090000_vtid_03885_partner_health_test_integration.sql |
| `20260915130000_vtid_03914_role_preferences_check_backoffice.sql` | relation "public.role_preferences" does not exist | 2 vitana-v1 schema | public.role_preferences created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql |
| `20260915131400_vtid_03916_widen_role_preferences_check.sql` | relation "public.role_preferences" does not exist | 2 vitana-v1 schema | public.role_preferences created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql |
| `20260915132000_vtid_03894_catalog_vertical_rls.sql` | relation "public.catalog_verticals" does not exist | 3a broken/drifted migration | cascade: public.catalog_verticals created by failed 20260915100000_vtid_03894_supplier_verticals.sql |
| `20260916130000_vtid_03974_commerce_vertical.sql` | relation "public.partner_organizations" does not exist | 3a broken/drifted migration | cascade: public.partner_organizations created by failed 20260915120000_vtid_03932_partner_organizations.sql |
| `20260916150000_vtid_03972_widen_oasis_events_retention.sql` | CREATE INDEX CONCURRENTLY cannot run inside a transaction block | 1 tooling | non-transactional statement in a transaction |
| `20260918100000_vtid_04044_lab_reports_rls_user_scoped.sql` | column new.processing_status does not exist | 3a broken/drifted migration | column drift (table not identified by the static scan) |
| `20260923120000_vtid_04321_rsvp_calendar_global_events.sql` | relation "public.global_community_events" does not exist | 2 vitana-v1 schema | public.global_community_events created only by vitana-v1 20250917153624_22b8e9be-eb29-477c-974b-87a609943321.sql |
| `20260923120000_vtid_04337_partner_org_members_rls_no_recursion.sql` | relation "public.partner_organization_members" does not exist | 3a broken/drifted migration | cascade: public.partner_organization_members created by failed 20260915120000_vtid_03932_partner_organizations.sql |
| `20260923130000_vtid_04331_calendar_data_model.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260923160000_vtid_04356_calendar_source_producers.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20260923170000_vtid_04389_garden_legacy_backfill.sql` | relation "public.ai_memory" does not exist | 2 vitana-v1 schema | public.ai_memory created only by vitana-v1 20251004102435_2abc2262-b1bf-455f-a954-26cb68538919.sql |
| `20260923180000_vtid_04372_calendar_google_sync.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260923200000_vtid_04402_connected_apps.sql` | relation "public.contacts" does not exist | 2 vitana-v1 schema | public.contacts created only by vitana-v1 20251010130129_0f59d882-2e49-4bf6-9277-7a8429e92088.sql |
| `20260924090000_vtid_04436_calendar_push.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20260924090000_vtid_04460_intent_ledger_embeddings_titan_v2.sql` | relation "public.user_intents" does not exist | 2 vitana-v1 schema | public.user_intents created only by vitana-v1 20260501000100_user_intents.sql |
| `20260924100000_vtid_04449_outlook_contacts_app.sql` | relation "public.connected_app_settings" does not exist | 2 vitana-v1 schema | cascade: public.connected_app_settings created by failed 20260923200000_vtid_04402_connected_apps.sql |
| `20260924130000_vtid_04471_partner_account_model.sql` | relation "public.partner_organizations" does not exist | 3a broken/drifted migration | cascade: public.partner_organizations created by failed 20260915120000_vtid_03932_partner_organizations.sql |
| `20260924150000_vtid_04478_partner_onboarding_engine.sql` | relation "public.partner_organizations" does not exist | 3a broken/drifted migration | cascade: public.partner_organizations created by failed 20260915120000_vtid_03932_partner_organizations.sql |
| `20260925120000_vtid_04561_one_role_truth.sql` | relation "public.role_preferences" does not exist | 2 vitana-v1 schema | public.role_preferences created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql |
| `20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql` | relation "public.role_preferences" does not exist | 2 vitana-v1 schema | public.role_preferences created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql |
| `20260926190000_vtid_04674_notification_type_controls.sql` | column t.tenant_id does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260928200400_vtid_04717_risk_mitigations.sql` | column "tenant_id" referenced in foreign key constraint does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20260929120000_vtid_04740_referrer_on_click_anonymous_buyers.sql` | relation "public.product_clicks" does not exist | 3a broken/drifted migration | cascade: public.product_clicks created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260929120100_vtid_04741_recommendation_commission_hold.sql` | relation "public.recommendation_commissions" does not exist | 3a broken/drifted migration | cascade: public.recommendation_commissions created by failed 20260715120000_vtid_02950_recommendation_commissions.sql |
| `20260929120200_vtid_04740_product_orders_tenant_nullable.sql` | relation "public.product_orders" does not exist | 3a broken/drifted migration | cascade: public.product_orders created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20260929120300_vtid_04741_commission_confirm_reverse_functions.sql` | relation "recommendation_commissions" does not exist | 3a broken/drifted migration | cascade: public.recommendation_commissions created by failed 20260715120000_vtid_02950_recommendation_commissions.sql |
| `20260929120400_vtid_04741_confirm_commission_order_lock_exclusions.sql` | relation "recommendation_commissions" does not exist | 3a broken/drifted migration | cascade: public.recommendation_commissions created by failed 20260715120000_vtid_02950_recommendation_commissions.sql |
| `20260929120500_vtid_04741_reverse_commission_order_recheck.sql` | relation "recommendation_commissions" does not exist | 3a broken/drifted migration | cascade: public.recommendation_commissions created by failed 20260715120000_vtid_02950_recommendation_commissions.sql |
| `20260929120600_vtid_04741_confirm_commission_refresh_terms.sql` | relation "recommendation_commissions" does not exist | 3a broken/drifted migration | cascade: public.recommendation_commissions created by failed 20260715120000_vtid_02950_recommendation_commissions.sql |
| `20260929120700_vtid_04740_product_clicks_select_own_only.sql` | relation "public.product_clicks" does not exist | 3a broken/drifted migration | cascade: public.product_clicks created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20261001120000_VTID_04762_audiobook_season0_prolog.sql` | column "vitana_voice_script" of relation "journey_checklist_translations" does not exist | 3a broken/drifted migration | public.journey_checklist_translations created earlier by 20260610130000_BOOTSTRAP_journey_checklist_translations.sql but absent (dropped/renamed) |
| `20261001120000_vtid_04769_supplier_go_live_lists_products.sql` | relation "public.products" does not exist | 3a broken/drifted migration | cascade: public.products created by failed 20260416120000_vtid_02000_marketplace_foundation.sql |
| `20261001140000_vtid_04783_discover_categories.sql` | relation "public.catalog_verticals" does not exist | 3a broken/drifted migration | cascade: public.catalog_verticals created by failed 20260915100000_vtid_03894_supplier_verticals.sql |
| `20261001180000_vtid_04809_vtna_reward_ledger.sql` | relation "public.user_wallets" does not exist | 2 vitana-v1 schema | public.user_wallets created only by vitana-v1 20250921100510_89b3a262-2aa9-4f5f-9079-8d57ee4f19ba.sql |
| `20261003100000_vtid_04859_founding_1000.sql` | relation "public.notification_test_actors" does not exist | 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql |
| `20261005090000_vtid_04880_archive_nav_catalog.sql` | relation "public.supported_locales" does not exist | 3b environment gap (pinned image) | cascade: public.supported_locales created by failed 20260806090000_VTID_03515_db_i18n_locale_registry.sql |
| `20261005100000_vtid_04878_claim_capped_reward.sql` | relation "public.notification_test_actors" does not exist | 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql |
| `20261005120000_vtid_04888_rule45_intents_profiles.sql` | relation "public.notification_test_actors" does not exist | 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql |
| `20261005130000_vtid_04895_partner_terms_lifecycle.sql` | relation "public.partner_terms_acceptances" does not exist | 3a broken/drifted migration | cascade: public.partner_terms_acceptances created by failed 20260924150000_vtid_04478_partner_onboarding_engine.sql |
| `20261006120000_vtid_04909_partner_terms_german_binding.sql` | relation "public.partner_terms_versions" does not exist | 3a broken/drifted migration | cascade: public.partner_terms_versions created by failed 20261005130000_vtid_04895_partner_terms_lifecycle.sql |
| `20261006140000_vtid_04915_community_event_host_and_time_sync.sql` | relation "public.global_community_events" does not exist | 2 vitana-v1 schema | public.global_community_events created only by vitana-v1 20250917153624_22b8e9be-eb29-477c-974b-87a609943321.sql |
| `20261006150000_vtid_04926_mention_notification_types.sql` | relation "public.notification_type_controls" does not exist | 3a broken/drifted migration | cascade: public.notification_type_controls created by failed 20260926190000_vtid_04674_notification_type_controls.sql |
| `20261007200000_vtid_04965_live_room_reminder_calendar.sql` | relation "public.community_live_streams" does not exist | 2 vitana-v1 schema | public.community_live_streams created only by vitana-v1 20251022080341_38ea1cf6-7460-47d3-b2c8-7ffebf4fcce5.sql |
| `20261008100000_vtid_04968_mcp_oauth_client_info.sql` | relation "auth.oauth_clients" does not exist | 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) |
| `20261008130000_vtid_04976_live_room_follows_host.sql` | relation "public.community_live_streams" does not exist | 2 vitana-v1 schema | public.community_live_streams created only by vitana-v1 20251022080341_38ea1cf6-7460-47d3-b2c8-7ffebf4fcce5.sql |
| `20261008150000_vtid_04978_reminders_in_calendar.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20261009090000_vtid_04994_subscription_dates_in_calendar.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20261010100000_vtid_04997_test_results_in_calendar.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20261010120000_vtid_05027_push_reach_active.sql` | relation "notification_test_actors" does not exist | 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql |
| `20261010150000_vtid_04917_audiobook_source_type.sql` | relation "public.calendar_events" does not exist | 2 vitana-v1 schema | public.calendar_events created only by vitana-v1 20250923103450_79ed87a3-aa6f-4634-a68f-d44e156b0d46.sql |
| `20261010160000_vtid_05035_reward_shop_images_bucket.sql` | column "public" of relation "buckets" does not exist | 3b environment gap (pinned image) | pinned image ships stub auth/storage schemas (no GoTrue / storage-api migrations) |
| `20261010160000_vtid_05038_welcome_trigger_enrollment_restore.sql` | relation "public.notification_test_actors" does not exist | 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql |
| `20261010160000_vtid_05057_contacts_phone_matching.sql` | relation "public.contacts" does not exist | 2 vitana-v1 schema | public.contacts created only by vitana-v1 20251010130129_0f59d882-2e49-4bf6-9277-7a8429e92088.sql |
| `20261010170000_vtid_05052_ci_welcome_greeting_health_exclude_test_accounts.sql` | relation "public.notification_test_actors" does not exist | 2 vitana-v1 schema | public.notification_test_actors created only by vitana-v1 20260805160000_vtid_03506_suppress_test_actor_notifications.sql |
| `20261010180000_vtid_05043_s3_membership_side_effect_guard.sql` | function public.claim_founding_seat_on_membership() does not exist | 2 vitana-v1 schema | cascade: public.claim_founding_seat_on_membership created by failed 20261003100000_vtid_04859_founding_1000.sql |
| `20261010190000_vtid_05055_partner_health_member_link_confirmation.sql` | relation "public.partner_health_result_inbox" does not exist | 3a broken/drifted migration | cascade: public.partner_health_result_inbox created by failed 20260914090000_vtid_03885_partner_health_test_integration.sql |
| `20261012180000_vtid_05095_phone_verification.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20261013200000_vtid_05143_unified_card_system.sql` | relation "public.profiles" does not exist | 2 vitana-v1 schema | public.profiles created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20261013233000_vtid_05147_s_m_membership_role_lockdown.sql` | relation "public.role_preferences" does not exist | 2 vitana-v1 schema | public.role_preferences created only by vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql |
| `20261014000100_vtid_05149_tenants_default_platform_flags.sql` | VTID-05149 M1: expected exactly 2 tenants, one of them maxina; found 3 tenants, 1 maxina | 3a broken/drifted migration | broken statement: ERROR:  VTID-05149 M1: expected exactly 2 tenants, one of them maxina; found 3 t |
| `20261014000200_vtid_05149_signup_default_tenant.sql` | function "public.handle_new_user()" does not exist | 2 vitana-v1 schema | public.handle_new_user created only by vitana-v1 20250822125320_2bbf7247-200c-4836-a799-4037ddf2f26c.sql |
| `20261014000400_vtid_05150_tenant_brand_pack.sql` | column "tenant_id" does not exist | 3a broken/drifted migration | column drift on public.tenant_settings (table shape differs from the statement) |
| `20261014000500_vtid_05150_provision_tenant.sql` | VTID-05150: apply 20261014000400_vtid_05150_tenant_brand_pack first | 3a broken/drifted migration | cascade: needs 20261014000400_vtid_05150_tenant_brand_pack.sql |
| `20261014000600_vtid_05151_public_tenant_registry.sql` | column "tenant_id" specified in USING clause does not exist in left table | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20261014000700_vtid_05151_seed_legacy_tenant_landing.sql` | column t.tenant_id does not exist | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20261014100100_vtid_05158_health_store.sql` | VTID-05158 health store placement guard: this database has auth.users and storage.objects (Supabase). The h... | 3b environment gap (pinned image) | VTID-05158/05161 placement guard: health store is Aurora-only, refuses a Supabase-shaped database |
| `20261014100200_vtid_05161_health_sources.sql` | VTID-05161 health store placement guard: this database has auth.users and storage.objects (Supabase). healt... | 3b environment gap (pinned image) | VTID-05158/05161 placement guard: health store is Aurora-only, refuses a Supabase-shaped database |
| `20261014130000_vtid_05167_activity_tiers.sql` | relation "public.user_activity_log" does not exist | 2 vitana-v1 schema | public.user_activity_log created only by vitana-v1 20251006130209_27a3569f-f9ee-485e-95bb-b11db2d902a5.sql |
| `20261101110000_mt_launch_tenant_pack_intake.sql` | VTID-05324: public.tenants(tenant_id) is missing; refusing to create tenant_pack_intake | 3a broken/drifted migration | public.tenants.tenant_id: live-only column, no committed migration adds it |
| `20261101110100_mt_launch_tenant_content_pipeline.sql` | VTID-05324: apply 20261101110000_mt_launch_tenant_pack_intake.sql first | 3a broken/drifted migration | cascade: needs 20261101110000_mt_launch_tenant_pack_intake.sql |
