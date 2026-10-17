# Design — mt-data-cleanup (WS2)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` v5.1 (§2 verified starting state, §4.7 migration
  pattern, §6 WS2 scope).
- Migration order, lane version ranges, apply status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Overloaded `…0001` / `…0099` constants:
  `services/gateway/src/services/orb-memory-bridge.ts:66-70` (`DEV_IDENTITY.USER_ID = …0099`,
  `DEV_IDENTITY.TENANT_ID = …0001`); `vitana-v1/.env:17` (`VITE_VITANA_BOT_USER_ID = …0001`).
- Legacy NULL→`…0001` tenant writers (now dormant): `database/migrations/20260103_vtid_01144_…sql:193,454`,
  `20260103_vtid_01139_…sql:224,431,559`, `20260103_vtid_01138_…sql:224,310,450,511`,
  `20260102_vtid_01137_…sql:269,376,573`, `20260102_vtid_01135_…sql:357,540`.
- Bot-as-sender (not hardcoded tenant) in `fire_welcome_chat_on_membership` / `notify_on_chat_message` (tenant from
  `NEW.tenant_id`).
- `product_analytics_events` schema: `DATABASE_SCHEMA.md:2536` (nullable `tenant_id`, service-role insert, no client
  RLS).
- Canonical membership source: mt-identity `membership-unification` (unified `user_tenants` with
  `is_primary`/`active_role`) — a predecessor spec; its handoff is `.kiro/specs/mt-identity/handoff.md`.
- `ci_tenant_isolation_health()` (VTID-05149) — production isolation monitor this spec's cleanup helps turn green.

## Design per lane

### orphan-analysis-and-quarantine (DB)
- `analyze_orphan_rows()` — SECURITY DEFINER, `search_path=public`, EXECUTE service_role only, **read-only**; returns
  per-table counts keyed by (tenant_id class ∈ {NULL, `…0001`, nonexistent, real}) × (owner-column class ∈ {`…0099`
  dev user, `…0001` bot user, real member}). This is the premise-1 column split; its output is the baseline the
  post-check compares against.
- `bak_mt_data_cleanup_<table>` tables (same columns as source + `backed_up_at`), one per table the lane touches;
  populated before any UPDATE/move.
- `mt_orphan_quarantine (id, source_table, source_pk, original_tenant_id, owner_user_id, reason, payload jsonb,
  quarantined_at)` — RLS on, service_role only, excluded from every member-facing surface (rules 43–45).
- The move function(s): dev-user `…0099` rows → quarantine (reason `dev_user_test_data`); bot-sent `chat_messages`
  (`sender_id = …0001`) → recipient's tenant (reason recorded, not quarantined); remaining rows → owner's canonical
  primary `user_tenants` tenant; owners with 0/2+ memberships and unattributable cross-tenant DMs → quarantine
  (reasons `no_membership` / `ambiguous_membership` / `cross_tenant_dm`). Batched (1–5k/txn), `lock_timeout`, retries.
- Rollback migration restores every touched table from its `bak_*` snapshot and empties the quarantine rows this lane
  added.

### memory-facts-supersede-merge (DB; depends on orphan-analysis-and-quarantine)
- After reassignment, a merge function groups current `memory_facts` by `(user_id, key)`; where >1, the newest
  `extracted_at` stays current and the rest are marked superseded through the memory system's existing supersede
  path (not a hard delete). Snapshot `bak_mt_data_cleanup_memory_facts_merge` first; rollback restores it.

### profiles-tenant-backfill (DB; depends on orphan-analysis-and-quarantine)
- `UPDATE profiles SET tenant_id = <canonical primary user_tenants tenant>` for members with exactly one membership;
  0/2+ stay NULL and are listed (reused by the quarantine review). Column stays nullable. Snapshot + rollback.

### hot-tables-not-null-expand-contract (DB; depends on orphan-analysis-and-quarantine + profiles-tenant-backfill)
- `chat_messages` and `user_notifications`: §4.7 expand/contract — BEFORE INSERT trigger fills `tenant_id` from the
  actor's resolved tenant → batched backfill of residual NULLs → `ADD CONSTRAINT <t>_tenant_not_null CHECK (tenant_id
  IS NOT NULL) NOT VALID` → `VALIDATE CONSTRAINT` → `ALTER COLUMN tenant_id SET NOT NULL` → `DROP CONSTRAINT`. All
  under `lock_timeout` + retries, off-peak.
- `product_analytics_events`: insert-time tenant default (payload `tenant_id` when present, else the actor's resolved
  tenant, else quarantine — never Maxina) + the same CHECK→VALIDATE→SET NOT NULL; no client RLS so no policy change.
- Rollback drops NOT NULL and the trigger/default.

## Rules every successor follows
1. **Migrations:** apply strictly in `docs/multitenancy/MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch
   per file, **by Claude only**, with read-only pre/post checks. New multi-tenant migrations take the next version in
   this spec's range `20261101040000`–`20261101045959` and are added to the queue in the same PR, positioned after
   mt-identity's WS1 migrations and before WS3. A PR adding a not-yet-live table adds it to
   `scripts/ci/migration-drift-baseline.json` and removes it after apply.
2. **Never remap test/ambiguous data to Maxina.** Dev user `…0099` and any 0/2+-membership owner go to quarantine,
   never to a live tenant (program §6; rules 43–45).
3. **Snapshot before every data move; keep `bak_*` 30 days; rollback restores from it** (§4.7). A data move / NOT NULL
   cannot be dark — the safety is snapshot + rollback + off-peak + `lock_timeout`, not a feature flag.
4. **Column-split first.** `…0001` means the dev tenant on `tenant_id`, the bot user on `sender_id`/`user_id`; never
   collapse the two.
5. **Read-only everywhere for Kiro and tests** (rules 31/31b/48). Counting/verification SQL is delivered for Claude;
   Kiro never runs SQL and never writes to Supabase or AWS (collaboration §7a). A DB change is a migration file in the
   lane PR.
6. **Depends on mt-identity `membership-unification`** for the canonical `user_tenants`; the cross-spec dependency is
   recorded in prose and each lane body, not in lane `depends_on:` front matter (that lists only lanes of this spec).
7. Test/service/platform accounts stay invisible to members (rules 43–45); no AI/spoken/i18n/route change — DB only.
