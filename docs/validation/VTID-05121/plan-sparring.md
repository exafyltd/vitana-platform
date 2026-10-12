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
