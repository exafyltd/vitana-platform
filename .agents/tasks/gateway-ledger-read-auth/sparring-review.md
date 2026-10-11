# Sparring review: gateway ledger read auth

Plan hash under review: fe44de27999c136dbaf33deaab2d2ce343da140e022b285b6f825d4faca7fd5f
Repos at review time: vitana-platform 5884a7a59, vitana-v1 b0fd64675 (both match the plan header).
Read-only review. No gateway, staging or production call was made; no test suite was run.

# Round 1

## Verified premises

- Repo HEADs (5884a7a5, b0fd6467) → TRUE: `git log -1` returns 5884a7a59 and b0fd64675.
- No global auth; every Tier 1 GET is ungated → TRUE. Registrations carry no middleware: `routes/oasis-tasks.ts:52,217,303`, `routes/oasis-vtid-ledger.ts:30`, `routes/vtid.ts:437,760,885,1174`, `routes/tasks.ts:28,206,322`, `routes/board-adapter.ts:118` (only `cors(corsOptions)`), `routes/approvals.ts:349,395`. The writes in the same files do carry `requireLedgerWriteAuth` (`oasis-tasks.ts:256,550`, `vtid.ts:144,579`).
- Mount lines → TRUE: `index.ts:757` (vtid), `787` (approvals), `1550` and `1624` (board), `1553` (tasks at `/`), `1558` (oasis-tasks), `1561` (oasis-vtid-ledger), `594` (`delegatedTokenGuard`). The vtid mount comes before the tasks mount, so `tasks.ts:206` is shadowed, as the plan says.
- `/api/v1/vtid/health` shares the vtid router prefix and is open (`vtid.ts:466`), so a mount-level gate would break it → TRUE.
- Write gate is reusable → TRUE. `middleware/ledger-write-auth.ts` exports `evaluateLedgerWriteAuth` and `serviceAuthHeaders`. Unset or empty `GATEWAY_SERVICE_TOKEN` never matches. Outcomes are 401 (no bearer or invalid) and 403 (non-admin). Mode resolution matches the plan: only `enforce` and `off` are special, anything else is `log`.
- Command Hub call sites that send no Authorization → TRUE for `app.js` 5452, 12788, 12823, 12910, 12934, 22434, 30598, 30809, 31407. Line 12675 sends the header only when `state.authToken` is set (TRUE). Lines 12405, 15864, 29033 and 33411 already send credentials (TRUE).
- Interceptor claim (`app.js:59-181`) → PARTIAL. See F8: the replay only adds the header if the original request had one, but `performRefresh()` runs for every 401 from an extended-session role first, anonymous requests included.
- No `/api/v1/tasks/stream` route → TRUE. `useTaskStream.ts:12,70` builds the URL from `GATEWAY_BASE`, and no gateway source matches `tasks/stream`. `VITE_TASKS_STREAM_URL` (`.env:16`) is unused under `src/`.
- vitana-v1 `taskApi.ts:15,40` send no Authorization (`credentials: "include"` only) → TRUE.
- `vtid-auto-close.cjs` `readRow()` sends no token while `closeRow` does via `authHeader(token)` → TRUE.
- `scripts/ci/staging-verify/smoke/gateway.json:13` ("OASIS tasks list", anonymous, no `expect_status`) and `:10` (`/api/v1/vtid/health`) → TRUE.
- Stage workflow strip-list entry for `LEDGER_WRITE_AUTH_MODE` at `AWS-STAGE-DEPLOY-GATEWAY.yml:1091` and pin at `:1161` → TRUE (the plan says ~1162). The prod workflow contains no `LEDGER_WRITE_AUTH_MODE` or `GATEWAY_SERVICE_TOKEN`; `test/vtid-04727-ledger-write-auth.test.ts:227` asserts the first.
- `test/vtid-04727-ledger-write-auth.test.ts:193` "read routes stay open" → TRUE. `test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts:124` enforces the 20,000-char `run:` cap → TRUE.
- Cognito identities have `exafy_admin: false` (`auth-supabase-jwt.ts:257`, "KNOWN GAP" at 243-247) → TRUE.
- gemini-operator approvals self-calls send `SUPABASE_SERVICE_ROLE` as the bearer (`gemini-operator.ts:5569-5599`) → TRUE.
- `gatewayApiCall` (`orb-tools/developer-tools.ts`) adds no Authorization unless the caller passes headers; the base URL is `GATEWAY_URL` or localhost → TRUE.
- Claim in 2b that the other gateway self-calls "found" are POSTs or Tier 2 and unaffected → FALSE. `services/task-state-query-service.ts:305` does an anonymous `GET /api/v1/oasis/tasks/discover` through plain `fetch` (headers at ~310-314 are only Content-Type, X-Actor, X-VTID). `routes/orb-live.ts:363` and `cross-turn-state-engine.ts:32` import that module. See F1.
- Claim that `services/mcp*` and other repos contain no Tier 1 callers → PARTIAL. `services/*` is clean, but top-level `mcp/vitana-work/src/lib/gateway-client.ts:113,246` calls `GET /api/v1/oasis/vtid-ledger`. It sends `VITANA_API_KEY` as the bearer (`:73,89`), and its default base URL is the decommissioned Cloud Run host (`:72`). The plan does not mention it.
- Claim that the Tier 2 list is the same exposure class → TRUE, but incomplete. See F3.

## Findings

F1 [blocker] The self-call inventory (section 2b) is incomplete: the ORB task-state path calls a Tier 1 route anonymously and would break silently under enforce.
Evidence: `services/gateway/src/services/task-state-query-service.ts:305-314` does `fetch(new URL('/api/v1/oasis/tasks/discover', GATEWAY_CONFIG.BASE_URL))` with no Authorization. `BASE_URL` is `process.env.GATEWAY_BASE_URL || 'http://localhost:3000'` (`:56-57`). The gateway listens on 8080 (CLAUDE.md rule 15), so this path is either already failing unless the env var is set, or it works only where `GATEWAY_BASE_URL` is set. The plan does not say which. Its consumers are `orb-live.ts:363` and `cross-turn-state-engine.ts:32` (voice "what are my tasks"). The plan's AC-4 ("every known caller sends credentials") is false as written. Log mode would only reveal this if the call currently works.
Suggestion: add to section 2b and the work plan: `task-state-query-service.ts` attaches `serviceAuthHeaders()` on the `fetch` at `:310`. Read the staging and production task definitions for `GATEWAY_BASE_URL` (read-only) and record the answer. Add a unit test that the discover call carries the bearer. Re-run the repo-wide caller grep with `git grep -n -E "oasis/tasks|vtid-ledger|vtid/(list|projection)|api/v1/tasks|commandhub/board|approvals/(pending|count)|api/v1/board"` over non-test `*.ts/*.js/*.cjs/*.mjs/*.py/*.sh/*.yml/*.json` outside `routes/` and the frontend. That grep found this caller, the ones the plan lists, and `mcp/vitana-work`. Attach the output to the plan.

F2 [major] Making `gatewayApiCall` attach the service token by default hands a service-token credential to every current and future self-call, including model-driven tools.
Evidence: `orb-tools/developer-tools.ts` `gatewayApiCall(path, init)` is a generic helper used by the Wave 2 developer tools (`vtid-lifecycle-tools.ts:131,165,194,265,286,458`, `cicd-pr-tools.ts:101`, `autopilot-controller-tools.ts:177`). VTID-04727 deliberately made the six write calls opt in with `serviceAuthHeaders()`. Defaulting changes behaviour for calls the plan did not audit. The plan itself says `autopilot-controller-tools.ts:177` hits a service-token-gated router and is "probably already 401 today", so the default would silently turn that into a working call with elevated rights. Any tool that builds a path from model-chosen arguments would then carry the service token. Reads of Tier 1 need credentials only for a few paths.
Suggestion: do not change the default. Pass `headers: serviceAuthHeaders()` explicitly at the Tier 1 read call sites (`vtid-lifecycle-tools.ts:265,286,458`, `approvalsApi`). Alternatively add a `service: true` flag on `gatewayApiCall`, or restrict the default to an explicit path allowlist (the Tier 1 prefixes). State which in the plan and change test plan item 5 to match.

F3 [major] The plan asks the owner to approve limiting the change to Tier 1 (D1) while admitting the Tier 2 inventory is unfinished, and the same ledger data stays anonymous next to the gated routes.
Evidence: the plan says gating only `/oasis/tasks` while board, tasks and approvals return the same titles would be "cosmetic" (section 1). The same applies to Tier 2. The Command Hub VTID detail fetch at `app.js:22434` loads `/api/v1/vtid/:vtid` (gated) and `/api/v1/events?vtid=` (not gated) in one `Promise.all`. `specs.ts:1325` `GET /:vtid` and `GET /api/v1/oasis/events` stay open. One more route the plan missed: `routes/ops-health-checks.ts:210` `GET /api/v1/ops/health/vtid-ledger` (mounted `index.ts:1447`, marked `// public-route`) returns up to 10 VTIDs (`evalLedgerIntegrity`, `:123-131`). After steps A to D, an anonymous caller still gets task titles and VTIDs from events and specs. Gate 1 would present a change that does not stop the exposure that motivated it.
Suggestion: complete the Tier 2 table before Gate 1 (route, file:line, what it returns, `vtid_ledger`-derived yes/no), including `ops-health-checks.ts:210`. Then either (a) move the OASIS event reads that take `vtid` and `GET /api/v1/specs/:vtid` into Tier 1 under the same per-route gate, or (b) keep them out and put in the Gate 1 message the exact sentence "this change closes rows X but anonymous callers can still read titles and statuses via events and specs until follow-up VTID-to-be-allocated". Name the follow-ups in D1.

F4 [major] Step D (production enforce) and the rollback procedure are left unspecified, although the repo already answers both.
Evidence: section 3 says the production pin follows "the existing prod pinning pattern (header comment around lines 935-960; not fully read here)" and section 4 says the emergency procedure was "not verified". `AWS-PROD-DEPLOY-GATEWAY.yml:21-29` documents an `env-only` deploy mode (VTID-03961) that keeps the current prod image and applies only `env_overrides`, and `:240` defines the `env_overrides` input. `:36-38` says promote mode preserves the awsdr task definition's env, so a staging pin never carries to prod. So (1) rollback is "dispatch env-only with `env_overrides={"LEDGER_READ_AUTH_MODE":"log"}`", and (2) step D can be the same env-only dispatch with `enforce` instead of a code change to the workflow file, which avoids promoting unrelated commits (CLAUDE.md IF-THEN rule 26 is cited in that workflow). The plan's step D as written also edits the prod workflow, which needs a PR plus a PUBLISH just to flip a flag, and it adds a prod workflow test that must be rewritten when the pin is added (`vtid-04727...test.ts:227` pattern).
Suggestion: replace section 4 steps D and Rollback with: production enforce and rollback are both `env-only` dispatches of `AWS-PROD-DEPLOY-GATEWAY.yml` with `env_overrides` (confirm the JSON format and the strip-then-add behaviour by reading lines 150-260 and the env_overrides apply step). Drop the production-workflow edit and test-plan item 7's "no pin until step D" clause, or justify keeping the file edit. Record that the owner-visible production flip is this dispatch, which falls under the PUBLISH/publish-to-prod path.

F5 [major] The production task definition might not carry `GATEWAY_SERVICE_TOKEN`, and step A's own pre-check does not catch that.
Evidence: the plan's step D pre-check says VTID-04727 never verified it. The prod workflow file contains no `GATEWAY_SERVICE_TOKEN` (grep of `AWS-PROD-DEPLOY-GATEWAY.yml`: no match; the stage workflow references it). In `enforce`, an unset or empty `GATEWAY_SERVICE_TOKEN` means no service-token caller can ever authenticate on prod: the self-calls, `vtid-auto-close` against prod, and the gemini-operator approvals tool all return 401, and only `exafy_admin` JWTs work. In `log` mode this appears only as a would-reject warn line if a caller sends a token, and the self-calls would be flagged as "invalid or expired token" with no explanation.
Suggestion: make it a precondition of step B (staging) and step D (production): read-only `aws ecs describe-task-definition` for the staging and awsdr services shows `GATEWAY_SERVICE_TOKEN` as a secret reference or env entry (report presence only, never the value). Add a log-mode startup line, once at boot: `[ledger-read-auth] mode=<mode> service_token_configured=<true|false>`. Add this check to the Gate 2 evidence list.

F6 [minor] The Command Hub static test (test plan item 6) is under-specified and will miss real call forms.
Evidence: call sites include a fetch inside `Promise.all([...])` on its own line (`app.js:22434`) and a chained `.then` after `fetch(...)` (`30809`, `31407`), so a "line contains fetch( and a Tier 1 path" check needs balanced-paren parsing. `services/gateway/src/frontend/command-hub/debug.html:25` also does an anonymous `fetch('/api/v1/tasks')` and is not in the plan's list. `app.js:12675` should become unconditional as the plan says.
Suggestion: specify the test as: tokenise `app.js` and `debug.html`, for each `fetch(` find the matching close paren, extract the URL expression, and fail if it contains a Tier 1 prefix and the call expression lacks `buildContextHeaders` (allowlist by line for the health probes). Add `debug.html:25` to the work plan step 4 or delete the legacy debug fetch (`command-hub-ownership-guard.js:203` already wants it removed).

F7 [minor] Log mode is meant to enumerate unknown callers, but the plan has no volume or injection control for the warn line.
Evidence: Command Hub polls tasks (5 s) and approvals (20 s) (`app.js` interceptor header comment). Every anonymous internet request in log mode logs one line with User-Agent (80 chars) and Origin/Referer host, all attacker-controlled. There is no dedupe.
Suggestion: dedupe by `route + reason + origin host + ua[:40]` with a 60 s window and a counter in the line, strip control characters and quotes from UA and origin before logging, and cap at N lines per minute per process. Say so in AC-2.

F8 [minor] The interceptor hazard is real for missed callers, and a one-line guard removes it.
Evidence: `app.js` interceptor: after `if (resp.status !== 401) return resp; if (!isExtendedSessionRole(getActiveRole())) return resp; var newToken = await performRefresh();` the check for an existing Authorization header happens only at replay time. An anonymous 401 therefore burns a single-use refresh token (rotation) and replays without credentials, and 14 handlers call `doLogout()` on 401 (`Select-String 'status === 401'` count 14). The plan relies on call-site fixes and a static test only.
Suggestion: in step 4, make the interceptor skip refresh when the original request had no Authorization header (`init.headers`/`input.headers`), and add that to the static test.

F9 [minor] vitana-v1 `taskApi` plan handles "no session" but not 403.
Evidence: `taskApi.ts:15,40` are used by `/dev/command` (`DevCommand.tsx:147`). A signed-in member without `exafy_admin` gets 403 on enforce, and `useTaskStream` polls every 10 s forever.
Suggestion: treat 401 and 403 as "stop polling, show access-denied state" in `taskApi`/`useTaskStream`; add a vitest case.

F10 [minor] Rollback flips staging back to log while the smoke suite expects 401.
Evidence: step B changes `smoke/gateway.json:13` to `expect_status: 401`. Setting `LEDGER_READ_AUTH_MODE=log` on staging (the documented rollback) then fails STAGING-VERIFY on every run.
Suggestion: note in section 4 that rollback on staging must be paired with reverting the smoke expectation, or write the smoke entry with `expect_status` accepting 200 and 401 and put the strict 401 assertion in the per-VTID `staging-tests.json` only.

F11 [minor] The 20,000-char `run:` cap on the staging deploy step is "at the limit" but never measured.
Evidence: the plan says roughly 60 chars fit; `AWS-STAGE-DEPLOY-GATEWAY.yml:853-870` shows the step already carries long rationale comments, and VTID-04677 states the step is at the limit.
Suggestion: state the current character count (from the helper in `staging-deploy-workflow-bash-syntax.test.ts`) in the plan, and put all rationale text in the workflow's top-level YAML comments, not inside the bash body.

F12 [minor] Ten open decisions (D1 to D10) conflict with the Autonomy Contract's "one message, nothing else asked".
Evidence: CLAUDE.md Autonomy Contract: "choose the most conservative option ... list under Decisions taken". D4, D5, D6, D7, D8 and D10 are implementation choices with a stated recommendation.
Suggestion: fold those into "Decisions taken" using the stated recommendation, and keep only D1 (scope), D2/D3 (who may read, Cognito) and D9 (write-side gaps) as owner questions.

F13 [minor] The board adapter's route-level `cors(corsOptions)` and the new gate need a stated order.
Evidence: `board-adapter.ts:118` is `router.get('/', cors(corsOptions), handler)`. If the gate runs first, a 401 from an allowlisted cross-origin caller lacks that route's CORS headers.
Suggestion: specify `cors(corsOptions), requireLedgerReadAuth, handler`, and make the wiring test assert that order for the board route.

F14 [minor] The production proof lines in section 5 need to be reconciled with CLAUDE.md rule 48.
Evidence: rule 48 allows only unauthenticated GETs of health and build-info on production. Section 5 plans "Post-deploy CURL_PROOF on production: anonymous read still 200" and, after step D, an anonymous 401 probe of a ledger route.
Suggestion: say the production proof is (1) `/api/v1/vtid/health` and `/api/v1/admin/build-info` anonymously, and (2) a single owner-run, token-bearing read recorded in acceptance.md, not an automated suite, and cite rule 48.

F15 [minor] `mcp/vitana-work` is not mentioned.
Evidence: `mcp/vitana-work/src/lib/gateway-client.ts:72-73,89,113,246` call `GET /api/v1/oasis/vtid-ledger` with `VITANA_API_KEY`, default base URL a dead Cloud Run host.
Suggestion: add one line to section 2: the package is unused or decommissioned (verify with `git log -3 -- mcp/vitana-work`), or list the env var it must be set to.

## Questions for the planner

1. Which question did the owner's "yes" (message 7) answer? The verbatim messages ask that your own access to the gateway be authenticated ("should you be", "set it up every access must be authenticated"). Gateway-side enforcement on the ledger reads is not stated there. Quote the question and state whether server-side enforcement was what the owner approved. If the "yes" only covered session-side auth, that part is already done by the standing rule and this plan is new scope.
2. Does the ORB task-state path (`task-state-query-service.ts:305`) work today on staging and production? What is `GATEWAY_BASE_URL` in both task definitions?
3. Do the real Command Hub operators (the plan says about three) have `app_metadata.exafy_admin` true? The log lines will show it, but say whether anyone has checked.
4. Is the deletion of the legacy `debug.html` fetch acceptable, or must the file stay?

## Verdict

NOT CONVERGED (round 1). One blocker (F1), four majors (F2 to F5), and ten minors. Two points on intent need an answer from the planner, and the owner is asked for them only if the planner cannot settle them from the code: (a) whether server-side enforcement on ledger reads was the owner's request (Question 1) and (b) whether to include events and specs reads in scope (F3, D1). The planner should answer every finding in a "Planner responses" section and send the revision back to this partner for round 2.

---

# Round 2

Plan hash under review: 4437abac6b6855b1aec73a558924d3b763752d68b288d48d32e7ea7ff0eadea4 (revision 2). I recomputed it from the lines between the two marker lines (LF, ASCII only, no trailing newline): it matches the `plan_hash:` line. Read-only review. No gateway, AWS or network call; no test suite run.

## Disposition of round-1 findings

- F1 [blocker] CLOSED. `task-state-query-service.ts:305-320` still sends no Authorization today; section 2b now carries the fix, test and P2. `GATEWAY_BASE_URL` is read only at `:57` in `services/gateway/src` (no other definition).
- F2 [major] CLOSED. `gatewayApiCall` stays opt-in; call sites `vtid-lifecycle-tools.ts:265,286,310,458` and `developer-tools.ts:241,267` match the source. `approvalsApi` (`developer-tools.ts:127-131`) forwards `init` so the opt-in header can be passed.
- F3 [major] CLOSED as acknowledged. Option (b) was one of the two I offered. The Tier 2 table exists with file:line, the residual-exposure sentence is mandatory, and D1 puts the scope to the owner. The directive stays unmet until phase 2; the plan says so.
- F4 [major] CLOSED. `AWS-PROD-DEPLOY-GATEWAY.yml:21-25, 240-256, 362-388, 1402-1425` confirm `env-only` re-registers the current image and applies `env_overrides` last. `:134-140` confirms PUBLISH passes only reason/deploy_mode/expected_commit, so the dispatch is outside PUBLISH, and the plan correctly routes it to the owner (CLAUDE.md IF-THEN rule 26).
- F5 [major] CLOSED in design (P1-P4 and the boot line). P1 itself cannot be checked here. Supporting evidence: `AWS-STAGE-DEPLOY-GATEWAY.yml:836-839` says the prod task definition already maps `GATEWAY_SERVICE_TOKEN`.
- F6 [minor] CLOSED. F7 [minor] CLOSED. F9 [minor] CLOSED. F10 [minor] CLOSED. F12 [minor] CLOSED. F13 [minor] CLOSED. F14 [minor] CLOSED. F15 [minor] CLOSED (mcp/vitana-work recorded dormant).
- F8 [minor] CLOSED. Re-verified `app.js:164-167`: `performRefresh()` runs before the Authorization check at `:176-178`.
- F11 [minor] DISPUTED, and now a blocker (see F16). The planner accepted the finding but the remedy rests on a false premise.

## Verified premises (round 2)

- Plan hash line matches the body → TRUE (recomputed; 4437abac...eadea4).
- Staging register step is ~19,967 chars → TRUE (I measured about 19,962 for the `run: |` block starting at `AWS-STAGE-DEPLOY-GATEWAY.yml:981`, ending before line 1239). Cap is `> 20_000` at `staging-deploy-workflow-bash-syntax.test.ts:128`.
- That block contains "six in-body `#` comment lines (~400 chars)" that can be relocated → FALSE. Lines 981-1238 contain no line starting with `#`. The only `#` characters are bash parameter expansions at `:1000` (`${pair#*:}`). There is nothing to relocate.
- Strip list entry goes "next to `LEDGER_WRITE_AUTH_MODE`" at line 1091 and the pin list holds `LEDGER_WRITE_AUTH_MODE` at 1161 → TRUE (`AWS-STAGE-DEPLOY-GATEWAY.yml:1091, 1161`).
- `index.ts` listen at 1649, `PORT || 8080` at `:9` → TRUE (`index.ts:9, 1649`). `delegatedTokenGuard()` at `:594` → TRUE.
- `evaluateLedgerWriteAuth` is exported and returns 401 for missing/invalid, 403 for non-admin, `service:internal` / `admin:<id>` actors → TRUE (`ledger-write-auth.ts:59-76`). Log mode can distinguish 403 from 401 by `result.status`.
- Command Hub interceptor refreshes before checking for an Authorization header → TRUE (`app.js:164-169`, replay check at `:176`).
- `debug.html:25` anonymous `fetch('/api/v1/tasks')`, `:37` events → TRUE (`debug.html:23-37` in the read output).
- `gemini-operator.ts:5569-5599` sends `SUPABASE_SERVICE_ROLE` as apikey and bearer → TRUE. The claim that this "is not the gateway token and would be rejected" → UNVERIFIED, probably FALSE (F18).
- PUBLISH cannot carry `env_overrides`; `env-only` mode exists → TRUE (`AWS-PROD-DEPLOY-GATEWAY.yml:134-140, 248-256`).
- The prod workflow has no `GATEWAY_SERVICE_TOKEN` or `LEDGER_WRITE_AUTH_MODE` text → TRUE (grep: no match).
- E2E Playwright users are `exafy_admin: true` → TRUE (`e2e/global-setup.ts:48-65`), so the browser suites do not break under enforce. The plan does not mention them; worth one line.

## Findings (new in round 2)

F16 [blocker] The staging workflow size mitigation is based on a false premise, and step B cannot fit as written.
Evidence: the plan (section 3, "Risk, measured (F11)") says the register step is ~19,967 of 20,000 chars and that moving "six in-body `#` comment lines (~400 chars)" to top-level YAML comments makes room. The block at `AWS-STAGE-DEPLOY-GATEWAY.yml:981-1238` has no `#` comment lines (checked line by line), so that relocation frees nothing. Measured size is ~19,962. The strip-list entry (`,"LEDGER_READ_AUTH_MODE"`, ~24 chars) fits in step A with ~14 chars to spare; the pin line (`{name:"LEDGER_READ_AUTH_MODE", value:"enforce"},` plus its indentation, ~70 chars) in step B pushes the step to ~20,050-20,060 and `staging-deploy-workflow-bash-syntax.test.ts:128` fails. The plan forbids raising the cap and forbids splitting the step, so as written the step B PR cannot pass CI. Work-plan step 6 and test plan 7 both depend on this.
Suggestion: delete the "relocate comments" instruction. Replace with one of these, chosen in the plan: (a) re-indent the jq arrays inside the block. Lines such as `:1085-1092` carry ~46 leading spaces each, jq ignores whitespace, and trimming indentation on the strip and pin lists frees several hundred chars; the size test is the check. (b) Follow the prod precedent (`AWS-PROD-DEPLOY-GATEWAY.yml:861-864`, VTID-04824): move a block of existing pins to its own step. State the chosen option, and add "measure with the jest helper after each edit; step B is blocked until the measured size is at most 19,900" to the work plan. Also correct the Section 3 text and the "required first action in step A".

F17 [minor] Inserting the new strip entry next to `LEDGER_WRITE_AUTH_MODE` breaks an existing test.
Evidence: `test/vtid-04677-scheduled-notifications-auth.test.ts:215` asserts the contiguous string `"LEDGER_WRITE_AUTH_MODE","SCHEDULED_NOTIFICATIONS_AUTH_MODE",` in the stage workflow. The plan says the new name goes "next to `LEDGER_WRITE_AUTH_MODE`" (line 1091).
Suggestion: append `"LEDGER_READ_AUTH_MODE"` after `"SCHEDULED_NOTIFICATIONS_AUTH_MODE",` (or at the end of the line), and list `vtid-04677-scheduled-notifications-auth.test.ts` in the named jest run.

F18 [minor] The claim that `gemini-operator` sends "not the gateway token" is unverified and probably wrong.
Evidence: `AWS-STAGE-DEPLOY-GATEWAY.yml:836-839` and `:999` map `GATEWAY_SERVICE_TOKEN` to the Secrets Manager secret `vitana/supabase/prod/service-role-key`, and `:495-496` says the staging task already carries the prod project's `SUPABASE_SERVICE_ROLE`. If both variables hold the same key, the two approvals self-calls at `gemini-operator.ts:5569,5593` already match the gateway token and are not "rejected". The fix (use `serviceAuthHeaders()`) is still fine, but the reason is wrong, those two calls will not show up as would-reject lines, and the owner should know that "the service token" is the Supabase service-role key.
Suggestion: reword section 2b to "currently relies on the Supabase service-role key matching `GATEWAY_SERVICE_TOKEN`; switch to `serviceAuthHeaders()` so the dependency is explicit", and add one line to the Gate 1 message stating that the gateway service token is the Supabase service-role secret (so P4 and the read gate carry that exposure).

F19 [minor] The section 2f "reproducible" grep misses two of the Tier 1 routes.
Evidence: the pattern `vtid/(list|projection|allocator)` matches neither `GET /api/v1/vtid/:vtid` (#7) nor `/api/v1/vtid/:vtid/execution-status` (#10). A wider search (`api/v1/vtid/\$`, `execution-status`) finds only `mcp/vitana-work/src/lib/gateway-client.ts:133` (`getWorkOrder`, dormant) outside routes and tests, so no live caller is missed today, but the command recorded in commands.log would not prove that at the implementation HEAD.
Suggestion: extend the pattern with `|api/v1/vtid/(\$|[A-Z]+-)|execution-status` and add `gateway-client.ts:133` to the dormant list.

## Questions for the planner

1. After F16, which size option do you choose (re-indent jq, or split a block as VTID-04824 did)? Either is acceptable; the plan must name one.
2. Should the Playwright suites under `e2e/` (Command Hub projects, `exafy_admin` users) be listed as verified-unaffected callers? I found no break.

## Verdict

NOT CONVERGED (round 2). One blocker (F16, false premise in the workflow size fix) and no open majors; 3 new minors (F17-F19). All of round 1 is closed except F11, which F16 replaces. Cap is 3 rounds; fixing F16 and answering F17-F19 should converge in round 3.

---

# Round 3 (final, cap reached)

Plan under review: revision 3, body between `<!-- plan:begin -->` and `<!-- plan:end -->` plus the "Planner responses" rounds 1 and 2. The `plan_hash:` line reads `PENDING (recomputed in finalize)` by the planner's stated instruction, so I could not compare a hash; the planner must hash the final text once at finalize. Read-only review: no gateway, AWS or network call, no test suite run, no shell command (the one shell call I attempted was declined; everything below comes from reading files).

## Disposition of earlier findings

- F1-F10, F12-F15 [closed in round 2]: unchanged, still closed. I re-read the revision-3 text for them and found no regression.
- F11 [was disputed]: CLOSED, superseded by F16.
- F16 [blocker]: CLOSED. The plan dropped the false "relocate comments" instruction and chose option (a), re-indenting the jq arrays, with a measured gate of at most 19,900 before step B and a stop-and-report fallback. I checked the arithmetic against `AWS-STAGE-DEPLOY-GATEWAY.yml:981-1238`. The strip-list continuation lines inside `IN(...)` sit at 46 raw spaces, which is 36 after the 10-space YAML indent. I count 30 such lines in the environment strip list and 7 in the secrets strip list, so 37 lines. Reclaim is (36-12) x 37 = 888, matching the plan. All 37 lines are inside the single-quoted jq program and outside string literals, so whitespace-only trimming is safe for jq and bash. A grep of the `*workflow*.test.ts` files for long space runs or indentation-sensitive regexes found none. The remaining risk is tests in the other ~90 files that read this workflow, and the plan already gates that with the full `npx jest`. I could not measure the 19,967 figure without a shell; the plan says the jest helper wins if it disagrees.
- F17 [minor]: CLOSED. Line 1091 reads `"FEEDBACK_AUTO_DISPATCH_ENABLED","LEDGER_WRITE_AUTH_MODE","SCHEDULED_NOTIFICATIONS_AUTH_MODE",` and `test/vtid-04677-scheduled-notifications-auth.test.ts:215` asserts the contiguous `"LEDGER_WRITE_AUTH_MODE","SCHEDULED_NOTIFICATIONS_AUTH_MODE",`. Appending after `SCHEDULED_NOTIFICATIONS_AUTH_MODE",` keeps it intact, and the test is now in the named jest run.
- F18 [minor]: CLOSED. `AWS-STAGE-DEPLOY-GATEWAY.yml:999` and `:1195` map `GATEWAY_SERVICE_TOKEN` to `vitana/supabase/prod/service-role-key`; `:836-839` and `:495-497` say what the plan says. The reworded 2b and the Gate 1 sentence are accurate.
- F19 [minor]: CLOSED. `mcp/vitana-work/src/lib/gateway-client.ts:132-133` is `getWorkOrder` calling `GET /api/v1/vtid/${vtid}`, and the plan lists it as dormant.

## Verified premises (round 3)

- `gemini-operator.ts` approvals self-calls go to `http://localhost:${PORT||8080}/api/v1/approvals/{pending,count}` with `apikey` and `Authorization` set to `SUPABASE_SERVICE_ROLE` → TRUE (`gemini-operator.ts:5568-5586, 5594-5600`). The request goes to the gateway, not to Supabase, so dropping `apikey` is safe.
- Playwright setup users have `app_metadata.exafy_admin = true` → TRUE (`e2e/global-setup.ts:49, 63`).
- `lib.cjs` supports `expect_status` on GET and defaults to 200 → TRUE (`scripts/ci/staging-verify/lib.cjs:132, 267`); the 401 precedent is the "community members requires auth" smoke entry.
- The Command Hub token key `vitana.authToken` is what `performRefresh` stores → TRUE, but at `app.js:125`, not "~104" (lines 95-103 are the `storage` event listener). Cosmetic (F21).
- `docs/validation/VTID-04727/staging-tests.json` line 8 has "task reads stay open", an anonymous GET of `/api/v1/oasis/tasks/VTID-04727` expecting 200 → TRUE.
- The plan's claim in 2c that "STAGING-VERIFY runs only the current PR's VTID file and the smoke set" (to be confirmed in step 9) → FALSE. `scripts/ci/staging-verify/run.mjs:324-328` lists every commit between the production baseline and the verified sha (`commitsBetween`), loads the `staging-tests.json` of every VTID named in those commit subjects, and `lib.cjs:197-229` (`planRange`) puts each manifest in `suites`. `.github/workflows/STAGING-VERIFY.yml:17-19` says the same. See F20.

## Findings (new in round 3)

F20 [major] The rollout order lets STAGING-VERIFY fail on earlier anonymous-200 probes after step B, and the plan's assumption about how STAGING-VERIFY picks suites is false.
Evidence: STAGING-VERIFY runs the change suite of every VTID in the range production..verified-sha (`run.mjs:324-328`, `lib.cjs:197-229`). The plan's own test plan 9 says step A's STAGING-VERIFY asserts that "anonymous reads still 200 in log mode". If step A's `staging-tests.json` carries any anonymous Tier 1 GET expecting 200, it stays in the range until step A reaches production through PUBLISH. Step B (staging enforce) then makes that probe return 401, and every STAGING-VERIFY run fails until step A is published, which the plan orders after the soak. The same applies to `docs/validation/VTID-04727/staging-tests.json:8` ("task reads stay open", 200) if the 04727 commit is not yet in production, which the plan did not check. A failed STAGING-VERIFY blocks Gate 2 for step B and for every unrelated change that lands on staging meanwhile (CLAUDE.md rules 46 and 50 forbid loosening a test to get green). The plan's "not verified" note in 2c tells the implementer to confirm the opposite of what the code does.
Suggestion: (1) Replace the 2c sentence with: "STAGING-VERIFY runs the suite of every VTID between production and the verified commit (run.mjs:324-328); before step B, list `docs/validation/*/staging-tests.json` for the VTIDs in that range and confirm none expects 200 from an anonymous Tier 1 GET." (2) Constrain step A's `staging-tests.json`: only `kind: http` probes on health routes plus `kind: existing` jest references, with no anonymous 200 on a Tier 1 route (log mode is proven by unit test, as the plan already says). Drop the "anonymous reads still 200" wording from work-plan step 9. (3) Add a hard ordering rule to section 4: step B merges only when step A and the 04727 commit are in production (read the production stamp and compare, as `describeBaseline` does), or the 04727 probe on `/api/v1/oasis/tasks/VTID-04727` is confirmed outside the range. If it is inside the range, step B's PR must wait for PUBLISH of A; do not edit the 04727 file.

F21 [minor] Wrong line reference for the token storage key.
Evidence: section 2a says the key is written "in `performRefresh`, app.js:~104"; the write is `app.js:125` (`localStorage.setItem('vitana.authToken', data.access_token)`).
Suggestion: change the reference to `app.js:125`.

## Questions for the planner

1. Is the 04727 commit already in production? The answer decides whether the 04727 probe can break step B (F20).

## Verdict

NOT CONVERGED, ESCALATED (round 3 of 3, cap reached). Open: F20 [major], F21 [minor]. F16 closed; F17-F19 closed. F20 is a text-and-ordering fix that does not need a new design, but the cap is spent, so the owner decides at Gate 1 whether to accept the fix as written in the Suggestion (recommended) or order one more pass. What the owner must decide: (a) accept the F20 fix (step A's suite has no anonymous Tier 1 200 probe, and step B waits until A and 04727 are published), plus the D1, D2/D3 and D9 questions already in the plan. Per `owner-preapproval.md`, an `escalated` verdict is outside the pre-approval, so it comes back to the owner.
