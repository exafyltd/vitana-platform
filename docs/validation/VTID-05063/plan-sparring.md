# Plan sparring record: gateway ledger read auth

Task folder: .agents/tasks/gateway-ledger-read-auth
Workflow: wf_2ce4e6c0be0ca0cd
Recorded by: SCRIBE (recording only, plan substance unchanged)

## Final verdict

**ESCALATED** (machine verdict file sparring-verdict.json: verdict=escalated, round=3 of cap 3).

- Plan hash (sha256 of the text between the plan markers, LF, UTF-8, no trailing newline; computed by the scribe because the plan.md plan_hash line still reads "PENDING (recomputed in finalize)"): `cc873442955182f743873f958ca461e745bc5720193fcacb7343b9e9d1019686`
- Body non-ASCII character count (hash definition requires ASCII only): 0
- Note: the hash is computed over revision 3 of the plan. The sparring reviewer's round 1 and 2 hashes (fe44de27..., 4437abac...) belong to earlier revisions.

### Open / disputed items for the owner (side by side)

| Item | Reviewer position (round 3) | Planner position | Status |
|---|---|---|---|
| F20 [major] STAGING-VERIFY runs the suite of every VTID between production and the verified commit (run.mjs:324-328, lib.cjs:197-229); plan 2c says the opposite. After step B, unpublished anonymous-200 Tier 1 probes (step A's own suite, or VTID-04727 staging-tests.json:8) would fail STAGING-VERIFY and block Gate 2. | Correct 2c; keep step A's staging-tests.json to health probes plus kind:existing jest refs; step B merges only after step A and the 04727 commit are in production (or the 04727 probe is confirmed outside the range). Recommended: accept as written. | No planner response: round 3 was the final round (cap reached) and the plan text still carries the old 2c wording and work-plan step 9 "anonymous reads still 200". | OPEN |
| F21 [minor] Section 2a cites app.js:~104; the vitana.authToken write is at app.js:125. | Change the reference to app.js:125. | No planner response (cosmetic). | OPEN |

Reviewer question outstanding: is the VTID-04727 commit already in production? (decides whether the 04727 probe can break step B.)

Per owner-preapproval.md an escalated verdict is outside the pre-approval, so this comes back to the owner.

### Open owner decisions carried in the plan

- D1: scope of "every access": phase 1 closes Tier 1 (13 route groups); Tier 2 (events incl. SSE, specs/:vtid, ops/health/vtid-ledger, self-healing, orchestrator, operator reads) and write-side lifecycle/terminalize gaps are a committed phase 2. Residual exposure stands until then.
- D2/D3: who may read: service token or exafy_admin JWT only; operators without the claim get 403; Cognito identities hardcoded exafy_admin false.
- D9: whether to open a VTID for the write-side gaps and the anonymous next_vtid RPC call on GET /api/v1/vtid/health.
- Plus (from the escalation): accept the F20 fix as written, or order one more sparring pass.

## Files in scope

See plan section 6 (reproduced inside the plan body below). Summary: NEW services/gateway/src/middleware/ledger-read-auth.ts; index.ts (boot line); routes oasis-tasks, oasis-vtid-ledger, vtid, tasks, board-adapter, approvals; orb-tools vtid-lifecycle-tools and developer-tools, task-state-query-service, gemini-operator; Command Hub app.js and debug.html; scripts/ci/vtid-auto-close.cjs (+test); smoke/gateway.json (step B); AWS-STAGE-DEPLOY-GATEWAY.yml (not the prod workflow); conversation-flag-pins.generated.ts (step B); tests; docs; vitana-v1 taskApi.ts, useTaskStream.ts, TasksView.tsx (separate PR).

## Test plan

See plan section 5 (inside the plan body below): unit/route/wiring/supertest tests for the new middleware, self-call tests, Command Hub static test, workflow wiring and size tests, vitest for vitana-v1, staging curl matrix (no-token column automated). Commands from services/gateway: npm run typecheck, npm run build, targeted npx jest then full npx jest; repo root node --test for CI scripts; vitana-v1 npm run test:unit, build, lint.

## Final plan (revision 3, copied between the markers)

<!-- final-plan:begin -->
 and ending at the last character of the line before `
<!-- final-plan:end -->

## Sparring rounds: findings paired with planner responses

# Sparring review: gateway ledger read auth

Plan hash under review: fe44de27999c136dbaf33deaab2d2ce343da140e022b285b6f825d4faca7fd5f
Repos at review time: vitana-platform 5884a7a59, vitana-v1 b0fd64675 (both match the plan header).
Read-only review. No gateway, staging or production call was made; no test suite was run.

---

## Round 1: reviewer findings

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
<<<APPEND_HERE>>>

## Owner approval

Owner approval: APPROVED 2026-10-09 by the owner in the Kiro chat session (reply to the owner message in .agents/tasks/gateway-ledger-read-auth/owner-message.md, which ended "Do you approve this plan?"; the owner answered affirmatively, then instructed "execute this ... only come back when staging is verified" with plan sparring always required), plan hash cc873442955182f743873f958ca461e745bc5720193fcacb7343b9e9d1019686). Approved with: F20 fix as written (step A staging-tests.json = health probes plus jest refs only; step B merges only after step A and VTID-04727 are in production), F21 line reference corrected, phased scope (Tier 1 now; Tier 2 and write-side gaps as a committed phase 2), reads limited to GATEWAY_SERVICE_TOKEN or an exafy_admin JWT. Production enforce needs a separate explicit owner go.

Scope addition after review (sparred in one round, recorded in the PR): `scripts/ci/command-hub-ownership-guard.js` (VTID-05063 added to the allow pattern, required by COMMAND-HUB-GUARDRAILS.yml for any Command Hub path change), `services/gateway/src/frontend/command-hub/index.html` (app.js and styles.css cache-bust bump so operators load the edited app.js), `scripts/ci/impact-rules/new-route-without-auth-middleware.mjs` (allow-list entry for the new gate). `debug.html` is not served (denylisted at /debug.html); its edit is inert.

### Scope-addition sparring result (one round, independent reviewer)

Verdict ESCALATED on one mechanical major and four minors; the reviewer found no widening of the approved blast radius (Tier 1 read gate, log mode, no step B, no production change). Major M1: older `docs/validation/*/staging-tests.json` suites pinned the old `index.html` cache-bust string and would turn STAGING-VERIFY red; fixed by repinning the HTML-path probes to `20261110-vtid-05063` (docs only). Minors: `scope.json` rewritten to the PR-GATE schema (`kind`, `paths`); PR body carries `VALIDATION_PROFILE: gateway_backend`; approval wording made verifiable (this section); the `debug.html` edit is inert because `/debug.html` is denylisted, kept for source consistency and stated in the PR. Full reviewer text: `.agents/tasks/gateway-ledger-read-auth/scope-spar.md`.
