# VTID-05122 — plan sparring record (FU6: Command Hub spec-approve calls)

Sparring record: `1cc5ea35-3b7c-4a65-a7a7-dd473d322e6f` · change class: standard · 2 rounds · verdict CONVERGED.
The plan below is copied verbatim from the sparred plan file; `VTID-XXXXX` placeholders were filled in at implementation time as VTID-05122.

# FU6 — Command Hub spec-approve calls: dead path + dead x-user-* headers

change class: standard (frontend-only bug fix, Command Hub app.js + index.html cache-bust + ownership-guard allowlist; no backend, no migration)
scope: services/gateway/src/frontend/command-hub/app.js (2 call sites), services/gateway/src/frontend/command-hub/index.html (?v= bump), scripts/ci/command-hub-ownership-guard.js (allowlist the new VTID), new test services/gateway/test/command-hub/vtid-XXXXX-spec-approve-route.test.ts, new docs/validation/VTID-XXXXX/staging-tests.json (+ plan-sparring.md)

<!-- plan:begin -->

## Problem

Verified read-only against origin/main @ 5f0220d0c (2026-10-12).

The real route is `POST /api/v1/specs/:vtid/approve`. It is defined at
`services/gateway/src/routes/specs.ts:1182` and mounted at `services/gateway/src/index.ts:798`
(`mountRouterSync(app, '/api/v1/specs', specsRouter)`).
- Auth: `requireServiceOrAdmin` (`middleware/require-service-or-admin.ts`). It accepts `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`
  or a Bearer JWT with `exafy_admin === true`. A request with no bearer gets `401 {"ok":false,"error":"missing bearer token"}` (JSON).
  A JWT without exafy_admin gets 403.
- Payload: no body needed. The VTID comes from the path. The approver comes from the JWT via `resolveSpecApprover()`
  (specs.ts ~1172, VTID-05048 / Track S S4-B, commit 76fe61083). `approved_by` in the body is read only for service callers.
  `x-user-id`/`x-user-role` are not read anywhere.
- Accepts `spec_status` `quality_checked`, or `validated` (legacy bypass, emits `vtid.spec.approval.legacy_bypass`). Any other status returns 409.
- No route matches `POST /api/v1/specs/approve`. The specs router only has `/:vtid/generate|validate|quality-check|approve` and `GET /:vtid`.
  That request falls through to Express's default 404, which is text/html (the gateway has no JSON 404 handler; see docs/validation/VTID-05098/staging-tests.json).

Call site A is a dead path: `app.js:46297`, in `renderSelfHealingView()` (starts at 46011).
- Trigger: Self-Healing view, Zone 2 "Active Repairs", **APPROVE** button. It appears when `task.spec_status === 'validated'`.
  The tasks come from `GET /api/v1/self-healing/active` (vtid_ledger rows: vtid, spec_status, …), loaded via `fetchSelfHealingData()` at app.js:40662.
- It calls `fetch('/api/v1/specs/approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({vtid}) })`.
  The route does not exist, and the request also sends **no Authorization header**. The auth interceptor at app.js:59
  (`installAuthFetchInterceptor`) only re-signs a request that already carries Authorization, and only on a 401.
- The `.then()` callback never inspects the response. It unconditionally calls `showToast('Spec approved for ' + task.vtid, 'success')`, so a 404 (or a 401/403) still produces the success toast. There is no `.catch`, so a network error is swallowed too. This is a silent failure, which breaks NEVER rule 19.
- The self-healing `POST /api/v1/self-healing/approve` (self-healing.ts:891, requireAdminOnly) is NOT the right target here.
  It takes a `self_healing_log` UUID `{id}` and is already used correctly by Zone 1 "Awaiting Approval" (app.js:46183).
  Zone 2 rows are ledger rows with no log id.

Call site B has dead identity headers: `app.js:10352`, in `renderTaskDrawer()` (starts at 9810).
- Trigger: the Task drawer spec pipeline, the **Approve Spec / Approve (Legacy)** button (visible when spec_status is `quality_checked` or `validated`).
- The path is already correct (`'/api/v1/specs/' + vtid + '/approve'`). It already uses `buildContextHeaders()` (app.js:1686), which adds `Authorization: Bearer state.authToken`.
- It still computes `userId`/`userRole` from `state.meContext` and sends `'x-user-id'`/`'x-user-role'` (app.js:10350-10357).
  These are the only `x-user-*` occurrences left in app.js, and the gateway ignores them since VTID-05048.

Archaeology: the local clone is shallow (603 commits). In it, `git log -S"/api/v1/specs/approve"` and `-S"'x-user-id': userId"` both bottom out at
cbfee44fe (VTID-04052, the shallow boundary), so both predate the visible history. The route moved to `/:vtid/approve` long ago (VTID-01188),
and only the Zone 2 button was never updated. The x-user-* headers became dead with 76fe61083 (VTID-05048, Track S S4-B).

## Fix

The smallest change. No backend change.

1. **Call site A (app.js ~46297).** Replace the fetch with:
   `fetch('/api/v1/specs/' + encodeURIComponent(task.vtid) + '/approve', { method: 'POST', headers: buildContextHeaders({ 'Content-Type': 'application/json' }), body: '{}' })`.
   - Check the result. The shape is pinned by the test regex:
     `.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (r.ok && j && j.ok) { …refresh…; showToast('Spec approved for ' + task.vtid, 'success'); } else { …re-enable…; showToast('Approve failed: ' + (j.message || j.error || 'HTTP ' + r.status), 'error'); } }); })`,
     followed by `.catch(function (err) { …re-enable…; showToast('Approve failed: ' + err.message, 'error'); })`. Use ES5 `function`, which matches the surrounding code.
   - Disable the button while the request runs and re-enable it on failure. This mirrors call site B and the Zone 1 pattern at app.js:46176-46199.
   - Keep the refresh (`state.selfHealing.fetched = false; fetchSelfHealingData();`) on both outcomes.
   - Keep the button gated on `spec_status === 'validated'`. The route's legacy bypass accepts exactly that status, so no gate change is needed.
2. **Call site B (app.js ~10346-10358).** Delete the `userId`/`userRole` locals and the two `x-user-*` header entries.
   The headers become `buildContextHeaders({ 'Content-Type': 'application/json' })`. Nothing else in that handler changes.
   Removing the locals adds no new zero-caller function, so the T2 guard is unaffected.
3. **Cache-bust.** In `index.html:28`, bump `app.js?v=20261117-vtid-05098` to a new unique value, e.g. `?v=<yyyymmdd>-vtid-XXXXX`.
   That is required by CLAUDE.md IF-THEN 25. If styles.css is untouched, leave its ?v=; other ?v= params do not change.
4. **Ownership guard.** In `scripts/ci/command-hub-ownership-guard.js`, add `VTID-XXXXX|` at the head of `ALLOWED_VTID_PATTERN` (line ~1047).
   Also add a header comment line in the existing style: `// VTID-XXXXX: app.js + index.html (?v= bump) only — Self-Healing Active Repairs APPROVE calls the real POST /api/v1/specs/:vtid/approve with Bearer auth and reports failure; Task drawer spec approve drops dead x-user-* headers.`
   Without this, any PR touching `services/gateway/src/frontend/command-hub/` fails the guard. The other way through is a branch or PR title containing an allowlisted marker.

## Tests

CI guards that will run on this PR, and what they need:
- `scripts/ci/command-hub-ownership-guard.js`: the new VTID must be in ALLOWED_VTID_PATTERN (Fix step 4), or the PR title/branch must carry an allowed marker.
  Its unit test `services/gateway/test/scripts/command-hub-ownership-guard.test.ts` must stay green.
- `test/command-hub/t2-no-zero-caller-functions.test.ts`: there must be no top-level function whose only mention is its definition. No functions are added or removed, so it passes.
- `test/command-hub/t1d-dead-functions-removed.test.ts`, `dead-code-*`, `t5c-no-fabricated-fallback-rows` and the other command-hub text-pinning suites:
  they pin unrelated strings and must stay green. Run the full `npx jest test/command-hub` in services/gateway.
- `test/vtid-05048-s4-caller-identity.test.ts` (resolveSpecApprover) must stay green. It is untouched.

New jest test `services/gateway/test/command-hub/vtid-XXXXX-spec-approve-route.test.ts`. It pins source text with readFileSync of app.js, like vtid-04437/t1d:
- app.js contains no `'/api/v1/specs/approve'`.
- app.js contains no `'x-user-id'` and no `'x-user-role'`. The x-user-role check is case-insensitive.
- Slice the `renderSelfHealingView` body: `BODY = APP_JS.slice(APP_JS.indexOf('function renderSelfHealingView('), APP_JS.indexOf('\nfunction ', APP_JS.indexOf('function renderSelfHealingView(') + 1))`.
  Then slice the Active Repairs APPROVE fetch: `CALL = BODY.slice(i, BODY.indexOf("showToast('Spec approved for '", i) + 200)`, where `i = BODY.indexOf("fetch('/api/v1/specs/' + encodeURIComponent(task.vtid) + '/approve'")`. Assert:
  - `i !== -1`, and `BODY` contains no `'/api/v1/specs/approve'`;
  - fetch-init auth: `/fetch\('\/api\/v1\/specs\/' \+ encodeURIComponent\(task\.vtid\) \+ '\/approve',\s*\{[^}]*headers:\s*buildContextHeaders\(/` matches `CALL`. That proves the Bearer helper is used in that fetch, not just somewhere in the function;
  - success only after an ok check: `OK_BRANCH = /if\s*\(\s*[\w.]*\bok\b[^)]*\)\s*\{[^]*?showToast\('Spec approved for '/` must match `CALL`.
    The `ok` in the condition may be `r.ok`, `res.ok`, `result.ok`, `j.ok` or a destructured `ok`.
    Also assert that the failure toast `'Approve failed'` appears in `CALL` after the success toast (the else branch);
  - `CALL` contains `.catch(`, so network errors surface;
  - mutation check, run as a self-test in the same file: a copy of `CALL` with the `if (…ok…) {` wrapper removed must make the ok-branch assertion fail. This proves the regex really detects an unconditional toast.
- Slice the `renderTaskDrawer` body and assert it still contains `'/api/v1/specs/' + vtid + '/approve'` and `buildContextHeaders(`.
- index.html's app.js `?v=` contains `vtid-XXXXX` (lower-case).
- Route cross-check: read `src/routes/specs.ts` and assert `router.post('/:vtid/approve', requireServiceOrAdmin` exists, including the middleware name, on purpose.
  The intent is to fail loudly if the route's auth is ever loosened or removed, so the frontend's Bearer assumption stays true.
  Also assert no `router.post('/approve'` exists. This keeps the frontend and backend contract tied together.

Staging (read-only), in `docs/validation/VTID-XXXXX/staging-tests.json`, using the format of VTID-04527 and VTID-05098:
```json
{
  "vtid": "VTID-XXXXX",
  "service": "gateway",
  "tests": [
    { "kind": "http", "name": "spec approve route is mounted and fails closed without a bearer (401 JSON, not HTML 404)",
      "method": "POST", "path": "/api/v1/specs/VTID-00000/approve", "rejected_probe": true,
      "expect_status": 401, "expect_content_type": "application/json",
      "expect_json": { "ok": false, "error": "missing bearer token" } },
    { "kind": "http", "name": "Command Hub loads the VTID-XXXXX app.js",
      "path": "/command-hub/", "expect_status": 200, "expect_content_type": "text/html",
      "expect_body_contains": ["app.js?v=<new-value>"] },
    { "kind": "http", "name": "served app.js calls the real spec approve route from Active Repairs",
      "path": "/command-hub/app.js?v=<new-value>", "expect_status": 200, "expect_content_type": "javascript",
      "expect_body_contains": ["'/api/v1/specs/' + encodeURIComponent(task.vtid) + '/approve'"] },
    { "kind": "existing", "ref": "npx jest test/command-hub/vtid-XXXXX-spec-approve-route.test.ts test/vtid-05048-s4-caller-identity.test.ts",
      "cwd": "services/gateway", "reason": "pins both approve call sites to the real route, the absence of x-user-* headers, and server-side approver resolution" }
  ]
}
```
The POST is allowed only as `rejected_probe` with 401/403 (scripts/ci/staging-verify/lib.cjs:143). It sends no bearer, so it can never write.
Nothing triggers an actual approval on staging, because staging writes the production DB.

## Rollout

Use the normal staging-first path. Merge, then `AWS-STAGE-DEPLOY-GATEWAY.yml` deploys to staging and STAGING-VERIFY runs the suite above.
Gate 2 then goes to production via `AWS-PROD-DEPLOY-GATEWAY.yml`, pinned to the verified commit (`expected_commit`),
with the commit range diffed against prod `/api/v1/admin/build-info`. The change is frontend-only static assets served by the gateway, and there is no migration.
Rollback is to redeploy the previous gateway image. Behaviour is unchanged for call site B, except that two ignored headers are gone.

## Risks

- After the fix, the Zone 2 APPROVE really approves the spec: vtid_ledger gets spec_status='approved' and an oasis_spec_approvals row.
  Before, it silently did nothing. This is the intended behaviour of the button, and it is gated server-side to exafy_admin.
  It does NOT dispatch the worker, unlike Zone 1's self-healing/approve. Dispatch stays with the existing pipeline (Activate / orchestrator).
  The toast text should say "Spec approved", not "dispatched". Flagged so the owner knows the button now has an effect.
- A non-exafy_admin Command Hub user (developer/infra/staff) now gets a visible 403 "Approve failed" toast instead of a false success. This is the correct behaviour.
- app.js is a hotspot (3 recent bug fixes, 2.3 MB, not indexed by RepoWise). Keep the diff to the two handlers. A concurrent Command Hub PR may need a rebase on index.html ?v= and on the guard allowlist line.

## Out of scope

- Any change to `routes/specs.ts`, `routes/self-healing.ts` or the auth middleware.
- Making Zone 2 APPROVE also dispatch, or merging it with Zone 1's `/self-healing/approve`.
- Other `buildContextHeaders` X-Vitana-* headers (X-Vitana-User/Tenant/Active-Role). These are a broader Track S cleanup, not this call.
- Removing the legacy `validated` bypass in the approve route.
- The `/api/v1/specs` "endpoints: 7" catalog label at app.js:33349.

<!-- plan:end -->

## Planner responses — round 1

Re-verified on origin/main 5f0220d0c. The partner's local checkout was stale and has since been reset to origin/main. Evidence (`git grep -n … origin/main`):
```
origin/main:services/gateway/src/frontend/command-hub/app.js:46297:                    fetch('/api/v1/specs/approve', {
origin/main:services/gateway/src/frontend/command-hub/app.js:10357:                            'x-user-role': userRole
origin/main:services/gateway/src/frontend/command-hub/app.js:46011:function renderSelfHealingView() {
origin/main:services/gateway/src/frontend/command-hub/app.js:9810:function renderTaskDrawer() {
origin/main:services/gateway/src/frontend/command-hub/index.html:28:  <script src="/command-hub/app.js?v=20261117-vtid-05098"></script>
origin/main:services/gateway/src/index.ts:798:  mountRouterSync(app, '/api/v1/specs', specsRouter, { owner: 'specs-pipeline' });
```

- **F1 [major] line numbers wrong: REJECTED.** Every file:line in the plan matches origin/main 5f0220d0c (evidence above). The partner's numbers came from a stale checkout.
  The implementer re-greps at implementation time anyway, because the anchors are the string literals, not the line numbers.
- **F2 [minor] ?v= value: REJECTED.** Same reason. `index.html:28` on origin/main is `app.js?v=20261117-vtid-05098`, as the plan states.
- **F3 [minor] wording: ACCEPTED.** The plan (Problem, call site A) now says the `.then()` callback never inspects the response and *unconditionally* shows the success toast. It also says there is no `.catch`.
- **F4 [minor] no .catch: ACKNOWLEDGED.** Fix step 1 already adds `.catch`, and it is now spelled out with re-enable plus an error toast. The jest test asserts `.catch(` is present in the call.
- **F5 [minor] REJECT button uses buildContextHeaders: ACKNOWLEDGED.** This is consistent with the fix: the APPROVE button now uses the same helper as the REJECT/ROLLBACK buttons beside it (`/api/v1/self-healing/rollback/:vtid`). There is no change to REJECT.
- **F6 [minor] fragile "near" assertion: ACCEPTED.** Tests now slice the `renderSelfHealingView` body, then the APPROVE fetch call (`CALL`). They assert:
  (a) `headers: buildContextHeaders(` sits inside that fetch's init object (regex given);
  (b) `OK_BRANCH = /if\s*\(\s*[\w.]*\bok\b[^)]*\)\s*\{[^]*?showToast\('Spec approved for '/` matches, so the success toast is inside an ok-guarded branch;
  (c) `'Approve failed'` follows it (the else branch);
  (d) `.catch(` is present;
  (e) a mutation self-test: stripping the `if (…ok…) {` guard makes (b) fail.
  Fix step 1 now pins the exact `if (r.ok && j && j.ok) { … } else { … }` shape the regex expects.
- **F7 placeholders: ACKNOWLEDGED.** `VTID-XXXXX` and `<new-value>` are deliberate. A VTID is allocated only after sparring and owner approval (rules 51–55).
  The real VTID and the `?v=` value are filled in at implementation time.
- **Partner Q2 (keep `requireServiceOrAdmin` in the route assertion?): YES, kept.** The intent is to catch any loosening or removal of the route's auth.
  The frontend fix assumes a Bearer-gated route that returns 401 JSON, and the staging probe expects that too. The plan's Tests section now states this intent.

## Owner approval (Gate 1)
Approved by owner in Claude Code session https://claude.ai/code/session_01TMPMNGNEtPxKwmVqyfdx46 on 2026-10-12 ("Yes"), including the recommended option for every owner decision and the production steps named in the plan. Verdict: CONVERGED (2 rounds).

## Verdict
**CONVERGED** after 2 rounds (standard class, cap 3). No blocker or major is open or disputed.

Final plan hash: `43217d4dc382a193c76630088503c22635550756da6064ebd8ad6f6479235027`

Owner approval (Gate 1): "Yes" — 2026-10-12, Claude Code session; plan hash 43217d4dc382a193c76630088503c22635550756da6064ebd8ad6f6479235027; sparring record 1cc5ea35-3b7c-4a65-a7a7-dd473d322e6f.

## Sparring partner findings (verbatim, round 1 then round 2)

Now I have all the evidence for my review.

## Verified premises

- **"The real route is `POST /api/v1/specs/:vtid/approve` defined at `specs.ts:1182`"** → TRUE -- `specs.ts:1182` confirms `router.post('/:vtid/approve', requireServiceOrAdmin, ...)`.

- **"Call site A calls `fetch('/api/v1/specs/approve', ...)`"** → TRUE but wrong line number. The plan says `app.js:46297`; the actual fetch is at `app.js:46148`. The call sends `{vtid}` in the body, no Authorization header, and shows a success toast unconditionally -- all as described. Plan premise TRUE, line reference FALSE.

- **"Call site B sends `x-user-id`/`x-user-role` headers"** → TRUE but wrong line number. The plan says `app.js:10352`; the actual headers are at `app.js:10220-10221`. These are the only occurrences in app.js. The path is already correct (`'/api/v1/specs/' + vtid + '/approve'`). Plan premise TRUE, line reference FALSE.

- **"Mounted at `index.ts:798`"** → FALSE. The specs router is mounted at `index.ts:794` (`mountRouterSync(app, '/api/v1/specs', specsRouter, { owner: 'specs-pipeline' })`). Line 798-799 is the VCAOP postback router.

- **"`index.html:28` has the `?v=` for app.js"** → FALSE. The app.js script tag is at `index.html:17`, not line 28. Current value is `?v=20261109-vtid-05006`.

- **"No `router.post('/approve'` exists"** → TRUE -- grep for `router.post('/approve'` in specs.ts returns no matches, confirming only `/:vtid/approve` exists.

- **"`renderSelfHealingView` starts at 46011"** → FALSE. It starts at line `45862`.

- **"`renderTaskDrawer` starts at 9810"** → FALSE. It starts at line `9674`.

## Findings

F1 [major] Multiple line-number references are wrong, which will break the pinning tests that slice by function name/line

Evidence: Plan says call site A is at `app.js:46297` (actual: 46148), call site B at `app.js:10352` (actual: 10220-10221), `renderSelfHealingView` starts at 46011 (actual: 45862), `renderTaskDrawer` starts at 9810 (actual: 9674), `index.ts:798` (actual: 794), `index.html:28` (actual: 17). None of these line numbers are close. The plan likely ran against a different version of app.js than what is currently on `origin/main`.

Suggestion: Correct all line numbers to match the current `origin/main`. The plan's test design (slice by function name regex, not line number) is not directly impacted because it uses `function renderSelfHealingView(` as the anchor, but the prose is misleading and any implementor who navigates by line number will land in the wrong place. Re-verify all references against the actual HEAD before implementation.

F2 [minor] The plan references `?v=20261117-vtid-05098` as the current cache-bust value

Evidence: `index.html:17` shows `app.js?v=20261109-vtid-05006`. The plan's reference to `vtid-05098` appears to be from a future or parallel change, not the current state.

Suggestion: Update the plan to reference the actual current value `20261109-vtid-05006` and pick a new value for this VTID's bump.

F3 [minor] The `.then()` on call site A does not just "ignore the response" -- it unconditionally shows a success toast

Evidence: `app.js:46152-46156` -- the `.then(function() { ... showToast('Spec approved for ' + task.vtid, 'success'); })` fires on any HTTP response (including 404 HTML). The plan's problem statement says "`.then()` ignores the response" but then correctly describes the false-success toast. The phrasing is slightly contradictory -- it ignores the response *content* but does execute a success action.

Suggestion: Minor wording clarity; the plan already proposes the correct fix (check `r.ok && j.ok`). No change needed to the fix itself.

F4 [minor] Call site A has no `.catch()` handler at all

Evidence: `app.js:46148-46156` -- the fetch chain has `.then(function() { ... })` with no `.catch()`. A network error would produce an unhandled promise rejection. The plan correctly proposes adding a `.catch` network-error toast, but does not call this out as an existing bug distinct from the wrong-route bug.

Suggestion: Already addressed by the fix proposal. No action needed.

F5 [minor] The plan says "the REJECT button ... `fetch('/api/v1/self-healing/rollback/' + task.vtid`" -- this should be verified as the intended reject path

Evidence: `app.js:46164` -- the REJECT button calls `POST /api/v1/self-healing/rollback/<vtid>` with `buildContextHeaders()`. This is out of scope per the plan, but worth noting: the REJECT button already uses `buildContextHeaders()` (auth), while the APPROVE button right next to it does not. This confirms the APPROVE button was simply missed when the auth pattern was applied.

Suggestion: No action needed (out of scope), but this confirms the diagnosis.

F6 [minor] The plan's test proposes asserting `'Approve failed'` text is "present near" the success toast -- this is fragile for a source-text-pinning test

Evidence: The plan says "asserting that the text `'Approve failed'` is present near it" to prove the success toast is inside an ok branch. In a 2.3 MB file, "near" is ambiguous without a formal definition. The slicing approach (extract the `renderSelfHealingView` body) already scopes it sufficiently; the real assertion should be that the success toast only appears after an ok-check, not just that an error string exists somewhere in the same function.

Suggestion: The test should assert that within the sliced function body, the `showToast('Spec approved` string appears AFTER a conditional check (e.g., the slice contains a pattern like `ok` or `r.ok` before the success toast). Alternatively, assert that `buildContextHeaders` and `Approve failed` both appear in the same fetch handler block. The exact regex is an implementation detail the implementor can decide.

F7 [minor] The plan's `?v=` value in the staging test JSON uses `<new-value>` placeholder but the staging test is meant to be committed as-is

Evidence: `staging-tests.json` lines in the plan show `"app.js?v=<new-value>"` -- these need to be the real value at commit time, not a placeholder.

Suggestion: The plan already uses `VTID-XXXXX` as a placeholder throughout (for the not-yet-allocated VTID). This is consistent. No change needed -- the implementor will substitute the real values.

## Questions for the planner

1. The line numbers are all significantly off (by 100-150 lines in many cases). Was the plan verified against a different commit than `5f0220d0c`? The plan header claims verification against that commit, but the discrepancies suggest the app.js content has shifted. Can you confirm the commit you actually read?

2. The plan's test proposes a route cross-check asserting `router.post('/:vtid/approve', requireServiceOrAdmin` exists in `specs.ts`. This is a good contract test. However, the import is `requireServiceOrAdmin` from `'../middleware/require-service-or-admin'` (specs.ts:16). If that middleware is ever renamed, this test would catch it -- is that the intent, or should it be more lenient (just assert the route pattern exists)?

## Verdict

NOT CONVERGED

F1 is major because the plan's claimed verification commit does not match the actual code state. Every line number in the plan is wrong, which means either (a) the plan was verified against a different commit, undermining the "verified read-only against origin/main @ 5f0220d0c" claim, or (b) the file has been modified since the plan was written and the plan needs a refresh. The fix design and test design are sound in principle -- the line numbers are wrong but the function names and behavioral descriptions are correct. Correcting the line numbers and confirming the actual commit resolves F1.
All claims verified. The plan is solid. Let me produce my round-2 output.

## Verified premises
- `fetch('/api/v1/specs/approve'` at app.js:46297 → TRUE -- `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/app.js:46297`
- `'x-user-role': userRole` at app.js:10357 → TRUE -- `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/app.js:10357`
- `function renderSelfHealingView()` at app.js:46011 → TRUE -- `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/app.js:46011`
- `function renderTaskDrawer()` at app.js:9810 → TRUE -- `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/app.js:9810`
- `mountRouterSync(app, '/api/v1/specs', specsRouter)` at index.ts:798 → TRUE -- `/home/user/vitana-platform/services/gateway/src/index.ts:798`
- `app.js?v=20261117-vtid-05098` at index.html:28 → TRUE -- `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/index.html:28`
- `router.post('/:vtid/approve', requireServiceOrAdmin` at specs.ts:1182 → TRUE -- `/home/user/vitana-platform/services/gateway/src/routes/specs.ts:1182`
- No `router.post('/approve'` in specs.ts → TRUE -- grep returns no matches

## Findings

F1 [major] line numbers wrong: **closed.** My round-1 checkout was stale. All line numbers confirmed against the current `origin/main` at `5f0220d0c`. The planner's evidence is correct.

F2 [minor] `?v=` value wrong: **closed.** Same stale-checkout issue. `index.html:28` is `app.js?v=20261117-vtid-05098` as the plan states.

F3 [minor] `.then()` wording: **closed.** Plan revised to say "the `.then()` callback never inspects the response" and "unconditionally calls showToast... so a 404 (or a 401/403) still produces the success toast."

F4 [minor] no `.catch`: **closed.** Fix step 1 now explicitly adds `.catch` with re-enable and error toast. Test asserts `.catch(` is present.

F5 [minor] REJECT button uses buildContextHeaders: **closed.** Acknowledged, out of scope, consistent with the fix direction.

F6 [minor] fragile "near" assertion: **closed.** The test design is now precise: slices the function body, then the APPROVE fetch call, uses a regex for the ok-branch guard, and includes a mutation self-test that proves the regex would fail without the guard. This is a well-designed pinning test.

F7 [minor] placeholders: **closed.** Deliberate per CLAUDE.md rules 51-55; VTID allocated after sparring and owner approval.

No new blocker or major findings. The revised plan is well-scoped, the test design is thorough (source-text pinning, ok-branch mutation self-test, route cross-check, staging probe), the fix is minimal, and all premises are verified against the actual code.

## Questions for the planner

None.

## Verdict

CONVERGED
