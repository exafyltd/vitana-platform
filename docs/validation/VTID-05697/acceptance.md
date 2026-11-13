# VTID-05697 acceptance: gateway write routes require the existing control-plane gates (SB-CON-22)

Plan `gateway-write-route-auth`, lane `route-auth`. Pin `origin/main` vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.

Change types: Backend, UI, Tooling/docs.

Route count: the plan text says "seven routes"; the routes it lists are six (the five of SB-CON-22 plus the sibling
`POST /api/v1/llm/routing-policy`). This lane gates those six. Seven was a miscount in the plan, not a missing route.

| Route | Gate (existing) | Before (pin) |
|---|---|---|
| `PATCH /api/v1/specs/:vtid` | `requireServiceOrAdmin` | none (`routes/specs.ts:745`) |
| `POST /api/v1/agents/triage/investigate` | `requireAdminOnly` | none (`routes/triage-agent.ts:168`) |
| `PUT /api/v1/ai-personality/:surface_key` | `requireAdminOnly` | none; read a never-set `req.identity` (`routes/ai-personality.ts:69,89-90`) |
| `POST /api/v1/ai-personality/:surface_key/reset` | `requireAdminOnly` | none (`:120`) |
| `POST /api/v1/llm/routing-policy` | `requireServiceOrAdmin` | `x-actor-role`, default `developer` allowed (`routes/llm.ts:165,182-192`) |
| `POST /api/v1/llm/routing-policy/reset` | `requireServiceOrAdmin` | same (`:236,243-255`) |

AC-1 No token, an invalid token, or `x-actor-role: admin` without a token → 401 on all six routes; no write function (for triage: no LLM router call) and no outbound fetch runs.
TEST: services/gateway/test/gateway-write-route-auth.test.ts ("rejects a request with no token (401) and writes nothing", "rejects x-actor-role: admin without a token (401): a caller header cannot grant privilege", "rejects a token that is neither the service token nor a valid JWT (401)")

AC-2 A signed-in user without `exafy_admin` → 403 on all six routes, also when it sends `x-actor-role: admin`; nothing is written.
TEST: services/gateway/test/gateway-write-route-auth.test.ts ("rejects a signed-in user without exafy_admin (403) and writes nothing", "rejects a signed-in non-admin who also sends x-actor-role: admin (403)")

AC-3 An `exafy_admin` JWT reaches the handler on all six; the service token reaches the three `requireServiceOrAdmin` routes and is refused (401) on the three admin-only routes.
TEST: services/gateway/test/gateway-write-route-auth.test.ts ("lets an exafy_admin JWT reach the handler", "lets the service token reach the handler", "rejects the service token (admin only)", "the handlers ran for an admin: …")

AC-4 Audit actor comes from the gate, never from `x-actor-*` (sparring R2-F1), on all four audited handlers (ai-personality PUT and reset, routing-policy POST and reset): admin JWT → (`<user_id>`, `exafy_admin`); admin JWT with an empty user id → (`unknown`, `exafy_admin`); service token → (`internal`, `service`).
TEST: services/gateway/test/gateway-write-route-auth.test.ts ("audit actor comes from the gate: …")

AC-5 Command Hub: exactly one write call site per route in `app.js`, matched by path pattern and HTTP method (so another write caller of the same route written differently is counted), each building headers with `buildContextHeaders(`; no `x-actor-id` / `x-actor-role` anywhere in `app.js`.
TEST: services/gateway/test/command-hub/gateway-write-route-auth-callers.test.ts

AC-6 Red on base, green after: 42 of 58 fail with the five source files of the pin, 58 of 58 pass with the change.
TEST: docs/validation/VTID-05697/outputs/jest-red-on-base.txt, docs/validation/VTID-05697/outputs/jest-green.txt

AC-7 No regression: 127 existing gateway suites that touch these routes or `app.js` pass (2293 tests); the gateway typechecks and builds.
TEST: docs/validation/VTID-05697/outputs/tsc-gateway.txt, docs/validation/VTID-05697/outputs/build.txt; commands.log

## Callers (census, outputs/caller-census.txt)
- Command Hub write call sites: `app.js:10054`, `:18512`, `:17974`, `:18009`, `:28670`, `:30433`. The other hits are GETs and stay as they are.
- vitana-v1: 0 hits.
- `services/openclaw-bridge/src/skills/vitana-llm-routing.ts:94,121` posts to `/routing-policy` and `/routing-policy/reset` with no Authorization (`:57-63`). Its `update_policy` body does not match `UpdatePolicySchema`, so it already got 400 on the pin; `reset_policy` is the one that loses a working, unauthenticated path. After this lane both actions get 401 and fail closed through the existing error path (`:64-67`). Giving that service a token is a credential change for the owner; proposed follow-up, recorded by lane `write-route-inventory` (VTID-05698). Its GET actions are unchanged.

## Unchanged
Auth middleware, JWT verification, service token, `index.ts`, tenant resolution, RLS, migrations, flags, secrets; the triage stream `GET /:sessionId/stream` (`routes/triage-agent.ts:351`, opened with `EventSource` at `app.js:18550`, which cannot send a bearer; follow-up in VTID-05698).

## Not yet observed
- STAGING-VERIFY on a staging gateway that runs this commit (`staging-tests.json`: five rejected probes expecting 401; the routing-policy reset has no probe, see its `reason`).
- Production: unchanged until an owner-commanded PUBLISH. If these routes are reachable in production today, they stay reachable until then.
- Cognito-authenticated admins cannot pass an `exafy_admin` gate (`middleware/auth-supabase-jwt.ts:267`, known gap, unchanged).

## Route mount evidence (Validator Check)
No route is added: the six routes and their mounts exist on `main`; the change inserts a middleware into existing
registrations, which the route-evidence gate reads as a changed registration line.
ROUTE_MOUNT: unchanged — `services/gateway/src/index.ts:832` (`/api/v1/specs`), `:864` (`/api/v1/llm`), `:885` (`/api/v1/agents/triage`), `:1148` (`/api/v1/ai-personality`)
FINAL_URL: `PATCH /api/v1/specs/:vtid`, `POST /api/v1/agents/triage/investigate`, `PUT /api/v1/ai-personality/:surface_key`, `POST /api/v1/ai-personality/:surface_key/reset`, `POST /api/v1/llm/routing-policy`, `POST /api/v1/llm/routing-policy/reset` (paths unchanged)
CURL_PROOF: not run. No live or staging request was made; the staging proof is the rejected probes of `staging-tests.json`, run by STAGING-VERIFY after a staging deploy, and is recorded here only when it has a run id.
