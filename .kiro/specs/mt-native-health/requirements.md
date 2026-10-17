# Requirements — mt-native-health (WS9 native tenancy delta + WS10 health-×-tenancy contract)

EARS requirements. Links, not copies: program plan `docs/programs/.../MULTI-TENANT-PLAN.md` §4.8, §4.9, §6 (WS9/WS10);
cross-spec rulings in `CROSS-SPEC-DECISIONS.md` (O1); companion `health-native` spec (`.kiro/specs/health-native/`) and
its two programs — Health Hub `docs/programs/health-hub/HEALTH-HUB-PLAN.md` (VTID-05020) and the native app
`vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), records under `docs/validation/VTID-05020/` and
`docs/validation/VTID-05021/`.

## Program position
- **Predecessors:** `mt-identity` (membership unification, `tenant_id_for_policies()`, `TENANT_TABLES`/`tenantDb`,
  canonical `isHealthTable()`), `mt-guardrails` (isolation suite, DB lints, D11 local stack); done A/B/C
  (VTID-05149/05150/05151); program `health-native` (native shell, Health Hub phases).
- **Successors:** `mt-m3` (switching UI, custom domains, offboarding) references this spec's switch mechanism; the
  Health plan's user-only health re-keying builds on the frozen home tenant introduced here.

## Requirements

- **R1 (Dual-member push).** WHEN a member belongs to two tenants and registers a device in either, THE SYSTEM SHALL
  keep delivering pushes for both tenants, with per-tenant copy and deep link derived from the notification's tenant.
- **R2 (Active-tenant switch — delta only).** The server-side switch already exists
  (`switch_to_tenant_by_slug`, VTID-05043: validates membership, sets `active_tenant_id`, raises
  `TENANT_NOT_JOINABLE`/unknown-slug) and the client already calls it (`TenantProvider.tsx:112-126`). WHEN the native
  app receives a `/<slug>` universal link, or a member opens the community picker, THE SYSTEM SHALL route it through
  the EXISTING switch and only then fetch tenant data; IF the caller is not a member (the `not_joinable` return) THEN
  it SHALL show a "join this community" screen; it SHALL NOT add a parallel switch or a new RPC.
- **R3 (Reserved slugs — already met by VTID-05150).** Reserved-slug enforcement
  (`reserved_tenant_slugs` + `provision_tenant` `RESERVED_SLUG`, synced from `screens.json` by
  `gen-reserved-slugs.mjs`/`TENANT-RESERVED-SLUGS-DRIFT.yml`) is already shipped and applied; this spec references it
  and SHALL NOT re-create or re-seed it.
- **R4 (Transport one-owner).** THE SYSTEM SHALL record a per-device transport (`appilix`|`native`) and SHALL ensure
  exactly one transport serves a given device at a time.
- **R5 (Frozen health home tenant).** THE SYSTEM SHALL assign each member a set-once `health_home_tenant_id` and WHEN a
  health row is read or written THE SYSTEM SHALL use that home tenant, never the session's active tenant; the home tenant
  SHALL NOT change when `is_primary` changes.
- **R6 (healthDb accessor).** THE SYSTEM SHALL exclude health tables from `TENANT_TABLES` and SHALL reach them only
  through a user-keyed `healthDb(userId)` accessor; a lint SHALL fail the build if a health reader/writer bypasses it.
- **R7 (OTA compatibility).** WHEN an OTA bundle declares `min_native_version` incompatible with the installed binary,
  THE SYSTEM SHALL refuse it and keep the last compatible bundle; native-dependent features SHALL be gated by runtime
  capability detection, not bundle version.
- **R8 (Health data never leaves the member — D18).** THE SYSTEM SHALL prevent any tenant-admin/tenant-owner analytics
  surface from reading `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`, enforced by a build-failing guard.
- **R9 (ORB health/commerce separation — Apple 5.1.3).** WHEN an ORB session carries HealthKit/Health-Connect-derived
  context and the current turn has no commerce intent, THE SYSTEM SHALL refuse product/cart/shopping handlers in the tool
  dispatcher (including `use_tool`), on Nova and the Vertex Serbian bridge. Re-verify at slice start whether
  `health-native` already ships this; if so, this requirement is already met and only R8 remains in the governance lane.
- **R10 (No Maxina constants in native tenancy surfaces — D16).** THE SYSTEM SHALL add no Maxina-specific constant to
  native config/metadata introduced by this spec, except immutable store identifiers.
- **R11 (Dark by default).** Every gateway/frontend read SHALL be dark behind `mt.native_push_tenant_fanout`,
  `mt.health_home_tenant` and `MT_RESOLUTION_V2` until enabled.
- **R12 (Read-only verification).** All verification SHALL be read-only against staging/production; native runtime
  verification SHALL use the D11 local stack / fixture tenants (rules 31/31b/48).
