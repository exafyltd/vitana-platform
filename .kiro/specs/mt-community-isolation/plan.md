---
change_class: standard
---
# Community isolation (WS3 Community part) — tenant_id + RLS + tenant-scoped reads

<!-- plan:begin -->
## Problem
Scope = the WS3 **Community** half of the program plan §4.11 / §6 (the Network layer — `scope`
columns on `chat_messages`/`daily_matches`/offerings, `network_visible`, the `send_message*`
rewrite, Network groups — is a sibling spec, out of scope here). Verified read-only in code
2026-10-15 against `vitana-platform-1` and `vitana-v1` origin/main.

1. **Community reads are network-wide, not tenant-scoped.** `find_community_member`'s candidate
   pool is every `global_community_profiles.is_visible = true` profile with no tenant/membership
   filter (`services/gateway/src/services/voice-tools/community-member-ranker.ts:265-281`,
   `community-member-ranker-repository.ts:20-22`). Same shape in the members directory
   (`routes/community-members.ts:98-128` + `community-members-repository.ts:24-26`), superlatives
   (`services/voice-tools/superlatives.ts:10-18`, `superlatives-repository.ts:21-23`), ORB
   `global_search` (`services/orb-tools/discovery-tools.ts` `tool_global_search`), ORB recipient
   resolution (`resolve_recipient_candidates`, `routes/users-resolve.ts`), and `connect-people`
   automations. They scope by visibility + the rule-45 exclusion set, never by the viewer's tenant.
2. **`daily_matches` candidate pool is cross-tenant** (`vitana-v1/supabase/functions/generate-daily-matches/index.ts:110-153`),
   and the table has no `tenant_id`/`scope` column.
3. **Social-memory resolver trusts a session-supplied `tenant_id`.** `social-memory-service.ts`,
   `social-context-builder.ts`, `person-context-builder.ts` pass `input.tenant_id` straight into
   `social-memory-repository.ts` reads (`.eq('tenant_id', tenantId)` at :259,:337,:378,:612,:710).
   The value is the caller's session tenant, not a verified active-tenant membership — correct once
   WS1's resolver is authoritative, unverified until then.
4. **Community content tables have tenant-unaware RLS, not none.** Program plan §2: 139/262 tenant
   tables lack a tenant-aware policy. The target tables already have RLS **enabled** with permissive
   policies (`global_community_profiles`/`groups`/`events` + content_reports RLS on at
   `vitana-v1/.../20250917153624_*.sql` and `.../20251010065205_*.sql`, `global_community_group_members`
   at `20251010065205`); so this spec **rewrites existing live policies**, it does not newly enable RLS.
   The four `global_community_*` tables are `global_community_profiles`, `global_community_groups`,
   `global_community_events`, `global_community_group_members`. `profiles.tenant_id` is NULL for all
   236 members (WS2 backfills it), so this spec scopes by a **membership join** (`user_tenants`), not
   by `profiles.tenant_id`.
5. **Founding pool cap and seat numbering are global, not per tenant.** `founding_members` ALREADY has
   `tenant_id uuid NOT NULL` (populated) and `claim_founding_seat(p_user_id, p_tenant_id)` already
   resolves/stores the tenant from `user_tenants`
   (`supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:60,99-112`). What is still global:
   `v_max_seats constant := 1000`, `max(seat_number)+1` table-wide, and the global
   `seat_number ... UNIQUE CHECK (seat_number BETWEEN 1 AND 1000)` (same file :57,:127). Gateway
   reporting is also global (`routes/billing-repository.ts:141` `FOUNDING_MAX_SEATS=1000`,
   `countFoundingSeats` with no tenant filter). Program plan D10 requires per-tenant pools — so the gap
   is per-tenant cap + per-tenant seat allocation, **not** a column add or a `tenant_id` backfill.
6. **Test/service account rules are platform-wide, not per tenant** (rule 43-45 sets:
   `service_bot_accounts`, `notification_test_actors`). There is no `platform_only_accounts` view
   (cross-spec O5 — this spec M2 creates it).
7. **Realtime community subscriptions carry no tenant predicate** (program plan §2/§3-S-J:
   realtime-reachable tables without tenant RLS leak once `current_tenant_id()` resolves).

## Fix (per lane)
Dependency: WS1 (identity/resolver — `tenant_id_for_policies()`, `is_member(tenant_id)`,
`TenantContext`, membership canonicalisation) ships the resolver this spec's RLS and read filters
call. This spec is **dark by default** (`tenant_settings.feature_flags.mt.community_scope`) and its
read-path filters are no-ops until WS1's resolver is live; the migrations expand-only so they are
safe to apply ahead of activation. DB lanes are split from code lanes (§4.7).

- **Lane `community-tenant-db` (DB, platform).** The three C-range migrations below: add
  `tenant_id` (nullable → trigger-fill → backfill by membership join → `CHECK NOT VALID` → VALIDATE,
  **not** `SET NOT NULL` in this spec — NOT NULL waits for WS2's backfill of existing rows) on
  `profile_posts`, `global_community_*`, `media_uploads`, `community_live_streams`, `calendar_events`,
  `content_reports`, `feedback_tickets`; **rewrite** the existing (already-enabled) RLS policies on
  them, classified user-private / tenant-shared (`is_member(tenant_id)`) / admin-only
  (`is_tenant_admin(tenant_id)`); confirm RLS is enabled on each browser/realtime-reachable table; add
  the realtime tenant predicate. **The policy rewrite is NOT flag-gated** — RLS is enforced at the DB
  the moment the migration applies, with no `feature_flags.mt.*` in front of it; so it must be
  MIGRATION-QUEUE-sequenced strictly after WS1's `is_member()`/`tenant_id_for_policies()` are live AND
  after this spec's own membership-join backfill has populated `tenant_id` on every existing row, and
  the rewritten read policies must keep author-owned (`user_id = auth.uid()`) read access for any row
  whose `tenant_id` is still NULL. For `content_reports` this spec owns only `tenant_id` + base RLS;
  mt-tenant-admin's `moderator-tenant-scope-db` (`070600`, sorts after) layers moderation policies on
  top (cross-spec O4). Expand/contract, `lock_timeout` + retries, snapshot `bak_*` tables before any
  data move, pre-approved rollback migration, read-only pre/post checks, MIGRATION-QUEUE rows at the
  stated position.
- **Lane `founding-pool-tenant-db` (DB, platform).** Make the Founding pool per tenant. The
  `tenant_id` column and `claim_founding_seat(p_user_id, p_tenant_id)` already exist (VTID-04859), so
  **no column add and no `tenant_id` backfill** — verify it is already populated. The change: replace
  the global `max(seat_number)+1` with a per-tenant sequence, replace the global
  `UNIQUE`/`CHECK (seat_number BETWEEN 1 AND 1000)` with per-tenant ones (`UNIQUE (tenant_id,
  seat_number)` + per-tenant cap check), and make `v_max_seats` a per-tenant cap. `countFoundingSeats`
  reporting is scoped in `community-scope-gateway`. Expand/contract on the constraint swap; snapshot +
  rollback migration. Separate DB lane because it is an independent table + RPC with its own queue row.
- **Lane `platform-only-accounts-db` (DB, platform) — M2, cross-spec O5.** Create the
  `platform_only_accounts` view (members of the platform tenant `is_platform=true` with no community
  membership) and add it to the rule-45 exclusion lint alongside `service_bot_accounts` /
  `notification_test_actors`. This spec's **C3 migration is version `20261101070160`** (reserved
  inside spec 07's gap — cross-spec C3; keep exactly). pgTAP: a platform-only account never appears
  in any community surface.
- **Lane `community-scope-gateway` (CODE, platform, dark).** Add the viewer's active-tenant
  membership filter to the Community read pools behind `feature_flags.mt.community_scope`:
  `community-member-ranker.ts` pool, members directory, superlatives, `tool_global_search`,
  `resolve_recipient_candidates` (community scope only — Network is the sibling spec), the
  social-memory resolver (take the active tenant from `TenantContext`, never a tool argument), events
  queries, and `connect-people`. Each reader goes through the WS1 `TenantContext.tenantId`; a lint
  bans a community read that scopes only by visibility. Active tenant = the member's **ACTIVE** tenant,
  not every tenant they belong to.
- **Lane `community-matches-v1` (CODE, vitana-v1, dark).** `generate-daily-matches` restricts its
  candidate pool to the viewer's active tenant behind the same flag; the new `daily_matches` tenant
  column (added in `community-tenant-db`) is written on insert. i18n DE-first for any new string.

## Migrations
Lane C version range **20261101060000–20261101065959** (NN=06) for `community-tenant-db` and
`founding-pool-tenant-db`; **the M2 `platform_only_accounts` migration is pinned to `20261101070160`**
(cross-spec C3, reserved in spec 07's gap — do not renumber). No `20261101*` migration exists yet
(verified). Each migration: expand/contract only, `bak_*` snapshot before data moves, pre-approved
rollback file under `docs/validation/<VTID>/`, read-only `live-before.sql` / `post-apply-checks.sql`,
one `RUN-MIGRATION.yml` dispatch per file, applied by Claude after merge. MIGRATION-QUEUE position:
after the WS1 resolver/membership migrations, in the order community tables → founding pool →
`20261101070160` platform_only_accounts.

## Tests
- pgTAP per table: a `b_member` session reads zero `T_A` community rows; a write with a foreign
  tenant fails; RLS on; realtime predicate present. Platform-only account invisible on every
  community surface. Founding count is per tenant.
- Vitest/Jest (gateway): each Community reader returns only the active tenant's members with the flag
  on, unchanged (visibility-only) with it off; social-memory resolver ignores a tool-supplied tenant.
- vitana-v1 Vitest: `generate-daily-matches` pool scoped; `daily_matches` tenant written.
- Isolation-suite semantics (program plan §4.11): Community surfaces return only the active tenant's
  rows; nothing private reachable. `npm run test:support` / `test:operator` only if those pipelines
  are touched (they are not here). Maxina golden suite byte-identical.

## Staging verification
Read-only (rule 48). A staging spec signs in as the test user and asserts the members directory /
`global_search` return only shared-tenant members with the flag on, and that no non-GET hits the
gateway. Writes/RLS proven by pgTAP + Vitest only (staging uses the production Supabase project).

## Rollout
The gateway/edge **read path** is dark by default (`tenant_settings.feature_flags.mt.community_scope`);
its flag is flipped per tenant only after WS1's resolver is live and the isolation suite is green. The
**RLS policy-rewrite migration is NOT flag-gated** and takes effect on apply, so it is sequenced in
MIGRATION-QUEUE strictly after the WS1 resolver/membership migrations AND after this spec's own
membership-join backfill of `tenant_id`; the rewritten read policies keep author-owned
(`user_id = auth.uid()`) access for NULL-`tenant_id` rows so an apply ahead of WS2 cannot deny reads.
DB migrations are applied by Claude via RUN-MIGRATION after merge, each with its read-only post-check.
`SET NOT NULL` on the community tables is deferred to WS2 (existing-row backfill). Owner-only step:
none beyond the standard RUN-MIGRATION dispatch.

## Risks
- Ordering vs WS1: the RLS predicates call `is_member()`/`tenant_id_for_policies()` which WS1 must
  ship first. The gateway/edge **read filters** are flag-dark, so merging that code ahead of
  activation changes nothing. The **RLS policy rewrite is different** — it is not flag-gated and takes
  effect the moment the migration applies: applied before WS1's functions exist it fails (missing
  function); applied after they exist but before `tenant_id` is backfilled on every row it would deny
  reads. Mitigation: `depends_on` the WS1 spec; sequence the policy-rewrite migration in
  MIGRATION-QUEUE strictly after the WS1 resolver AND after this spec's own backfill; keep author-owned
  (`user_id = auth.uid()`) read access for NULL-`tenant_id` rows so the rewrite degrades safely.
- `profiles.tenant_id` empty until WS2 → scope by membership join, never by `profiles.tenant_id`
  (stated in every lane).
- Realtime token staleness (program plan §4.2): tenant-shared policies also check `is_member`, so a
  stale socket cannot read a tenant it no longer belongs to.
- Founding per-tenant renumbering: existing `founding_members` rows already carry `tenant_id`, so
  swapping the global `UNIQUE`/`CHECK` for per-tenant ones must not collide on live data (two tenants
  can now both hold seat 1). Snapshot `bak_founding_members` first; the constraint swap validates the
  new per-tenant uniqueness against existing rows before dropping the global one; rollback migration.

## Out of scope
- The Network layer (O4-adjacent): `scope` columns, `network_visible`, `send_message`/`send_message_as`/
  `request_connection`, Network groups, Network recipient resolution — sibling spec.
- Moderation RPCs/triggers/event-games — mt-tenant-admin (cross-spec O4).
- WS1 resolver/membership/auth-hook; WS2 data cleanup and `SET NOT NULL`; WS4 provisioning;
  WS5 content packs; WS7 frontend tenant layer.
- Discover/commerce `distribution` scoping — mt-discover / commerce specs.

## Depends on
- WS1 identity & resolver spec (`tenant_id_for_policies()`, `is_member()`, `TenantContext`,
  membership canonicalisation) — hard dependency for RLS + read filters.
- Done M0: VTID-05147 (S-M), 05149 (A: `tenants.is_default/is_platform`, `ci_tenant_isolation_health`),
  05150 (B), 05151 (C). The platform tenant (`is_platform=true`) that `platform_only_accounts` reads
  comes from VTID-05149.
- Cross-spec: O5 (this spec M2 creates `platform_only_accounts`; mt-discover references it), C3
  migration ordering (`20261101070160`), O4 (`content_reports` — this spec owns `tenant_id` + base RLS
  at `060*`; mt-tenant-admin's `moderator-tenant-scope-db` at `070600` sorts after and layers
  moderation policies on top, so the two never both own one policy).

## Owner decisions
Cites decided D1 (two scopes — Community half here), D8 (one active tenant per session; Community =
active tenant, not all memberships), D10 (Founding pool per tenant), D13 (no synthetic tenant in prod;
tests on the local stack). No new owner decision.
<!-- plan:end -->

## Open questions for sparring
- Confirm the WS1 identity spec slug this lane set `depends_on` points at (the resolver owner), so the
  queue blocks correctly; if WS1 is not yet a spec folder, record it as a named external dependency.
