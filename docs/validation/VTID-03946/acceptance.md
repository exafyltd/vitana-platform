# VTID-03946 — Operator: fix cross-repo blind spot + 384KB search blind spot

Reported live by the user, sharing a real Operator Console conversation:
asked Operator to scope a frontend change, and Operator replied *"I don't
yet see where the actual console UI lives"*, asking 8 clarifying questions
(repo path, framework, stack, etc.) for something the codebase already
answers — after `dev_search_codebase` for "Operator Console" returned only
backend/gateway files.

## Root cause — two independent, stacked defects

1. **`dev_search_codebase`/`dev_read_file` were hardcoded to a single repo**
   (`exafyltd/vitana-platform`, `OPERATOR_DEFAULT_REPO`), with no parameter
   to reach `exafyltd/vitana-v1` at all — the separate repo holding the
   actual consumer-facing Vitana app frontend. This repo's own frontend is
   only the internal Command Hub admin console
   (`services/gateway/src/frontend/command-hub/app.js`). Raised directly by
   the user mid-investigation.

2. **GitHub's Search Code API excludes files over 384KB from its index.**
   `app.js` is ~2.5MB. Reproduced live via the real API (the same endpoint
   `dev_search_codebase` calls): searching `Operator Console` across
   `exafyltd/vitana-platform` returned 263 hits — zero from `app.js`, even
   though that file contains the literal string `'Operator Console'`
   (`renderOperatorOverlay()`: `title.textContent = 'Operator Console';`).
   No query wording could ever surface content inside that one file via
   this tool — a structural tool limitation, not evidence the content
   doesn't exist.

Both defects independently explain the reported symptom; either alone
would have produced it.

## Fix

`services/gateway/src/services/gemini-operator.ts`:

- [x] `dev_search_codebase`/`dev_read_file` gained an optional, allowlisted
      `repo` parameter (`exafyltd/vitana-platform` default, or
      `exafyltd/vitana-v1`). Any other value is rejected outright
      (`unknown_repo`) — never accept an arbitrary repo string from the
      model.
- [x] The `exafyltd/vitana-v1` path reuses the already-provisioned
      `FRONTEND_DEPLOY_TOKEN` (existing credential for the PUBLISH-button
      frontend promotion, CLAUDE.md §8) rather than requesting a new one —
      resolved lazily at call time (`operatorRepoToken()`), not frozen at
      module load, so a task-def env change takes effect without a
      restart, matching this repo's own `BEDROCK_ROLE_ARN` convention
      (CLAUDE.md §2b).
- [x] Missing `FRONTEND_DEPLOY_TOKEN` fails loudly
      (`repo_token_not_configured`) rather than silently falling back to
      the wrong (vitana-platform) token, which would 404/401 confusingly.
- [x] Default-repo call shape is unchanged — still exactly 3 positional
      args to `searchCode`/`getFileContents` — so VTID-03835's own tests
      needed zero changes.
- [x] Both tool descriptions and `CODEBASE_OVERVIEW_BLOCK` (the always-on
      orientation block, VTID-03930) now explicitly state: two repos exist,
      most frontend/UI code lives in `vitana-v1` not `vitana-platform`, and
      `dev_search_codebase` always returns zero hits inside `app.js`
      specifically — use `dev_read_file` with an explicit path there
      instead of concluding the content is missing.

---

AC-1 — `dev_search_codebase`/`dev_read_file` still default to
`exafyltd/vitana-platform` with the exact pre-existing 3-arg call shape
when `repo` is omitted

TEST: `test/vtid-03946-operator-cross-repo-search.test.ts` — "still defaults
to vitana-platform with a 3-arg call when repo is omitted" (both tools)
Output: outputs/targeted-tests.txt

AC-2 — passing `repo: 'exafyltd/vitana-v1'` routes to that repo with the
`FRONTEND_DEPLOY_TOKEN` override

TEST: `test/vtid-03946-operator-cross-repo-search.test.ts` — "routes to
vitana-v1 with the FRONTEND_DEPLOY_TOKEN override when repo is passed"
(both tools)
Output: outputs/targeted-tests.txt

AC-3 — an unlisted/arbitrary repo string is rejected without ever calling
GitHub

TEST: `test/vtid-03946-operator-cross-repo-search.test.ts` — "rejects an
unlisted repo without ever calling GitHub" (both tools)
Output: outputs/targeted-tests.txt

AC-4 — a missing `FRONTEND_DEPLOY_TOKEN` fails loudly instead of silently
using the wrong token

TEST: `test/vtid-03946-operator-cross-repo-search.test.ts` — "fails loudly
rather than silently using the wrong token when FRONTEND_DEPLOY_TOKEN is
unset" (both tools)
Output: outputs/targeted-tests.txt

AC-5 — no regression to VTID-03835's own pre-existing test suite (role
gating, kill switches, default-repo search/read, error surfacing)

TEST: `test/vtid-03835-operator-console-read-tools.test.ts` (full file, all
20 tests, unmodified)
Output: outputs/targeted-tests.txt

AC-6 — mutation-verified: reverting the fix reproduces the exact bug shape
and fails 6 of the 8 new tests (the 2 default-repo-path tests still pass
unaffected, since they don't exercise new behavior)

TEST: manual mutation check — `git stash` (reverting the fix) → re-ran
`test/vtid-03946-operator-cross-repo-search.test.ts` → 6/8 tests failed.
`git stash pop` restored the fix and all 8 tests passed again.

AC-7 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest --runInBand` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
Note: both show the same pre-existing failures/errors already documented
in this session's own VTID-03927/03933/03934/03937/03944 evidence packs
(missing `@aws-sdk` sub-packages in local `node_modules`, declared in
`package.json`, not referenced by any file this VTID touches). Zero
failures in `gemini-operator.ts` or the new test file.

AC-8 — the reported live failure is reproduced against the real GitHub
Search Code API, not assumed

TEST: live API call — `repo:exafyltd/vitana-platform Operator Console` via
the real GitHub Search Code API (same endpoint `dev_search_codebase`
calls) returned 263 hits, zero from `services/gateway/src/frontend/
command-hub/app.js`, despite that file containing the exact literal string
searched for. Confirms the 384KB exclusion is real, not a query-wording
theory.
Output: reproduced interactively via the session's own GitHub tool access;
raw result recorded in this VTID's PR description.
