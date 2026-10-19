# Tasks — mt-data-cleanup (WS2)

Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`. All lanes are DB-only; read-only counting SQL is
written for Claude to run (Kiro never runs SQL). VTID: allocated by PLAN-SPAR after approval.

Allowed paths: `supabase/migrations/20261101040*.sql`, `supabase/tests/vtid_mt_data_cleanup_orphan_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`,
`supabase/migrations/20261101041*.sql`, `supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql`,
`supabase/migrations/20261101042*.sql`, `supabase/tests/vtid_mt_data_cleanup_profiles_*.sql`,
`supabase/migrations/20261101043*.sql`, `supabase/tests/vtid_mt_data_cleanup_notnull_*.sql`

<!-- lane: orphan-analysis-and-quarantine -->
## orphan-analysis-and-quarantine — orphan analysis, snapshot, remap, quarantine (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101040*.sql`, `supabase/tests/vtid_mt_data_cleanup_orphan_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`

- [ ] O1 Forward migration (`20261101040000_…`): `analyze_orphan_rows()` (read-only, service_role) returning
      per-table counts split by `tenant_id` class × owner-column class, flagging `…0001`-as-dev-tenant vs
      `…0001`-as-bot-user and dev user `…0099`.
- [ ] O2 `bak_mt_data_cleanup_<table>` snapshot tables (RLS on, service_role) populated before any move; 30-day
      retention noted.
- [ ] O3 `mt_orphan_quarantine` table (RLS on, service_role; excluded from member-facing surfaces per rules 43–45).
- [ ] O4 Move logic: dev-user `…0099` rows → quarantine (never Maxina); bot-sent `chat_messages` (`sender_id = …0001`)
      → recipient's tenant; remaining rows → owner's canonical primary `user_tenants` tenant; 0/2+-membership owners
      and unattributable cross-tenant DMs → quarantine. Batched 1–5k/txn, `lock_timeout` + retries, off-peak.
- [ ] O5 Pre-approved rollback migration restoring every touched table from `bak_*` and clearing this lane's
      quarantine rows.
- [ ] O6 `docs/validation/<vtid>/`: read-only pre-check (pins the §2 baseline counts), post-check (zero remaining
      orphan rows), rollback-check SQL for Claude; copy of `plan-sparring.md`, `scope.json`, `staging-tests.json`.
- [ ] O7 pgTAP `supabase/tests/vtid_mt_data_cleanup_orphan_*.sql`: `…0099`→quarantine and in no live tenant; bot row
      → recipient tenant; single-membership owner remapped; 0/2+ owner → quarantine, never Maxina; rollback restores
      snapshot counts.
- [ ] O8 Add the MIGRATION-QUEUE rows (forward + rollback) after mt-identity's WS1 migrations; baseline-json entry for
      any not-yet-live table, removed after apply.

Acceptance: pgTAP green on the local stack; `analyze_orphan_rows()` is read-only (no write); no row owned by `…0099`
or a 0/2+ membership owner lands in a live tenant; MIGRATION-QUEUE rows present and ordered; PR gate
scope/sparring/weakening green; PR title `VTID-xxxxx (mt-data-cleanup/orphan-analysis-and-quarantine): …`; commits
carry `Collab-Session` / `Collab-Lane: mt-data-cleanup/orphan-analysis-and-quarantine`. Kiro never runs SQL against a
live system.

<!-- lane: memory-facts-supersede-merge -->
## memory-facts-supersede-merge — supersede-merge reassigned memory_facts (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101041*.sql`, `supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] M1 Forward migration (`20261101041000_…`): snapshot `bak_mt_data_cleanup_memory_facts_merge`, then for each
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
(mt-data-cleanup/memory-facts-supersede-merge): …`; `Collab-Lane: mt-data-cleanup/memory-facts-supersede-merge`.
Kiro never runs SQL against a live system.

<!-- lane: profiles-tenant-backfill -->
## profiles-tenant-backfill — backfill profiles.tenant_id (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101042*.sql`, `supabase/tests/vtid_mt_data_cleanup_profiles_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] P1 Forward migration (`20261101042000_…`): snapshot, then backfill `profiles.tenant_id` from each member's
      canonical primary `user_tenants` row; 0/2+-membership members stay NULL and are listed. Column stays nullable.
- [ ] P2 Pre-approved rollback migration restoring from the snapshot.
- [ ] P3 `docs/validation/<vtid>/`: read-only pre/post counts (profiles with/without tenant_id), rollback-check SQL;
      `plan-sparring.md` copy, `scope.json`, `staging-tests.json`.
- [ ] P4 pgTAP `supabase/tests/vtid_mt_data_cleanup_profiles_*.sql`: single-membership member gets its tenant; 0/2+
      member stays NULL, never Maxina; rollback restores.
- [ ] P5 MIGRATION-QUEUE rows after the orphan lane.

Acceptance: pgTAP green; no member defaulted to Maxina; column still nullable; depends_on
orphan-analysis-and-quarantine honoured; PR gate green; PR title `VTID-xxxxx
(mt-data-cleanup/profiles-tenant-backfill): …`; `Collab-Lane: mt-data-cleanup/profiles-tenant-backfill`. Kiro never
runs SQL against a live system.

<!-- lane: hot-tables-not-null-expand-contract -->
## hot-tables-not-null-expand-contract — NOT NULL on hot tables via §4.7 (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101043*.sql`, `supabase/tests/vtid_mt_data_cleanup_notnull_*.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] H1 Forward migration(s) (`20261101043000_…`): §4.7 expand/contract to `tenant_id NOT NULL` on `chat_messages`
      and `user_notifications` — BEFORE INSERT backfill trigger → batched backfill of residual NULLs → `CHECK … NOT
      VALID` → `VALIDATE` → `SET NOT NULL` → drop CHECK; `lock_timeout` + retries, off-peak.
- [ ] H2 `product_analytics_events`: insert-time tenant default (payload tenant_id, else actor's resolved tenant, else
      quarantine — never Maxina) + CHECK→VALIDATE→SET NOT NULL; no client RLS change.
- [ ] H3 Pre-approved rollback migration dropping NOT NULL and the trigger/default.
- [ ] H4 `docs/validation/<vtid>/`: read-only pre/post counts (NULL `tenant_id` rows → 0; constraint present),
      rollback-check SQL; `plan-sparring.md` copy, `scope.json`, `staging-tests.json`.
- [ ] H5 pgTAP `supabase/tests/vtid_mt_data_cleanup_notnull_*.sql`: INSERT with NULL tenant_id is trigger-filled;
      NOT NULL holds after contract; rollback removes it.
- [ ] H6 MIGRATION-QUEUE rows last in this spec (after orphan + profiles lanes).

Acceptance: pgTAP green; `chat_messages`/`user_notifications`/`product_analytics_events` `tenant_id` NOT NULL with no
writer broken; rollback clean; depends_on orphan-analysis-and-quarantine + profiles-tenant-backfill honoured; PR gate
green; PR title `VTID-xxxxx (mt-data-cleanup/hot-tables-not-null-expand-contract): …`; `Collab-Lane:
mt-data-cleanup/hot-tables-not-null-expand-contract`. Kiro never runs SQL against a live system.
