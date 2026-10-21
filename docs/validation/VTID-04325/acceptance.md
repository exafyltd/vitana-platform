# VTID-04325 — default capability grants per role (Orchestrator plan §3.2, §8.2)

Owner decision, 2026-09-23: "You decide the default permissions for each role."

This change is shadow only. The policy engine is a pure module
(`services/orchestrator/policy.ts`) and is exposed read-only. No agent path
enforces it yet. Enforcement is switched on one path at a time, in later
VTIDs, after the defaults have been reviewed against real traffic.

## The defaults

Each domain has three possible sources of a ceiling. The effective ceiling is
the lowest one that applies:

1. **Role ceiling per domain.** A domain not listed for a role is `none`.

   | Role | Ceilings |
   |---|---|
   | community | community commit; health commit (own data) |
   | patient | community commit; health commit (own data) |
   | professional | community read; health read; professional draft |
   | staff | community read; staff draft |
   | backoffice | community read; backoffice read, or the ERP grant tier when one is supplied |
   | admin | community, professional and staff read; admin commit |
   | developer | community, admin and backoffice read; dev commit; ops read |
   | infra | dev read; ops commit |

2. **Channel ceiling.**
   - Voice is capped at draft.
   - Chat, web, system and ci are capped at commit.

3. **Commerce.** The ceiling comes only from the organisation role:
   - owner or admin: commit;
   - member: draft.

   The platform role grants nothing in commerce.

**High-risk actions** are never allowed directly:
- If the role ceiling reaches commit, the action escalates to maker-checker.
  A second person must approve, and approval is only possible over web.
- Otherwise the action is denied.

`exafy_admin` does not bypass any of this.

## Acceptance criteria

AC-1: Each role's ceilings match the defaults table above. An unknown or
missing role has no authority in any domain.
TEST: services/gateway/test/services/orchestrator/policy.test.ts

AC-2: Voice never commits. If the role allows the commit, the request
escalates to chat or web. Chat and web can commit. A request above the role
ceiling is denied on every channel.
TEST: services/gateway/test/services/orchestrator/policy.test.ts

AC-3: A high-risk action is never allowed directly. It escalates to
maker-checker when the role reaches commit, and is denied otherwise.
`exafy_admin` cannot bypass this.
TEST: services/gateway/test/services/orchestrator/policy.test.ts

AC-4: Commerce authority comes only from organisation membership. Backoffice
follows the ERP grant tier when one is supplied.
TEST: services/gateway/test/services/orchestrator/policy.test.ts

AC-5: `GET /api/v1/orchestrator/policy` behaves as follows:
- It requires sign-in.
- It returns the defaults (`enforced: false`), the caller's own ceilings for
  the requested channel, and an optional dry evaluation for `?domain=&tier=`.
- An unknown domain or tier returns 400.
- It writes nothing.
TEST: services/gateway/test/routes/orchestrator.test.ts

## Route evidence

ROUTE_MOUNT: `services/gateway/src/index.ts`. The existing mount
`mountRouterSync(app, '/api/v1/orchestrator', orchestratorRouter, { owner: 'orchestrator' })`
is unchanged; this change adds `GET /policy` to that router.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/orchestrator/policy`

CURL_PROOF: Before merge, the route is exercised in-process with supertest
(AC-5). After deploy, an unauthenticated `GET` on staging must return
`401 application/json`, never `404 text/html`. The result goes in
`outputs/staging-curl.txt`.

Staging deploys are currently blocked because the AWS account cannot place
ECS tasks. The curl will be run once that clears.
