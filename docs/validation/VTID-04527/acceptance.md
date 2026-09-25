# VTID-04527 — Commerce partner onboarding Phase 1: org-scoped per-connection endpoints

Follow-up to VTID-04499. A connection's own routes (detail, mapping preview and decisions, sandbox tests, activation summary, Shopify / SMART-on-FHIR authorize, pause, resume, reauthorize, revoke) previously served only the org owner, through the portal's owner-scoped `/vcaop/portal/my/connections/:id/*`. Now every org_admin of the org can use them under `/api/v1/partner-onboarding/:orgId/connections/:id/*`.

## What changed

- **One implementation, two scopes.** The portal's per-connection handlers now live in `registerConnectionRoutes(router, scope)` in `vcaop-portal-my.ts`, parameterised by a `ConnectionScope`:
  - `guards`: middleware run before each route;
  - `fetchManifest`: which connections the caller may reach;
  - `surface`: the value recorded on OASIS events;
  - `onStateChange`: a hook called after the connection's state changes.
  - The portal registers the routes with its owner scope: no guards, `partner_tenant.owner_user_id = caller`, surface `merchant_self_service`. Its behaviour is unchanged.
  - A whitespace-insensitive diff of `vcaop-portal-my.ts` shows only the scope plumbing, plus the rename below.
- **Org scope** (`partner-onboarding-connections.ts`), registered under `/:orgId`:
  - guards: `requireAuth` and `requireOrgAdmin()`, attached per route, so unrelated paths under an org stay a plain 404;
  - `fetchOrgManifest()` (new in the VCAOP repository) filters on `partner_tenant.partner_organization_id = :orgId`, so another org's connection id is a 404;
  - surface `partner_onboarding`;
  - `onStateChange` reconciles the mapping step (the VTID-04499 logic, now `refreshMappingStep()`). A reconcile failure is logged and never turns an already-applied state change into an error.
- **Mapping decisions** record the calling admin as `decided_by`, the same rule as the portal. **Activation** stays on the admin router; there is no approve route on either surface.
- **Bug avoided in the move:** the FHIR authorize handler destructured a request-body field named `scope`. Inside the new function, that would shadow the `scope` parameter and throw a TDZ `ReferenceError` on every call. The body field is now read as `scope: oauthScope`, so the request API is unchanged. The existing portal FHIR test sends `scope`, which covers the rename.

## Acceptance criteria

AC-1 Any org_admin (not only the owner) reads a connection of the org; the lookup is filtered by id and `partner_tenant.partner_organization_id`.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-2 Another org's connection id returns 404. A non-admin gets 403 before any connection is read.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-3 Revoking a connection:
- moves its state and writes the VCAOP audit event with surface `partner_onboarding` and the acting admin;
- reconciles the mapping step (`done` → `in_progress`, with `partner_org.mapping_step_changed`).

An illegal transition returns 409 and changes nothing.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-4 There is no activation route on the onboarding surface. An unrelated path under an org stays a plain 404, because the guards are per-route.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-5 The portal behaves as before after the extraction: owner scoping, authority boundaries, the certification gate, and the Shopify/FHIR authorize flows, including the FHIR `scope` field.
TEST: services/gateway/test/routes/vcaop-portal-my.test.ts

## Route mount

ROUTE_MOUNT: `router.use('/:orgId', perConnection)` in `routes/partner-onboarding-connections.ts`, a `Router({ mergeParams: true })`. It sits on the router already mounted at `/api/v1/partner-onboarding` (VTID-04499); `src/index.ts` is unchanged.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/<orgId>/connections/<id>` (plus `/mapping-preview`, `/mapping-decisions`, `/sandbox-tests`, `/activation-summary`, `/shopify/authorize`, `/fhir/authorize`, `/pause`, `/resume`, `/reauthorize`, `/revoke`), on staging after merge.
CURL_PROOF: **not yet run.** The routes are deployed nowhere yet. The route suite exercises them with supertest. After the staging deploy, `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/connections/x` should return `401 application/json`.
CURL: see CURL_PROOF above.

## OASIS

OASIS_IMPACT: yes. There are no new topics.
- The existing VCAOP connection topics (`vcaop.portal.connection.paused|resumed|reauthorize_requested|revoked`, `vcaop.portal.mapping.decided`, `vcaop.portal.sandbox_tests.completed`) now also carry `surface: 'partner_onboarding'` when they come from this surface.
- `partner_org.mapping_step_changed` (VTID-04499) is also emitted after state changes made here.

OASIS_PROOF: the route suite asserts the revoke audit event's surface and actor, and the mapping-step event. After deploy:
`SELECT topic, metadata->>'surface', metadata->>'actor' FROM oasis_events WHERE topic LIKE 'vcaop.portal.%' AND metadata->>'surface' = 'partner_onboarding' ORDER BY created_at DESC LIMIT 5;`

## Not in this VTID

- The org lifecycle does not gate these routes. A rejected or suspended org can still pause or revoke its own connections, and severing an integration should never be blocked.
- No schema change.
