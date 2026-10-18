---
change_class: standard
---
# mt-data-cleanup ΓÇö WS2 orphan data cleanup, quarantine, and NOT NULL hardening

<!-- plan:begin -->
## Problem
Multi-tenant program plan `docs/MULTI-TENANT-PLAN.md` v5.1 ┬º6 WS2. All premises re-verified read-only against
current platform `origin/main` today; the program's own file:line refs are from 2026-10-06/10 and had drifted, so
these are the current citations.

1. **The orphan tenant id `ΓÇª0001` is overloaded.** `services/gateway/src/services/orb-memory-bridge.ts:65-76`
   defines `export const DEV_IDENTITY` (line 65) with `USER_ID: '00000000-0000-0000-0000-000000000099'` (line 67) and
   `TENANT_ID: '00000000-0000-0000-0000-000000000001'` (line 69), while `vitana-v1/.env:17`
   `VITE_VITANA_BOT_USER_ID="00000000-0000-0000-0000-000000000001"` makes `ΓÇª0001` the **bot user id** too. So an
   orphan row's `ΓÇª0001` means different things by column: `tenant_id = ΓÇª0001` is the dead dev tenant;
   `sender_id/user_id = ΓÇª0001` is the bot user; `user_id = ΓÇª0099` is the dev test user. Cleanup MUST split every
   orphan count by column before deciding, or it will mislabel bot-authored real content as dev test data.
2. **Legacy NULL-fallback writers wrote `ΓÇª0001` as a tenant.** `database/migrations/20260103_vtid_01144_ΓÇªsql:193`,
   `20260103_vtid_01139_ΓÇªsql:224`, `20260103_vtid_01138_ΓÇªsql:224`, `20260102_vtid_01137_ΓÇªsql:269`,
   `20260102_vtid_01135_ΓÇªsql:357` all do `IF v_tenant_id IS NULL THEN v_tenant_id := 'ΓÇª0001'`. The program verified
   (2026-10-06) the resulting orphan rows under nonexistent tenant `ΓÇª0001`: all 1,067 `memory_facts` belong to dev
   user `ΓÇª0099` (test data, zero real members); 305 `chat_messages` from 2 senders, 236 sent by the bot user `ΓÇª0001`;
   135 `memory_items`; 9 `user_notifications`; 3 rows under fake `550e8400ΓÇª`. Newest orphan row 2026-07-21 ΓÇö not
   being written now.
3. **`ΓÇª0001` is the bot USER id, not a hardcoded tenant, in the welcome/notify triggers.** In
   `fire_welcome_chat_on_membership` / `notify_on_chat_message` the `ΓÇª0001` is the bot sender (tenant comes from
   `NEW.tenant_id`), so bot-sent `chat_messages` carry a **recipient's** real tenant context, not the dev tenant.
   Bot-sent orphan rows therefore get the recipient's tenant, never quarantine.
4. **`profiles.tenant_id` is NULL for all 236 members** (program ┬º2), so no cleanup or later WS can rely on it;
   community scoping in WS3 joins membership until this backfill lands.
5. **Hot tables lack `tenant_id NOT NULL`.** `chat_messages` (Γëê49k rows) and `user_notifications` (Γëê83k rows) are
   browser/realtime-reachable and have nullable `tenant_id`; a NOT NULL added naively locks the table. ┬º4.7 requires
   expand/contract. `product_analytics_events` (`DATABASE_SCHEMA.md:2536` section header; the `tenant_id UUID` field is nullable at
   `DATABASE_SCHEMA.md:2540`) has nullable `tenant_id`, no client RLS,
   service-role insert only ΓåÆ it is hardened by an insert-time default + NOT NULL, not a client-visible rewrite.
6. Memory is user-owned (program ┬º4.9/┬º6): after an orphan `memory_facts` row is reassigned to a real tenant via the
   member's canonical membership, two rows for the same `(user_id, key)` can coexist across the move and must be
   supersede-merged (keep the newest `extracted_at`, mark older superseded) ΓÇö the same merge the memory system
   already models.

**Depends on mt-identity `membership-unification`** (canonical `user_tenants` with `is_primary`/`active_role`): the
remap-by-canonical-membership and quarantine-for-0/2+-memberships steps read that unified source. See `## Depends on`.

## Fix (per lane ΓÇö all DB; ┬º4.7 split; no client-visible CODE in this spec)
Read-only counting/verification SQL is **written for Claude to run** (Kiro never runs SQL); each lane ships its SQL
under `docs/validation/<vtid>/`.

1. **`orphan-analysis-and-quarantine`** (DB) ΓÇö the foundation lane.
   - `analyze_orphan_rows()` (SECURITY DEFINER, service_role only, **read-only**): for each affected table
     (`memory_facts`, `memory_items`, `chat_messages`, `user_notifications`, and any other tenant table with rows
     whose `tenant_id` is NULL or `= ΓÇª0001` or a non-existent tenant), returns counts split by column
     (`tenant_id` class ├ù `user_id`/`sender_id` class), flagging the `ΓÇª0001`-as-bot vs `ΓÇª0001`-as-tenant cases and
     the dev user `ΓÇª0099`. Pins the premise-2 counts in a post-check.
   - `bak_mt_data_cleanup_<table>` snapshot tables (full copy of every row the lane will move/delete; retained 30
     days per ┬º4.7), created before any write.
   - **Dev-user `ΓÇª0099` rows ΓåÆ quarantine/delete, NEVER remapped to Maxina** (program ┬º6, explicit). All 1,067
     `memory_facts` and the `ΓÇª0099`-owned `memory_items` go to the quarantine table, not to any live tenant.
   - **Bot-sent rows (`sender_id = ΓÇª0001`) ΓåÆ the recipient's tenant** (premise 3), derived from the DM peer's /
     group's tenant, not quarantined.
   - **Remaining orphan rows ΓåÆ the row owner's canonical membership tenant** (mt-identity `membership-unification`:
     the member's single primary `user_tenants` row).
   - **`mt_orphan_quarantine` table** for rows whose owner has **0 or 2+ memberships** (ambiguous ΓÇö never default to
     Maxina) and for cross-tenant DMs that cannot be attributed; columns capture source table, original row, reason.
   - Batched moves (1ΓÇô5k rows/txn, off-peak), `lock_timeout` + retries; a pre-approved rollback migration restores
     from the `bak_*` snapshots.
2. **`memory-facts-supersede-merge`** (DB; depends on lane 1) ΓÇö after reassignment, for each `(user_id, key)` with
   more than one current fact, keep the newest `extracted_at` as current and mark the older ones superseded using the
   memory system's existing supersede mechanism; snapshot before; rollback restores from snapshot. Read-only pre/post
   counts for Claude.
3. **`profiles-tenant-backfill`** (DB; depends on lane 1) ΓÇö backfill `profiles.tenant_id` from each member's canonical
   primary `user_tenants` row (members with 0/2+ memberships stay NULL and are listed for the quarantine review, never
   defaulted to Maxina). Expand-only: a nullable column stays nullable here (NOT NULL for `profiles` is out of scope,
   WS3/WS10). Snapshot + rollback. Read-only pre/post counts.
4. **`hot-tables-not-null-expand-contract`** (DB; depends on lanes 1 and 3) ΓÇö ┬º4.7 expand/contract to
   `tenant_id NOT NULL` on `chat_messages` and `user_notifications`: nullable ΓåÆ BEFORE INSERT trigger filling
   `tenant_id` from the actor's resolved tenant (so no writer breaks mid-migration) ΓåÆ batched backfill of residual
   NULLs (1ΓÇô5k/txn, off-peak, realtime fan-out considered) ΓåÆ `ADD CONSTRAINT ΓÇª CHECK (tenant_id IS NOT NULL) NOT
   VALID` ΓåÆ `VALIDATE CONSTRAINT` ΓåÆ `SET NOT NULL` ΓåÆ drop the CHECK; `lock_timeout` + retries throughout.
   `product_analytics_events`: insert-time tenant default + the same CHECKΓåÆVALIDATEΓåÆSET NOT NULL (no client RLS, so no
   policy rewrite). Pre-approved rollback drops NOT NULL / the trigger. Read-only pre/post counts for Claude.

## Migrations
Lane version range `20261101040000`ΓÇô`20261101045959` (NN=04). The executor renumbers if a later migration exists at
implementation time and adds the MIGRATION-QUEUE rows in the same PR, positioned **after mt-identity's WS1
migrations** (this spec reads the unified `user_tenants`) and before WS3 community-isolation. Each lane: a forward
migration, a pre-approved rollback migration (restores from the lane's `bak_*` snapshot where it moved data), and
read-only pre/post-apply check SQL under `docs/validation/<vtid>/`. Applied by Claude via `RUN-MIGRATION.yml`, one
file per dispatch, post-check after each. Proposed queue order within this spec: 1 orphan-analysis-and-quarantine ΓåÆ
2 memory-facts-supersede-merge ΓåÆ 3 profiles-tenant-backfill ΓåÆ 4 hot-tables-not-null (4 last; it depends on the NULL
residue being resolved by 1 and 3).

## Tests
- **pgTAP** per lane on a local Supabase stack (program D11, schema dump never data): dev-user `ΓÇª0099` rows land in
  quarantine and in **no** live tenant; a bot-sent row gets its recipient's tenant; an owner with exactly one
  membership is remapped to it; an owner with 0 or 2+ memberships lands in `mt_orphan_quarantine` and is never set to
  Maxina; supersede-merge keeps exactly one current fact per `(user_id, key)`; after lane 4, an INSERT with NULL
  `tenant_id` is filled by the trigger and the NOT NULL constraint holds; rollback restores the `bak_*` snapshot
  row-for-row.
- **Snapshot/rollback drill** in pgTAP: apply forward, assert moved counts, apply rollback, assert original counts.
- Required repo suites unaffected (no gateway/app code changes): a touched-nothing run of `npm run test:support`
  (rule 42c) and `npm run test:operator` (rule 42e) stays green.
- Read-only counting SQL (for Claude) proves the premise-2 numbers before and the zero-orphan state after.

## Staging verification
Read-only only (rules 31/31b/48; staging writes to the production Supabase project). No new user-facing surface, so
no Playwright suite is required; the staging check is the read-only `analyze_orphan_rows()` / post-check SQL run by
Claude against staging to confirm zero remaining orphan rows and the NOT NULL constraints present. `staging-tests.json`
lists these read-only checks. No suite ever points at `vitanaland.com`.

## Rollout
Pure DB, applied by Claude via `RUN-MIGRATION.yml` after merge, strictly in MIGRATION-QUEUE order, each with its
read-only pre-check (must match the premise-2 baseline) and post-check. `bak_*` snapshots retained 30 days; a
pre-approved rollback migration per lane restores from them. No feature flag applies (a data move / NOT NULL cannot be
dark ΓÇö program ┬º4.7); the safety is the snapshot + rollback + off-peak window + `lock_timeout`, not a flag. Owner-named
steps: none beyond the standard `RUN-MIGRATION` dispatch (no auth-hook, no production write by Kiro).

## Risks
- **Mislabelling bot content as dev test data** if `ΓÇª0001` is read as a tenant on a `sender_id` column. Mitigation:
  premise-1 column-split analysis is the first step; pgTAP pins the bot-vs-dev distinction.
- **Lock contention on hot tables** (`chat_messages` 49k, `user_notifications` 83k). Mitigation: ┬º4.7 expand/contract,
  batched backfill, `lock_timeout` + retries, off-peak window.
- **Realtime staleness** during the hot-table backfill. Mitigation: the BEFORE INSERT trigger fills new rows so no
  writer breaks; backfill touches only residual NULLs.
- **Dependency drift**: this spec reads mt-identity's unified `user_tenants`. Mitigation: lane 1 is held until
  mt-identity `membership-unification` is done (stated in the lane body and `## Depends on`); its post-check asserts
  the canonical membership source is present.
- **Irreversible delete**: dev-user rows are moved to quarantine, not deleted, so the move is reversible from the
  snapshot; a later purge of the quarantine table is a separate owner-approved step, out of scope here.

## Out of scope
- WS1 identity/resolution/membership unification itself (mt-identity) ΓÇö a dependency, not re-planned here.
- The `DEV_IDENTITY` fallback removal in `orb-memory-bridge.ts` and the slug maps ΓÇö mt-identity
  `tenant-db-and-slug-cleanup` (CODE).
- WS3 community `tenant_id` + RLS on community tables; `profiles.tenant_id NOT NULL`; `scope`/`network_visible`.
- Purging (vs quarantining) dev/test data ΓÇö a later owner-approved step.
- Any client/gateway code change (this spec is DB-only).

## Depends on
- **Spec `mt-identity`, lane `membership-unification`** (canonical `user_tenants`) ΓÇö cross-spec; recorded here and in
  each lane body, NOT in lane `depends_on:` front matter (that field is for lanes of THIS spec only).
- Done: VTID-05149 (`tenants.is_default`/`is_platform`, `TenantContext`, `ci_tenant_isolation_health()`),
  VTID-05147 (S-M membership/role lockdown ΓÇö no later migration re-opens member writes).
- Within this spec: lanes 2, 3 depend on lane 1; lane 4 depends on lanes 1 and 3 (see `depends_on:` in each lane).

## Owner decisions
Implements decided items ΓÇö program ┬º6 WS2 and the standing rules (never remap dev/test data to Maxina; never default
ambiguous owners to Maxina; ┬º4.7 expand/contract; snapshots before data moves; read-only SQL for Claude). No new owner
decision proposed.
<!-- plan:end -->

## Open questions for sparring
- The exact `product_analytics_events` insert-time tenant source (actor's resolved tenant vs the event payload's
  `tenant_id`): the executor confirms against the live insert path at implementation time; defaults to the event
  payload's `tenant_id` when present, else the actor's resolved tenant, else quarantine ΓÇö never Maxina.