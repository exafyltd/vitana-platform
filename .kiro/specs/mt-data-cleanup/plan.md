---
change_class: standard
---
# mt-data-cleanup — WS2 orphan data cleanup, quarantine, and NOT NULL hardening

<!-- plan:begin -->
## Problem
Multi-tenant program plan `docs/MULTI-TENANT-PLAN.md` v5.1 §6 WS2. Premises re-verified read-only on current
platform `origin/main` (the program's 2026-10 refs had drifted).

1. **The orphan tenant id `…0001` is overloaded.** `services/gateway/src/services/orb-memory-bridge.ts:65-69`
   `DEV_IDENTITY` has `USER_ID` `…0099` (line 67) and `TENANT_ID` `…0001` (line 69); `services/gateway/src/lib/vitana-bot.ts:9` `VITANA_BOT_USER_ID` (parent v5.1 line 28; client mirror
   `vitana-v1/.env:17`) makes `…0001` the **bot user id** too. So an
   orphan row's `…0001` means different things by column: `tenant_id = …0001` is the dead dev tenant;
   `sender_id/user_id = …0001` is the bot user; `user_id = …0099` is the dev test user. Cleanup MUST split every
   orphan count by column before deciding, or it will mislabel bot-authored real content as dev test data.
2. **Legacy NULL-fallback writers wrote `…0001` as a tenant** (`IF v_tenant_id IS NULL THEN v_tenant_id := '…0001'`;
   full list in premise 7). The program verified
   (2026-10-06) the resulting orphan rows under nonexistent tenant `…0001`: all 1,067 `memory_facts` belong to dev
   user `…0099` (test data, zero real members); 305 `chat_messages` from 2 senders, 236 sent by the bot user `…0001`;
   135 `memory_items`; 9 `user_notifications`; 3 rows under fake `550e8400…`. Newest orphan row 2026-07-21.
3. **`…0001` is the bot USER id, not a hardcoded tenant, in the welcome/notify triggers.** In
   `fire_welcome_chat_on_membership` / `notify_on_chat_message` the `…0001` is the bot sender (tenant comes from
   `NEW.tenant_id`), so bot-sent `chat_messages` carry a **recipient's** real tenant context, not the dev tenant.
   Bot-sent orphan rows therefore get the recipient's tenant, never quarantine.
4. **`profiles.tenant_id` is NULL for all 236 members** (program §2), so no cleanup or later WS can rely on it;
   community scoping in WS3 joins membership until this backfill lands.
5. **All three WS2 hot tables are already `tenant_id NOT NULL` in their authoritative DDL (R1-F1/F2).**
   `chat_messages` (parent line 65), `user_notifications` (`supabase/migrations/20260225000000_notification_system.sql:27`
   ; parent line 62 agrees) and `product_analytics_events`
   (`supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql:33`). No migration drops it (the only such `DROP NOT NULL` is `product_orders`, `20260929120200_vtid_04740_…sql:12`). `DATABASE_SCHEMA.md:2542` omits the marker — a doc gap, not a nullable
   column. Parent line 109's "NOT NULL via §4.7 on hot tables" is therefore already satisfied by DDL; WS2's job is to
   **prove and pin** it (Lane 4), not to expand/contract. Their wrong-but-non-NULL `…0001` rows are Lane 1 remap/quarantine.
6. Memory is user-owned (program §4.9/§6): after an orphan `memory_facts` row is reassigned to a real tenant via the
   member's canonical membership, two rows for the same `(user_id, key)` can coexist across the move and must be
   supersede-merged (keep the newest `extracted_at`, mark older superseded) — the same merge the memory system
   already models.

7. **Six migrations carry NULL-fallback writer functions, still deployed** (R1-F3: full `git grep` of both
   migration dirs for the `v_tenant_id := '…0001'` literal):
   `01135_boundary_consent.sql:357,540`, `01137_d43_…sql:269,376,573`, `01138_d44_…sql:224,310,450,511`,
   `01139_d45_…sql:224,431,559`, `01144_…sql:193,454`, and `supabase/migrations/20260102200000_vtid_01127_availability_readiness_engine.sql:271,356,418,497,542`
   (JWT `tenant_id` claim, else `…0001`). The five 01127 functions ALSO default a NULL `auth.uid()` to the dev user
   (`v_user_id := '…0099'`, `01127_…sql:275,360,422,501,546`; R2-F1) — the only such user fallback in any migration
   (full `git grep`). `01142_d48` / `01143_d49` carry **no** fallback and no INSERT
   (`01142_…sql:137-386`, `01143_…sql:122-318`) — baseline count only.
   01135 reads `profiles.tenant_id` (NULL for all, premise 4) so its fallback is unconditional today. Unrepointed, the
   zero-orphan post-check re-pollutes. DB objects → WS2 work, not the mt-identity CODE cleanup.
8. **The same writers insert into d43–d50 and availability tables** with `tenant_id = '…0001'` on the NULL fallback
   (e.g. `d45_predictive_windows` `01139_…sql:236`; `availability_assessments`/`availability_overrides`,
   `01127_…sql:26,91`). The baseline enumerates d43–d50 (incl. d48 `contextual_opportunities`, d49 `risk_mitigations`)
   and the availability tables, counted even if zero.
**Depends on mt-identity `membership-unification`** (canonical `user_tenants` with `is_primary`/`active_role`): the
remap-by-canonical-membership and quarantine-for-0/2+-memberships steps read that unified source. See `## Depends on`.

## Fix (per lane — all DB; §4.7 split; no client-visible CODE in this spec)
Read-only counting/verification SQL is **written for Claude to run** (Kiro never runs SQL); each lane ships its SQL
under `docs/validation/<vtid>/`.

1. **`orphan-analysis-and-quarantine`** (DB) — the foundation lane.
   - `analyze_orphan_rows()` (SECURITY DEFINER, service_role only, **read-only**; **`REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`** after create — R1-F5/S-B pattern): for each affected table
     (`memory_facts`, `memory_items`, `chat_messages`, `user_notifications`, the d43–d50 analytics tables, the 01127 availability tables, and any other tenant table with rows
     whose `tenant_id` is NULL or `= …0001` or a non-existent tenant), returns counts split by column
     (`tenant_id` class × `user_id`/`sender_id` class), flagging the `…0001`-as-bot vs `…0001`-as-tenant cases and
     the dev user `…0099`. Pins the premise-2 counts in a post-check.
   - `bak_mt_data_cleanup_<table>` snapshot tables (full copy of every row the lane will move/delete; retained 30
     days per §4.7), created before any write.
   - **Dev-user `…0099` rows → quarantine/delete, NEVER remapped to Maxina** (program §6, explicit). All 1,067
     `memory_facts` and the `…0099`-owned `memory_items` go to the quarantine table, not to any live tenant.
   - **Bot-sent rows (`sender_id = …0001`) → the recipient's tenant** (premise 3), derived from the DM peer's /
     group's tenant, not quarantined.
   - **Remaining orphan rows → the row owner's canonical membership tenant** (mt-identity `membership-unification`:
     the member's single primary `user_tenants` row).
   - **`mt_orphan_quarantine` table** for rows whose owner has **0 or 2+ memberships** (ambiguous — never default to
     Maxina) and for cross-tenant DMs that cannot be attributed; columns capture source table, original row, reason.
   - **Repoint every NULL-fallback writer in the six migrations of premise 7** (01127/01135/01137/01138/01139/01144,
     R1-F3): the `v_tenant_id := '…0001'` branch becomes `SELECT tenant_id FROM user_tenants WHERE user_id = v_user_id
     AND is_primary = true` (exactly one row); on 0/2+ primaries it **fails closed** — returns the function's existing
     error shape (`{ok:false, error:'TENANT_UNRESOLVED'}`) where it already returns jsonb errors, else raises — and
     never writes `…0001`. Same signatures, grants and SECURITY mode (no privilege widening).
   - **01127 user fallback cleared too (R2-F1):** in all five 01127 functions the `v_user_id := '…0099'` branch is
     removed; a NULL `auth.uid()` returns `{ok:false, error:'UNAUTHENTICATED'}` before the tenant lookup and before any
     INSERT, so no writer can recreate `…0099`-owned availability rows after the cleanup.
   - **Precondition gate (R1-F4):** the repoint migration opens with a DO block that RAISEs (aborting the apply) if
     `user_tenants.is_primary` is absent or no `is_primary = true` row exists — so a DDL-only `membership-unification`
     (column present, backfill not run) can never leave every repointed writer failing.
   - Batched moves (1–5k rows/txn, off-peak), `lock_timeout` + retries; a pre-approved rollback migration restores
     from the `bak_*` snapshots.
2. **`memory-facts-supersede-merge`** (DB; depends on lane 1) — after reassignment, for each `(user_id, key)` with
   more than one current fact, keep the newest `extracted_at` as current and mark the older ones superseded using the
   memory system's existing supersede mechanism; snapshot before; rollback restores from snapshot. Read-only pre/post
   counts for Claude.
3. **`profiles-tenant-backfill`** (DB; depends on lane 1) — backfill `profiles.tenant_id` from each member's canonical
   primary `user_tenants` row (members with 0/2+ memberships stay NULL and are listed for the quarantine review, never
   defaulted to Maxina). Expand-only: a nullable column stays nullable here (NOT NULL for `profiles` is out of scope,
   WS3/WS10). Snapshot + rollback. Read-only pre/post counts.
4. **`hot-tables-not-null-expand-contract`** (DB; depends on lanes 1 and 3) — **assert-and-pin, no expand/contract**
   (R1-F1/F2: premise 5, all three columns are NOT NULL in DDL). No trigger, no backfill, no `SET NOT NULL`, no
   insert-time default.
   - One idempotent forward migration: a DO block that RAISEs (fails the apply loudly, rule 10) if
     `information_schema.columns.is_nullable = 'YES'` for `tenant_id` on `chat_messages`, `user_notifications` or
     `product_analytics_events`, or if any of them has a row with `tenant_id` not in `tenants` (the post-Lane-1 state).
     If it ever fires, the §4.7 expand/contract is re-planned in a new sparred plan, not improvised here.
   - `DATABASE_SCHEMA.md`: record `tenant_id UUID NOT NULL` at line 2542 (`product_analytics_events`) and on the
     `user_notifications` entry (ALWAYS 24), so the false nullable premise cannot recur.
   - Rollback: the migration is a pure assertion (no DDL), so its rollback is a no-op file kept for the queue contract.
     Read-only pre/post check for Claude: the same `information_schema` query + the zero-orphan count.

## Migrations
Lane version range `20261101040000`–`20261101045959` (NN=04). The executor renumbers if a later migration exists at
implementation time and adds the MIGRATION-QUEUE rows in the same PR, positioned **after mt-identity's WS1
migrations** (this spec reads the unified `user_tenants`) and before WS3 community-isolation. Each lane: a forward
migration, a pre-approved rollback migration (restores from the lane's `bak_*` snapshot where it moved data), and
read-only pre/post-apply check SQL under `docs/validation/<vtid>/`. Applied by Claude via `RUN-MIGRATION.yml`, one
file per dispatch, post-check after each. Proposed queue order within this spec: 1 orphan-analysis-and-quarantine →
2 memory-facts-supersede-merge → 3 profiles-tenant-backfill → 4 hot-tables-not-null (4 last; its assertion includes
the zero-orphan state that 1 and 3 produce).

## Tests
- **pgTAP** per lane on a local Supabase stack (program D11, schema dump never data): dev-user `…0099` rows land in
  quarantine and in **no** live tenant; a bot-sent row gets its recipient's tenant; an owner with exactly one
  membership is remapped to it; an owner with 0 or 2+ memberships lands in `mt_orphan_quarantine` and is never set to
  Maxina; supersede-merge keeps exactly one current fact per `(user_id, key)`; lane 4's assertion passes on the
  NOT NULL schema and RAISEs on a fixture where `tenant_id` is made nullable or holds a non-existent tenant; rollback
  restores the `bak_*` snapshot row-for-row.
- **Writer call-tests (R1-F3/F4) in pgTAP, on the local stack (never staging — the writers INSERT):** every repointed
  function of all six migrations, called as a member with exactly one `is_primary` row, succeeds and writes that
  tenant; called as a member with 0 and with 2 primaries, it fails closed and writes no row with `…0001`; each 01127
  function called with NULL `auth.uid()` returns UNAUTHENTICATED and writes no `…0099` row (R2-F1); the
  precondition gate RAISEs on a fixture with the column but zero primary rows. `has_function_privilege('authenticated',
  '<fn>','EXECUTE')` is false for every function this spec creates.
- **Read-only post-check (for Claude):** no deployed function body contains the `…0001` or `…0099` fallback
  (`pg_get_functiondef` over the repointed names), zero `availability_assessments`/`availability_overrides` rows have
  `user_id = …0099`, and the count of real members with exactly one primary row is
  reported next to the 0/2+ list — proving the lookup path is live without calling a writer on a shared database.
- **Snapshot/rollback drill** in pgTAP: apply forward, assert moved counts, apply rollback, assert original counts.
- No gateway/app code changes: `npm run test:support` (42c) and `npm run test:operator` (42e) stay green.
- Read-only counting SQL (for Claude) proves the premise-2 numbers before and the zero-orphan state after.

## Staging verification
Read-only only (rules 31/31b/48; staging writes to the production Supabase project). No new user-facing surface, so
no Playwright suite is required; the staging check is the read-only `analyze_orphan_rows()` / post-check SQL run by
Claude against staging to confirm zero remaining orphan rows and the NOT NULL constraints present. `staging-tests.json`
lists these read-only checks. No suite ever points at `vitanaland.com`.

## Rollout
Pure DB, applied by Claude via `RUN-MIGRATION.yml` after merge, strictly in MIGRATION-QUEUE order, each with its
read-only pre-check (must match the premise-2 baseline) and post-check. `bak_*` snapshots retained 30 days; a
pre-approved rollback migration per lane restores from them. No feature flag (a data move cannot be dark, §4.7); safety
is snapshot + rollback + off-peak + `lock_timeout`. No other
owner-named steps; no production write by Kiro.

## Risks
- **Mislabelling bot content as dev test data** if `…0001` is read as a tenant on a `sender_id` column. Mitigation:
  premise-1 column-split analysis is the first step; pgTAP pins the bot-vs-dev distinction.
- **Lock contention on hot tables** (`chat_messages` 49k, `user_notifications` 83k) during Lane 1's remap.
  Mitigation: batched moves, `lock_timeout` + retries, off-peak window; Lane 4 takes no table lock (catalog read only).
- **Repointed writers fail closed for 0/2+-membership members** (they no longer get a `…0001` row). Intended: such a
  write was mis-tenanted before; the member is on the quarantine review list. The precondition gate stops the
  degenerate all-fail case.
- **Dependency drift**: this spec reads mt-identity's unified `user_tenants`. Mitigation: lane 1 is held until
  mt-identity `membership-unification` is done (stated in the lane body and `## Depends on`); its post-check asserts
  the canonical membership source is present.
- **Irreversible delete**: none — dev-user rows are quarantined, not deleted; reversible from the snapshot.

## Out of scope
- WS1 identity/resolution/membership unification itself (mt-identity) — a dependency, not re-planned here.
- The `DEV_IDENTITY` fallback in `orb-memory-bridge.ts` (gateway CODE) and slug maps — mt-identity `tenant-db-and-slug-cleanup`. The DB writer functions of the six premise-7 migrations ARE repointed here in Lane 1.
- §4.7 expand/contract on the hot tables — not needed (premise 5); re-planned only if Lane 4's assertion ever fires.
- WS3 community `tenant_id` + RLS on community tables; `profiles.tenant_id NOT NULL`; `scope`/`network_visible`.
- Purging (vs quarantining) dev/test data — a later owner-approved step.
- Any client/gateway code change (this spec is DB-only).

## Depends on
- **Spec `mt-identity`, lane `membership-unification`** (canonical `user_tenants`) — cross-spec; recorded here and in
  each lane body, NOT in lane `depends_on:` front matter (that field is for lanes of THIS spec only).
- Done: VTID-05149 (`tenants.is_default`/`is_platform`, `TenantContext`, `ci_tenant_isolation_health()`),
  VTID-05147 (S-M membership/role lockdown — no later migration re-opens member writes).
- Within this spec: lanes 2, 3 depend on lane 1; lane 4 depends on lanes 1 and 3 (see `depends_on:` in each lane).

## Owner decisions
Implements decided items only (program §6 WS2 + standing rules). No new owner decision proposed.
<!-- plan:end -->

## Open questions for sparring
- None open. (The former `product_analytics_events` insert-default question is moot: the column is NOT NULL in DDL,
  premise 5.)
