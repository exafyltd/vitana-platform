# Platform review: VTID-05063 step A (vitana-platform half)

Worktree: `.worktrees/vtid-05063-ledger-read-auth`, branch `VTID-05063-ledger-read-auth`, base 62383c10d.
Method: reading only. Git was not run, so the changed-file list comes from the plan scope list, `docs/validation/VTID-05063/commands.log`, and a content search for `VTID-05063` / `requireLedgerReadAuth` across the worktree. Nothing was run; CI runs the tests later.
Process note: I called the shell twice by mistake (two no-op `echo` calls) before correcting myself. They touched nothing and read nothing.

**Verdict: CHANGES_REQUESTED** (1 blocker, 1 major, 8 minors)

## Blocker

**B1. Command Hub Path Ownership Guard will fail closed.** (confirmed)
The change edits `services/gateway/src/frontend/command-hub/app.js` and `debug.html`. `COMMAND-HUB-GUARDRAILS.yml:44` runs `scripts/ci/command-hub-ownership-guard.js`, which exits 1 for any change under `PROTECTED_PATH` (line 15) unless the branch name or PR title matches `ALLOWED_VTID_PATTERN` (line 1042, matched case-insensitively). `VTID-05063` is not in that pattern, and the pattern has no generic `VTID-0xxxx` entry. Only `DEV-COMHU-\d+` and a list of named VTIDs match. The branch `VTID-05063-ledger-read-auth` does not match any alternative. Every earlier Command Hub VTID registered itself there, and `test/console-task-17-cost-badge-tooltip.test.ts:179` states the consequence ("the ownership guard fails closed on the Command Hub path").
The plan scope list does not name this file, but the change cannot pass without it.
Fix: add `VTID-05063` to the front of `ALLOWED_VTID_PATTERN` and add the usual history comment above it.

## Major

**M1. `index.html` cache-bust not bumped, so operators keep the old `app.js`.** (confirmed)
`index.html:17` still loads `/command-hub/app.js?v=20261109-vtid-05006`. `index.ts:1603-1611` serves `.js` and `.css` under `/command-hub` with `Cache-Control: public, max-age=31536000, immutable`. The comment at `index.ts:1593-1600` calls the `?v=` bump "an enforced discipline whenever those files change". A browser that already cached that URL will never fetch the edited `app.js`. It keeps the 13 call sites without `buildContextHeaders()` and the interceptor without the F8 guard for up to a year. For step A this means false "unknown caller" would-reject lines in the measurement window. For step B it means 401s and the logout and refresh-token burn the plan was meant to prevent. This is exactly the failure the plan's Command Hub work exists to remove.
Fix: bump `app.js?v=` and `styles.css?v=` to the same new value in `index.html` (several command-hub tests require the two to stay equal and compare the value with `>=`; for example `test/command-hub/t5b-gcp-static-screens-gated.test.ts:223`, `escape-html.test.ts:140`). `index.html` is not on the plan scope list; add it to the scope.

## Minor

**m1. PR-GATE evidence gaps (report-only today).** (confirmed)
`docs/validation/VTID-05063/plan-sparring.md` has the verdict (ESCALATED) and the plan hash (line 11), but no owner-approval line. `lib.mjs:157` requires `/owner approval/i`. The `owner_approval:` line the scribe wrote lives only in `.agents/tasks/.../plan-sparring.md`, and with an underscore it would not match anyway. There is also no `docs/validation/VTID-05063/scope.json` (`gate.mjs:77` reports it missing). `scripts/ci/pr-gate/config.json` has `enforce: false`, so this is a warning for now. Add the approval line and a `scope.json`; the scope should list the files in B1, M1 and m2 too.

**m2. Out-of-plan edit: `scripts/ci/impact-rules/new-route-without-auth-middleware.mjs:74-77`.** (confirmed)
It adds `requireLedgerReadAuth` to the auth allow-list. It is needed (the impact rule would otherwise flag every gated `router.get(` line as an unauthenticated new route) and it mirrors VTID-04727. It is not on the plan scope list, so record it in `scope.json` and the PR description.

**m3. `debug.html` is never served.** (confirmed)
`index.ts:1591-1592` mounts `denyCommandHubBackupFiles`, which 404s exactly `/debug.html` (`middleware/command-hub-backup-denylist.ts:31`). The line 25 bearer fix and its static-test coverage are correct but inert, and the plan's "it is a served static file" is wrong. No code action needed. Correct the statement in acceptance.md or the PR text. The file still adds the B1 guard trigger, so consider reverting the `debug.html` edit to shrink the Command Hub footprint.

**m4. Boot-line wiring test is weaker than its title.** (confirmed)
`test/vtid-05063-ledger-read-auth.test.ts:315-318` anchors on `index.indexOf('app.listen(PORT')`. The first match is the redirector listener at `index.ts:53`, so the assertion only proves the call sits after line 53. It does not prove it is inside the main listen callback (`index.ts:1664`). The call itself is correctly placed at `index.ts:1673`. Anchor on `const server = app.listen(PORT`.

**m5. Evidence in `commands.log` is thinner than plan work-step 1.** (confirmed)
It records the classified caller list, not the raw grep output. It has no dynamic-path `$GATEWAY/...` grep over `.github` and `scripts`, and no measured register-step size. The size is an upper bound only: base cap 20,000, minus 240 re-indented spaces, plus 24, gives at most 19,784. The plan expected about 888 chars reclaimed from 37 lines; only ten lines were re-indented. That still meets the 19,900 target by the bound, and the new test asserts it in CI. My independent content search found no uncovered Tier 1 caller outside the plan list (`mcp/vitana-work` is dormant by decision). The whitespace-only claim for the ten lines cannot be diffed here. Expect the full `npx jest` run to confirm it (90 test files read this workflow).

**m6. Stale warning text in `scripts/ci/vtid-auto-close.cjs:146`.** (confirmed, cosmetic)
It still says the token matters only for "LEDGER_WRITE_AUTH_MODE=enforce". The read now needs the token under `LEDGER_READ_AUTH_MODE=enforce` too.

**m7. New log volume from `optionalAuth` on read polls.** (possible)
`auth-supabase-jwt.ts:337` logs `[VTID-03292] JWT verified via JWKS (ES256)` for every ES256 token it verifies. The gate now runs that verifier on each Command Hub poll (tasks every 5 s, approvals every 20 s) in log and enforce mode, so each poll can add a log line. Check CloudWatch volume in the log-mode window. This is not a correctness problem.

**m8. Command Hub symbol index not regenerated.** (possible)
`services/gateway/specs/command-hub-symbol-index.json` carries line ranges for `app.js` functions. Earlier Command Hub VTIDs regenerated it (`docs/validation/VTID-05004/commands.log:6-7`). I found no CI gate that checks it, so this is a navigation-aid nit.

## What I checked and found correct

- **Scope vs plan.** Created: `middleware/ledger-read-auth.ts`, four `vtid-05063-*.test.ts` files, and `docs/validation/VTID-05063/{acceptance.md,commands.log,plan-sparring.md,staging-tests.json}`. Edited: `index.ts` (boot line only), the six route files, `vtid-lifecycle-tools.ts`, `developer-tools.ts`, `task-state-query-service.ts`, `gemini-operator.ts`, `app.js`, `debug.html`, `vtid-auto-close.cjs` and its test, `AWS-STAGE-DEPLOY-GATEWAY.yml`, `test/vtid-04727-ledger-write-auth.test.ts` (title only), `CLAUDE.md`, `.claude/rules/infrastructure.md`, `docs/CHANGELOG.md`. Not touched, as required: `AWS-PROD-DEPLOY-GATEWAY.yml` (no `LEDGER_READ_AUTH_MODE` in it), `smoke/gateway.json` (line 13 still has no `expect_status`), `conversation-flag-pins.generated.ts` (no read pin), `gatewayApiCall` (still credential-free by default), mounts in `index.ts`.
- **Compile level.** `ledger-read-auth.ts` imports `evaluateLedgerWriteAuth` and `LedgerWriteAuthResult` that `ledger-write-auth.ts` exports. Mode semantics match the write gate (only `enforce` and `off` are special). `res.status(result.status ?? 401)`, the two-argument `.then`, `Request & { route? }` and the Map eviction type-check by reading. The per-route imports use the same relative paths and quote style as their files. `serviceAuthHeaders` is imported where used (`gemini-operator.ts:61`, `developer-tools.ts:24`, `task-state-query-service.ts:25`). `approvalsApi` already accepts `{ headers }`. `index.ts` uses the same inline `require` style as its neighbours.
- **Gate coverage.** All 14 Tier 1 GET registrations carry `requireLedgerReadAuth`: oasis-tasks 3, oasis-vtid-ledger 1, vtid 4 (`/allocator/status`, `/list`, `/projection`, `/:vtid`), tasks 3, board 1, approvals 2. The board route is `cors(corsOptions), requireLedgerReadAuth` (`board-adapter.ts:123`). Open routes stay open: `/api/v1/vtid/health` (`vtid.ts:469`), approvals `/feed` (`approvals.ts:481`), the OPTIONS registrations, terminalize health. There is no `.use(` of the gate in any source file.
- **Callers.** All 13 Command Hub Tier 1 reads in `app.js` send `buildContextHeaders()`; board is unconditional (`12686-12688`). The interceptor guard sits between the 401 check and `performRefresh()` (`app.js:165-172`). The four voice lifecycle reads, the two approvals reads, the ORB task-state discover fetch, both gemini-operator approvals calls and the `vtid-auto-close.cjs` read all send `serviceAuthHeaders()`. The gemini-operator calls no longer send the Supabase key to the gateway. The write-side approve/reject calls are untouched. The F21 reference is `app.js:125`, as the plan said.
- **Tests, by reading.** The mocks in `vtid-05063-ledger-read-auth.test.ts` follow the 04727 pattern. The dedupe, cap and sanitiser expectations match the implementation. The supertest file mounts routers in production order, and the shared `test/__mocks__/setup-tests.ts` supplies the `global.fetch` mock. The self-call test's Supabase stub matches `fetchVtidLedgerRowByCandidates`. The scanner fixtures behave as described. The `vtid-auto-close.test.cjs` cases pass by reading. The `vtid-04727` write-count regex still sees six writes. Nothing was run.
- **F-items.** F20: `staging-tests.json` holds two health probes plus two `existing` jest refs, with no anonymous Tier 1 probe. F16: the strip-list entry is appended after `SCHEDULED_NOTIFICATIONS_AUTH_MODE` (04677 contiguity kept), and the rationale comment sits above `run:` rather than inside it. The residual-exposure sentence is in `acceptance.md` and the CHANGELOG states the Tier 2 gap.
- **Secrets.** A pattern search of the new files found no JWT, key or bearer value. Tests use `svc-token` and `very-secret-service-token-value` as fixtures. Docs name only the Secrets Manager path, never a value.

## Not verified

- Anything that needs execution: jest, `tsc`, `bash -n`, and the measured size of the register step. The 19,900 bound is computed, not measured.
- That the ten re-indented jq lines changed whitespace only (no diff available).
- Whether the `app.js` fetch scanner mis-parses a regex literal containing a quote inside a Tier 1 call. The conservative fallback window may cover it. The full jest run will show.
- Other changed files I could not enumerate without git. If B1 and M1 were missed because of this, others of the same kind may exist.
