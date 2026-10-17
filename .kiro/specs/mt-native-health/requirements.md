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
- **R2 (Active-tenant switch).** WHEN the native app requests a tenant by slug (deep link, picker, or stored last
  tenant), THE SYSTEM SHALL validate membership server-side, set the active-tenant preference, and only then let the app
  fetch tenant data; IF the caller is not a member THEN it SHALL route to a "join this community" flow; IF the slug is
  unknown or reserved THEN it SHALL reject.
- **R3 (Reserved slugs).** THE SYSTEM SHALL maintain a reserved-slug list derived from `screens.json` top-level routes
  and WHEN `provision_tenant` is called with a reserved slug THE SYSTEM SHALL reject it.
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
