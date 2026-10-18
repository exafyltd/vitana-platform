---
change_class: standard
---
# mt-data-cleanup — WS2 orphan data cleanup, quarantine, and NOT NULL hardening

<!-- plan:begin -->
## Problem
Multi-tenant program plan `docs/MULTI-TENANT-PLAN.md` v5.1 §6 WS2. All premises re-verified read-only against
current platform `origin/main` today; the program's own file:line refs are from 2026-10-06/10 and had drifted, so
these are the current citations.

1. **The orphan tenant id `…0001` is overloaded.** `services/gateway/src/services/orb-memory-bridge.ts:65-76`
   defines `export const DEV_IDENTITY` (line 65) with `USER_ID: '00000000-0000-0000-0000-000000000099'` (line 67) and
   `TENANT_ID: '00000000-0000-0000-0000-000000000001'` (line 69); the authoritative bot-user id is `services/gateway/src/lib/vitana-bot.ts:9` (`VITANA_BOT_USER_ID`, matching parent plan v5.1 line 28),
   so (the client mirror `vitana-v1/.env:17 VITE_VITANA_BOT_USER_ID` carries the same value) `…0001` is the **bot user id** too, which makes `…0001` the **bot user id** too. So an
   orphan row's `…0001` means different things by column: `tenant_id = …0001` is the dead dev tenant;
   `sender_id/user_id = …0001` is the bot user; `user_id = …0099` is the dev test user. Cleanup MUST split every
   orphan count by column before deciding, or it will mislabel bot-authored real content as dev test data.
2. **Legacy NULL-fallback writers wrote `…0001` as a tenant.** `database/migrations/20260103_vtid_01144_…sql:193`,
   `20260103_vtid_01139_…sql:224`, `20260103_vtid_01138_…sql:224`, `20260102_vtid_01137_…sql:269`,
   `20260102_vtid_01135_…sql:357` all do `IF v_tenant_id IS NULL THEN v_tenant_id := '…0001'`. The program verified
   (2026-10-06) the resulting orphan rows under nonexistent tenant `…0001`: all 1,067 `memory_facts` belong to dev
   user `…0099` (test data, zero real members); 305 `chat_messages` from 2 senders, 236 sent by the bot user `…0001`;
   135 `memory_items`; 9 `user_notifications`; 3 rows under fake `550e8400…`. Newest orphan row 2026-07-21 — not
   being written now.
3. **`…0001` is the bot USER id, not a hardcoded tenant, in the welcome/notify triggers.** In
   `fire_welcome_chat_on_membership` / `notify_on_chat_message` the `…0001` is the bot sender (tenant comes from
   `NEW.tenant_id`), so bot-sent `chat_messages` carry a **recipient's** real tenant context, not the dev tenant.
   Bot-sent orphan rows therefore get the recipient's tenant, never quarantine.
4. **`profiles.tenant_id` is NULL for all 236 members** (program §2), so no cleanup or later WS can rely on it;
   community scoping in WS3 joins membership until this backfill lands.
5. **`tenant_id NOT NULL` is per-table.** Parent line 65 (§4.11, verified 2026-10-10): `chat_messages.tenant_id` is **already NOT NULL**; WS2 line 109 lists it only as a summary, reconciled by a live `information_schema.columns` pre-check (for Claude) before Lane 4 acts. `user_notifications` (≈83k, nullable per line 109) is the real nullable hot table needing §4.7 expand/contract. `product_analytics_events` (`DATABASE_SCHEMA.md:2536` section header; the `tenant_id UUID` field is nullable at
   `DATABASE_SCHEMA.md:2540`) has nullable `tenant_id`, no client RLS,
   service-role insert only → it is hardened by an insert-time default + NOT NULL, not a client-visible rewrite.
6. Memory is user-owned (program §4.9/§6): after an orphan `memory_facts` row is reassigned to a real tenant via the
   member's canonical membership, two rows for the same `(user_id, key)` can coexist across the move and must be
   supersede-merged (keep the newest `extracted_at`, mark older superseded) — the same merge the memory system
   already models.

7. **The five NULL-fallback writer functions are still deployed** (R1-F2). `01135_boundary_consent.sql:357,540`, `01144_positive_trajectory_reinforcement.sql:193,454` (and 01137/01138/01139) set `v_tenant_id := '…0001'` when tenant is NULL; 01135 reads `profiles.tenant_id` (NULL for all 236, premise 4) so its fallback is unconditional today. Unrepointed, the zero-orphan post-check re-pollutes on the next call. They are DB objects — repointing them is WS2 work, not the mt-identity CODE cleanup.
8. **The same writers insert into d43–d50 tables** with `tenant_id = '…0001'` on the NULL fallback (e.g. `d45_predictive_windows` `01139_d45_predictive_risk_forecasting.sql:236`). `analyze_orphan_rows()` sweeps 'any other tenant table', but the baseline must enumerate d43–d50 (count even if zero).
**Depends on mt-identity `membership-unification`** (canonical `user_tenants` with `is_primary`/`active_role`): the
remap-by-canonical-membership and quarantine-for-0/2+-memberships steps read that unified source. See `## Depends on`.

## Fix (per lane — all DB; §4.7 split; no client-visible CODE in this spec)
Read-only counting/verification SQL is **written for Claude to run** (Kiro never runs SQL); each lane ships its SQL
under `docs/validation/<vtid>/`.

1. **`orphan-analysis-and-quarantine`** (DB) — the foundation lane.
   - `analyze_orphan_rows()` (SECURITY DEFINER, service_role only, **read-only**; **`REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`** after create — R1-F5/S-B pattern): for each affected table
     (`memory_facts`, `memory_items`, `chat_messages`, `user_notifications`, the d43–d50 analytics tables, and any other tenant table with rows
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
   - **Repoint the five NULL-fallback writers** (01135/01137/01138/01139/01144, R1-F2): `v_tenant_id := '…0001'` becomes `SELECT tenant_id FROM user_tenants WHERE user_id = v_user_id AND is_primary = true LIMIT 1`; on 0/2+ memberships it **raises** instead of writing `…0001`. No privilege widening.
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
4. **`hot-tables-not-null-expand-contract`** (DB; depends on lanes 1 and 3) — §4.7 expand/contract.
   **Pre-check first (R1-F1):** Claude runs `information_schema.columns` for `tenant_id` on `chat_messages`/`user_notifications` against staging. `chat_messages.tenant_id` is already NOT NULL (parent line 65) — **out of scope** here (its …0001 rows are Lane 1 remap/quarantine); the lane hardens only columns the pre-check reports nullable (expected `user_notifications`).
   For each still-nullable hot table: BEFORE INSERT trigger → batched backfill of residual NULLs (1–5k/txn, off-peak) → `CHECK (tenant_id IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop CHECK; `lock_timeout` + retries.
   **Trigger resolver (R1-F3):** a direct `SECURITY DEFINER` lookup `SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid() AND is_primary = true LIMIT 1` — **not** `current_tenant_id()` (JWT-dependent, NULL for browser JWTs, parent §4.2). Resolver and any snapshot/move function **`REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`** (R1-F5).
   **`user_notifications` trigger order (R1-F4):** existing `trg_enforce_notification_type_controls` (`DATABASE_SCHEMA.md:1085`) drops rows (returns NULL) BEFORE INSERT; Postgres fires BEFORE INSERT triggers alphabetically, so the fill trigger is named to sort **after** it (e.g. `trg_zzz_tenant_fill_user_notifications`).
   `product_analytics_events`: insert-time tenant default + CHECK→VALIDATE→SET NOT NULL (no client RLS). Rollback drops NOT NULL / the trigger. Read-only pre/post counts for Claude.

## Migrations
Lane version range `20261101040000`–`20261101045959` (NN=04). The executor renumbers if a later migration exists at
implementation time and adds the MIGRATION-QUEUE rows in the same PR, positioned **after mt-identity's WS1
migrations** (this spec reads the unified `user_tenants`) and before WS3 community-isolation. Each lane: a forward
migration, a pre-approved rollback migration (restores from the lane's `bak_*` snapshot where it moved data), and
read-only pre/post-apply check SQL under `docs/validation/<vtid>/`. Applied by Claude via `RUN-MIGRATION.yml`, one
file per dispatch, post-check after each. Proposed queue order within this spec: 1 orphan-analysis-and-quarantine →
2 memory-facts-supersede-merge → 3 profiles-tenant-backfill → 4 hot-tables-not-null (4 last; it depends on the NULL
residue being resolved by 1 and 3).

## Tests
- **pgTAP** per lane on a local Supabase stack (program D11, schema dump never data): dev-user `…0099` rows land in
  quarantine and in **no** live tenant; a bot-sent row gets its recipient's tenant; an owner with exactly one
  membership is remapped to it; an owner with 0 or 2+ memberships lands in `mt_orphan_quarantine` and is never set to
  Maxina; supersede-merge keeps exactly one current fact per `(user_id, key)`; after lane 4, an INSERT with NULL
  `tenant_id` is filled by the trigger and the NOT NULL constraint holds; rollback restores the `bak_*` snapshot
  row-for-row.
- **R1-F3/F4/F5 pgTAP:** a claimless-JWT INSERT with no `tenant_id` is filled by the resolver (not NULL); a `user_notifications` INSERT for a disabled type is still dropped (controls trigger runs before the fill trigger); `has_function_privilege('authenticated','<fn>','EXECUTE')` is false for every function this spec creates; a repointed writer with a 0/2+-membership user raises instead of writing …0001.
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
dark — program §4.7); the safety is the snapshot + rollback + off-peak window + `lock_timeout`, not a flag. Owner-named
steps: none beyond the standard `RUN-MIGRATION` dispatch (no auth-hook, no production write by Kiro).

## Risks
- **Mislabelling bot content as dev test data** if `…0001` is read as a tenant on a `sender_id` column. Mitigation:
  premise-1 column-split analysis is the first step; pgTAP pins the bot-vs-dev distinction.
- **Lock contention on hot tables** (`chat_messages` 49k, `user_notifications` 83k). Mitigation: §4.7 expand/contract,
  batched backfill, `lock_timeout` + retries, off-peak window.
- **Realtime staleness** during the hot-table backfill. Mitigation: the BEFORE INSERT trigger fills new rows so no
  writer breaks; backfill touches only residual NULLs.
- **Dependency drift**: this spec reads mt-identity's unified `user_tenants`. Mitigation: lane 1 is held until
  mt-identity `membership-unification` is done (stated in the lane body and `## Depends on`); its post-check asserts
  the canonical membership source is present.
- **Irreversible delete**: dev-user rows are moved to quarantine, not deleted, so the move is reversible from the
  snapshot; a later purge of the quarantine table is a separate owner-approved step, out of scope here.

## Out of scope
- WS1 identity/resolution/membership unification itself (mt-identity) — a dependency, not re-planned here.
- The `DEV_IDENTITY` fallback in `orb-memory-bridge.ts` (gateway CODE) and slug maps — mt-identity `tenant-db-and-slug-cleanup`. The five DB writer functions ARE repointed here in Lane 1 (R1-F2).
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
Implements decided items — program §6 WS2 and the standing rules (never remap dev/test data to Maxina; never default
ambiguous owners to Maxina; §4.7 expand/contract; snapshots before data moves; read-only SQL for Claude). No new owner
decision proposed.
<!-- plan:end -->

## Open questions for sparring
- The exact `product_analytics_events` insert-time tenant source (actor's resolved tenant vs the event payload's
  `tenant_id`): the executor confirms against the live insert path at implementation time; defaults to the event
  payload's `tenant_id` when present, else the actor's resolved tenant, else quarantine — never Maxina.
