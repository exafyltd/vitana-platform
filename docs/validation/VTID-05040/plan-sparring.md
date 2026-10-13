# Track S / S1 — gate the gateway debug routes (S-A + S-J)

- **Change class:** `expedited`. P1 live data exposure. On production, an anonymous
  `GET /api/v1/orb/debug/context-bootstrap?user_id=<any>&tenant_id=<any>` returns that member's memory
  items plus the **full** context instruction (`full_context_instruction`). It needs no token.
  The fix touches routes and auth, so it is not `light`. Expedited cap: 2 rounds.
- **Source:** `docs/MULTI-TENANT-PLAN.md` §3 (branch `claude/zealous-pasteur-i0czi8`), S-A and S-J (debug-route part only).
  All line numbers are from `origin/main` @ `c2c1adc3`.
- **Scope (exact files):**
  - PR-1 (hot file, ≤20 lines, own PR): `services/gateway/src/routes/orb-live.ts`,
    `services/gateway/test/routes/s1-debug-route-gates.test.ts` (new),
    `docs/validation/<VTID>/staging-tests.json` (new), `docs/validation/<VTID>/plan-sparring.md` (new)
  - PR-2: `services/gateway/src/routes/domain-routing.ts`, `services/gateway/src/routes/situational-awareness.ts`,
    `services/gateway/test/routes/situational-awareness.test.ts` (adds the auth mock so existing assertions send an admin identity, plus an anonymous-401 case), the same new test file, and `staging-tests.json`
    (adds probes)

<!-- plan:begin -->
## Problem (evidence)
Inventory of every `/debug`-style route in `services/gateway/src` (`git grep` over all `router|app.(get|post|…)` paths containing `debug`):

| # | Route | Where | Current gate | Exposure |
|---|---|---|---|---|
| 1 | GET /api/v1/orb/debug/context-bootstrap | orb-live.ts:15669 | **none** | **any user's memory items + full context instruction** (user_id/tenant_id from query, :15673-15674; response :15718-15730) |
| 2 | GET /api/v1/orb/debug/tts | orb-live.ts:15551 | **none** | anonymous caller triggers a Google Cloud TTS call. `ttsClient` is always constructed (orb-live.ts:2184-2186), so this is a cost and abuse vector and a Google call outside the sr/ru carve-out |
| 3 | GET /api/v1/orb/debug/brain-instruction | orb-live.ts:15305 | requireAuthWithTenant + self-or-admin on user_id (:15315) | `tenant_id` comes from the query unchecked (:15308). With `full=1` a member can render their own instruction under **another tenant's** context |
| 4 | GET /api/v1/orb/debug/awareness | orb-live.ts:15085 | optionalAuth; JWT gives self only; `?user_id` honoured only with `x-service-role-key` == service-role secret (:15096-15100, :15121) | an anonymous caller gets an empty fixed payload (:15160). No leak. Keep |
| 5 | GET /api/v1/orb/debug/memory | orb-live.ts:15356 | `isDevSandbox()` gives 404 | DEV_IDENTITY only. Keep |
| 6 | GET /api/v1/orb/debug/intent | orb-live.ts:15445 | `isDevSandbox()` gives 404 | keep |
| 7 | GET /api/v1/routing/debug | domain-routing.ts:239 | **none** | returns the cached routing input and bundle for any `session_id`, and lists `available_sessions` |
| 8 | GET /api/v1/situational/debug | situational-awareness.ts:416 | **none** | returns any `user_id`'s cached situation_vector and action_envelope, and lists user-id prefixes (:424) |
| 9 | GET /api/v1/voice-lab/debug/events | voice-lab.ts:1602 | requireVoiceLabDevAccess (router.use :538, exafy_admin or internal token) | keep |
| 10 | GET /api/v1/auth/me/debug | auth.ts:743 | requireAuth, self | keep |
| 11 | GET /api/v1/reminders/_format-time-debug | reminders.ts:465 | none (OPEN_PATHS :73) | pure formatter, no data. Keep |
| 12 | GET /debug/governance-ping, vtid-0524, vtid-0600-check, vtid-0538-routes, vtid-0529 | index.ts:607-689 | none | build and route diagnostics, env *presence* booleans, no member data. Keep (deferred, see Out of scope) |

`isDevSandbox()` (orb-memory-bridge.ts:163) reads `ENVIRONMENT || VITANA_ENV`. Staging pins `VITANA_ENV=staging`
(AWS-STAGE-DEPLOY-GATEWAY.yml:1148) and production uses `production`, so routes 5 and 6 return 404 in both.

**Consumers (checked so the fix does not break a legitimate caller):** nothing calls routes 1, 2, 7 or 8. There are no hits in
`command-hub/app.js`, `services/gateway/src/frontend`, `scripts`, `e2e`, `.github`, `services/agents`, or
vitana-v1. The only test is situational-awareness.test.ts:381-419 (route 8). The Command Hub calls only route 4
(app.js:49958, :50110, :50808, with exafy_admin `buildContextHeaders`), and that route is unchanged. The orb-agent calls
`/api/v1/orb/context-bootstrap` (orb-livekit.ts:981, optionalAuth, identity from the JWT only). That is a **different route**, which this fix does not touch.

## Fix per route
Existing pattern: `requireAuth` + `requireExafyAdmin` (auth-supabase-jwt.ts:384, :462), as in testing-catalog and admin routes.
Anonymous callers get 401 `UNAUTHENTICATED` and non-admin callers get 403. The routes are kept, not deleted, because the Voice LAB doc comment names #1 as an admin tool.
1. context-bootstrap: `router.get('/debug/context-bootstrap', requireAuth, requireExafyAdmin, …)`. The handler body is unchanged.
2. tts: **disabled** — the handler is replaced by `requireAuth, requireExafyAdmin` + an immediate `503 { ok:false, error:'DEBUG_ROUTE_DISABLED', reason:'Google Cloud TTS is decommissioned outside the sr/ru bridges' }`; no TTS client call remains in the handler (CLAUDE.md GCP rule; stricter option per IF-THEN 9). Auth stays in front so anonymous callers still get 401 and the probe stays meaningful.
3. brain-instruction: after the user scope check, add
   `if (tenantId !== identity?.tenant_id && !identity?.exafy_admin) return 403 FORBIDDEN_TENANT_SCOPE` (about 3 lines).
4–6, 9–12: no change.
7. routing/debug and 8. situational/debug: add `requireAuth, requireExafyAdmin` (import from `../middleware/auth-supabase-jwt`).
orb-live.ts import (:293-300): add `requireAuth, requireExafyAdmin`. The orb-live.ts diff is about 8 lines, within the ≤20 hot-file rule.

## Tests
- New `test/routes/s1-debug-route-gates.test.ts` (supertest). It follows the auth-mock pattern of `test/routes/testing-catalog.test.ts:16-26`
  (a mocked `requireAuth` sets `req.identity` or returns 401; a mocked `requireExafyAdmin` returns 403), and mounts the real `orb-live`,
  `domain-routing` and `situational-awareness` routers. It mocks `orb-memory-bridge`, `oasis-event-service`,
  `orb/live/session/session-context-builder` and `@google-cloud/text-to-speech` the way
  `test/orb-live-session-bootstrap-timeout.test.ts:24-36` does. Cases for routes 1, 2, 7 and 8: anonymous gets 401 JSON, a member gets 403, and an
  exafy_admin gets 200 (the builder is called only in the admin case); for tts, exafy_admin gets 503 `DEBUG_ROUTE_DISABLED` and the TTS mock is never called. For route 3: a member with another tenant_id gets 403 with exactly `error: 'FORBIDDEN_TENANT_SCOPE'` (same family as the existing `FORBIDDEN_USER_SCOPE` on that route), and the member's own tenant gets 200.
  For routes 5 and 6: `isDevSandbox()=false` gives 404.
- **Drift guard** (same file; routes whose auth comes from a `router.use(...)` on the same router — e.g. voice-lab's `requireVoiceLabDevAccess` at voice-lab.ts:538 — are recognised by scanning that router file for a `router.use` with an allowlisted middleware, and are additionally listed explicitly in the guard's allowlist with the reason): read every `src/routes/*.ts` and `src/index.ts` and find each `\.(get|post|put|patch|delete|all)\(['"][^'"]*debug`
  registration. Assert that each one is either gated (its line or handler contains `requireExafyAdmin|requireVoiceLabDevAccess|requireAuth|requireAuthWithTenant|isDevSandbox`)
  or on an explicit allowlist that gives the reason (routes 4, 11, 12). A new ungated debug route then fails CI.
- Update situational-awareness.test.ts:381-419: add the auth-middleware mock (same pattern as the new test file) so every existing assertion sends the mocked admin identity, and add one anonymous-gets-401 case.
- Mutation check: removing the middleware from route 1 must fail both the route test and the drift guard.
- `docs/validation/<VTID>/staging-tests.json` (read-only probes; anonymous GETs never reach a handler):
```json
{ "vtid": "VTID-05040", "service": "gateway", "tests": [
  { "kind": "http", "name": "context-bootstrap anon rejected", "path": "/api/v1/orb/debug/context-bootstrap?user_id=00000000-0000-0000-0000-000000000000", "expect_status": 401, "expect_json": { "error": "UNAUTHENTICATED" } },
  { "kind": "http", "name": "debug tts anon rejected", "path": "/api/v1/orb/debug/tts", "expect_status": 401, "expect_json": { "error": "UNAUTHENTICATED" } },
  { "kind": "http", "name": "brain-instruction anon rejected", "path": "/api/v1/orb/debug/brain-instruction", "expect_status": 401 },
  { "kind": "http", "name": "debug memory hidden off-sandbox", "path": "/api/v1/orb/debug/memory", "expect_status": 404 },
  { "kind": "http", "name": "debug intent hidden off-sandbox", "path": "/api/v1/orb/debug/intent?text=hi", "expect_status": 404 },
  { "kind": "http", "name": "routing debug anon rejected", "path": "/api/v1/routing/debug", "expect_status": 401 },
  { "kind": "http", "name": "situational debug anon rejected", "path": "/api/v1/situational/debug", "expect_status": 401 },
  { "kind": "existing", "ref": "npx jest test/routes/s1-debug-route-gates.test.ts test/routes/situational-awareness.test.ts", "cwd": "services/gateway",
    "reason": "admin-allowed / member-403 / tenant-scope paths need a JWT; proven in CI with mocked auth (mutation-checked), plus the drift guard" } ] }
```
Note: the brain-instruction probe only proves the pre-existing `requireAuthWithTenant` gate still holds; the new tenant-scope check is proven by the Jest suite (no JWT in read-only staging probes). PR-1 ships the first five probes and the jest ref. PR-2 adds the routing and situational probes.
The post-deploy production check is limited to the same anonymous GET of context-bootstrap returning 401 (read-only, no sign-in).

## Rollback
No migrations and no data changes. Revert the PR(s). On production, the AWS-PROD-DEPLOY-GATEWAY automatic rollback runs on a failed verify, or the previous image is re-PUBLISHed.
Rolling back reopens the exposure, so the preferred path is fix-forward.

## Risks
- An unknown external caller of routes 1, 2, 7 or 8 (none found in either repo) would start getting 401. Accepted: the routes are diagnostic.
- If `ENVIRONMENT` were ever set to a value containing `dev` on staging or prod, routes 5 and 6 would open (`includes('dev')`). The staging 404 probes pin this.
- Loading the full `orb-live` router in jest is heavy. If module side effects make it flaky, fall back to mounting only the handlers by
  exporting a small `debugRouteGuards` array. That decision is listed under "Decisions taken".
- The hot-file rule requires orb-live.ts to be rebased just before merge.

## Out of scope (tracked)
- The whole `situational-awareness` and `domain-routing` routers accept a caller-supplied `user_id` without auth on their non-debug
  routes (e.g. the compute body, situational-awareness.ts ~:118). That goes to a new Track S item via the WS0 route inventory (S-J follow-up).
- Root `index.ts` `/debug/vtid-*` diagnostics (hot file, no member data). Removing them goes to the WS0 inventory cleanup.
- The `/debug/awareness` service-role path uses `===` rather than a timing-safe compare. Admin `?user_id` with a JWT is ignored (a functional gap, not a leak).
- Non-private realtime channels (rest of S-J), and `/api/v1/orb/context-bootstrap` (orb-livekit, JWT-scoped).
<!-- plan:end -->

## Planner responses — round 1
- F1 ACCEPTED — tests assert exactly `error: 'FORBIDDEN_TENANT_SCOPE'`.
- F2 ACCEPTED — noted that the brain-instruction staging probe covers only the pre-existing gate; the new check is proven in Jest.
- F3 ACCEPTED — drift guard recognises `router.use`-level auth on the same router and lists those routes (voice-lab) explicitly with reasons.
- F4 ACCEPTED, option (a) — `/debug/tts` is disabled (503 `DEBUG_ROUTE_DISABLED` behind requireAuth+requireExafyAdmin, no Google call left in the handler); tests assert the TTS client is never called. Q1 answered.
- F5 ACKNOWLEDGED — already covered in Risks (staging 404 probes pin `isDevSandbox()` = false).
- F6 ACCEPTED — PR-2 scope names the auth-mock change in situational-awareness.test.ts.
- Q2: no current consumer was found for routes 1/7/8 (only the Voice LAB doc comment); per the Autonomy Contract's conservative rule (nothing deleted inside an approved plan) they are gated, not deleted; deletion can follow as a separate cleanup once a release confirms nobody needs them.

## Sparring verdict
Round 1: 1 major (F4) + 5 minor → all accepted/acknowledged. Round 2: all closed, no new findings. **Verdict: CONVERGED** (partner: plan-sparring-partner agent, 2 rounds).
Final plan-body hash: `136ab5ab1add28d86666fade481f3c41673e94045d44ce2d2bc3f6c92fcb4c0b`

## Record
- Plan hash (sha256 of the text between the plan markers, as recorded by the sparring gate): `136ab5ab1add28d86666fade481f3c41673e94045d44ce2d2bc3f6c92fcb4c0b`
- Partner: plan-sparring-partner, 2 rounds (expedited). Verdict: **CONVERGED**.

Owner approval (Gate 1): "Yes approved" — 2026-10-10, Claude Code session; plan hash 136ab5ab1add28d86666fade481f3c41673e94045d44ce2d2bc3f6c92fcb4c0b; sparring record 7d23ada4-a71a-4cb1-ac55-f01fbbaf0e7a.
