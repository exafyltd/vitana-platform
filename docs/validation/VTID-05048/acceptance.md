# VTID-05048 - Track S / S4 PR-B (S-I): caller identity and header hardening (security fix)

Owner approval 2026-10-10 (Gate 1: "Yes approved"). Sparring: `plan-sparring.md` (converged, 2 rounds). First allocation VTID-05045 was tombstoned by the allocated-orphan reaper; this VTID replaces it.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /api/v1/governance/controls/:key` (index.ts:749) and `POST /api/v1/specs/:vtid/approve` (index.ts:784) now run `requireServiceOrAdmin` first. `routes/governance.ts` (index.ts:747) adds `optionalAuth`; reads stay open.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/governance/controls (staging).

CURL_PROOF: unauthenticated POST to both write routes answers 401 application/json (before: 400 from body validation on controls, 404 on approve; i.e. no auth at all).

OASIS_PROOF: unchanged; refused calls never reach the handler, so no `vtid.spec.approved` or control-audit rows are written for them.

## Acceptance criteria

AC-1: `POST /governance/controls/:key` answers 401 with no auth and with spoofed `x-user-id`/`x-user-role` headers, 403 for a signed-in tenant admin, and 200 for an exafy_admin JWT or the gateway service token. Nothing is written on 401/403.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (I3 governance controls write)
  CURL: staging POST /api/v1/governance/controls/__s4_probe_nonexistent__ (no auth) -> 401 application/json

AC-2: The control actor comes only from the credential: `admin:<user_id>` / role `exafy_admin`, or `service:internal` / role `service`; an ORB tool's `x-orb-caller-user-id` is appended as `/orb:<user_id>` on service calls only, malformed labels are dropped, and spoofed headers are ignored.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (actor label cases)

AC-3: `POST /specs/:vtid/approve` has the same 401/401/403/200 matrix; the approver is `admin:<user_id>` (`exafy_admin`) or `service:<approved_by|internal>` (`service`); no ledger read happens on 401/403.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (I4 spec approval)
  CURL: staging POST /api/v1/specs/VTID-00000/approve (no auth) -> 401 application/json

AC-4: The operator tool `dev_approve_spec` calls the approve route with `gatewayServiceAuthHeader()` instead of the Supabase service key, and the operator pipeline stays green.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (source guards)
  TEST: npm run test:operator (test/vtid-04465-operator-pipeline-regression.test.ts)

AC-5: The ORB control writes (`admin_set_control_key`, `dev_set_control`) send `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` plus `x-orb-caller-user-id`, never `x-user-id`/`x-user-role`, and refuse a non-exafy_admin session before any gateway call. The ORB control reads send no spoofed headers.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (ORB control tools)
  TEST: services/gateway/test/orb-tools/admin-governance-tools.test.ts
  TEST: services/gateway/test/orb-tools/governance-tools.test.ts

AC-6: Governance reads ignore `x-tenant-id`/`?tenantId` unless the caller is an exafy_admin or presents the service token (else `SYSTEM`); `GET /governance/controls` and `GET /governance/rules` stay open.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (I2 governance tenant)
  CURL: staging GET /api/v1/governance/controls -> 200 application/json
  CURL: staging GET /api/v1/governance/rules -> 200 application/json

AC-7: Autopilot prompts take the tenant from `me_context`, then the verified identity, then the primary `user_tenants` row; the `x-tenant-id` header and the `'1111…'` default are gone; no tenant answers 400 `TENANT_REQUIRED`.
  TEST: services/gateway/test/routes/autopilot-prompts.test.ts
  CURL: staging GET /api/v1/autopilot/prefs (no auth) -> 401 application/json

AC-8: Reminders take the tenant from the verified identity, resolved through `requireTenant` (primary `user_tenants` row) on the route that writes it; `X-Tenant-ID`, `X-Vitana-Tenant` and `DEFAULT_TENANT_ID` are ignored; no tenant answers 400 `TENANT_REQUIRED`.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (I5 reminders tenant)
  TEST: services/gateway/test/routes/reminders-snooze.test.ts

AC-9: Automations member routes (`/wallet/*`, `/sharing/*`, `/referrals`) carry explicit `requireAuth` (401 anonymous) and use only the JWT tenant; body `tenant_id` and `DEFAULT_TENANT_ID` remain available only on the `requireInternalOrAdmin` routes.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (I6 automations member routes)
  TEST: services/gateway/test/routes/automations-wallet-balance.test.ts
  TEST: services/gateway/test/vtid-04510-community-autopilot-automation-proposals.test.ts

AC-10: `OPS-TOGGLE-FLOW-V3-STAGING.yml` sets the control with `Authorization: Bearer ${{ secrets.GATEWAY_SERVICE_TOKEN }}` (failing loudly if the secret is missing) and no longer sends `x-user-id`/`x-user-role`.
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts (source guards)

AC-11: Shared-auth regression suites stay green: roles, support, operator.
  TEST: npm run test:roles
  TEST: npm run test:support
  TEST: npm run test:operator
