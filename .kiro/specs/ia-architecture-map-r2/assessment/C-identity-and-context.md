# C. User identity and context assessment

The directive separates five dimensions: identity, tenant, role, working context and permissions (§3.3). This section
maps where each one lives today and where they are mixed.

## 1. The five dimensions today

| Dimension | Stored in | Resolved by | Trusted from client? |
|---|---|---|---|
| **Identity** | JWT `sub` (Supabase) or `custom:legacy_user_id` (Cognito); `app_users.vitana_id` | `verifyAndExtractIdentity` → `SupabaseIdentity` (`GW/middleware/auth-supabase-jwt.ts:41-55`, `:277-289`); `vitana_id` lookup has a 5-minute cache | No |
| **Tenant** | JWT `app_metadata.active_tenant_id` (a preference written by `switch_to_tenant_by_slug`), `user_tenants`, plus `app_users.tenant_id` and the `me_context` RPC as secondary sources | Token tenant is membership-checked and cached 60 s (`:531-557`, `:651-690`). Otherwise the primary membership (`resolvePrimaryTenant`). `TenantContext` is attached to `req.tenant` but not read (B §8). | No on most routes; `X-Vitana-Tenant` is still read in 4 places (B §10 item 8) |
| **Role** | `role_preferences` (per user and tenant), `user_tenants.active_role`, `user_active_roles` (no tenant column), grants in `user_permitted_roles`, `memberships`, `patient_profiles`, partner-org business roles | `resolveEffectiveRole` (`GW/routes/orb-live.ts:814-845`): preference beats `active_role`, then clamped to the permitted set (VTID-05147). exafy_admin skips the clamp. | **Yes on two paths:** the declared ORB surface and the `/conversation/turn` body role (plan `mt-track-s-authz`) |
| **Working context** | Not stored. Sent by the client on each voice session: `surface`, `view_role`, `current_route`, `recent_routes`, `journey_trail`, `is_mobile` | `resolveAssistantProfile` once per session; mid-session `context_update` (`GW/routes/orb-live.ts:17864-17869`, `context-update.ts`) | Yes, by design. But it also selects the role (row above). |
| **Permissions** | No store or service of its own. Derived from role strings and the `exafy_admin` claim. | Route middleware, ORB tool packs plus handler gates, frontend `hasPermission` (§6) | Indirectly, via the role |

## 2. Role catalogue

| Source | Roles | Location |
|---|---|---|
| Gateway canonical list | community, patient, professional, staff, backoffice, admin, developer, infra (rank = index + 1); `SUPER_ADMIN_ONLY_ROLES` = developer, infra | `GW/constants/vitana-roles.ts:19-41` |
| ORB role registry | the 8 above plus `commerce` (ORB-only); `exafy_admin` maps to developer | `GW/orb/profile/role-registry.ts:58-115` |
| Permitted-role union | `user_permitted_roles` ∪ active `memberships` ∪ `community` (re-types the 8 roles as `SWITCHER_ROLES`) | `GW/lib/permitted-roles.ts:6-57` |
| VTID task-target codes | DEV, COM, ADM, PRO, ERP, PAT, INFRA (no STAFF or BACKOFFICE; no mapping to app roles) | `GW/routes/vtid.ts:35-36` |
| Frontend | `UserRole` and `ROLE_HIERARCHY` (same 8); `ROLE_LADDER`; `MOBILE_EXCLUDED_ROLES` (backoffice, developer, infra); `OrbSurface` = vitanaland, admin, backoffice, commerce (**no command-hub**) | `V1:src/hooks/useRole.tsx:12-23`, `useRoleSwitch.ts:33-41`, `src/lib/orb-view-profile.ts:13` |
| Partner organisations | org_admin, staff, professional, on a separate axis (`useBusinessMode`); "reseller" is a capability | `V1:src/hooks/useRoleSwitch.ts:17-20`, `:58-67` |

**Mismatches:**
- `commerce` is an ORB role with no `VITANA_ROLES` entry.
- `exafy_admin` is a boolean claim, but `role-registry.ts:113`, `gemini-operator.ts:4315-4319` and `operator.ts:588`
  compare it as a role string.
- Mobile forces `currentRole` to `community` (`useRole.tsx:86-89`). The gateway deliberately ignores device type
  (`assistant-profile.ts:84-88`).
- `docs/ROLE_SCREEN_MATRIX.md` lists 5 roles.

**Role scope is implicit.**
- developer and infra are platform roles: super-admin-only and served on the platform-wide Command Hub.
- The other six are tenant roles.
- The directive's example "Admin and Developer in one tenant" therefore does not match today's model. Developer is not
  tenant-scoped. The context contract must model role scope explicitly (`platform` or `tenant`).

## 3. Role storage, resolution and switching

- **Client writes are blocked** on the four role tables (VTID-05147). `set_role_preference` refuses a tenant the caller
  is not a member of (`20261013233000…sql:65-133`). The V1 test `role-tables-no-client-writes.vtid-05147.test.ts` pins
  this.
- **Dual write.** `set_role_preference` and `me_set_active_role` both write `role_preferences` and `user_active_roles`
  (`20260925120000_vtid_04561_one_role_truth.sql`). The regression suite pins it at
  `test/vtid-04560-role-separation-regression.test.ts:458-474`.
- **Member-app switch flow:**
  1. ProfileDrawer or RoleSwitcherSheet calls `useRoleSwitch.switchRole`, which calls `useRole.setRole`
     (`V1:src/hooks/useRole.tsx:56-84`).
  2. `setRole` updates the cache optimistically and fires `role.changed`.
  3. It calls the `set_role_preference` RPC and rolls back on error.
  4. It navigates. developer and infra get a cross-origin `location.assign` to the Command Hub.
  5. The ORB widget gets `setViewRole` and restarts an open conversation (`V1:src/hooks/useOrbVoiceWidget.ts:151-163`).
  6. A context-cache prewarm runs after navigation (`:545-585`).
- **Command Hub switch:** `POST /api/v1/me/active-role` calls the `me_set_active_role` RPC (`GW/routes/me.ts:298-427`).
- **A switch does not update** the JWT (it has no role claim), the 60 s membership cache, or an Assistant Profile that is
  already resolved.

## 4. Tenant membership and context

Details are in B §2, §7 and §8. Points that matter for the context contract:

- **One active tenant per session.** Switching UI is deferred to M3 (decision D8). The switch mechanism exists:
  `setTenantBySlug` → `switch_to_tenant_by_slug` → `refreshSession` (`V1:src/hooks/useTenant.tsx:159-245`).
- **The memory key conflicts with D8.** D8 says "memory owned by the user, social context per tenant". Today memory reads
  filter by `(tenant_id, user_id)` (`GW/services/orb-memory-bridge-repository.ts:18-152`; `memory_facts` at
  `orb-memory-bridge.ts:985`). A dual member who switches tenant therefore sees a different memory set. Directive §3.2
  requires continuity across tenants. No MT lane re-keys memory by user. **This is a design decision to settle with the
  MT owners, not to implement independently** (G, IA-3).
- **Cognito sessions have no tenant claim.** They always fall back to the primary membership and have no `exafy_admin`
  source (KNOWN GAP comment at `auth-supabase-jwt.ts:253-268`). Command Hub sessions on Cognito therefore resolve as
  `unverified`.

## 5. Working context

| Path | Sends | Refreshed mid-session | Evidence |
|---|---|---|---|
| Web ORB voice (widget) | `current_route`, `current_route_entered_at`, `recent_routes`, `journey_trail`, `is_mobile`, `surface`, `view_role` | Yes: `updateContext` on every route change, then a WS/SSE `context_update`. A surface change restarts the conversation. | `V1:src/hooks/useOrbVoiceWidget.ts:297-310`, `:514-559`; `GW/frontend/command-hub/orb-widget.js:6414-6445` |
| Command Hub ORB | `surface: 'command-hub'`, `view_role: 'developer'` (hard-coded) | route only | `GW/frontend/command-hub/app.js:35365-35366` |
| Mobile ORB | `surface`, `view_role`, `context_update` with `is_mobile` | yes | `V1:apps/mobile/src/orb/session.ts:102-103`, `:448-483` |
| Text: `POST /conversation/turn` | optional `ui_context {surface, screen, selection, metadata}`; role from the body. The only V1 caller (coach chat) sends a fixed `{surface: "orb", screen: "health_coach"}`, not the real route. | per request | `GW/routes/conversation.ts:216`, `:286`; `V1:src/lib/coach-chat-api.ts:52` |
| Text: Operator Console `/operator/chat` | thread id; no route, surface or role (exafy_admin is mapped to `admin`) | no | `GW/routes/operator.ts:475`, `:588` |
| `ClientContextEnvelope` | device surface, journey surface, route, time, wake origin, location, privacy. **No user, tenant or role.** | schema only; senders not confirmed [unverified] | `GW/orb/context/client-context-envelope.ts:51-100` |

**Gaps:**
- **Screens are route strings.** The navigation registry ids (`V1:src/navigation/registry/screens.json`, 184 screens) are
  not sent.
- **There is no task dimension.** The only task-like fields are `workSurfaceTask: 'commerce_setup'` and `operator_thread_id`.
- **A surface change through `context_update` does not change the declared tools** (`context-update.ts:18-20`). The
  member must restart.

## 6. Permissions

There is no central permission service.
`GW/capabilities/` (VTID-01939) is a catalogue of connector actions (`music.play`, `email.read`) resolved to the user's
connected provider. It is not authorization, so the name is misleading.

| Layer | Mechanism | Checks |
|---|---|---|
| Gateway routes | `requireAuth`, `optionalAuth`, `requireTenant`, `requireAuthWithTenant`, `requireExafyAdmin`, `requireAdminAuth`, `requireTenantAdmin`, `requirePlatformScope`, `require-service-or-admin` | JWT, membership, permitted admin role, `exafy_admin` claim. File counts: requireAuth 112, tenant variants 49, requireTenantAdmin 22, admin variants 61. |
| ORB tools | Tool packs from `ROLE_REGISTRY` choose what is declared. `applySurfaceGate` (`live-tool-catalog.ts:255`) allowlists per surface. Handlers run `developerGate`/`adminGate`. `dispatchOrbTool` runs a role-policy check **in shadow only** (`orb-tools-shared.ts:5536-5550`, `FEATURE_ROLE_POLICY_ENFORCE` off). | The **served** role string (plan `mt-track-s-authz`) |
| Frontend | `ProtectedRoute` + `hasPermission`: exafy, or rank(dbRole) ≥ rank(required) (`V1:src/components/ProtectedRoute.tsx:24-49`, `useRole.tsx:109-115`); `AuthGuard`, `DevAuthGuard`, `useRoleRouteEnforcement` | The **selected** role on a ladder |

**Role selection is used as authorization in four places:**
- the frontend rank ladder;
- `requireTenantAdmin`, which requires the *selected* `active_role` to be admin, so a permitted admin in community mode
  is refused;
- `developerGate`/`adminGate`;
- the served-role path.

## 7. Carriers: no canonical context object

| Carrier | Location | Holds |
|---|---|---|
| `SupabaseIdentity` | `auth-supabase-jwt.ts:41-55` | user, claimed tenant, exafy flag (`role` is the DB role `authenticated`) |
| `AuthenticatedRequest.tenant: TenantContext` | `:134-142`; `tenant-context.ts:22-30` | tenant, slug, `active_role` (not clamped), source, platform flag |
| `OrbToolIdentity` | `GW/routes/orb-tool.ts:81-86` | user, tenant, served role, JWT |
| `AssistantProfile` | `assistant-profile.ts:57-67` | surface, served role, persona, resolution, declared values |
| `ProfiledSessionLike` | `session-profile.ts:17-23` | profile, `active_role`, route, mobile |
| `RoleEntry` | `role-registry.ts:35-47` | role → surface, persona, tool packs, knowledge packs, opener, memory scope |
| `DelegationCaller` | `delegation-tools.ts:150-166` | user, tenant, platform role, exafy, surface, channel |
| `WorkSurfaceKnowledgeInput` | `work-surface-context.ts:30-33` | user, tenant |
| `ClientContextEnvelope`; `SanitizedContextUpdate` | `client-context-envelope.ts`; `context-update.ts:35-59` | working context only |
| Operator thread auth | `operator.ts:475` | user, exafy |
| V1 `useRole()`, `useTenant()`, `orbViewProfile` | `useRole.tsx:117-123`; `useTenant.tsx`; `orb-view-profile.ts:40-46` | role and permission; tenant and exafy; surface and view role |

Each layer rebuilds its own subset. The permitted-role union alone is computed three times: in SQL
(`get_my_permitted_roles`), in `GW/lib/permitted-roles.ts`, and in V1's `computeAvailableRoles`.

## 8. Tests that pin today's behaviour

- **`P:services/gateway/test/vtid-04560-role-separation-regression.test.ts`** (1,048 lines, `npm run test:roles`). It covers:
  - the profile matrix;
  - both greeting ladders;
  - per-surface instructions and the marker;
  - the text-path engineering gate;
  - widget source contracts;
  - the role registry;
  - dual-write;
  - developer knowledge and tools;
  - deep dive (including `:848-851`, the delegation caller's served role; plan `mt-track-s-authz`);
  - the console caller;
  - evaluation and telemetry;
  - the admin opener;
  - VTID-04655/04656.
- **Also:** `vtid-05147-effective-role-permitted`, `vtid-05147-s-m-membership-role-lockdown`, `vtid-05149-tenant-context`,
  `vtid-04495-memory-role-not-jwt-role`, `vtid-03926-operator-chat-userrole`, `vtid-03832-vitana-roles-constant`,
  `role-policy-enforcer`.
- **V1:** `useRole.{hasPermission,hierarchy,setRole}`, `useRoleSwitch(.vtid-05147.wiring)`,
  `role-tables-no-client-writes.vtid-05147`, `useOrbVoiceWidget.vtid-04548-role-prewarm`, `ProtectedRoute`,
  `orb-view-profile`.

## 9. Gaps against directive §3.3 and §5

1. **Role selection used as authorization** (§6). The directive's rule "role selection is not a substitute for
   authorization" is not met.
2. **Declared working context selects the role** with no permission check (plan `mt-track-s-authz`), and on text, the body role selects
   the tools (same plan).
3. **Role scope is not modelled.** Platform and tenant roles share one list and one ladder.
4. **Multi-role users get one selected role per tenant.**
   - Partner-org roles sit outside the role system.
   - The permitted set is computed three times.
   - A permitted admin acting as community cannot use admin routes, because `requireTenantAdmin` checks the selected role.
5. **Revocation mid-session is not handled.**
   - Profile and effective role are resolved once per session, and `context_update` never re-checks them.
   - A removed member keeps access for the 60 s membership cache window (accepted residual, `auth-supabase-jwt.ts`
     comment at `:511-513`).
   - `exafy_admin` lasts until the token expires.
6. **Working context is fragmented.**
   - There are three surface vocabularies: OrbSurface on V1, on the gateway, and the envelope's device surface.
   - Screens are route strings and there is no task dimension.
   - Text paths carry at most a fixed label: coach chat sends `screen: "health_coach"`, and the Operator Console sends
     nothing.
7. **Tenant continuity is undecided** (memory keyed by tenant, §4).
8. **Registries carry no role or tenant.**
   - `screens.json` has no role or tenant field; `access` is the only gate.
   - `screen-manifest.json` has none either.
   - Role and tenant availability live only in stale markdown (`ROLE_SCREEN_MATRIX.md`, `TENANT_SCREEN_AVAILABILITY.md`).

## 10. What the context contract should reuse, and what waits on MT

**Reuse unchanged:**
- `verifyAndExtractIdentity`;
- `getTenantContext` / `requireAuthWithTenant`;
- `resolveEffectiveRole` + `fetchPermittedRoles`;
- `resolveAssistantProfile`, plus the work-surface permission check of plan `mt-track-s-authz`;
- `ROLE_REGISTRY` as the role → capability-pack map;
- `ClientContextEnvelope` for working context;
- the `screens.json` ids as the screen vocabulary.

**Do not build:** a second tenant resolver, role resolver, membership cache, role table or claim. These belong to
mt-identity (B §5).

**Waits on MT decisions:**
- the single role source (mt-identity `plan.md:184`);
- the hook claim shape (`tenant_id`, `tenant_role`);
- `tenant_id_for_policies`/`is_member`;
- the memory continuity rule under D8;
- the fixtures (mt-guardrails local stack).
