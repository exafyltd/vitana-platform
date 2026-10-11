# Gateway ledger read auth: plan for your approval

Verdict: ESCALATED after 3 of 3 sparring rounds (cap reached). The loop did not fully converge, so this is outside your pre-approval and comes back to you. Plan hash (revision 3, sha256 of the text between the plan markers): cc873442955182f743873f958ca461e745bc5720193fcacb7343b9e9d1019686

What you asked for has two layers. Layer 1, my own gateway calls carry the bearer token, is already in force through the standing gateway-auth rule. Layer 2, the gateway itself refusing anonymous reads, is this plan.

## Plan summary

- Add a read gate (new middleware ledger-read-auth.ts) that reuses the existing write-gate credential rule: GATEWAY_SERVICE_TOKEN bearer or an exafy_admin JWT. Anonymous or bad token gives 401, a valid non-admin JWT gives 403.
- Gate 13 Tier 1 route groups one by one (never at mount level): oasis tasks, oasis vtid-ledger, vtid list/projection/:vtid/allocator status, tasks, execution-status, the Command Hub board (cors first, then gate), and approvals pending/count. Health and build-info routes stay open.
- Mode switch LEDGER_READ_AUTH_MODE (log by default, enforce, off). Rollout: ship in log mode everywhere (step A, with all caller fixes), measure, enforce on staging (step B), soak, then enforce on production by an env-only dispatch (step D). Production rollback is the same dispatch set to log.
- Caller fixes so nothing breaks: Command Hub requests and the 401 interceptor guard, debug.html, gateway self-calls (explicit opt-in token, gatewayApiCall unchanged), the ORB task-state path, gemini-operator approvals calls, vtid-auto-close read, and vitana-v1 taskApi (stops polling on 401/403).
- Staging workflow size: the register step is about 19,967 of the 20,000 character cap, so the plan re-indents jq arrays (whitespace only) before adding the new entries.

Residual exposure (mandatory): this change closes anonymous reads of the VTID ledger rows via the 13 Tier 1 route groups. Until the Tier 2 follow-up ships, anonymous callers can still read VTIDs and task titles/statuses through the OASIS event reads, GET /api/v1/specs/:vtid and (VTIDs only) GET /api/v1/ops/health/vtid-ledger. The directive "every access must be authenticated" is NOT fully met until Tier 2 ships. Also note: the gateway service token is the Supabase service-role secret, so the read gate and any holder of the token carry that exposure.

## Sparring result

- Rounds run: 3 (cap 3).
- Closed: F1 to F19 (one blocker F1 and one blocker F16, majors F2 to F5, and the minors).
- Still open: F20 (major): STAGING-VERIFY runs the suite of every VTID between production and the verified commit, so an unpublished anonymous-200 probe would fail after step B and block Gate 2; the plan's section 2c states the opposite. Suggested fix: step A's staging-tests.json holds only health probes plus existing jest references, and step B merges only after step A and the VTID-04727 commit are in production. F21 (minor): a wrong line reference (app.js:125, not ~104).

## Scope (files expected to touch)

vitana-platform: new services/gateway/src/middleware/ledger-read-auth.ts; index.ts (one boot-line call); routes oasis-tasks, oasis-vtid-ledger, vtid, tasks, board-adapter, approvals; orb-tools vtid-lifecycle-tools and developer-tools, task-state-query-service, gemini-operator; Command Hub app.js and debug.html; scripts/ci/vtid-auto-close.cjs and its test; smoke/gateway.json (step B); AWS-STAGE-DEPLOY-GATEWAY.yml (the production workflow is not edited); conversation-flag-pins.generated.ts (step B); tests; CLAUDE.md, infrastructure rules, CHANGELOG and validation docs. vitana-v1 (separate PR): taskApi.ts, useTaskStream.ts, TasksView.tsx and a test. Not touched: ledger-write-auth.ts, gatewayApiCall, mount points, Tier 2 routes, mcp/vitana-work.

## Test plan

- Jest in services/gateway: mode resolution, enforce/log/off behaviour, wiring assertions (every Tier 1 registration gated, no router.use, health routes open, cors before gate), supertest per router, self-call header tests, log hygiene and boot line tests, a Command Hub static test with balanced-paren parsing, workflow wiring and the 20,000 character size test, then the full npx jest, npm run typecheck and npm run build.
- Root: node --test for vtid-auto-close and staging-verify lib. vitana-v1: npm run test:unit, build, lint.
- Staging after step B: STAGING-VERIFY asserts anonymous Tier 1 GETs return 401 (no token needed). Production: only health and build-info anonymous checks, plus one owner-run token read recorded in acceptance.md and the boot line mode=enforce service_token_configured=true.

## Decisions needed from you

- D1: confirm phased delivery (Tier 1 now, Tier 2 and write-side gaps as a committed phase 2).
- D2/D3: confirm reads are limited to the service token or exafy_admin JWTs (operators without the claim get 403).
- D9: open a VTID for the write-side gaps and the anonymous next_vtid call on GET /api/v1/vtid/health.
- Escalation: accept the F20 fix as written (recommended), or order one more sparring pass. Is the VTID-04727 commit already in production?

Production enforce (step D) is a manual dispatch outside the PUBLISH path and will need your explicit approval at that moment.

Do you approve this plan?
