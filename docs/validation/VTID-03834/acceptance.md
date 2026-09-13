# VTID-03834 — Gateway: BackOffice ERP capability grants API

## Report

Third code VTID of the BackOffice plan (design gate PR #3282, role VTID-03832,
skeleton VTID-03833). The Vitana role opens the `/backoffice` door; an ERP
**capability** gates what a person may do inside. This VTID ships the
capability layer end to end:

- **Catalog + role defaults** (`src/constants/erp-capabilities.ts`): the 30
  capabilities of GOLDEN-WORKFLOWS §3.1 (cross-checked mechanically against the
  document on the VTID-03831 branch — 30 cited, 0 missing, 0 extra) and the §3.2
  defaults: tenant `admin` gets every `*.view`, `crm.manage`, `sales.*`,
  `finance.approve/reconcile`, `accounting.post/configure`, `approvals.policy`,
  `erp.admin` — **not** `finance.pay`, `accounting.close`, and never `hr.*` /
  `payroll.*` (explicit-only, personal data); `developer`/`infra` view-only;
  `backoffice` nothing until granted; Exafy super-admins everything.
- **Pure policy** (`src/services/backoffice/erp-access.ts`): effective =
  defaults ∪ explicit; who may manage access (Exafy, or effective `erp.admin`);
  grant validation (catalog; `hr.*`/`payroll.*` only by a tenant `admin` or
  Exafy — a delegated `erp.admin` holder cannot widen employee-data access).
- **Routes** (`src/routes/backoffice-access.ts`, mounted at
  `/api/v1/backoffice`): `GET /me`, `GET /access`, `GET /access/:userId`,
  `POST /access/grant`, `POST /access/revoke`, mirroring `role-admin.ts`
  (tenant-scoped, service-role PostgREST writes, idempotent duplicate grant,
  target-in-tenant check). Its identity/tenant helpers were **extracted
  verbatim** from `role-admin.ts` into `src/lib/tenant-role-auth.ts` and
  re-imported there rather than copied. `requireErpCapability(cap)` is the
  middleware later BackOffice routes attach.
- **Table** `erp_capability_grants` — migration file only, **NOT applied**
  (rule 4); `DATABASE_SCHEMA.md` updated and marked as such.
- **Frontend companion** (`exafyltd/vitana-v1`, same VTID): hooks over the new
  endpoints, sections hidden by capability (Overview/Approvals never), a
  no-access body on gated placeholders, and BackOffice › Settings › Access
  cloned from Roles & Access.

## Acceptance Criteria

AC-1 — The catalog is exactly the design gate's §3.1 list (30, unique,
`<domain>.<level>`), `hr.*`/`payroll.*` are explicit-only and appear in no
role's defaults, and the §3.2 defaults hold (admin lacks `finance.pay` and
`accounting.close`; developer/infra view-only; backoffice/staff none).

TEST: `test/vtid-03834-erp-capabilities.test.ts` — "is the design-gate
catalog…", "hr.* and payroll.* are explicit-only…", "role defaults match
§3.2…" (`outputs/gateway-jest-vtid-03834.txt`); one-off doc cross-check
recorded in `commands.log` (30 cited / 0 missing / 0 extra).

AC-2 — Effective access = role defaults ∪ explicit grants, de-duplicated,
unknown strings dropped; managers are Exafy, tenant admins, or explicit
`erp.admin` holders; grant validation refuses unknown capabilities and
personal-data grants from non-admins.

TEST: same file — "effective = defaults ∪ explicit…", "who manages access…",
"validateGrant…". (The de-duplication assertion failed on the first run —
a real defect in the first draft, fixed.)

AC-3 — `GET /api/v1/backoffice/me` returns 401 JSON without identity (mount
proof), and for a tenant admin returns defaults incl. `erp.admin`, explicit
grants read for that user in that tenant only, the union, and
`can_manage_access: true`; a `backoffice` user with no grants gets an empty
list and cannot manage; a failed grants read fails closed on explicit grants
but keeps role defaults.

TEST: `test/routes/backoffice-access.test.ts` — describe "GET /me" (4 tests),
supertest against the real router mounted at `/api/v1/backoffice`.

AC-4 — `requireErpCapability('finance.pay')` returns 403 naming the missing
capability and passes once the capability is held.

TEST: same file — "requireErpCapability middleware".

AC-5 — `/access*` is refused (403) to a `backoffice` user without
`erp.admin`; a tenant admin gets grants grouped per user; a non-Exafy caller
cannot read another tenant via `?tenant_id`; grant validates the catalog,
posts `{user_id, tenant_id, capability, granted_by}` with the service role,
is idempotent on duplicates, refuses `hr.*` from a delegated `erp.admin`
holder but accepts it from a tenant admin, and refuses a target outside the
tenant; revoke deletes scoped to user × tenant × capability.

TEST: same file — describes "GET /access", "POST /access/grant", "POST
/access/revoke" (8 tests).

AC-6 — `role-admin.ts` behaviour is unchanged by the helper extraction;
`tsc --noEmit` clean; no regression in the full gateway suite.

TEST: `test/vtid-03832-vitana-roles-constant.test.ts` still passes (it
imports `role-admin`'s neighbours); `outputs/gateway-tsc-noemit.txt` (exit
0); `outputs/gateway-jest-full-tail.txt`.

AC-7 — Route mount evidence.

CURL: supertest `GET /api/v1/backoffice/me` → 401 `application/json`
(`test/routes/backoffice-access.test.ts`, first test); live staging curl of
FINAL_URL below after merge.

ROUTE_MOUNT: `backofficeAccessRouter` (`services/gateway/src/routes/backoffice-access.ts`)
is mounted in `services/gateway/src/index.ts` right after the role-admin
mount: `mountRouterSync(app, '/api/v1/backoffice', backofficeAccessRouter,
{ owner: 'backoffice-access' })`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/backoffice/me
CURL_PROOF: local, against the real router via supertest (test "401 without
identity (mount proof: JSON, not HTML)"): `GET /api/v1/backoffice/me` →
`401 application/json {"ok":false,"error":"UNAUTHENTICATED"}`. After
merge-to-main auto-deploys staging: `curl -s -o /dev/null -w "%{http_code}
%{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/backoffice/me`
must print `401 application/json…` (a `404 text/html` would mean the mount
did not ship).

## Not verified / blocked

- The migration is not applied (owner's "apply now" required). Until then
  `/me` serves role defaults only and `/access/grant` fails at PostgREST.
- No staging curl yet (route ships with the merge); the FINAL_URL check above
  is the first live proof.
- The frontend Access screen was screenshotted against a local dev server with
  these two GET endpoints mocked to the router's exact response shape; see the
  vitana-v1 companion PR's evidence.
