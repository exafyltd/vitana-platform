# FU5 — Hand the member autopilot-prompts paths past the pipeline service-token gate

change class: standard (routes/auth)
scope: `services/gateway/src/routes/autopilot.ts` (gate exemption only), `services/gateway/src/routes/autopilot-prompts.ts` (optionalAuth + per-user express-rate-limit on the 3 write routes only), new `services/gateway/test/vtid-XXXXX-autopilot-prompts-not-behind-service-token.test.ts`, `docs/validation/<VTID>/{plan-sparring.md,staging-tests.json}`. No change to `index.ts`, `live.ts`, the service, the DB, or the frontend.

Evidence base: `origin/main` @ `5f0220d0c` (2026-10-12); staging probes 2026-10-12 22:09 UTC (unauthenticated GETs only).

<!-- plan:begin -->

## Problem

1. `services/gateway/src/index.ts:881` mounts `autopilotRouter` (`routes/autopilot.ts`) at `/api/v1/autopilot`. `index.ts:884` then mounts `autopilotPromptsRouter` (`routes/autopilot-prompts.ts`) at the same prefix, and `index.ts:887` mounts the recommendations router at `/api/v1/autopilot/recommendations`.
2. `routes/autopilot.ts:124-165` `requireServiceToken`, installed with `router.use(requireServiceToken)` at `:166`, runs for every request under `/api/v1/autopilot`. Its exemptions are:
   - `:133-141`: health only (`/health`, `/pipeline/health`, `/prompts/health`, `/recommendations/health`), handled with `next()`.
   - `:149-152`: `/recommendations` and `/recommendations/*`, handled with `next("router")` (VTID-04530).
   Every other path needs `Bearer $GATEWAY_SERVICE_TOKEN` or gets 401 `missing bearer token` / `invalid service token`.
3. The member endpoints in `routes/autopilot-prompts.ts` are `GET/POST /prefs` (`:168`, `:210`), `GET /prompts/today` (`:269`), `POST /prompts/generate` (`:312`) and `POST /prompts/:id/action` (`:379`). They authenticate the member themselves through `getUserContext` (`:91-144`): a Bearer JWT, then a user-scoped Supabase client, then `me_context`. The tenant comes from the verified identity or the primary `user_tenants` row, otherwise 400 (VTID-05048). Because the gate answers first, a member JWT is never accepted on any of these paths.
4. Staging confirms this:
   - `GET /api/v1/autopilot/prefs` returns 401 `{"error":"missing bearer token"}`.
   - `GET /api/v1/autopilot/prompts/today` returns 401 `{"error":"missing bearer token"}`. That is the pipeline gate's message, not the prompts router's `UNAUTHENTICATED`.
   - For comparison, `/api/v1/autopilot/recommendations/count` returns 401 `{"error":"UNAUTHENTICATED"}` (its own gate), and `/prompts/health` returns 200.
   - `docs/validation/VTID-05048/staging-tests.json` (the "autopilot prefs" entry) already records this: "routes/autopilot.ts … already answers 401 to any non-service caller here".
5. Who calls these paths today:
   - `vitana-v1` `src/` and `supabase/`: no caller of `/api/v1/autopilot/prefs` or `/prompts/*`.
   - Command Hub `app.js:28441`: only `/prompts/health`.
   - In-process use of the tables: `services/automation-handlers/connect-people.ts` and `automation-executor-repository.ts`, which do not go over HTTP.
   So the member HTTP surface has been unreachable since the gate landed (#2867, 2026-08-10) and nobody depends on it today. That is why the fix stays minimal and gets no frontend work.

## Fix

The fix has two parts.

**Part A: the gate exemption.** Use the same mechanism as VTID-04530. Add one exemption block to `requireServiceToken` in `routes/autopilot.ts`. It goes after the health block (`:133-141`) and before the `/recommendations` block (`:149-152`), so `/prompts/health` keeps its current path through `next()` (sparring F3):

```ts
// <VTID>: /prefs and /prompts/* belong to the member-facing autopilot-prompts
// router (mounted at the same prefix right after this one, index.ts:884),
// which verifies the member's own JWT on every path (getUserContext).
// Hand them to the router that owns them; never authenticate them here.
if (
  req.path === "/prefs" || req.path === "/prefs/" ||
  req.path === "/prompts" || req.path.startsWith("/prompts/")
) {
  next("router");
  return;
}
```

**Part B: per-user rate limits on the three write routes (sparring F2).** Use the existing VTID-04904 pattern in `routes/live.ts:57-112`:
- `express-rate-limit` (`services/gateway/package.json:59`) with `optionalAuth` run before the limiter (`middleware/auth-supabase-jwt.ts:433`).
- The key is the verified `identity.user_id`, else the first X-Forwarded-For hop, else `req.ip` (`liveRateLimitKey`, `live.ts:68-75`).
- `validate: { xForwardedForHeader: false }`, the JSON body `{ ok:false, error:'RATE_LIMIT_EXCEEDED' }`, and `standardHeaders`.

In `routes/autopilot-prompts.ts`:

```ts
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { optionalAuth } from '../middleware/auth-supabase-jwt';
// key = verified user, else first XFF hop, else req.ip (same as live.ts:68-75, VTID-04904)
function promptsRateLimitKey(req: Request): string { /* same 6 lines as liveRateLimitKey */ }
const limiterBase = { keyGenerator: promptsRateLimitKey, validate: { xForwardedForHeader: false } as const,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED' }, standardHeaders: true, legacyHeaders: false };
const prefsWriteLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60 * 1000, max: 30 });
const generateLimiter   = rateLimit({ ...limiterBase, windowMs: 15 * 60 * 1000, max: 10 });
const actionLimiter     = rateLimit({ ...limiterBase, windowMs: 15 * 60 * 1000, max: 60 });
router.post('/prefs', optionalAuth, prefsWriteLimiter, …);
router.post('/prompts/generate', optionalAuth, generateLimiter, …);
router.post('/prompts/:id/action', optionalAuth, actionLimiter, …);
```

- The key function is a local copy and is not imported from `live.ts`. Importing `live.ts` would run its module-level side effects (`new RoomSessionManager()` at `live.ts:114`) inside the prompts router. Copying six lines, with a comment citing VTID-04904, is the smaller and safer change, and `live.ts` stays untouched.
- `optionalAuth` only sets `req.identity` from a JWT it has verified. The handlers keep their own `getUserContext` gate. A forged token gets no user bucket and shares the IP bucket.
- The GET routes get no limiter. They are read-only.
- **Bounds that already exist** (defence in depth):
  - `generatePrompts` enforces the member's daily cap `max_prompts_per_day` (`services/autopilot-prompts-service.ts:372-373`) and quiet hours (`:380`).
  - The cap can be set to at most 50 (`types/autopilot-prompts.ts:31,41`).
  - Each generate call creates at most 10 prompts (`types/autopilot-prompts.ts:97`).
  - The per-request HTTP limiter is still needed, because a member can raise their own cap through `POST /prefs`.

**Matching rules**

- Match exactly. `/prefsX`, `/promptsX` and `/prompt/...` stay gated. Every pipeline path (`/tasks/*`, `/controller/*`, `/spec/*`, `/validation/*`, `/loop/*`, `/pipeline/summary`) stays service-token only. `autopilot.ts` defines no `/prefs` or `/prompts*` route, so `next("router")` skips nothing it owns.
- Use `next("router")` and not `next()`, so the rest of the pipeline router, including `checkDeprecatedBypass` and any later middleware, never runs for member traffic.
- `/prompts/health` is still answered by the earlier health block (`next()`), so its path is unchanged.
- Do not reorder the mounts in `index.ts`. Moving a central file (high churn, an "untested hotspot") is a larger change, and the VTID-04530 test asserts the current order.
- Leave member auth in `autopilot-prompts.ts` unchanged. It already 401s without a Bearer token and 400s without a tenant.

## Tests

1. **New jest test** `services/gateway/test/vtid-XXXXX-autopilot-prompts-not-behind-service-token.test.ts`. It copies the mocks and harness of `test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts`, mounts the real `autopilot.ts` router first and a stub router at `/api/v1/autopilot` second (production order), and covers these cases:
   - **Member JWT reaches the prompts router.** Each of `GET /prefs`, `POST /prefs`, `GET /prompts/today`, `POST /prompts/generate` and `POST /prompts/abc/action`, sent with `Authorization: Bearer member.jwt`, returns 200 from the stub with `reached:'prompts'` and the header passed through untouched.
   - **No token.** The request still reaches the stub. The prompts router makes the decision, not the pipeline gate.
   - **Gated paths still reject.**
     - `GET /tasks/pending-plan` with a member JWT returns 401 `invalid service token`.
     - `GET /controller/status` with no header returns 401 `missing bearer token`.
     - `POST /loop/start` with a member JWT returns 401.
   - **Trailing slash.** `GET /prefs/` with a member JWT also reaches the stub.
   - **Look-alike paths stay gated.** `/prefsX`, `/promptsX` and `/prompt/today`, each sent with a member JWT, return 401.
   - **Rate limits.**
     - Mock `verifyAndExtractIdentity` so `optionalAuth` sets `identity.user_id`.
     - The 11th `POST /prompts/generate` from user A within the window returns 429 `RATE_LIMIT_EXCEEDED`, while user B's first call still reaches the handler (per-user bucket).
     - The same check with smaller counts covers `/prompts/:id/action` (61st call) and `POST /prefs` (31st call).
     - `GET /prefs` and `GET /prompts/today` never return 429.
     - A forged token does not verify, gets no identity, and falls back to the IP or XFF bucket.
   - **Real router end to end.** Mount the actual `autopilot-prompts.ts` router after `autopilot.ts`, with `createUserSupabaseClient`, the repository and the service mocked the way `test/routes/autopilot-prompts.test.ts` does:
     - `GET /api/v1/autopilot/prefs` with a member JWT reaches `getPromptPrefs` and returns 200.
     - With no header it returns 401 `UNAUTHENTICATED`, which proves the request reached the member gate and not the service-token gate.
   - **Pins.**
     - `index.ts` still mounts `autopilotRouter` before `autopilotPromptsRouter`.
     - `autopilot-prompts.ts` still calls `getUserContext` in every non-health handler, so the hand-off opens nothing.
2. **Existing suites that must stay green:**
   - `test/routes/autopilot.test.ts`, including the VTID-03598 health-exemption block at `:777-810`
   - `test/vtid-04530-…`
   - `test/routes/autopilot-prompts.test.ts`
   - `test/vtid-05048-s4-caller-identity.test.ts`
   - `npm run test:operator`, because `routes/autopilot.ts` sits on the operator/autopilot path
   - `npm run test:roles`. No route file is added and `autopilot*` is already claimed by the `autopilot` atlas domain (`orb/developer/domain-atlas.ts:52`), so no atlas change is needed.
   - Gateway `tsc` / lint.
3. **Staging (`docs/validation/<VTID>/staging-tests.json`)**, all read-only GETs without auth, in the VTID-04530 format:
   ```json
   { "vtid": "<VTID>", "service": "gateway", "tests": [
     { "kind": "http", "name": "prefs answers from its own member gate, not the pipeline service-token gate", "path": "/api/v1/autopilot/prefs", "expect_status": 401, "expect_json": { "ok": false, "error": "UNAUTHENTICATED" } },
     { "kind": "http", "name": "today's prompts answer from their own member gate", "path": "/api/v1/autopilot/prompts/today", "expect_status": 401, "expect_json": { "ok": false, "error": "UNAUTHENTICATED" } },
     { "kind": "http", "name": "prompts health still up", "path": "/api/v1/autopilot/prompts/health", "expect_json": { "ok": true, "service": "autopilot-prompts" } },
     { "kind": "http", "name": "pipeline routes keep the service-token gate", "path": "/api/v1/autopilot/controller/status", "expect_status": 401, "expect_json": { "ok": false, "error": "missing bearer token" } },
     { "kind": "existing", "ref": "npx jest test/vtid-XXXXX-autopilot-prompts-not-behind-service-token.test.ts test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts test/routes/autopilot.test.ts test/routes/autopilot-prompts.test.ts", "cwd": "services/gateway", "reason": "member-JWT reachability and the pipeline gate matrix (writes are proven here, never on staging)" }
   ] }
   ```
   Before the fix the first two return `missing bearer token`; after it they return `UNAUTHENTICATED`. The VTID-05048 `/prefs` 401 probe stays valid, because the status is still 401 and the content type is still JSON.

## Rollout

Follow the standard pipeline: PR, CI (gateway jest, the operator and roles suites), merge, `AWS-STAGE-DEPLOY-GATEWAY.yml`, STAGING-VERIFY on the merge commit, then Gate 2. The production deploy is pinned to the verified commit and diffed against prod build-info. There is no migration, no env var and no flag. Rollback is a revert of the single block.

## Risks

- **Re-opens a dormant member surface.** It has been unreachable since 2026-08-10. That includes two write paths:
  - `/prompts/generate`, which creates prompts for the member.
  - `/prompts/:id/action` with `yes`, which creates a connection request, joins a group or RSVPs.
  Both act only as the JWT's own user, in the resolved tenant, through the user-scoped Supabase client. The VTID-05048 tenant hardening has already shipped. Mitigations:
  - the real-router jest case and the staging member-gate probes;
  - the per-user limiters (Part B);
  - the service's daily cap.
- **Prefix collision.** A future pipeline route under `/prefs` or `/prompts` would silently skip the service-token gate. The jest look-alike and pin cases document this, and the code comment names the owner.
- Limiter state is in memory per ECS task, the same as every existing `express-rate-limit` use, so the effective limit is max × task count. This is accepted as a backstop: the daily cap in the service is the durable bound.
- No frontend calls these paths today, so no user-visible behaviour changes on deploy. Any member traffic that appears afterwards is new.

## Out of scope

- Re-ordering the mounts in `index.ts`, or narrowing `autopilot.ts` to its own sub-prefixes (a structural fix for the whole class).
- Any frontend use of `/prefs` or `/prompts/*`.
- Removing the matchmaking-prompts HTTP surface.
- The rest of S-J: debug routes and realtime channels.

## Owner decisions

1. **Restore or retire.** This plan restores member access, which is the conservative option: one exemption block, a proven pattern, nothing deleted. The alternative is to retire the five member endpoints, since no frontend has called them since August. Recommended: restore now. Retiring them would be a separate VTID if the owner wants it.

<!-- plan:end -->

## Planner responses — round 1

- **F1 [minor] line numbers: partly accepted.** Re-checked with `git grep -n` on `origin/main` 5f0220d0c.
  - These hold: `index.ts:881,884,887`; `autopilot.ts:124` (`requireServiceToken`), `:134` (health block), `:149` (`/recommendations`), `:166` (`router.use`); `autopilot-prompts.ts:168,210,269,312,379,434`. They are rejected as findings, because the partner read a stale checkout.
  - One number was wrong: the `getUserContext` range. It is `autopilot-prompts.ts:91-144`, not `:62-121`. Corrected in the plan.
- **F2 [major] dormant write routes with no HTTP rate limit: accepted.** The gateway already has a limiter pattern: `express-rate-limit` (`package.json:59`) with `optionalAuth` and a key built from the verified user, else XFF, else IP (`routes/live.ts:57-112`, VTID-04904; also used in `me-phone.ts:31`). The plan now applies it to `POST /prefs` (30 per 15 min), `POST /prompts/generate` (10 per 15 min) and `POST /prompts/:id/action` (60 per 15 min), with jest cases. The GET routes are not limited. The key function is copied rather than imported, so the prompts router does not pull in `live.ts`'s module side effects (`live.ts:114`). The existing service bounds are cited as defence in depth.
- **F3 [minor] exemption placement: accepted, option (a).** The block now sits after the health block (`:133-141`) and before `/recommendations`, so `/prompts/health` keeps its `next()` path.
- **F4 [minor] trailing slash: accepted.** The block also matches `"/prefs/"`, with a jest case.
- **F5 [minor] `expect_json`: accepted.** The staging probes now assert `{ "ok": false, "error": ... }`. The runner already matches per key as a subset (`scripts/ci/staging-verify/lib.cjs:352-353`), so this is stricter, not required.

## Owner approval (Gate 1)
Approved by owner in Claude Code session https://claude.ai/code/session_01TMPMNGNEtPxKwmVqyfdx46 on 2026-10-12 ("Yes"), including the recommended option for every owner decision and the production steps named in the plan. Verdict: CONVERGED (2 rounds).

## Record
- VTID: VTID-05121 (allocated after owner approval; `<VTID>` / `vtid-XXXXX` in the plan text above are VTID-05121).
- Plan hash (sha256 of the text between the plan markers): `b345adc7e7dd8bc0f52dba65c56f8aff6c7849bcdfce58bf3d1f23c986055437`
- Partner: plan-sparring-partner, 2 rounds. Round-1 findings F1–F5 answered above; round 2 closed them. Verdict: **CONVERGED**.

Owner approval (Gate 1): "Yes" — 2026-10-12, Claude Code session; plan hash b345adc7e7dd8bc0f52dba65c56f8aff6c7849bcdfce58bf3d1f23c986055437; sparring record 30502099-d45a-4f23-99e9-2ef46ef6cdb5.

## Sparring partner findings (verbatim, round 1 then round 2)

The generate endpoint already has its own rate limits. Good. I have enough evidence for a thorough review.

## Verified premises

- **"index.ts:881 mounts autopilotRouter, :884 mounts autopilotPromptsRouter, :887 mounts recommendations"** --> PARTIAL -- The structure and order are correct but the line numbers are wrong. Actual: `index.ts:871` (autopilotRouter), `:874` (autopilotPromptsRouter), `:877` (recommendations). `/home/user/vitana-platform/services/gateway/src/index.ts:871-877`

- **"routes/autopilot.ts:124-165 requireServiceToken with exemptions at :133-141 (health) and :149-152 (recommendations), router.use at :166"** --> TRUE -- All line numbers match exactly. `/home/user/vitana-platform/services/gateway/src/routes/autopilot.ts:124-166`

- **"autopilot-prompts.ts member endpoints: GET /prefs (:168), POST /prefs (:210), GET /prompts/today (:269), POST /prompts/generate (:312), POST /prompts/:id/action (:379), each calling getUserContext"** --> TRUE -- All routes and line numbers match. Every handler calls `getUserContext()` which returns `UNAUTHENTICATED` without a bearer token. `/home/user/vitana-platform/services/gateway/src/routes/autopilot-prompts.ts:168-423`

- **"getUserContext at :62-121"** --> PARTIAL -- `getUserContext` is at lines 91-141, not 62-121. Lines 64-80 are `resolveFallbackTenant`, a different function. `/home/user/vitana-platform/services/gateway/src/routes/autopilot-prompts.ts:91`

- **"autopilot.ts defines no /prefs or /prompts* route"** --> TRUE -- grep of all `router.(get|post|...)` calls in autopilot.ts shows only `/tasks/*`, `/controller/*`, `/spec/*`, `/validation/*`, `/loop/*`, `/health`, `/pipeline/*` paths. No `/prefs` or `/prompts` anywhere. `/home/user/vitana-platform/services/gateway/src/routes/autopilot.ts`

- **"No frontend caller of /api/v1/autopilot/prefs or /prompts/*"** --> TRUE -- `vitana-v1/src` has zero matches; `app.js` only references `/prompts/health`. `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/app.js:28196`

## Findings

F1 [minor] Plan cites wrong line numbers for index.ts mounts (881/884/887 vs actual 871/874/877) and wrong range for getUserContext (62-121 vs actual 91-141).
Evidence: `/home/user/vitana-platform/services/gateway/src/index.ts:871-877`, `/home/user/vitana-platform/services/gateway/src/routes/autopilot-prompts.ts:91`
Suggestion: Correct to `:871`, `:874`, `:877` and `:91-141`. Not a design issue, just accuracy for the audit trail.

F2 [major] Re-opening dormant write surface without rate limiting at the HTTP layer. The plan acknowledges `/prompts/generate` and `/prompts/:id/action` as write paths (the action handler can create connection requests, join groups, RSVP). While `/prompts/generate` documents its own internal rate limits (line 296), there is no Express-level rate limiter on these routes. Since the service-token gate has been the only defense since August 2026, removing it exposes these endpoints to unauthenticated brute-force or replay attacks using a stolen JWT. The plan's "Out of scope" section explicitly defers rate limiting, but the plan's own "Risks" section acknowledges these are write paths that have been unreachable for two months.
Evidence: `/home/user/vitana-platform/services/gateway/src/routes/autopilot-prompts.ts:312` (generate), `:379` (action). No `rateLimit` middleware on the router itself. `executeYesAction` at `/home/user/vitana-platform/services/gateway/src/services/autopilot-prompts-service.ts:720-722` creates real community actions (connection requests, group joins, RSVPs).
Suggestion: Either (a) add a per-user Express rate limiter on the `autopilot-prompts` router in this same PR (matching existing patterns elsewhere in the gateway), or (b) explicitly document in the plan that `/prompts/generate`'s internal rate limit is sufficient for that endpoint and that `/prompts/:id/action` is bounded by the finite number of prompts a user has (each prompt can only be actioned once, state transitions to `accepted`/`dismissed`). If (b), state why that is acceptable and note it as a follow-up, not "out of scope" -- a dormant surface being restored is the right moment to add the limiter, not later.

F3 [minor] The `next("router")` for the health path `/prompts/health` creates a subtle behavioral change the plan acknowledges but underestimates. Currently (line 136) `/prompts/health` is exempted with `next()`, meaning it falls through to the rest of `autopilot.ts`'s middleware stack (including `checkDeprecatedBypass`). After the fix, the new block catches `/prompts/health` first (since `req.path.startsWith("/prompts/")` matches it) and calls `next("router")`, skipping the autopilot.ts router entirely. The plan says "Keep the existing :136 line, which costs nothing" -- but the new block at lines before :136 will match first, making the :136 line dead code rather than harmless. The behavior change is benign (health endpoints should not go through deprecation checks), but the plan should be explicit that this IS a behavior change for `/prompts/health`, not a no-op.
Evidence: The proposed `req.path.startsWith("/prompts/")` matches `/prompts/health`. The existing line 136 (`req.path === "/prompts/health"`) in the health block at lines 133-141 calls `next()` (falls through to the rest of autopilot.ts). With the new block inserted before the token check, the new block's `next("router")` fires first.
Suggestion: Either (a) place the new exemption block AFTER the existing health check (between line 141 and 149), so `/prompts/health` still hits the existing `next()` path, or (b) explicitly document that `/prompts/health` now takes the `next("router")` path instead and that this is intentional and harmless (it reaches the same handler either way because the prompts router defines it).

F4 [minor] The plan proposes `req.path === "/prefs"` but does not account for trailing slashes. Express normalizes some but not all cases. A request to `/api/v1/autopilot/prefs/` would have `req.path === "/prefs/"` and would NOT match the exemption, falling through to the service-token check and returning 401. The VTID-04530 recommendations block handles this by matching both exact and prefix (`req.path.startsWith("/recommendations/")`), which inherently handles trailing slashes. The `/prefs` case has no prefix variant.
Evidence: Line 149: `req.path === "/recommendations" || req.path.startsWith("/recommendations/")` handles trailing slash. Proposed: `req.path === "/prefs"` does not.
Suggestion: Add `|| req.path === "/prefs/"` to the condition, or note in the test that trailing-slash requests are intentionally gated (since no sub-paths of `/prefs` exist).

F5 [minor] The staging test expects `{"error": "UNAUTHENTICATED"}` but the actual `getUserContext` response shape is `{"ok": false, "error": "UNAUTHENTICATED"}` (line 100 returns `{ ok: false, error: 'UNAUTHENTICATED' }`, and the handler at line 168-190 returns `res.status(context.status || 401).json({ ok: false, error: context.error || 'UNAUTHENTICATED' })`). The staging test's `expect_json` of `{"error": "UNAUTHENTICATED"}` would need to be a subset match, not an exact match. Verify that the STAGING-VERIFY runner uses subset/partial matching, or add `"ok": false` to the expected JSON.
Evidence: `/home/user/vitana-platform/services/gateway/src/routes/autopilot-prompts.ts:171-175` always wraps with `ok: false`.
Suggestion: Update `expect_json` to `{"ok": false, "error": "UNAUTHENTICATED"}` or confirm the runner does subset matching and document that.

## Questions for the planner

1. On F2: Is the internal rate-limit logic in `generatePromptsFromMatches` (the function `/prompts/generate` calls) sufficient to prevent abuse, or should a per-IP / per-user Express-level limiter be added in this PR given you are restoring a dormant surface? What about `/prompts/:id/action` -- is the finite-prompt-set argument (each prompt can only be actioned once) considered sufficient?

2. On F3: Do you prefer placing the new exemption block AFTER the health check block (between current lines 141 and 149) to preserve the existing `/prompts/health` routing path, or are you comfortable with the behavior change where `/prompts/health` now routes via `next("router")` instead of `next()`?

## Verdict

NOT CONVERGED -- F2 is major: restoring two months of dormant write endpoints (one of which creates connection requests and group joins on behalf of the authenticated user) without addressing rate limiting at the HTTP layer needs an explicit decision, not a deferred "out of scope" note.
Everything checks out. I have verified all the new claims in the revised plan. Here is my round-2 assessment.

## Verified premises
- **index.ts:881,884,887 mount autopilotRouter, autopilotPromptsRouter, recommendations** --> TRUE -- confirmed on the current checkout at `/home/user/vitana-platform/services/gateway/src/index.ts:881-887`. My round-1 checkout was stale.
- **express-rate-limit at package.json:59, optionalAuth at auth-supabase-jwt.ts:433, liveRateLimitKey at live.ts:68-75** --> TRUE -- all three exist at the cited lines.
- **RoomSessionManager side effect at live.ts:114** --> TRUE -- `const sessionManager = new RoomSessionManager()` runs at module scope, confirming the copy-not-import rationale.
- **Service-level daily cap max 50 (types:31), per-request limit max 10 (types:97)** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/types/autopilot-prompts.ts:31,97`.

## Findings — round 1 disposition

- **F1 [minor] line numbers** --> `closed` -- the planner is correct; my checkout was stale. The one genuine error (getUserContext range) was fixed.
- **F2 [major] dormant write surface with no HTTP rate limit** --> `closed` -- Part B adds per-user `express-rate-limit` on all three write routes, following the proven VTID-04904 pattern in `live.ts`. The bounds are reasonable (10/15min for generate, 60/15min for action, 30/15min for prefs write), the key function avoids importing `live.ts`'s side effects, and the existing service-level daily cap is correctly cited as defence in depth.
- **F3 [minor] /prompts/health path change** --> `closed` -- the new block is now placed after the health block, so `/prompts/health` keeps its existing `next()` path.
- **F4 [minor] trailing slash** --> `closed` -- the condition now includes `"/prefs/"` and the test covers it.
- **F5 [minor] expect_json shape** --> `closed` -- staging probes now assert `{ "ok": false, "error": ... }`.

## Findings — round 2

No new blocker or major findings. The revised plan is clean.

One observation (not a finding): the plan notes the in-memory limiter state is per-ECS-task and the effective limit is `max x task_count`. This is an accepted, documented trade-off consistent with every other `express-rate-limit` use in the gateway. No action needed.

## Questions for the planner

None.

## Verdict

CONVERGED -- all five round-1 findings are closed. The revised plan adds rate limiting (Part B) using the proven VTID-04904 pattern, correctly places the exemption block to preserve the `/prompts/health` path, handles trailing slashes, and fixes the staging test assertions. No new blocker or major introduced.
