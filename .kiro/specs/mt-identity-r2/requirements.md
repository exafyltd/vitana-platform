# Requirements — mt-identity-r2 (WS1 identity, tenancy resolution & roles)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, §4.2/§4.3, WS1). This spec is the Kiro-readable hand-off of the remaining
WS1 work after VTID-05149. It links the program's records instead of copying them.

## Program position
- **Predecessor:** VTID-05149 (lane A) — `tenants.is_default`/`is_platform`, signup default tenant,
  `resolvePrimaryTenant()` + `TenantContext` (`services/gateway/src/services/tenancy/tenant-context.ts`),
  `ci_tenant_isolation_health()`. Records: `docs/validation/VTID-05149/**`.
- **This spec:** the WS1 "rest" — access-token hook (shadow), the `tenant_id_for_policies()`/`is_member()` helpers and
  the bare-policy rewrite (32 policies on 15 tables, recounted 2026-11-01), membership unification, one role
  source, `tenantDb`/`TENANT_TABLES`/`isHealthTable`/`healthDb`, slug-map removal, `bootstrap_admin_user` fix.
- **Successors:** the hook GO-LIVE lane (owner-applied, D14) and the final `current_tenant_id()` alias migration;
  WS2 data cleanup; WS3 community/network isolation; WS10 health-table policy move; WS0 CI wiring. mt-guardrails and
  mt-native-health reference this spec's canonical `isHealthTable()` (ruling O1).

## Requirements (EARS)

### R1 — Policy helpers and the N3 ordering gate (lane `helpers-and-policy-rewrite`)
1. THE SYSTEM SHALL provide `tenant_id_for_policies()` and `is_member(tenant_id)` as STABLE SECURITY DEFINER functions
   over the unique `(tenant_id, user_id)` index, WITHOUT redefining `current_tenant_id()`.
2. WHEN the access-token claim is absent or the hook is disabled THE SYSTEM SHALL still resolve a member's own tenant
   via the N2 degraded path (`coalesce(<claim if is_member>, <auth.uid()'s primary user_tenants row>)`).
3. THE SYSTEM SHALL rewrite every bare `tenant_id = current_tenant_id()` policy currently in `supabase/migrations/**`
   (no `auth.uid()`/`current_user_id()`/`is_member`/service-role guard) to a user-private
   (`user_id = auth.uid() AND tenant_id = (select tenant_id_for_policies())`) or tenant-shared
   (`(select is_member(tenant_id))`) form. Recounted 2026-11-01: **32 policies on 15 tables** —
   `community_groups`, `community_meetups`, `community_listings`, `d42_domain_weights`, `event_attendance`,
   `live_highlights`, `live_room_attendance`, `live_rooms`, `products_catalog`, `services_catalog`,
   `tenant_catalog_overrides`, `match_targets`, `relationship_nodes`, `social_alignment_signals`, `topic_registry`. The executor re-runs the recount at implementation and records the exact set in the PR
   (the figure is the verified set, not a frozen constant).
3a. Of the 18 program-listed tables, the 7 health tables already carry a user guard (excluded via `isHealthTable()`,
   R5.2); `tenants`/`relationship_edges` carry no bare policy; and 5 — `access_audit_log`, `consents`,
   `retrieval_traces`, `role_sessions`, `user_roles` — have NO RLS policy at all. THE SYSTEM SHALL NOT create or
   relax policies on those 5 in this spec (their hardening is WS2/WS10).
4. THE bare-policy lint SHALL read ZERO before any later migration redefines `current_tenant_id()` (N3).

### R2 — Membership unification (lane `membership-unification`)
1. THE SYSTEM SHALL make `user_tenants` the single canonical membership store and replace `memberships` with a view
   over it, keeping legacy writers working through a dual-write trigger.
2. THE SYSTEM SHALL backfill drifted memberships-only rows (expand/contract, snapshot first) WITHOUT firing the four
   `user_tenants` AFTER INSERT side-effect triggers for the backfill (N1).
3. A nightly drift report SHALL read 0 once converged.

### R3 — Access-token hook in shadow (lane `access-token-hook-shadow`)
1. THE hook SHALL emit `tenant_id_shadow` ONLY and SHALL NOT emit a top-level `tenant_id`.
2. THE hook SHALL fail open (return the original claims on any error), use a single indexed lookup and a short
   statement timeout.
3. Shadow-vs-membership mismatches SHALL be recorded in a log table (as decisions) for the 7-day soak.
4. THE hook GO-LIVE and its auth-config enablement SHALL NOT be in this spec (owner-applied later, D14).

### R4 — One role source + bootstrap fix (lane `role-source-and-bootstrap`)
1. THE SYSTEM SHALL have a single role source of truth with the other role stores derived from it.
2. `bootstrap_admin_user` SHALL key on `tenants.is_default` (not `name = 'Maxina'`) and write canonical `user_tenants`.

### R5 — tenantDb, health exclusion, slug cleanup (lane `tenant-db-and-slug-cleanup`)
1. THE SYSTEM SHALL provide `tenantDb(ctx)` injecting the tenant predicate for a schema-derived `TENANT_TABLES` list.
2. THE canonical `isHealthTable()` predicate SHALL be defined in THIS spec (ruling O1); health tables SHALL be
   excluded from `TENANT_TABLES` and reached only through `healthDb(userId)` resolving the frozen health home tenant.
3. THE SYSTEM SHALL remove the slug maps / fake tenant ids / `limit(1)` at `routes/me.ts`, `routes/dev-auth.ts`,
   `services/orb-memory-bridge.ts`, resolving through `TenantContext` and the DB registry.
4. EVERY merged CODE read SHALL be dark behind `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*`.

## Standing rules (binding)
Never test against production (31/31b/48); staging read-only; dark by default; Bedrock-only AI, no Google beyond the
carve-outs; rule 41 (no hardcoded spoken strings); rules 43–45 (test/service accounts invisible); 42c/42e/42h suites
when touched; i18n DE-first du-form + RTL; Spotlight contract; What's New only for finished member features; nav
registry / screen manifest / parity ledger when `App.tsx` routes are added (none here). The executor never writes to a
live system (collaboration §7a); a DB change is a migration file, applied by Kiro via RUN-MIGRATION only on the owner's approval of the
files and the target database (§7d); the owner applies
the auth hook (D14).

## Not in this spec
See plan.md "Out of scope": the hook go-live and `current_tenant_id()` alias, WS2/WS3/WS10, WS0 CI wiring.
