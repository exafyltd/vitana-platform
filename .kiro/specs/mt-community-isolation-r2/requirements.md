# Requirements — Community isolation (WS3 Community part) — mt-community-isolation-r2 (re-plan)

Program: `docs/MULTI-TENANT-PLAN.md` v5.1 (owner-approved 2026-10-10), §4.11 "Community and Network
scopes" and §6 WS3. This spec is the Community half; it links the program records instead of copying
them.

## Program position
- **Predecessors (done, M0):** VTID-05147 (S-M membership/role lockdown), VTID-05149 (A:
  `tenants.is_default`/`is_platform`, default-tenant signup, `TenantContext`,
  `ci_tenant_isolation_health()`), VTID-05150 (B: brand pack, `provision_tenant`), VTID-05151 (C:
  public registry, DB-driven `useTenant`). Records: `docs/validation/VTID-0514{7,9}/**`,
  `docs/validation/VTID-0515{0,1}/**`, `docs/multitenancy/MIGRATION-QUEUE.md`,
  `docs/multitenancy/LANE-C.md`.
- **Hard predecessor (WS1 identity/resolver):** `tenant_id_for_policies()`, `is_member(tenant_id)`,
  `is_tenant_admin(tenant_id)`, `TenantContext`, membership canonicalisation. This spec's RLS and
  read filters call them; it merges dark and expand-only ahead of their activation.
- **Siblings:** the Network layer (scope columns, `network_visible`, `send_message*`, Network groups)
  — separate spec; moderation RPCs/triggers/event-games — mt-tenant-admin (cross-spec O4); Discover
  `distribution` scoping — mt-discover. `platform_only_accounts` (R4) is referenced by mt-discover
  (cross-spec O5).
- **Successor:** WS2 data cleanup, which backfills existing rows and applies `SET NOT NULL` on the
  community tables this spec leaves `CHECK … VALID` but nullable.

## Requirements (EARS)

### R1 — Community content tables are tenant-isolated (lane `community-tenant-db`)
1. THE SYSTEM SHALL add a nullable `tenant_id` (FK `tenants`) to `profile_posts`, the four
   `global_community_*` tables (`global_community_profiles`, `global_community_groups`,
   `global_community_events`, `global_community_group_members`), `media_uploads`,
   `community_live_streams`, `calendar_events`, `content_reports`, `feedback_tickets` and
   `daily_matches`, filled on insert from the actor's resolved tenant and backfilled on existing rows
   by a membership join (`profiles.tenant_id` is NULL until WS2, so the backfill joins `user_tenants`,
   not `profiles`).
2. WHILE WS2 has not backfilled every historical row THE SYSTEM SHALL stop at `CHECK … VALID` and
   SHALL NOT apply `SET NOT NULL`.
3. GIVEN these tables already have RLS enabled with permissive policies, THE SYSTEM SHALL **rewrite**
   each policy as user-private, tenant-shared (`is_member(tenant_id)`), or admin-only
   (`is_tenant_admin(tenant_id)`) rather than newly enabling RLS, and SHALL add a tenant predicate to
   realtime subscriptions on these tables. The rewritten read policies SHALL keep author-owned
   (`user_id = auth.uid()`) read access for rows whose `tenant_id` is still NULL. For `content_reports`
   THE SYSTEM SHALL rewrite only `tenant_id` + base RLS; mt-tenant-admin's `moderator-tenant-scope-db`
   (`070600`) owns the moderation policies (O4).
4. WHILE the policy-rewrite migration is NOT feature-flag-gated, THE SYSTEM SHALL sequence it in
   MIGRATION-QUEUE strictly after WS1's `is_member()`/`tenant_id_for_policies()` are live AND after
   this spec's own membership-join backfill of `tenant_id`.
5. WHEN a member of tenant T_B queries any of these tables THE SYSTEM SHALL return zero rows of tenant
   T_A (pgTAP).

### R2 — Community read surfaces are scoped to the member's active tenant (lanes `community-scope-gateway`, `community-matches-v1`)
1. WHILE `tenant_settings.feature_flags.mt.community_scope` is on THE SYSTEM SHALL restrict the
   members directory, `find_community_member`, superlatives, ORB `global_search`,
   `resolve_recipient_candidates` (community branch), `connect-people` and `generate-daily-matches`
   to members of the viewer's **active** tenant (not every tenant the viewer belongs to).
2. WHILE the flag is off THE SYSTEM SHALL behave byte-identically to today (visibility-only scope).
3. THE social-memory resolver SHALL take the active tenant from `TenantContext`, never from a tool or
   call argument.
4. Community scoping SHALL use a membership join (`user_tenants`), not `profiles.tenant_id`.

### R3 — Founding pool is per tenant (lane `founding-pool-tenant-db`)
1. GIVEN `founding_members.tenant_id` and `claim_founding_seat(p_user_id, p_tenant_id)` already exist
   and are populated (VTID-04859, `20261003100000_*.sql`), THE SYSTEM SHALL make the seat cap and seat
   numbering per tenant: a per-tenant `seat_number` sequence replacing the table-wide
   `max(seat_number)+1`, `UNIQUE (tenant_id, seat_number)` and a per-tenant cap check replacing the
   global `UNIQUE`/`CHECK (seat_number BETWEEN 1 AND 1000)`, and the 1000 cap applied per tenant
   (program plan D10). THE SYSTEM SHALL NOT add a `tenant_id` column or backfill `tenant_id` (both
   already done) and SHALL verify it is already populated instead.

### R4 — platform_only_accounts view (lane `platform-only-accounts-db`, M2 / cross-spec O5)
1. THE SYSTEM SHALL create a `platform_only_accounts` view (platform-tenant members with no community
   membership) in migration version `20261102070160` and SHALL add it to the rule-45 exclusion lint;
   a platform-only account SHALL never appear on any community-member surface.

### R5 — Test/service account rules per tenant
1. THE rule-43–45 exclusion sets (`service_bot_accounts`, `notification_test_actors`,
   `platform_only_accounts`) SHALL be applied on every tenant-scoped community surface so an excluded
   account is invisible within every tenant.

## Not in this spec
Network scope and all `scope`/`network_visible`/`send_message*`/Network-group work; moderation
RPCs/triggers/event-games (mt-tenant-admin, O4); WS1 resolver/membership/auth-hook; WS2 cleanup and
`SET NOT NULL`; WS4 provisioning; WS5 content packs; WS7 frontend tenant layer; Discover/commerce
`distribution`. Each is sparred on its own.
