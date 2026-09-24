# VTID-04499 — Commerce partner onboarding Phase 1: the connections step

Spec §6.2 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md`: "`POST /:orgId/connections` — shop or API connection — wraps the VCAOP `/my/connections` state machine". Also §6.1 "mapping confirmed".

## What changed

- **New router** `routes/partner-onboarding-connections.ts`, mounted on `/api/v1/partner-onboarding`, org_admin only.
  - `GET /:orgId/connections` lists the org's connections and reconciles the mapping step from their states.
  - `POST /:orgId/connections` starts a connection. When the body names no connector or provider, they default to the org's website detection (VTID-04481). Without either, the request fails with 400 `CONNECTOR_REQUIRED`.
- **Same state machine as the merchant portal.** The manifest, first version and schema sources are created by `insertConnection()`. That function was extracted verbatim from the portal's own `POST /connections` in `vcaop-portal-my.ts`, so the portal now calls the same function with unchanged behaviour. The connection starts in `authorization_required`, or in `mapping` when an OpenAPI document is supplied.
- **One `partner_tenant` per org**, keyed by `partner_organization_id` (VTID-04471; the column exists live).
  - Its `owner_user_id` is the org owner, so the portal's existing per-connection endpoints serve the owner: mapping preview and decisions, sandbox tests, OAuth, pause and revoke.
  - `owner_email` is recorded only when the owner started the connection.
- **The mapping step:**
  - `done` once any connection is `certified`, `active` or `degraded`;
  - `in_progress` while one exists;
  - no row while there are none.
  - Connection states move through the portal endpoints, which don't know the org, so the step is reconciled on every list and create. It is written, and `partner_org.mapping_step_changed` emitted, only when the status moves.
- `partner_org.connection_started` is emitted on every connection start.
- **Locked** (409 `CONNECTIONS_LOCKED`) for rejected and suspended orgs.
- **Activation stays with the platform.** Moving a connection from certified to active remains the platform's one-approval gate on the admin router.

## Acceptance criteria

AC-1 The mapping step status is:
- null with no connections;
- `done` when any connection is certified, active or degraded;
- `in_progress` otherwise.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-2 Access:
- 401 JSON without a token;
- 403 for a non-admin, with no manifest query;
- 409 `CONNECTIONS_LOCKED` for a suspended org, before any write.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-3 Create:
- 400 `CONNECTOR_REQUIRED` with no connector and no detection;
- 400 for an invalid token or a non-object OpenAPI document;
- creates the org's partner_tenant (org link, the org owner as owner, the owner's email only when the owner starts it, the caller's tenant, `discovered`);
- creates the connection in `authorization_required` with the portal's defaults;
- defaults the connector from the detection and reuses the org's partner_tenant;
- an OpenAPI document starts the connection in `mapping` with a version;
- events are emitted in the order connection_started, then mapping_step_changed, and the step event only when the status moves.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-4 List:
- scoped by `partner_tenant.partner_organization_id`;
- a certified connection completes the mapping step once, with no second write or event on the next list;
- nothing is written for an org with no connections.
TEST: services/gateway/test/partner-onboarding-connections.test.ts

AC-5 The portal's own `POST /connections` still passes its existing suite after the `insertConnection()` extraction.
TEST: services/gateway/test/routes/vcaop-portal-my.test.ts

## Route mount

ROUTE_MOUNT: a new `mountRouterSync(app, '/api/v1/partner-onboarding', partnerOnboardingConnectionsRouter, { owner: 'partner-onboarding-connections' })`, after the catalogue router. The paths do not collide.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/<orgId>/connections` (staging, after merge).
CURL_PROOF: **not yet run**, because the router is not deployed anywhere yet.
- Before merge, `test/partner-onboarding-connections.test.ts` exercises the router with supertest.
- After the staging deploy, `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/connections` should return `401 application/json`.
CURL: see CURL_PROOF above.

## OASIS

OASIS_IMPACT: yes. Two new topics:
- `partner_org.connection_started`, with payload `partner_organization_id`, `connection_id`, `connector_id`, `provider_id` and `state`;
- `partner_org.mapping_step_changed`, with payload `from`, `to` and `connection_count`, emitted on transitions only.

OASIS_PROOF: the route suite asserts both events, their order, and the absence of the step event when the status does not move. After deploy:
`SELECT topic, metadata->>'to', metadata->>'connection_count' FROM oasis_events WHERE topic IN ('partner_org.connection_started','partner_org.mapping_step_changed') ORDER BY created_at DESC LIMIT 5;`

## Not in this VTID

- Org-scoped wrappers for the per-connection endpoints, so that any org_admin (not only the owner) can use them.
- Mapping confirmation for partners with a manual catalogue and no connection.
- The tracking test (§8.3).
- No schema change.
