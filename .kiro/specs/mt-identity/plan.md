---
change_class: standard
---
# mt-identity — WS1 identity, tenancy resolution & roles (the rest after VTID-05149)

<!-- plan:begin -->
## Problem
Program `docs/MULTI-TENANT-PLAN.md` v5.1, §4.2/§4.3, workstream WS1. VTID-05149 already shipped
`tenants.is_default`/`is_platform`, the signup default tenant, `resolvePrimaryTenant()` + `TenantContext`
(`services/gateway/src/services/tenancy/tenant-context.ts`) and `ci_tenant_isolation_health()`. The remaining WS1
pieces are still open and verified today against platform `origin/main`:

1. No tenant-claim access-token hook exists in `supabase/migrations/**`. Browser JWTs carry no top-level `tenant_id`, so `current_tenant_id()` returns NULL for them
   (program §2).
2. Bare `tenant_id = current_tenant_id()` policies (no `auth.uid()`/`current_user_id()`/`is_member`/`is_tenant_admin`/
   service-role check) fail closed while the claim is NULL and would open tenant-wide the instant `current_tenant_id()`
   resolves (N3). **Recounted today** (parser over all 668 `supabase/migrations/*.sql`, last-definition-wins per
   policy name): **19 bare policies on 11 tables** — `community_groups` (insert/update/delete),
   `community_meetups` (insert/update/delete), `community_listings` (`_select_public`), `d42_domain_weights`
   (`_select`), `event_attendance` (`_select`), `live_highlights` (`_select`), `live_room_attendance` (`_select`),
   `live_rooms` (select/insert/update), `products_catalog` (select/insert), `services_catalog` (select/insert),
   `tenant_catalog_overrides` (`_select`). This supersedes the program §2 "26 on 18" figure (2026-10-10), which drifted.
   Of the 18 program-listed tables, 7 are the health set (already `AND user_id = current_user_id()`, O1, excluded),
   `tenants`/`relationship_edges` carry no bare policy, and **5 have NO RLS policy at all** —
   `access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles`. No `tenant_id_for_policies()` or
   `is_member()` helper exists.
3. Membership stores disagree: `memberships` vs `user_tenants` (program §2: 15 rows only in one, 18 only in the
   other), plus `user_permitted_roles` / `role_preferences` / `active_role` as competing role sources.
4. `tenantDb`/`TENANT_TABLES`/`isHealthTable`/`healthDb` do not exist (only a forward-reference comment at
   `middleware/auth-supabase-jwt-repository.ts:17-21`). Tenant-table access is ad hoc; health tables are not excluded.
5. Two distinct fake-tenant-id shapes are live. (a) Two FOUR-entry slug maps (`…0001`–`…0004` =
   vitana/maxina/alkalma/earthlings, not two): `routes/me.ts:15` (`TENANT_SLUGS`, id→slug, read at `me.ts:270,408`) +
   `routes/me.ts:23` (`SLUG_TO_TENANT_ID`, slug→id), and `routes/dev-auth.ts:26` (`SLUG_TO_TENANT_ID`, read at
   `dev-auth.ts:491`). (b) A dev-sandbox constant, not a map: `services/orb-memory-bridge.ts:66` `DEV_IDENTITY`
   (user `…0099`) pinned to `TENANT_ID='…0001'`/`TENANT_SLUG='vitana'`, the no-session sandbox fallback.
6. `bootstrap_admin_user` pins `tenants.name IN ('Maxina','Alkalma','Earthlings')` / `name = 'Maxina'` (wrong key
   column) and writes `memberships` (vitana-v1 `20250831083908_…`–`20250831091149_…`).

## Fix
DB lanes are split from CODE lanes (§4.7). Five lanes; the hook GO-LIVE is deliberately a SEPARATE later lane (owner
D14), not here.

1. **helpers-and-policy-rewrite (DB).** Add `tenant_id_for_policies()` — a NEW name, not a redefine of
   `current_tenant_id()` — and `is_member(tenant_id)` as a STABLE SECURITY DEFINER pair over the unique
   `(tenant_id, user_id)` index, with the N2 degraded path `coalesce(<claim if is_member>, <auth.uid()'s primary
   user_tenants row>)`. `(select tenant_id_for_policies())` is uncorrelated so Postgres hoists it to an initPlan — one
   indexed lookup per statement on the hot user-private tables (`user_notifications`/`chat_messages`). `(select
   is_member(tenant_id))` on tenant-shared tables is CORRELATED on the outer `tenant_id` column, so it runs once per
   row, NOT an initPlan; acceptable because `is_member()` is STABLE SECURITY DEFINER over the unique index (one index
   probe/call) and the test plan adds an EXPLAIN check bounding the per-row cost on the largest tenant-shared table
   (`live_rooms`). Rewrite each of the
   **19 bare policies on the 11 tables above** to `user_id = auth.uid() AND tenant_id = (select tenant_id_for_policies())`
   (user-private) or `(select is_member(tenant_id))` (tenant-shared, owner-tagged). The 5 named tables with NO policy
   (`access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles`) are **out of scope for a
   rewrite** (WS2/WS10, see Out of scope); this lane neither creates nor relaxes a policy on them. Add the N3 bare-policy lint (counts bare `current_tenant_id()`
   policies outside an owner-tagged tenant-shared allowlist; must read ZERO). This lane neither redefines
   `current_tenant_id()` nor enables the hook. **The executor re-runs the recount at implementation** (same parser)
   and records the exact set in the PR before rewriting; if a migration landed since this review changed the count,
   it updates the per-table list, not this plan.
2. **membership-unification (DB).** `user_tenants` (with `is_primary`/`active_role`) becomes canonical; backfill the
   drifted rows (recount read-only at implementation); `memberships` becomes a view over `user_tenants` with a
   dual-write trigger for legacy writers; a nightly drift report reads 0 when converged. The dual-write trigger body
   (steady state, not just the backfill) writes `INSERT INTO user_tenants … ON CONFLICT (tenant_id, user_id) DO
   NOTHING`, so a legacy idempotent re-insert of an existing `memberships` row is a no-op and NEVER re-fires the four
   `user_tenants` AFTER INSERT triggers (the VTID-03990 duplicate-welcome-DM shape, program §3/S-E). The Vitana bot
   user (`lib/vitana-bot.ts:9`, user id `…0001` — same literal as the vitana tenant id, different column, so no key
   clash) and every `service_bot_accounts` user are EXCLUDED from the backfill and from the drift report's member
   counts, so the bot is never counted as a member. Expand/contract;
   snapshot first; the view cutover must not perturb the four AFTER INSERT triggers (N1 side-effect guard).
3. **access-token-hook-shadow (DB).** The hook function reads the active `user_tenants` membership (treating
   `app_metadata.active_tenant_id` as a preference only) and emits `tenant_id_shadow` ONLY, failing open
   (`EXCEPTION WHEN OTHERS` → original claims, single indexed lookup, short statement timeout). A mismatch-log table
   records shadow-vs-membership disagreements as decisions for the 7-day soak; it is **service-role-only** — the
   migration runs `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT ALL … TO service_role; ALTER TABLE … ENABLE
   ROW LEVEL SECURITY` with NO policy (RLS then denies every non-service-role read), so `authenticated`/PostgREST can
   never read another user's shadow-claim rows. Migrations only — no auth config here.
4. **role-source-and-bootstrap (DB, depends on membership-unification).** One role source of truth; the others derive
   from it. Fix `bootstrap_admin_user` to key on `tenants.is_default` and write canonical `user_tenants` through the
   dual-write path. Expand/contract; snapshot first.
5. **tenant-db-and-slug-cleanup (CODE, gateway; depends on helpers-and-policy-rewrite).** Ship the O1 interface
   (the contract other specs reference, spelled out so it can't drift): `type TENANT_TABLES` (schema-derived set),
   `isHealthTable(tableName: string): boolean`, `tenantDb(ctx: TenantContext)`, `healthDb(userId: string)` — health
   tables EXCLUDED from `TENANT_TABLES` and reachable only via `healthDb` (frozen home tenant). Two cleanups: (a) the
   two four-entry slug maps — `me.ts:15`+`:23`, `dev-auth.ts:26` — and the `limit(1)` are REMOVED, resolving through
   the DB registry. `tenant-context.ts` has no slug→id lookup today (`loadTenantFlags()` builds only `byId`), so this
   lane adds a `bySlug` map there (from the already-fetched `slug` column) and `getTenantIdBySlug(slug): Promise<string
   | null>`. `dev-auth.ts:491` uses it (unknown slug → the same 400 with the live slug list; registry unavailable →
   503); `me.ts:270,408` use `(await getTenantMeta(id))?.slug ?? null`. (b) `orb-memory-bridge.ts:66` `DEV_IDENTITY` is a dev-only fallback constant with
   no session to resolve, so it is NOT iterated like a map: drive `TENANT_ID`/`TENANT_SLUG` from a `DEV_TENANT_SLUG`
   env var defaulting to `vitana` (DB-registry-backed in the sandbox), keeping the pinned dev user `…0099`; so no
   `…0001` literal remains in that file. `dev-auth.ts:364` (`DEV_TENANT_ID || '…0001'`) falls back to
   `getDefaultTenantId()` instead. (c) The last `fetchPrimaryTenantForUser` callers — `routes/autopilot-prompts.ts:109`
   (repo fn `middleware/auth-supabase-jwt-repository.ts:35`, whose VTID-05149 comment at `:17` defers it to this slice)
   and the two local copies `routes/presence.ts:55` / `routes/presence-did-you-know.ts:63` (repo fns
   `presence-repository.ts:22`, `presence-did-you-know-repository.ts:23`) — resolve via `resolvePrimaryTenant()`
   (`tenant-context.ts:43`) behind the flag; the three repo fns are marked `@deprecated` (removed in the contract step
   after the flag is on) and the `:17` comment is rewritten to say so. The other ad-hoc `.eq('is_primary', true)` reads
   are inventoried in the PR and move route by route as each adopts `tenantDb`, not here. All reads dark behind
   `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*`.

## Migrations
Range `20261101030000`–`20261101035959` (verified free: newest existing migration is `20261015180000`). Files
(executor renumbers if a later migration lands at implementation and adds the MIGRATION-QUEUE rows at the stated
position, after the VTID-05151 rows):
- helpers: `…030000_tenant_id_for_policies_is_member.sql`, `…030100_bare_policy_rewrite.sql` (+ rollback).
- membership: `…031000_user_tenants_canonical.sql`, `…031100_memberships_view_dualwrite.sql`,
  `…031200_membership_drift_report.sql` (+ rollback).
- hook shadow: `…032000_access_token_hook_shadow.sql`, `…032100_tenant_claim_mismatch_log.sql` (+ rollback).
- role/bootstrap: `…033000_single_role_source.sql`, `…033100_fix_bootstrap_admin_user.sql` (+ rollback).
Each DB slice: dry-run on the D11 local stack, pre-approved rollback migration, off-peak window, owner approval to
apply, read-only post-apply check. Expand/contract only; `lock_timeout` + retries; 30-day `bak_*` snapshot before any
data move. Applied by Claude via RUN-MIGRATION after merge (sessions never apply). CODE lane: no migration.

## Tests
- pgTAP: a_member cannot read a_admin's user-private rows on each of the 11 tables that carry a user-private policy
  after the rewrite (and, read-only, on the health tables, which already enforce it); tenant-shared policies
  (`is_member`) admit same-tenant members only, not another tenant; the 5 no-policy tables are not asserted (nothing
  to isolate yet — WS2/WS10). The bare-policy lint reads 0; the hook fails open (returns original claims on a forced
  error) and emits only `tenant_id_shadow`; `is_member()`/degraded fallback resolve the right tenant with the hook
  OFF. `tenant_claim_mismatch_log` denies a read by the `authenticated` role (RLS, no policy) and admits
  `service_role`. Re-inserting an already-present `memberships` row through the dual-write trigger creates ZERO extra
  `chat_messages`/founding seats/autopilot rows/live rooms (VTID-03990 contract applied to the steady-state trigger);
  inserting a `memberships` row for the bot user `…0001` likewise yields zero `chat_messages`, and the backfill
  touches no bot/`service_bot_accounts` user.
  An EXPLAIN check bounds the per-row `is_member()` cost on the largest tenant-shared table (`live_rooms`).
- Local-stack test with the hook OFF after the policy rewrite: members still see their own rows and nothing of the
  other tenant.
- Vitest (gateway): `tenantDb` injects the tenant predicate; `isHealthTable()` matches the health table set and
  health tables are absent from `TENANT_TABLES`; `healthDb` resolves the frozen home tenant; the two slug maps are
  gone; `getTenantMeta(id)`/`getTenantIdBySlug(slug)` round-trip on stubbed flags and an unknown slug → null; with the flag on, the three former `fetchPrimaryTenantForUser`
  callers resolve via `resolvePrimaryTenant()` (existing `vtid-05121-autopilot-prompts-…` test stays green). Literal
  lint, two parts: (1) `me.ts`, `dev-auth.ts`, `orb-memory-bridge.ts` contain NO `…0001`–`…0004` literal (no carve-out,
  so a partial removal fails); (2) ratchet: `…0001` literals in gateway TS outside the ONE intentional site
  `lib/vitana-bot.ts` (`VITANA_BOT_USER_ID`, bot USER id, program §2) never exceed the baseline recorded in the test at
  implementation (today ~30: d28–d51 engine dev constants, zod `.default()`s, `orb-live.ts` sandbox fallbacks, a
  duplicate bot id in `admin-tenants-repository.ts:57`) — those are WS2 cleanup, not this spec.
- Required suites when touched: `npm run test:support` (42c), `npm run test:operator` (42e), `npm run test:roles`
  (42h — the role-source lane touches the role registry path). Maxina golden suite unchanged (program WS0).

## Staging verification
Read-only (rule 48). CODE lane: a staging spec signs in as the test user and asserts resolution still returns the
member's own tenant and no cross-tenant rows via existing GET endpoints; a network guard aborts every non-GET. DB
lanes are verified by RUN-MIGRATION post-checks (read-only SQL) and `ci_tenant_isolation_health()` after apply; no
suite targets production.

## Rollout
Dark by default: every CODE read is behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`. DB changes
follow the §4.7 slice protocol and are applied by Claude via RUN-MIGRATION after merge; the owner applies nothing here
(the hook stays shadow). Owner-only step: NONE in this spec — the hook go-live (D14) is a separate later lane.

## Risks
- A bare policy missed by the rewrite opens a table tenant-wide when the hook later goes live. Mitigation: the N3 lint
  must read 0 before any go-live lane; pgTAP per table.
- The `memberships` → view cutover breaks a legacy writer or fires an N1 side-effect trigger. Mitigation: dual-write
  trigger, suppression guard on the backfill, drift report, snapshot + rollback.
- The bot user id `…0001` equals the vitana tenant id literal; counted as a member it would skew seat counts.
  Mitigation: backfill + drift report exclude it and `service_bot_accounts`; pgTAP zero-side-effect check.
- Hook latency/error on login. Mitigation: shadow-only here, fail-open, single indexed lookup, short statement
  timeout, 7-day mismatch soak before any go-live.
- `tenant_id_for_policies()` per-row cost on hot tables. Mitigation: `(select …)` initPlan evaluation; shared lookup
  with `is_member()`.

## Out of scope
- The access-token hook GO-LIVE (emitting real `tenant_id`) and its Supabase auth-config enablement/disable runbook —
  a SEPARATE later lane, owner-applied per D14, after this spec's policy rewrite + helpers land.
- Redefining `current_tenant_id()` as an alias of `tenant_id_for_policies()` (the final go-live migration, later lane).
- WS2 data cleanup, WS3 community/network isolation, WS0 CI lint/isolation-suite wiring, and the health-table policy
  move to `user_id = auth.uid()` (WS10) — their own specs.
- Creating or hardening RLS on the 5 no-policy tables named above (WS2/WS10).
- Cleaning the ~30 other gateway `…0001` literals (ratcheted, WS2) and moving every ad-hoc `is_primary` read.

## Depends on
- Done: VTID-05147 (S-M), VTID-05149 (A: `tenants.is_default`/`is_platform`, `TenantContext`, resolver), VTID-05150,
  VTID-05151. This spec builds on VTID-05149's `tenant-context.ts`.
- Cross-spec: O1 (this spec OWNS the canonical `isHealthTable()`); mt-guardrails lints with it, mt-native-health
  references it.

## Owner decisions
Cited, already decided: N2, N3 (program decision register), D14 (hook applied by owner only — honored by keeping
go-live out of this spec). No new owner decision proposed.
<!-- plan:end -->

## Open questions for sparring
- Which of `role_preferences` / `active_role` / `user_permitted_roles` is the single role source of truth — the
  role-source lane proposes `user_tenants.active_role` as canonical with the others derived; confirm no consumer needs
  the others as a primary write path (cross-check with mt-tenant-admin's role work).
