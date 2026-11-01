---
change_class: standard
---
# plan(mt-track-s-authz): server-side authorization for the approvals actions, the ORB work surfaces and the text-path role

Author: Kiro, session `kiro-202611011939-b712` (Kiro Web; account seat not readable from the session, so the id
carries no seat). Planner of the Integrated Architecture initiative, joining the multi-tenant programme's Track S.
vitana-platform premises pinned to `origin/main` `900d76c485` (2026-11-01); every cited file is unchanged since
`62990ce285`.

<!-- plan:begin -->
## 1. Goal
The owner's Integrated Architecture directive (this session, 2026-11-01), §5 "Mandatory rules": *"Do not allow a
frontend-selected role or tenant identifier to override backend authorization"* and *"Role selection is not a
substitute for authorization. Every action must be checked against the authoritative permission system."* The owner
then asked that this work be added to the ongoing multi-tenant build (2026-11-01: *"how can this plan be added to the
ongoing multi tenant building, so we merge both sessions"*). `docs/MULTI-TENANT-PLAN.md` §3 puts live security
exposures in Track S, "independent of multi-tenancy, fix first". This plan is a Track S slice next to
`mt-track-s-r2` (VTID-05441/05442, S-H residual) and changes nothing that plan or `mt-guardrails-r2` builds.

Three gaps, each closed by checking a server-side permission instead of a client-supplied value:
1. **Approvals actions without a caller check.** The three POST routes of `routes/approvals.ts` merge or reject
   through the gateway's own service token, and the router has no auth middleware.
2. **The declared ORB work surface sets the served role.** A session's `surface` comes from the request body and
   decides the served role, the admin briefing and the privileged tool catalog, without a permission check.
3. **The text conversation path takes the role from the request body** and picks tool definitions with it.

## 2. Today (evidence; read each file at the pin)
Files: `services/gateway/src/routes/approvals.ts`, `src/index.ts`, `src/middleware/require-service-or-admin.ts`,
`src/services/orb-tools/developer-tools.ts`, `src/routes/orb-live.ts`, `src/routes/orb-tool.ts`,
`src/orb/profile/assistant-profile.ts`, `src/orb/profile/session-profile.ts`,
`src/orb/live/session/live-session-controller.ts`, `src/orb/live/tools/live-tool-catalog.ts`,
`src/services/admin-voice-tools.ts`, `src/services/admin-scanners/briefing.ts`, `src/routes/orb-livekit.ts`,
`src/routes/conversation.ts`, `src/types/conversation.ts`, `src/services/tool-registry.ts`, `src/lib/permitted-roles.ts`,
`src/routes/command-hub.ts`, `src/frontend/command-hub/app.js`, `src/frontend/command-hub/operator-console.js`,
`services/gateway/test/vtid-04560-role-separation-regression.test.ts`, `test/vtid-05047-cicd-routes-auth.test.ts`.
All paths below are under `services/gateway/`.

Approvals:
- `src/index.ts:819` mounts `approvalsRouter` at `/api/v1/approvals` with no middleware; `src/routes/approvals.ts` has
  no `router.use` and no auth middleware on `POST /feed/approve` (`:529`), `POST /:approval_id/approve` (`:651`) or
  `POST /:approval_id/reject` (`:780`).
- Both approve handlers call `/api/v1/github/autonomous-pr-merge` with `gatewayServiceAuthHeader()` and
  `automerge: true` (`:589-596`, `:728-735`). `/:approval_id/approve` takes the VTID from the id by regex
  (`:659`) and the branch from OASIS PR info (`:705-723`); `/feed/approve` takes `branch` from the body and checks only
  that `pr_number` is open with CI passing (`:531-574`); it never compares `branch` with that PR's own branch
  (`listOpenPrsWithStatus` returns it as `branch`, `src/services/github-service.ts:989-1030`).
- `requireServiceOrAdmin` (`src/middleware/require-service-or-admin.ts:71`) accepts the gateway service token or an
  exafy_admin JWT. VTID-05047 put it on the `cicd` router's routes (`test/vtid-05047-cicd-routes-auth.test.ts:36-37`,
  `:123-124`); this separate router was not covered.
- Callers: the developer voice tools call these routes through `approvalsApi` → `gatewayApiCall` with no
  `Authorization` header (`src/services/orb-tools/developer-tools.ts:109-132`; `dev_approve_pr` `:311-345`,
  `dev_reject_pr` `:348`). No Command Hub screen calls the POST routes: `app.js:5272` reads `GET /feed` with
  `buildContextHeaders` (Bearer token, `app.js:1218-1224`); `operator-console.js:3116`, `:3702` read `GET /pending`
  without headers.
- Voice tool identity: the generic registry-tool fallback passes no `user_jwt` (`src/routes/orb-live.ts:7019-7030`),
  while the admin domain tools already pass the session token (`:6430`, `:6474`, `:6506`). The LiveKit tool route
  builds its identity without `user_jwt` (`src/routes/orb-tool.ts:81-86`).

ORB work surfaces:
- `live-session-controller.ts:1181-1187` resolves the Assistant Profile from `body.surface` / `body.view_role`.
  `assistant-profile.ts:110-128` gives every non-member surface its fixed role (`command-hub` → developer, `admin`,
  `backoffice`, `commerce`); `:118` marks `command-hub` without the exafy_admin claim `unverified`, which only feeds
  telemetry (`live-session-controller.ts:1192`, `:1422`).
- A work-surface session adopts that role (`live-session-controller.ts:1414`) and loads the tenant's admin briefing
  for every work surface except commerce (`:1393`). `clampRoleToProfile` returns the work-surface role unchanged
  (`assistant-profile.ts:161`); `sessionServedRole` (`session-profile.ts:36`) is what the voice tools receive as
  `role` (`orb-live.ts:3669`, `:4730`, `:7024`, `:6982-6991`).
- The privileged catalogs are declared from that role (`live-tool-catalog.ts:2895-2911`); the handler gates check the
  same string: `developerGate` (`developer-tools.ts:35-47`), `adminGate` (`admin-users-rbac-tools.ts:23-35`),
  `isAdminRole` for the admin voice tools (`admin-scanners/briefing.ts:30-34`, `admin-voice-tools.ts:40`), and the deep
  dive's `isDeveloperCaller` on `callerFromSession`'s profile role (`orb/developer/deep-dive.ts:293-297`,
  `orb/live/tools/delegation-tools.ts:150-166`).
- The LiveKit token mint resolves the same profile (`routes/orb-livekit.ts:690-697`). Its tool route re-resolves the
  clamped role per call (`orb-tool.ts:74-80`), the pattern this plan reuses.
- `fetchPermittedRoles(sb, userId, tenantId)` (`lib/permitted-roles.ts:36`) returns the roles a user holds
  (`user_permitted_roles` ∪ active memberships ∪ community) or `roles: null` when unreadable.
- Who may open each surface today (the screens' own gates): the Command Hub admits exafy_admin or `developer`,
  `admin`, `infra`, `staff` (`routes/command-hub.ts:21`, `:27-52`); vitana-v1 `ProtectedRoute` admits a rank at or
  above the screen's role (`src/hooks/useRole.tsx:14-23`, `:109-115`).

Text path:
- `ConversationTurnRequestSchema.role` defaults to `'user'` (`src/types/conversation.ts:71`). `/turn` takes it from
  the body (`routes/conversation.ts:216`) and uses it for the prompt (`:497`), the tool definitions (`:502` →
  `tool-registry.ts:1364` `getToolsForRole`) and `userRole` (`:520`); `/stream` passes `input.role` (`:918`). Only the
  `developer_assistant` channel re-checks it server-side (`:225-269`). 18 registry tools allow only
  `['developer','admin']`.

## 3. Interfaces between lanes
None. The lanes change disjoint files and can land in either order. Lane `approvals-auth` closes the approvals path
even before lane `work-surface-permission` lands, because the forwarded token of a non-exafy caller is refused by
`requireServiceOrAdmin`.

## 4. Lanes
### Lane `approvals-auth`
1. `routes/approvals.ts`: `requireServiceOrAdmin` on the three POST routes (`:529`, `:651`, `:780`). The GET routes
   (`/count`, `/pending`, `/feed`) are unchanged (read-only; `operator-console.js` reads `/pending` without a header).
2. `routes/approvals.ts` `/feed/approve`: answer 400 `branch_mismatch` when the body `branch` is not the feed item's
   `branch`, so the merge always targets the PR that passed the CI check.
3. `services/orb-tools/developer-tools.ts`: `approvalsApi` takes the tool identity and sends
   `Authorization: Bearer <id.user_jwt>` when present; `dev_approve_pr` / `dev_reject_pr` with no `user_jwt` answer
   that a signed-in admin session is needed (the `NO_ADMIN_SESSION` pattern, `admin-users-rbac-tools.ts:37-41`)
   without calling the route. `gatewayApiCall` itself is unchanged.
4. `routes/orb-live.ts:7019-7030` (≤ 3 lines): the generic fallback identity carries `user_jwt` exactly as `:6430`
   does. `routes/orb-tool.ts:81-86` (≤ 3 lines): the identity carries the request's bearer as `user_jwt`.
5. Test `test/mt-track-s-authz-approvals-auth.test.ts` (fails on base for the 401/403 and mismatch cases): each POST
   route answers 401 without a bearer and 403 with a non-exafy JWT, and reaches its handler with the service token
   and with an exafy_admin JWT (outbound fetch mocked, nothing merged); `/feed/approve` answers 400 on a branch
   mismatch; the tools forward the JWT and do not call without one.

### Lane `work-surface-permission`
1. `orb/profile/assistant-profile.ts`: a pure `verifyWorkSurfaceProfile(profile, { isExafyAdmin, permittedRoles })`.
   A work surface is kept when the caller holds the exafy_admin claim or a permitted role the surface's screens
   admit: `command-hub` → `developer|admin|infra|staff` (= `COMMAND_HUB_ROLES`); `admin` → `admin|developer|infra`;
   `backoffice` → `backoffice|admin|developer|infra` (the `ProtectedRoute` rank rule). `commerce` is unchanged
   (navigation pack only, no member or admin context). Otherwise, and when `permittedRoles` is `null`, the result is
   the member profile (`surface: 'vitanaland'`, `resolution: 'narrowed'`, declared values kept for telemetry).
   `resolveAssistantProfile` itself is unchanged.
2. `orb/live/session/live-session-controller.ts` (≤ 20 lines, after `:1181-1187`): for an authenticated session whose
   profile is a work surface, read `fetchPermittedRoles` (skipped for exafy_admin) and apply step 1 before anything
   reads the profile; the existing `orb.session.profile.resolved` event reports the final resolution.
3. `routes/orb-livekit.ts:690-697`: the same verification for the LiveKit mint.
4. `routes/conversation.ts` (`/turn` `:216`, `/stream` `:918`): the body role `'user'` or `'community'` passes as today;
   any other value is used only when the exafy_admin claim is present or `resolveEffectiveRole` (`orb-live.ts:814-845`)
   returns that role for the caller, else `'user'`. The `developer_assistant` check stays.
5. Test `test/mt-track-s-authz-work-surface.test.ts` (fails on base): the step-1 matrix (each surface × exafy,
   permitted, not permitted, unreadable); a controller-level case where a caller without a permitted role declares
   `command-hub` or `admin` and is served the member surface with no admin briefing; a text-path case where body
   role `developer` without permission gets the `'user'` tool set.

## 5. Parallel work, shared and hot files
- No two lanes edit the same file. Hot files: `routes/orb-live.ts` (lane `approvals-auth`, ≤ 3 lines) and
  `live-session-controller.ts` (lane `work-surface-permission`, ≤ 20 lines), each in its own PR, rebased on `main`
  before merge.
- Multi-tenant overlap: lane `persona-pack` of `mt-packs-r2` (drafted, not approved) claims `orb/profile/**`,
  `routes/orb-live.ts` and `live-session-controller.ts`. This plan lands first; `persona-pack` rebases on it. No other
  multi-tenant lane path overlaps (checked `mt-identity-r2`, `mt-network-r2`, `mt-tenant-admin-r2`, `mt-guardrails-r2`,
  `mt-track-s-r2`). `fetchPermittedRoles` and `resolveEffectiveRole` are read, not changed.
- Programme: the plan PR adds `vitana-platform:mt-track-s-authz` to `docs/programs/multi-tenant/program.md`.

## 6. Tests and commands
Gateway: `npx jest test/mt-track-s-authz-*.test.ts`, `npm run test:roles` (rule 42h), `npm run test:operator`
(rule 42e), `npm run test:support` (rule 42c), `npx tsc --noEmit`. Each lane records red on `origin/main` and green
on its head in `docs/validation/<VTID>/`.
Staging (read-only, `docs/validation/<VTID>/staging-tests.json`):
- `approvals-auth`: `POST /api/v1/approvals/appr_invalid/approve` and `POST /api/v1/approvals/feed/approve` with
  `{}` and no bearer expect 401. On base they answer 400 at input validation, so neither state writes anything.
- `work-surface-permission`: not verified on staging. Proving it needs an authenticated ORB session start, which
  writes session rows to the shared database (CLAUDE.md rule 48). Covered by the Jest suites, referenced as `existing`.

## 7. Measurement
`docs/validation/<plan VTID>/timings.json` (collaboration.md §8b). Gate 2 quotes it.

## 8. Risks
- A Command Hub user whose token carries no exafy_admin claim (Cognito sessions, `auth-supabase-jwt.ts:253-268`) and
  who has no permitted `developer|admin|infra|staff` role is now served the member surface. That is the intended
  fail-closed result; the remedy is granting the role. The share is visible in `orb.session.profile.resolved` events
  (`resolution: narrowed`).
- `staff` keeps the developer surface on the Command Hub, because the Command Hub itself admits staff
  (`command-hub.ts:21`). Narrowing that is a product decision outside this plan.
- The approvals GET routes stay unauthenticated (read-only). Recorded as a follow-up, not changed here.
- Developer voice approve and reject now need the caller's own token; sessions without one get the admin-session
  answer instead of a merge.

## 9. Unchanged
No migration, flag, RLS policy or tenant code (`tenant-context.ts`, auth middleware) changes. `resolveAssistantProfile`,
the member-surface clamp, `ROLE_REGISTRY`, `resolveEffectiveRole`, `fetchPermittedRoles` and the cicd router are
unchanged. Production is reached only by PUBLISH after Gate 2.
<!-- plan:end -->
