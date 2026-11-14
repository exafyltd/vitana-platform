---
change_class: standard
---
# plan(gateway-write-route-auth): gate the SB-CON-22 gateway write routes with the existing auth middleware, and confirm every other unauthenticated write route
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repo `exafyltd/vitana-platform`.
Premises pinned to `origin/main` vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.
<!-- plan:begin -->
Pin: vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`. Every `file:line` below is checked against it. A lane
that starts on a newer `origin/main` re-verifies its citations there first and records both SHAs in `commands.log`.

## 1. Goal
Owner, 2026-11-11 ("Consolidated Execution Directive — Vitanaland", §3): *"The possible unauthenticated gateway write
routes are a security stop and must be investigated immediately. [...] Start the security plan through the established
intake, sparring, approval and VTID process."* The investigation must cover the auth architecture, middleware
registration, route mounting, handler dependencies and callers; inherited boundaries; required roles; that
caller-supplied role headers cannot establish privileged identity; tests for unauthenticated,
authenticated-but-unauthorised and authorised calls; a controlled read-only staging verification; and exact evidence.
*"Do not perform unauthorised live probing. Do not make production security changes without the required approval
and verification."*

Not authorised by this plan: production deploy or PUBLISH (owner-commanded only, collaboration.md §7c), live probing of
production, changes to tenant identity, membership, RLS, credentials, secrets or permissions, new auth middleware or a
new identity model.

## 2. Today (evidence, code read at the pin; live exposure not probed)
- Global middleware before the route mounts: CORS `services/gateway/src/index.ts:598`, SSE headers `:599`, compression
  `:603`, webhook body parsers `:614-632`, `express.json` `:635`, `delegatedTokenGuard()` `:640`. None authenticates;
  `delegatedTokenGuard` calls `next()` when no bearer token is present (`services/gateway/src/services/delegation-guard.ts:151-179`).
  No `app.use` on `/api/v1` adds auth. `mountRouterSync` (`services/gateway/src/governance/route-guard.ts:248`) only records
  the mount for duplicate detection.
- Mounts: specs `index.ts:832`, llm `:864`, triage `:885`, ai-personality `:1148`. None of the four route files has a
  `router.use`.
- Existing gates (reuse, do not add new ones): `requireServiceOrAdmin` (`services/gateway/src/middleware/require-service-or-admin.ts:71`,
  service token or `exafy_admin` JWT), `requireAdminOnly` (`:110`, `exafy_admin` JWT only), `getControlPlaneActor` (`:138`);
  `requireAuth` / `requireExafyAdmin` / `requireAdminAuth` in `services/gateway/src/middleware/auth-supabase-jwt.ts`.
  Already gated neighbours: `POST /api/v1/specs/:vtid/approve` (`routes/specs.ts:1182`, `requireServiceOrAdmin`);
  `routes/llm.ts:520` (`requireAdminAuth`, comment `:514-519` "real middleware, NOT the x-actor-role header").
- The SB-CON-22 routes:
  1. `PATCH /api/v1/specs/:vtid` (`routes/specs.ts:745`): no identity read; rewrites `oasis_specs.spec_markdown` and the
     ledger spec hash while the spec is draft, quality_failed or rejected. Caller: Command Hub `app.js:10054-10057`
     (already sends `buildContextHeaders`, `app.js:1218`).
  2. `POST /api/v1/agents/triage/investigate` (`routes/triage-agent.ts:168`): no identity read; builds an LLM prompt
     from caller text plus OASIS events of any `session_id` and spends LLM or Anthropic Managed Agents credit. Caller:
     `app.js:18512` (`buildContextHeaders`).
  3. `PUT /api/v1/ai-personality/:surface_key` (`routes/ai-personality.ts:69`) and 4. `POST .../:surface_key/reset`
     (`:120`): read `req.identity`, which nothing on this router sets (`:89-90`, falls back to `'command-hub-user'` /
     `'developer'`); they change the live assistant personality config for every user. Callers: `app.js:17974` and
     `:18009`, both with `{'Content-Type': 'application/json'}` only, no Authorization.
  5. `POST /api/v1/llm/routing-policy/reset` (`routes/llm.ts:236`): `x-actor-role` defaults to `'developer'`, an allowed
     role (`:243-255`), so an anonymous call passes. Sibling `POST /api/v1/llm/routing-policy` (`:165`, same header logic
     `:182-192`) writes an arbitrary policy. Callers: `app.js:30433` (`buildContextHeaders`), `app.js:28670-28674` (sends
     `x-actor-id` / `x-actor-role: developer`, no Authorization), and outside the Command Hub
     `services/openclaw-bridge/src/skills/vitana-llm-routing.ts:94,121` (`callGateway` `:57-63` sends no Authorization).
- Caller census at the pin (`grep -n -F` of each path over the repo and over vitana-v1 `e31bf4627f` `src apps supabase`;
  the lane re-runs it into `commands.log`): `app.js` has exactly one PATCH of `/api/v1/specs/:vtid` (`:10054`; `:9432`,
  `:9775`, `:9938` are GETs), one `/agents/triage/investigate` (`:18512`), one ai-personality PUT (`:17974`) and one
  reset (`:18009`) (`:17925` is the GET list), one routing-policy POST (`:28670`) and one reset (`:30433`) (`:16273`,
  `:28613`, `:30078` are GETs, unchanged). The only other caller in the repo is the openclaw-bridge skill above;
  vitana-v1 has 0 hits. `'x-actor-'` occurs once in `app.js` (`:28673`).
- The triage stream `GET /api/v1/agents/triage/:sessionId/stream` (`routes/triage-agent.ts:351`) is opened with
  `new EventSource(result.stream_url)` (`app.js:18550`); `EventSource` cannot send an Authorization header, so the
  stream cannot take a bearer gate without a design change.
- `x-actor-role` / `x-actor-id` are read only in `routes/llm.ts:182-183,243-244`. Other header-based identity was removed
  earlier (e.g. `routes/specs.ts:1168`, `routes/governance-controls.ts:32-33`).
- Upstream boundary: `scripts/deploy/deploy-service.sh:152,168,183,193` deploys Cloud Run services with
  `--allow-unauthenticated`; the repo holds no gateway ALB, WAF, CloudFront or API Gateway rule. Whether anything
  upstream blocks these paths in AWS is **Unknown**.
- A heuristic pass over `services/gateway/src/routes/*.ts` (write routes whose router has no auth `router.use`, with no
  auth-named inline middleware and no identity read in the handler) lists 123 routes in 45 files. It has known false
  positives (e.g. `routes/admin-tenants.ts:317` checks `verifyExafyAdmin` inside the handler) and misses (the
  ai-personality routes, which read an identity nothing sets). Examples that need a manual answer:
  `routes/worker-orchestrator.ts:223-1715` (11 routes incl. task claim `:1230`), `routes/operator.ts:1291,1343,1414`
  (`/deploy` takes its role from `x-operator-role`, `:147-151`; environment is `'dev'` only,
  `services/gateway/src/types/operator-command.ts:31`), `routes/dev-access.ts:314,441`, `routes/backoffice-commands.ts:78,172-173,200`,
  `routes/semantic-memory.ts:251,427,541`, `routes/tenant-specialists.ts:136-1058`, `routes/specs.ts:537,854`.
- Tests: jest in `services/gateway` (`npx jest test/<file>.test.ts`); route 401 pattern `test/ai-bridge.test.ts:78-82`;
  static Command Hub caller pattern `test/command-hub/vtid-05122-spec-approve-route.test.ts:34-55`. Staging proof uses
  rejected probes in `docs/validation/<VTID>/staging-tests.json` (format: `docs/validation/VTID-04527/staging-tests.json`;
  rule `.kiro/pipeline/lane-code.md:62-65`).

## 3. Interfaces between lanes
`route-auth` changes code: four route files, three Command Hub callers, two new test files. `write-route-inventory`
changes no code: one Markdown report and its evidence. The report lists `route-auth`'s seven routes as "in progress
(route-auth)" and every other route with a verdict. A route the report finds unauthenticated becomes a "proposed
follow-up" line (route, file:line, effect, proposed existing gate, callers) for a later sparred plan. The two lanes
share no file.

## 4. Lanes
### Lane `route-auth` (seat `exafy`, area platform)
Add the existing gates to the seven routes, before any body validation, so an unauthenticated call is rejected before
the handler runs:
- `PATCH /api/v1/specs/:vtid` → `requireServiceOrAdmin` (same as `:vtid/approve`, `specs.ts:1182`).
- `POST /api/v1/agents/triage/investigate` → `requireAdminOnly`.
- `PUT /api/v1/ai-personality/:surface_key`, `POST /api/v1/ai-personality/:surface_key/reset` → `requireAdminOnly`;
  audit `updated_by` / role from `getControlPlaneActor`, not from the never-set `req.identity`.
- `POST /api/v1/llm/routing-policy`, `POST /api/v1/llm/routing-policy/reset` → `requireServiceOrAdmin` (a service caller
  exists); remove the `x-actor-role` / `x-actor-id` reads and the role allow-list; actor from `getControlPlaneActor`.
- Command Hub: `app.js:17974`, `:18009`, `:28670-28674` send `buildContextHeaders(...)` and no `x-actor-*` header.
- openclaw-bridge `set_policy` / reset (`vitana-llm-routing.ts:94,121`) get 401 after this lane: they fail closed with
  the existing error path (`:64-67`). The lane does not give that service a token (credential change, owner-gated); it
  records this in the PR body and the inventory as a proposed follow-up. Its GET actions are unchanged.

Tests (red on the pin, green after):
- `services/gateway/test/gateway-write-route-auth.test.ts` (supertest, services mocked): for each of the seven routes,
  no token → 401; valid JWT without `exafy_admin` → 403; `exafy_admin` JWT → the handler runs (2xx with mocked
  service); for `PATCH /specs/:vtid` also the service token → handler runs; a request with only
  `x-actor-role: admin` → 401 (header cannot grant privilege). Asserts the mocked write function is never called on a
  401 or 403.
- `services/gateway/test/command-hub/gateway-write-route-auth-callers.test.ts` (static, VTID-05122 pattern): for each
  of the seven routes the number of write call sites in `app.js` equals the census above (1 each), and each call
  site's fetch init uses `buildContextHeaders(`; the routing-policy POST and reset call sites carry no `x-actor-`
  header; and `app.js` as a whole contains no `'x-actor-role'` / `'x-actor-id'` (the census shows the only occurrence is
  the header being removed).

Staging proof (`docs/validation/<VTID>/staging-tests.json`, rejected probes only, no token, nil-UUID or invalid keys,
staging only): seven `rejected_probe` entries expecting 401, plus the two jest files as `existing`. These run only
after this lane is on staging, so every probe is rejected before the handler runs.

Paths: `services/gateway/src/routes/specs.ts`, `services/gateway/src/routes/triage-agent.ts`,
`services/gateway/src/routes/ai-personality.ts`, `services/gateway/src/routes/llm.ts`,
`services/gateway/src/frontend/command-hub/app.js`, the two test files, `docs/validation/VTID-*/**`.

### Lane `write-route-inventory` (seat `exafy`, area platform)
`docs/programs/security/gateway-write-route-inventory.md`: every POST/PUT/PATCH/DELETE route of
`services/gateway/src/routes/*.ts` (and inline routes in `index.ts`) with mount path, gate (router-level, inline,
in-handler, signature or token check, none), identity source, effect (tables, external calls, cost), callers, and one
verdict: gated; gated in handler; public by design (named reason, e.g. signed webhook, beacon); unauthenticated and
needs a gate; Unknown. It also covers every GET route that returns data produced by one of the seven routes, starting
with the triage stream (`routes/triage-agent.ts:351`, `EventSource` caller `app.js:18550`), as a proposed follow-up with
severity and a gate design that works with `EventSource` (e.g. a short-lived stream token issued by the gated
`/investigate`); and the openclaw-bridge routing-policy writes that fail closed after `route-auth`. For "needs a gate": severity (critical / high / medium / low by effect), the existing gate to
use, and the callers that must change. The worker-orchestrator routes are cross-referenced with the autonomy risk
register of VTID-05686 (claim fail-open). The command that reproduces the heuristic list is in `commands.log`.

Paths: `docs/programs/security/gateway-write-route-inventory.md`, `docs/validation/VTID-*/**`.

## 5. Parallel / shared / hot files
Both lanes run in parallel; no shared file. `app.js` is a large shared file but not on the hot list
(collaboration.md §8a.4); `route-auth` edits only the three caller blocks. `route-auth` is a deploying lane (gateway).

## 6. Tests and commands
`cd services/gateway && npx jest test/gateway-write-route-auth.test.ts test/command-hub/gateway-write-route-auth-callers.test.ts`,
the existing tests of the touched routes (`npx jest test/command-hub/vtid-05122-spec-approve-route.test.ts` and any
`test/**/*{specs,llm,ai-personality,triage}*`), `npm run typecheck`, `npm run build`; preflight; `node --test
scripts/collab/*.test.mjs`.

## 7. Measurement
Seven routes: 401 without a token on staging (STAGING-VERIFY run id recorded). Inventory: every write route has a
verdict; count per verdict; list of "needs a gate" with severity.

## 8. Risks
- A legitimate caller without a token breaks. Mitigation: the census above lists every caller; the Command Hub callers
  are changed; the openclaw-bridge write actions fail closed by design until the owner approves a token for it.
- Cognito-authenticated admins cannot pass an `exafy_admin` gate today (`auth-supabase-jwt.ts:267`); unchanged, stated
  in the lane doc.
- Production stays unchanged until an owner-commanded PUBLISH; until then the routes stay open in production if they
  are open now. The owner is told this in the lane PR.

## 9. Unchanged
Auth middleware, JWT verification, service token, tenant resolution, RLS, migrations, flags, secrets, CLAUDE.md, the
plan-sparring gate mode, the triage stream route (`routes/triage-agent.ts:351`, a proposed follow-up of the inventory),
openclaw-bridge code and configuration.
<!-- plan:end -->
