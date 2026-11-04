---
change_class: standard
---
# plan(operator-chat-service-token): Operator Chat approve and reject send the gateway service token

Author: Kiro, session `kiro-hotmail-202611011452-6d16`, seat hotmail. This is a local draft: not pushed, no PR, not
sparred. Premises were checked at `origin/main` `7292527d60` (fetched 2026-11-04). CI sparring (PLAN-SPAR) and the VTID
come when the plan is pushed as a `plan(` PR.

<!-- plan:begin -->
## 1. Goal
The goal, as given for this plan: "Operator Chat approve and reject must keep working once the approvals routes require
requireServiceOrAdmin (GATEWAY_SERVICE_TOKEN or an exafy_admin JWT)."

The lane changes the credential that two in-process calls send. It changes no approvals route.

## 2. Today (evidence at origin/main 7292527d60)
Paths are under `services/gateway/`.
- `src/services/gemini-operator.ts:5686` `executeDevApproveItem` POSTs to `http://localhost:${PORT}/api/v1/approvals/<id>/approve`
  (fetch at :5692). Its headers are `Content-Type`, `apikey: SUPABASE_SERVICE_ROLE` (:5696) and
  `Authorization: Bearer ${SUPABASE_SERVICE_ROLE}` (:5697).
- `executeDevRejectItem` (:5723) does the same for `/reject` (fetch :5729, headers :5733-5734) and sends a JSON body
  with `reason`.
- `executeTool` (:3710) reaches both through `dev_approve_item` (:4151-4152) and `dev_reject_item` (:4155-4156).
- The pattern to follow is the VTID-05048 call in `executeDevApproveSpec` (:5594): a comment at :5606-5607 and
  `headers: { 'Content-Type': 'application/json', ...gatewayServiceAuthHeader() }` at :5608. That call sends no `apikey`.
- The source guard `test/vtid-05047-cicd-routes-auth.test.ts:103-107` pins the same rule for two other calls in this file
  (`/api/v1/deploy/service` and `/api/v1/cicd/lock-status`): the service token is sent, and `SUPABASE_SERVICE_ROLE` does
  not appear near them. It does not cover approve or reject. The new test asserts the rule on the approve and reject
  calls themselves.
- `gatewayServiceAuthHeader()` (`src/middleware/require-service-or-admin.ts:63`) returns
  `{ Authorization: 'Bearer <GATEWAY_SERVICE_TOKEN>' }`, or `{}` when the token is unset. gemini-operator imports it at :59.
- `requireServiceOrAdmin` (same file, :71) accepts the service token first. Otherwise it needs a JWT whose
  `app_metadata.exafy_admin` is true (`src/middleware/auth-supabase-jwt.ts:284`). A request with no bearer gets 401
  `missing bearer token`. A caller that fails the admin check gets 403, or 401 when no identity resolves.
- On base the three POST routes have no gate: `src/routes/approvals.ts:529` (`/feed/approve`), `:651`
  (`/:approval_id/approve`) and `:780` (`/:approval_id/reject`). The router is mounted bare at `src/index.ts:821`. No
  handler reads the caller's bearer.
- Two in-flight lanes add that gate to the same three routes: `approvals-auth` (local branch
  `kiro/mt-track-s-authz/approvals-auth` at `d3f9a4a685`, the head the handover names for PR #4606) and
  `approvals-auth-v2` (local branch `kiro/mt-track-s-authz/approvals-auth-v2` at `a6455dfbc5`, VTID-05528, not pushed).
  The Supabase service key carries no `exafy_admin` claim, so once either lane lands, both Operator Chat calls are refused.
- Commit `7a30f146d9` on the approvals-auth-v2 branch already holds this change and a test with this lane's file name.
  Its commit message says it was kept separate so the change can move into this lane. The builder may read it. The lane
  still needs its own red and green evidence.
- Test setup: `services/gateway/test/__mocks__/setup-tests.ts:10` mocks `node-fetch`. gemini-operator imports `fetch`
  from `node-fetch` (:26), so the mock receives these calls. `setup-tests.ts:19` sets `SUPABASE_SERVICE_ROLE` to a mock
  value. The module reads that variable once, at load (:101), so the test sets its own value before it requires the module.
- The success path calls `emitOasisEvent` (imported at :45). The test mocks `src/services/oasis-event-service.ts`.
- No lane file on `origin/main` lists `gemini-operator.ts`. `mt-discover-r2` lists `gemini-operator-repository.ts`, a
  different file.

## 3. Change
In `src/services/gemini-operator.ts`, in `executeDevApproveItem` and `executeDevRejectItem` only:
- Replace the `apikey` and `Authorization` headers with `...gatewayServiceAuthHeader()`, keeping
  `'Content-Type': 'application/json'`. This matches :5608.
- Add a comment with the VTID, in the style of :5606-5607.
- Keep the URLs, bodies, error handling and OASIS events as they are.

Unchanged: every route's authorization (`routes/approvals.ts`, the mount at `index.ts:821`, `requireServiceOrAdmin`), the
other `SUPABASE_SERVICE_ROLE` uses in the file, and the approvals GET routes.

## 4. Interfaces and ordering
- After this lane, gemini-operator sends `POST /api/v1/approvals/:id/approve` or `/reject` to localhost with
  `Content-Type: application/json` and `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`, and with no `apikey`. The
  response is unchanged.
- **Ordering: this lane merges to `main` before `approvals-auth-v2` (VTID-05528) and before `approvals-auth` (PR #4606).**
  The owner named `approvals-auth-v2`. `approvals-auth` adds the same gate to the same routes, so it waits for this lane
  too. Whoever merges either of those lanes first checks that this lane is already on `main`.
- The order is safe. On base the approve and reject handlers ignore the bearer, so the new header changes nothing until
  a gate exists.
- When this lane lands, `approvals-auth-v2` drops its own copy of the change (commit `7a30f146d9`) on rebase. Its local
  plan amendment (commit `76b22526d4` on `kiro/mt-track-s-authz/plan-amend-1-sync`) adds `gemini-operator.ts` to that
  lane's paths. That path should come out, because this lane owns the file. The planner of `approvals-auth-v2` makes
  that change.

## 5. Lanes
### Lane `operator-chat-service-token`
- Seat `hotmail`, executor `kiro`, reviewer `agent:vitana-lane-reviewer (claude-sonnet-5.5)`, repo
  `exafyltd/vitana-platform`, `depends_on: []`, no VTID (CI allocates it).
- Files: `services/gateway/src/services/gemini-operator.ts` (edit), `services/gateway/test/operator-chat-service-token.test.ts`
  (new), `docs/validation/<VTID>/**` (evidence).
- Test that fails on origin/main: `test/operator-chat-service-token.test.ts`, one case. It sets `GATEWAY_SERVICE_TOKEN`
  and `SUPABASE_SERVICE_ROLE` to different sentinels before it requires the module. It drives `dev_approve_item` and then
  `dev_reject_item` through `executeTool`, with `node-fetch` mocked. For each call it asserts the URL path, that
  `init.headers` equals `{ 'Content-Type': 'application/json', Authorization: 'Bearer <token>' }` exactly, and that the
  serialised call does not contain the Supabase sentinel. On base both calls send the Supabase sentinel, so the header
  assertion fails. It restores `process.env` afterwards.

## 6. Parallel, shared and hot files
- No other open lane on `main` owns `gemini-operator.ts`. The one exception is the planned `approvals-auth-v2` amendment
  in section 4.
- `docs/validation/**` is shared. This lane writes only `docs/validation/<its VTID>/`.
- `docs/programs/standalone/program.md`: one `specs:` line, so `queue.mjs validate` finds the slug in a programme.

## 7. Tests and commands (run in `services/gateway`)
1. Red first: `npx jest test/operator-chat-service-token.test.ts` against the unchanged file. Save the output as
   `docs/validation/<VTID>/outputs/red-on-base.txt`.
2. Green after the change: the same command.
3. `npm run test:operator` (CLAUDE.md rule 42e, the Operator Console path).
4. `npm run test:roles` (rule 42h, the developer assistant tools).
5. Every suite under `test/` that imports `services/gemini-operator`: 25 on origin/main, plus the new test. Among them are
   `vtid-05019`, `vtid-05047` and `vtid-05048`, which pin the service-token pattern. Save the file list in `commands.log`.
6. `npm run typecheck`.

Preflight (`scripts/collab/preflight.mjs`) runs before any push.

## 8. Measurement
The plan driver writes `docs/validation/<plan VTID>/timings.json` after CI allocates the VTID. This local draft writes none.

## 9. Staging proof
Not verified on staging: the change alters the headers of two in-process calls, and a real approve or reject writes to the
shared Supabase project. Staging suites are read-only (CLAUDE.md rule 48). The covering test is
`test/operator-chat-service-token.test.ts`.

## 10. Risks
1. **Order inversion.** If `approvals-auth` or `approvals-auth-v2` merges first, Operator Chat approve and reject fail
   until this lane lands. Mitigation: the order in section 4, checked before either merge.
2. **`GATEWAY_SERVICE_TOKEN` unset in a runtime.** The header is empty, the gate answers 401, and the call fails loudly.
   Not verified here: that staging and production set the variable. The VTID-05019, -05047 and -05048 callers already
   depend on it.
3. **The production ALB rule** (owner action, per the handover) blocks external `POST /api/v1/approvals/*`. These calls go
   to `localhost` inside the gateway process, so the rule does not see them. The rule stays in place.
4. **Duplicate change.** If `approvals-auth-v2` keeps commit `7a30f146d9` on rebase, the two copies conflict. Mitigation:
   section 4.
5. **Follow-ups, out of scope.** The spec calls in the same file (`/api/v1/specs/:vtid/generate`, `/validate` and
   `/quality-check`, at `gemini-operator.ts:5460`, `:5546`, `:5575`) also send the Supabase key. Those routes have no gate
   on base (`routes/specs.ts:537`, `:854`, `:1024`), so they work today. They need the same change if they gain a gate.
   The approvals GET calls (`:5645`, `:5669`) carry the same key. If follow-up F1 in `mt-track-s-authz` puts a gate on the
   approvals GET routes, they need the same change too.

## 11. Decisions taken
- The header is `gatewayServiceAuthHeader()`, and `apikey` is removed. That matches VTID-05048, and the Supabase key
  appears in no header.
- One test case, as requested. Its exact-header assertion also fails if `apikey` comes back.
- `change_class: standard`. The `light` class excludes auth, and this change sits on the auth path.
- The approvals routes keep their current authorization in this lane.
<!-- plan:end -->
