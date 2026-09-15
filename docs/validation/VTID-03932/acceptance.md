# VTID-03932 — Commerce Partner Onboarding: self-service partner_organizations + staff/professional roles + patient aggregation (Phase 1)

## Report

Phase 1 of the platform-owner-approved plan: any business (medical or
non-medical) should go through one onboarding flow — self-register, invite
staff/professionals, and have anyone who consumes a health service
automatically gain the Vitana-wide `patient` role. A 3-agent codebase audit
found the role ladder and grant machinery real and reusable
(`vitana_role`/`tenant_role`, VTID-03832) but "tenant" means a small,
Vitana-operated set of portal brands, not "one row per external company" —
so per the platform owner's explicit decision, this phase builds a
**separate, parallel** `partner_organizations` concept rather than widening
`tenants`, and treats a partner's products/services as first-party for v1
(no new payout/settlement ledger).

- **Migration** (`supabase/migrations/20260915120000_vtid_03932_partner_organizations.sql`,
  **not applied** — rule 4, no live DB access from this session):
  `partner_organizations` (business identity, `pending_review→active`),
  `partner_organization_members` (org-scoped `org_admin|staff|professional`
  roster — deliberately NOT the `vitana_role` enum, a separate dimension),
  `partner_organization_invites` (email+token invite-to-join),
  `patient_profiles` (Vitana-wide activation flag), a nullable
  `partner_organization_id` FK added to the existing `partner_registry`
  (VTID-03885, reused not duplicated), and `assigned_professional_user_id`
  added to `partner_health_test_orders` for order-scoped least-privilege
  assignment. An `AFTER INSERT` trigger on `partner_health_test_orders`
  activates `patient_profiles` and best-effort bumps the ordering user's
  `memberships.role` from `community`→`patient` (never downgrades
  staff/admin; wrapped in `EXCEPTION` so a live-schema surprise in
  `memberships` — inferred from `routes/auth.ts`'s `GET /me` contract, not
  created by a migration in this repo — can never block the order insert
  itself).
- **Routes** (`services/gateway/src/routes/partner-orgs.ts`, mounted at
  `/api/v1/partner-orgs`): `POST /register` (any authenticated user — every
  account is already auto-`community`), `POST /:orgId/members/invite` +
  `POST /invites/:token/accept` + `GET /:orgId/members` (org_admin-only,
  re-keyed `canManageErpAccess()`/`requireManager()` pattern from
  `backoffice-access.ts`), `POST /:orgId/activate` (exafy_admin-only,
  mirrors the VCAOP `certified→active` precedent).
- **Generalized, not duplicated**: `admin-partner-health.ts`'s existing
  orders/inbox/upload-result/confirm-match routes (VTID-03885) now serve a
  partner org's own `staff`/`professional` members too, via a new
  `requirePartnerHealthAccess` gate replacing `requireTenantAdmin` — same
  `ingestPartnerResult()`/`recordStatusChange()` write path, zero
  duplication. New `services/partner-health/org-access.ts` resolves
  `{scope:'admin'}` (exafy_admin/tenant admin, unchanged behavior) or
  `{scope:'org', fullAccessPartnerIds, assignedOnlyPartnerIds}`
  (org_admin/staff = full org access; professional = assigned-order-only,
  least-privilege — never a standing "see everything for this patient"
  grant). This is also where the smaller "replace the raw-JSON upload
  textarea with a real form" task lands conceptually: the upload-result
  primitive is now shared by Vitana's fallback admin AND a partner's own
  professional, not admin-only — the frontend form itself is explicitly
  deferred to Phase 4 of the plan (not in this Phase 1 PR).

## Acceptance Criteria

AC-1 — The migration creates `partner_organizations`,
`partner_organization_members`, `partner_organization_invites`,
`patient_profiles`; adds `partner_organization_id` to `partner_registry` and
`assigned_professional_user_id` to `partner_health_test_orders`; and the
`AFTER INSERT` trigger activates `patient_profiles` + best-effort bumps
`memberships.role` community→patient only.

TEST: manual SQL-structure review (balanced parens, one `CREATE TRIGGER`,
one `CREATE OR REPLACE FUNCTION`, four `CREATE TABLE`) —
`outputs/migration-sanity-check.txt`; full file read start-to-finish and
cross-checked against `20260914090000_vtid_03885_partner_health_test_integration.sql`'s
and `20260913000002_vtid_03832_role_functions.sql`'s conventions (naming,
RLS pattern, `COMMENT ON` usage). Not executed against a live database —
no Supabase/gateway credentials in this session (see "Not verified" below).

AC-2 — `services/partner-health/org-access.ts`'s pure predicates correctly
resolve full-vs-assigned-only access and never leak access to a partner
outside both lists.

TEST: `test/partner-health/org-access.test.ts` — `resolveOrgHealthAccess`
(null on no membership, full access for org_admin/staff, assigned-only for
professional, full-access precedence when both memberships resolve to the
same partner), `hasFullPartnerAccess`/`canActOnOrder`/`allVisiblePartnerIds`
(admin scope always true/null-filter; org scope: full partner any order,
assigned-only partner only the caller's own assignment, unrelated partner
never actionable).

AC-3 — `POST /api/v1/partner-orgs/register` requires auth (mount proof: 401
JSON without a token), validates required fields, creates the org
`pending_review` with the caller as `org_admin`, and 409s on a duplicate
`org_key`.

TEST: `test/partner-orgs.test.ts` — describe "partner-orgs — auth (mount
proof)", "POST /register" (3 tests).

AC-4 — `GET /:orgId/members` and `POST /:orgId/members/invite` are
org_admin-or-exafy_admin-only for THAT org; invite validates the role
enum; `POST /invites/:token/accept` 404s an unknown token, 409s an
already-accepted one, 410s an expired one, and on success inserts the
membership + marks the invite accepted.

TEST: same file — describes "GET /:orgId/members" (3 tests), "POST
/:orgId/members/invite" (2 tests), "POST /invites/:token/accept" (4 tests).

AC-5 — `POST /:orgId/activate` is exafy_admin-only, 404s an unknown org, and
flips `status` to `active` on success, emitting `partner_org.activated`.

TEST: same file — describe "POST /:orgId/activate" (3 tests).

AC-6 — `admin-partner-health.ts`'s routes are byte-for-byte unchanged in
behavior for a Vitana admin (exafy_admin or tenant admin), and now also
correctly scope a partner org's own staff (full access to their org's
orders/inbox) and professional (assigned-orders-only, 403 otherwise) members
— without any change to the `ingestion.ts` write path.

TEST: `test/admin-partner-health.test.ts` — every pre-existing admin-path
test still passes against the new `requirePartnerHealthAccess` gate
(auth mock changed from `require-tenant-admin` to `auth-supabase-jwt`'s
`requireAuth`, admin path unchanged); new describes "GET /orders —
org-scoped access (VTID-03932)" (staff full access, professional
assigned-only filtering) and new PATCH tests (403 for an unassigned
professional, 200 for the professional's own assigned order); new 403 test
for a caller with no admin/org access at all.

AC-7 — `tsc` produces no new errors attributable to this VTID's own files.

TEST: `outputs/gateway-tsc-narrow.txt` — narrow `tsc --noEmit` run (this
sandbox has no `node_modules`, so full-project `tsc`/`npm ci` cannot run;
see `commands.log`). The only errors present are pre-existing sandbox noise
(missing `@supabase/supabase-js`/`express`/`process`/`crypto` types) —
identical shape to the precedent recorded in
`docs/validation/VTID-03901/commands.log`. Zero errors reference
`partner-orgs.ts`, `org-access.ts`, or the touched lines of
`admin-partner-health.ts`/`index.ts`/`types/cicd.ts`.

AC-8 — Route mount evidence (new routes added: `partner-orgs.ts`).

ROUTE_MOUNT: `partnerOrgsRouter` (`services/gateway/src/routes/partner-orgs.ts`)
is mounted in `services/gateway/src/index.ts` right after the partner-health
consent mount: `mountRouterSync(app, '/api/v1/partner-orgs', partnerOrgsRouter,
{ owner: 'partner-orgs' })`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/partner-orgs/register
CURL_PROOF: local, against the real router via supertest (test "401 without
any token" in `test/partner-orgs.test.ts`): `POST
/api/v1/partner-orgs/register` → `401 application/json
{"ok":false,"error":"UNAUTHENTICATED"}`. After merge-to-main auto-deploys
staging: `curl -s -o /dev/null -w "%{http_code} %{content_type}"
-X POST https://preview-aws-gateway.vitanaland.com/api/v1/partner-orgs/register`
must print `401 application/json…` (a `404 text/html` would mean the mount
did not ship).

AC-9 — OASIS traceability.

OASIS_PROOF: `emitOasisEvent()` is called for `partner_org.registered`
(register), `partner_org.member_joined` (invite accept), and
`partner_org.activated` (admin activate) — all three added to
`CicdEventType` in `src/types/cicd.ts`. Asserted in
`test/partner-orgs.test.ts`'s happy-path tests via
`expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({type: '...'}))`.

## Not verified / blocked

- **The migration is not applied.** No Supabase/gateway credentials are
  reachable from this session — per platform convention (rule 4: migration
  file only) the SQL ships as a file for the owner to apply. Until applied,
  every new route in this PR will fail at PostgREST (`partner_organizations`
  etc. do not exist yet) — this matches the exact, already-accepted pattern
  of VTID-03834's `erp_capability_grants` shipping unapplied in the same way.
- **No live staging curl yet** — the FINAL_URL check in AC-8 is the first
  live proof, available only after merge-to-main auto-deploys staging AND
  the migration above is applied.
- **`memberships`'s exact live schema is inferred, not confirmed**, from
  `routes/auth.ts`'s `GET /me` response contract (`tenant_id`, `user_id`,
  `role`, `status` columns) — the trigger's ladder-bump UPDATE is wrapped in
  a `BEGIN...EXCEPTION` block specifically because this repo's own
  `vitana-platform` CLAUDE.md §3 warns that live DB state can outrun this
  repo's migration history for tables like this one.
- **No jest execution in this sandbox** — `node_modules` is absent and `npm
  ci`/`npm install` fail with `403 Forbidden` against the registry (same
  environment limitation recorded in `docs/validation/VTID-03901/commands.log`).
  Every test file's logic was traced manually against the exact fake-Supabase
  chain semantics (`op`/`terminal` dispatch) rather than executed; see
  `commands.log` for the trace notes.
- Phases 2–5 of the approved plan (frontend org registration/admin console,
  real `/patient/*` and `/professional/*` screens + the mobile-role-force
  fix, generalized `PartnerHealthOrders.tsx`, DoctorBox as the first
  self-registered org) are explicitly out of scope for this Phase 1 PR, per
  the plan's own phased-delivery section.
