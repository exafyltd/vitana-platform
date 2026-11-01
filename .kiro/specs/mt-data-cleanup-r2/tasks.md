# Tasks — mt-data-cleanup-r2 (WS2; re-plan of mt-data-cleanup)

Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`. Lanes 1–4 are DB; lane 5 is gateway CODE.
Read-only counting SQL runs as the `RUN-MIGRATION.yml` pre/post-checks (Kiro, read only). Migrations are applied by
Kiro only after the owner approves the files and the target database (`collaboration.md` §7d). Every lane: `executor:
kiro`, reviewed by `agent:vitana-lane-reviewer`. VTIDs: allocated by CI PLAN-SPAR after policy approval.

Allowed paths: `supabase/migrations/20261102040*.sql`, `supabase/tests/vtid_mt_data_cleanup_orphan_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`,
`supabase/migrations/20261102041*.sql`, `supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql`,
`supabase/migrations/20261102042*.sql`, `supabase/tests/vtid_mt_data_cleanup_profiles_*.sql`,
`supabase/migrations/20261102043*.sql`, `supabase/tests/vtid_mt_data_cleanup_notnull_*.sql`,
`DATABASE_SCHEMA.md`, and for lane 5 the paths in its group below.

<!-- lane: orphan-analysis-and-quarantine -->
## orphan-analysis-and-quarantine — orphan analysis, snapshot, remap, quarantine (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102040*.sql`, `supabase/tests/vtid_mt_data_cleanup_orphan_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`

- [ ] O1 Forward migration (`20261102040000_…`): `analyze_orphan_rows()` (read-only, service_role) returning
      per-table counts split by `tenant_id` class × owner-column class, flagging `…0001`-as-dev-tenant vs
      `…0001`-as-bot-user and dev user `…0099`.
- [ ] O2 `bak_mt_data_cleanup_<table>` snapshot tables (RLS on, service_role) populated before any move; 30-day
      retention noted.
- [ ] O3 `mt_orphan_quarantine` table (RLS on, service_role; excluded from member-facing surfaces per rules 43–45).
- [ ] O4 Move logic: dev-user `…0099` rows → quarantine (never Maxina); bot-sent `chat_messages` with a real tenant untouched;
      bot-sent rows with `tenant_id = …0001` → quarantine reason `bot_sender_dev_tenant` (R3-F1, never recipient-derived); remaining rows → owner's canonical primary `user_tenants` tenant; 0/2+-membership owners
      and unattributable cross-tenant DMs → quarantine. Batched 1–5k/txn, `lock_timeout` + retries, off-peak.
- [ ] O5 Pre-approved rollback migration restoring every touched table from `bak_*` and clearing this lane's
      quarantine rows.
- [ ] O6 `docs/validation/<vtid>/`: read-only pre-check (pins the §2 baseline counts), post-check (zero remaining
      orphan rows), rollback-check SQL (RUN-MIGRATION checks); the R3-F1 re-pollution check (post-cleanup `…0001` rows per table
      and sender class, must read 0); copy of `plan-sparring.md`, `scope.json`, `staging-tests.json`.
- [ ] O7 pgTAP `supabase/tests/vtid_mt_data_cleanup_orphan_*.sql`: `…0099`→quarantine and in no live tenant; bot row with a
      real tenant untouched; bot row with `tenant_id = …0001` → quarantine `bot_sender_dev_tenant`; single-membership owner remapped; 0/2+ owner → quarantine, never Maxina; rollback restores
      snapshot counts.
- [ ] O8 Repoint migration: precondition DO block (RAISE if `user_tenants.is_primary` absent or no primary row), then
      `CREATE OR REPLACE` every NULL-fallback function of 01127/01135/01137/01138/01139/01144 (plan premise 7) to the
      single primary `user_tenants` row; 0/2+ primaries fail closed (existing error shape, else raise), never `…0001`;
      same signatures/grants. The five 01127 functions also drop their `v_user_id := '…0099'` fallback (R2-F1): NULL
      `auth.uid()` returns `{ok:false, error:'UNAUTHENTICATED'}` before any lookup or INSERT. pgTAP call-tests per
      function: 1 primary → writes that tenant; 0 and 2 → no `…0001` row; 01127 with NULL `auth.uid()` → UNAUTHENTICATED,
      no `…0099` row; gate RAISEs on a zero-primary fixture. Post-check: no repointed body contains `…0001` or `…0099`
      (`pg_get_functiondef`); zero availability rows with `user_id = …0099`.
- [ ] O9 Add the MIGRATION-QUEUE rows (forward + rollback) after mt-identity-r2's WS1 migrations; baseline-json entry for
      any not-yet-live table, removed after apply.

Acceptance: pgTAP green on the local stack; `analyze_orphan_rows()` is read-only (no write); no row owned by `…0099`
or a 0/2+ membership owner lands in a live tenant; MIGRATION-QUEUE rows present and ordered; PR gate
scope/sparring/weakening green; PR title `VTID-xxxxx (mt-data-cleanup-r2/orphan-analysis-and-quarantine): …`; commits
carry `Collab-Session` / `Collab-Lane: mt-data-cleanup-r2/orphan-analysis-and-quarantine`. Kiro never runs SQL against a
live system.

<!-- lane: memory-facts-supersede-merge -->
## memory-facts-supersede-merge — supersede-merge reassigned memory_facts (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102041*.sql`, `supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] M1 Forward migration (`20261102041000_…`): snapshot `bak_mt_data_cleanup_memory_facts_merge`, then for each
      `(user_id, key)` with >1 current fact keep the newest `extracted_at` current and mark older ones superseded via
      the existing supersede mechanism (no hard delete).
- [ ] M2 Pre-approved rollback migration restoring from the snapshot.
- [ ] M3 `docs/validation/<vtid>/`: read-only pre/post counts (one current fact per `(user_id, key)`), rollback-check
      SQL; `plan-sparring.md` copy, `scope.json`, `staging-tests.json`.
- [ ] M4 pgTAP `supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql`: duplicate `(user_id, key)` collapses to one
      current fact (newest wins); rollback restores duplicates.
- [ ] M5 MIGRATION-QUEUE rows after the orphan lane.

Acceptance: pgTAP green; exactly one current fact per `(user_id, key)` after merge; rollback restores; depends_on
orphan-analysis-and-quarantine honoured; PR gate green; PR title `VTID-xxxxx
(mt-data-cleanup-r2/memory-facts-supersede-merge): …`; `Collab-Lane: mt-data-cleanup-r2/memory-facts-supersede-merge`.
Kiro never runs SQL against a live system.

<!-- lane: profiles-tenant-backfill -->
## profiles-tenant-backfill — backfill profiles.tenant_id (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102042*.sql`, `supabase/tests/vtid_mt_data_cleanup_profiles_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] P1 Forward migration (`20261102042000_…`): snapshot, then backfill `profiles.tenant_id` from each member's
      canonical primary `user_tenants` row; 0/2+-membership members stay NULL and are listed. Column stays nullable.
- [ ] P2 Pre-approved rollback migration restoring from the snapshot.
- [ ] P3 `docs/validation/<vtid>/`: read-only pre/post counts (profiles with/without tenant_id), rollback-check SQL;
      `plan-sparring.md` copy, `scope.json`, `staging-tests.json`.
- [ ] P4 pgTAP `supabase/tests/vtid_mt_data_cleanup_profiles_*.sql`: single-membership member gets its tenant; 0/2+
      member stays NULL, never Maxina; rollback restores.
- [ ] P5 MIGRATION-QUEUE rows after the orphan lane.

Acceptance: pgTAP green; no member defaulted to Maxina; column still nullable; depends_on
orphan-analysis-and-quarantine honoured; PR gate green; PR title `VTID-xxxxx
(mt-data-cleanup-r2/profiles-tenant-backfill): …`; `Collab-Lane: mt-data-cleanup-r2/profiles-tenant-backfill`. Kiro never
runs SQL against a live system.

<!-- lane: hot-tables-not-null-expand-contract -->
## hot-tables-not-null-expand-contract — assert and pin NOT NULL on the hot tables (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102043*.sql`, `supabase/tests/vtid_mt_data_cleanup_notnull_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `DATABASE_SCHEMA.md`

- [ ] H1 Forward migration (`20261102043000_…`), assertion only (plan premise 5 — all three columns are NOT NULL in
      DDL): a DO block that RAISEs if `information_schema.columns.is_nullable = 'YES'` for `tenant_id` on
      `chat_messages`, `user_notifications` or `product_analytics_events`, or if any row's `tenant_id` is not in
      `tenants`. No trigger, no backfill, no `SET NOT NULL`, no default.
- [ ] H2 `DATABASE_SCHEMA.md`: mark `tenant_id UUID NOT NULL` for `product_analytics_events` (line 2542) and on the
      `user_notifications` entry.
- [ ] H3 Rollback file (no-op; the forward migration has no DDL) kept for the queue contract.
- [ ] H4 `docs/validation/<vtid>/`: read-only pre/post check (the same `information_schema` query + zero-orphan
      count); `plan-sparring.md` copy, `scope.json`, `staging-tests.json`.
- [ ] H5 pgTAP `supabase/tests/vtid_mt_data_cleanup_notnull_*.sql`: the assertion passes on the real schema and RAISEs
      on a fixture with a nullable `tenant_id` and on one with a non-existent tenant.
- [ ] H6 MIGRATION-QUEUE rows last in this spec (after orphan + profiles lanes).

Acceptance: pgTAP green; the assertion applies cleanly on the NOT NULL schema and fails loudly otherwise;
`DATABASE_SCHEMA.md` records NOT NULL; depends_on orphan-analysis-and-quarantine + profiles-tenant-backfill honoured; PR gate
green; PR title `VTID-xxxxx (mt-data-cleanup-r2/hot-tables-not-null-expand-contract): …`; `Collab-Lane:
mt-data-cleanup-r2/hot-tables-not-null-expand-contract`. Kiro never runs SQL against a live system.

<!-- lane: engine-tenant-fallbacks -->
## engine-tenant-fallbacks — d46/d48/d49 engines never write the dead dev tenant (repo vitana-platform, CODE)

Allowed paths: `services/gateway/src/services/d46-anticipatory-guidance-engine.ts`,
`services/gateway/src/services/d48-opportunity-surfacing-engine.ts`,
`services/gateway/src/services/d49-risk-mitigation-engine.ts`, `services/gateway/src/routes/opportunity-surfacing.ts`,
`services/gateway/test/mt-data-cleanup-engine-tenant.test.ts`.

- [ ] E1 d46 (`:150-177`): on the authenticated path resolve `tenantId` from the caller (`resolvePrimaryTenant(userId)`,
      `tenant-context.ts:43`, or the explicit request context) instead of keeping `DEV_IDENTITY.TENANT_ID` (`:153`).
- [ ] E2 d48 (`:894`, `:917`; route `opportunity-surfacing.ts:152`) and d49 (`:519`, `:608-610`): outside
      `isDevSandbox()`, an empty or `…0001` tenant → no insert, result `TENANT_UNRESOLVED`.
- [ ] E3 Jest `test/mt-data-cleanup-engine-tenant.test.ts`: per engine, authenticated caller with primary tenant T_A
      inserts `tenant_id = T_A`; unresolvable tenant and `…0001` context insert nothing and return
      `TENANT_UNRESOLVED`; dev-sandbox branch unchanged. The d46 case is recorded red on `origin/main`.

Acceptance:
- Change types: Backend.
- E3 green and red-first; full gateway Jest suite, `npm run test:support` (42c) and `npm run test:operator` (42e)
  green; no test weakened; no live write.
- PR title `VTID-xxxxx (mt-data-cleanup-r2/engine-tenant-fallbacks): …`; trailers `Collab-Session` /
  `Collab-Lane: mt-data-cleanup-r2/engine-tenant-fallbacks`.

## Escalation carry-over (from `mt-data-cleanup`, session `2efa877e`, round 3)
Each finding is answered in `plan.md` "Re-plan answers"; the tasks carry the acceptance.
- R3-F1 [major], verbatim: "Premise 3 misattributes the origin of the 236 bot-sent `chat_messages` rows. The plan
  asserts 'in `fire_welcome_chat_on_membership` / `notify_on_chat_message` the `…0001` is the bot sender'. But
  `fire_welcome_chat_on_membership` declares `v_bot := '…0001'` only to EXCLUDE the bot from the recipient list
  (line 39 `IF v_user_id = v_bot THEN RETURN NEW`; lines 63-66/99-101 exclude `ut.user_id <> v_bot`), and its
  INSERT writes `sender_id = v_user_id` (the new member) with `tenant_id = v_tenant_id = NEW.tenant_id` — never
  `sender_id = …0001`."
  Tasks: `orphan-analysis-and-quarantine` O4, O6, O7.
  Acceptance: pgTAP shows a `sender_id = …0001 AND tenant_id = …0001` fixture row in `mt_orphan_quarantine` with
  reason `bot_sender_dev_tenant` and in no live tenant. A bot row with a real tenant is unchanged. The re-pollution
  check SQL is in `docs/validation/<VTID>/` and reads 0 on the post-cleanup fixture. The PR body lists the
  bot-sender writers with file:line from `plan.md`.
- R3-F2 [major], verbatim: "d48/d49 tables (`contextual_opportunities`, `risk_mitigations`) are populated
  exclusively by `service_role` writers, not by any migration being repointed. [...] This is a re-pollution window
  the plan cannot close within its declared scope."
  Tasks: `engine-tenant-fallbacks` E1–E3.
  Acceptance: E3 covers d46, d48 and d49. No authenticated path inserts `…0001`, and the d46 case is red on
  `origin/main`. The DB post-check names d46/d48/d49 as "backed by lane 5's tests", not proven by the count alone.
