# VTID-05044 - Track S / S4 PR-A: invitation role allowlist + email-bound atomic accept; cross-tenant marketing budget metric (security fix)

Owner approval 2026-10-10 (Gate 1: "Yes approved"). Sparring: `plan-sparring.md` (converged, 2 rounds). This VTID is PR-A of plan S4 only (S-G + S-K); PR-B (S-I) and PR-C (S-H) are separate.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: unchanged mounts — `POST /api/v1/admin/tenants/:tenantId/invitations` (requireTenantAdmin), `POST /api/v1/admin/invitations/accept/:token` (requireAuth), `GET /api/v1/billing/admin/metrics` (requireAuth + requireExafyAdmin). Only handler logic changes.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/invitations/accept/s4-probe-invalid (staging).

CURL_PROOF: anonymous POST to invitation accept and create answers 401 application/json; anonymous GET of billing admin metrics answers 401 (staging-tests.json). Authenticated behaviour is proven by Jest (rule 48: no writes on staging).

OASIS_PROOF: unchanged; no OASIS events are emitted by these handlers.

## Acceptance criteria

AC-1: Creating an invitation validates every role against VITANA_ROLES: an unknown role (`bogus`, `commerce`, a non-string) answers 400 INVALID_ROLE with `valid_roles`, and nothing is inserted. Duplicate roles are stored once.
  TEST: services/gateway/test/routes/tenant-admin/invitations.test.ts ("VTID-05044 create: role allowlist")

AC-2: A tenant admin cannot invite with a SUPER_ADMIN_ONLY_ROLES role (`developer`, `infra`): 403 ROLE_NOT_GRANTABLE, nothing inserted. An exafy_admin can (201). A tenant admin can still invite as `backoffice` and `admin` (201).
  TEST: services/gateway/test/routes/tenant-admin/invitations.test.ts ("VTID-05044 create: role allowlist")
  CURL: staging POST /api/v1/admin/tenants/00000000-0000-4000-8000-000000000000/invitations without a bearer -> 401 application/json

AC-3: Accepting requires a confirmed email that matches the invitation case-insensitively. A different email answers 403 EMAIL_MISMATCH, an unconfirmed email 403 EMAIL_UNVERIFIED, a case-only difference is accepted (200). On refusal the invitation stays pending and nothing is granted. A failed auth lookup is 500, never a grant.
  TEST: services/gateway/test/routes/tenant-admin/invitations.test.ts ("VTID-05044 accept: email binding, legacy roles, atomic claim")
  CURL: staging POST /api/v1/admin/invitations/accept/s4-probe-invalid without a bearer -> 401 application/json

AC-4: An invitation already in the table that carries an unknown role, or `developer`/`infra` from an inviter who is not exafy_admin, answers 409 INVITATION_ROLES_INVALID at accept time and grants nothing. The same role from an exafy_admin inviter is honoured.
  TEST: services/gateway/test/routes/tenant-admin/invitations.test.ts ("legacy invite carrying infra", "legacy invite carrying an unknown role", "infra invite from an exafy_admin inviter")

AC-5: Accept claims the invitation with a conditional update (pending, not revoked, not expired) BEFORE any membership or role is written. Of two accepts, the second answers 409 ALREADY_USED and writes nothing. A failed membership read does not consume the invitation.
  TEST: services/gateway/test/routes/tenant-admin/invitations.test.ts ("double accept", "creates membership + grants roles", "returns 500 (not a silent membership reset)")

AC-6: `GET /billing/admin/metrics` reads every tenant_settings row (no maybeSingle). `marketing_budget_remaining_cents` is the sum of the numeric per-tenant budgets (null when none / 0 rows), and the additive `marketing_budget_remaining_by_tenant` maps tenant_id to cents or null. A read error is logged, not swallowed.
  TEST: services/gateway/test/routes/billing-admin-metrics.test.ts ("marketing budget across tenants (VTID-05044)")
  TEST: services/gateway/test/routes/billing-repository.test.ts ("fetchTenantSettingsFeatureFlags reads every tenant row")
  CURL: staging GET /api/v1/billing/admin/metrics without a bearer -> 401 application/json
