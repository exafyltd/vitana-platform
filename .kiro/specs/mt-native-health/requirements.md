# Requirements — mt-native-health

The authoritative plan is `plan.md` (sparred by PLAN-SPAR). This file states the EARS requirements and links to
the program documents rather than copying them.

## Program position
- **Predecessor specs:** `mt-identity` (access-token hook, `tenant_id_for_policies()`, membership unification,
  TenantContext, `isHealthTable()` predicate), `mt-tenant-admin` (S-L: removes the live tenant-admin partner-health
  scope). mt-native-health references these; it does not re-own them.
- **Peer programs this contract wraps:** `health-native` — Native app (VTID-05021,
  `docs/programs/native-app/NATIVE-APP-PLAN.md`) and Health Hub (VTID-05020,
  `docs/programs/health-hub/HEALTH-HUB-PLAN.md`). Those build the app and the health pipeline; mt-native-health is
  the multi-tenancy layer they consume.
- **Program plan:** `docs/MULTI-TENANT-PLAN.md` §8 (native app & tenancy), §9 (health data & tenancy), WS9, WS10.

## Requirements (EARS)

### R1 — Frozen health home tenant
- The system SHALL store one frozen `health_home_tenant_id` per member in `app_users`, set once (backfilled to the
  current primary membership; set at first health write for new members) and NOT changed when `is_primary` changes.
- WHEN a member writes or reads health data in any session, the system SHALL use the member's frozen home tenant,
  not the session's active tenant.
- WHILE a member has 0 or 2+ primary memberships, the system SHALL treat the freeze as ambiguous and quarantine the
  member for resolution via mt-identity's membership unification, and SHALL NOT default the home tenant to Maxina.

### R2 — User-keyed health accessor
- The system SHALL expose a `healthDb(userId)` accessor that resolves the frozen home tenant itself, and every
  health reader and writer SHALL go through it.
- IF a health reader or writer reads a health table without going through `healthDb`, THEN the build SHALL fail
  (reader/writer inventory lint), except an allowlist of the accessor and service-role platform jobs.
- WHEN `MT_RESOLUTION_V2` is off, the accessor SHALL fall back to the current session-tenant behaviour (dark by
  default).

### R3 — Health data isolation from tenant operators and commerce
- The system SHALL fail the build IF any tenant-analytics or commerce reader module (tenant-admin KPIs/overview/
  health-index, tenant-owner analytics, exports, Discover feed/search, ORB product/cart tools, autopilot offers)
  reads a health table, where "health table" is `isHealthTable()` from mt-identity.
- Member-facing health-coaching modules SHALL be explicitly exempt from this guard.
- WHEN a T_B tenant admin queries any health table, the system SHALL return zero rows (pgTAP).

### R4 — Per-tenant native push
- The system SHALL fetch a member's device tokens by `user_id` only (no tenant filter on fetch).
- WHEN a notification is delivered, the system SHALL derive its copy and deep link from the notification row's
  `tenant_id`, not from the device token's stored tenant.
- The system SHALL keep exactly one active transport (`appilix` | `native`) per device.
- WHEN a member of both T_A and T_B has one registered device, the system SHALL deliver a push from each tenant with
  that tenant's copy and deep link (contract test, ab_dual).

### R5 — Native tenant resolution invariant
- The native app SHALL resolve the active tenant only from the JWT claim; a deep-link slug and device-stored last
  tenant SHALL be inputs to a server-validated switch, never a resolution source on their own.
- WHEN a signed-in member follows a deep link to a tenant they do not belong to, the app SHALL show the "join this
  community" screen and SHALL fetch no tenant data.
- The push registration SHALL send only `user_id`-scoped identity and SHALL NOT send a client-chosen tenant.

## Non-functional / standing rules
- Never test against production; staging specs read-only (rules 31/31b/48). Dark by default. Bedrock-only AI; no
  Google beyond the carve-outs. i18n DE-first du-form + RTL for any new user-visible string (none expected — this
  spec is contract + tests). Spotlight contract for any new screen (none expected). What's New entries only for
  finished member-facing features (none here). Rule 41 (no hardcoded spoken strings) — not touched. Rules 43–45
  test/service/platform-only account exclusion — unaffected (this spec adds no member-facing surface).
