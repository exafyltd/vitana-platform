# VTID-04838 — Commerce "Set up with AI": website draft, apply on confirm

Slice 2 of the AI-first Commerce setup (owner decisions 2026-10-02: AI setup is
the primary path; the supplier confirms a review card with ONE tap and only
that tap writes; the owner runs the end-to-end write on staging, because
staging shares the production database). Builds on VTID-04837.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/index.ts — `mountRouterSync(app, '/api/v1/commerce/ai-setup', commerceAiSetupRouter, { owner: 'commerce-ai-setup' })`
FINAL_URL: GET /api/v1/commerce/ai-setup/status · POST /api/v1/commerce/ai-setup/draft · POST /api/v1/commerce/ai-setup/apply (all requireAuth; 404 AI_SETUP_DISABLED unless COMMERCE_AI_SETUP_ENABLED=true)
CURL_PROOF: after the staging deploy, STAGING-VERIFY runs docs/validation/VTID-04838/staging-tests.json — unauthenticated `curl -s -o /dev/null -w '%{http_code}' https://preview-aws-gateway.vitanaland.com/api/v1/commerce/ai-setup/status` and POSTs to /draft and /apply must answer 401 application/json (rejected probes; no write reaches staging). Not run from the authoring session: the routes are not deployed until this merges.

OASIS_PROOF: `commerce.ai_setup.applied` (vtid VTID-04838, source commerce-ai-setup) is emitted once per apply that created a business or added products, never on a replay — asserted in services/gateway/test/vtid-04838-commerce-ai-setup.test.ts ("creates the business…", "a double tap or retry creates nothing new").

## Acceptance criteria

AC-1: Signed-in only; off by default: draft and apply answer 404 AI_SETUP_DISABLED unless COMMERCE_AI_SETUP_ENABLED is exactly "true"; /status reports it for the portal; input (URL, category, price, setup key) is checked before anything is read or written; drafting is rate-limited per member.
  TEST: services/gateway/test/commerce-ai-setup.test.ts
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-2: Drafting reads the website through the SSRF-guarded fetch, uses a Shopify shop's public /products.json for exact titles, prices, links and images, and turns the page into readable text (no scripts, styles, comments).
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-3: The draft never invents a price, country or currency; unknown categories fall back to general_commerce; page text is passed to the model as data; the model call is the Bedrock-routed planner stage with a forced tool and the member's language.
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-4: Drafting writes nothing; an invalid URL, an unreachable site and a model outage are distinct errors.
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-5: Apply creates the business (owner = caller, org_admin membership), a hidden merchant and hidden draft products from the confirmed draft only, through the VTID-04837 services.
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-6: Apply is idempotent per setup key: a double tap or retry creates no second business and no duplicate products, and emits no second event.
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-7: Adding to an existing business is only for its org_admin; a locked (rejected/suspended) catalogue is refused before any write.
  TEST: services/gateway/test/vtid-04838-commerce-ai-setup.test.ts
AC-8: The new route file is claimed by the commerce domain in the developer atlas (role-separation drift guard).
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Scope

- New: `services/gateway/src/services/commerce-ai-setup.ts`, `services/gateway/src/routes/commerce-ai-setup.ts`, the Jest suite, this evidence pack and the staging suite.
- Changed: `services/gateway/src/index.ts` (mount), `services/gateway/src/orb/developer/domain-atlas.ts` (commerce domain claims the route).
- No migration, no schema change. Drafting uses the existing `planner` stage on Bedrock (CLAUDE.md 10a).
