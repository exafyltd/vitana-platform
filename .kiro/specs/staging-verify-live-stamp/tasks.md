# Tasks — staging-verify-live-stamp

<!-- lane: fix -->
## Lane `fix` — commit_sha optional; live-served commit resolved when omitted (vitana-platform)
- [x] F1 `.github/workflows/STAGING-VERIFY.yml`: `commit_sha` input → `required: false`, `default: ''`; header
      comment and `run-name` updated.
- [x] F2 `.github/workflows/STAGING-VERIFY.yml`: move "Checkout runner (vitana-platform main)" and
      `actions/setup-node@v4` to the top of `steps:`; add "Checkout target main for live-served commit lookup
      (gateway)" and "… (community-app)", each gated on `env.SERVICE`, `github.event_name == 'workflow_dispatch'`
      and `inputs.commit_sha == ''`.
- [x] F3 `.github/workflows/STAGING-VERIFY.yml`: "Resolve commit under test (VTID-04715)" gets one new `elif`
      branch — reachable only when `commit_sha` was omitted — that runs `run.mjs stamp` and validates its result;
      the existing `deployed-commit` branch and the final fallthrough (incl. an explicit `commit_sha`) are
      byte-for-byte unchanged.
- [x] F4 `scripts/ci/staging-verify/workflow.test.cjs`: static cases for F1/F2, plus behavioral cases that extract
      the real "Resolve commit under test" script text and execute it (fake `node` on PATH) for: `commit_sha`
      omitted (lookup called, result used), `commit_sha` given (lookup never called), a VTID-04709 pinned rollback,
      a plain `workflow_run`/`repository_dispatch` deploy (both regression-only, lookup never called), and the
      lookup failing (fails loudly, `SHA` never written). Written to fail on `main`, pass after F1–F3.

**Acceptance (reviewer agent):**
- Only `.github/workflows/STAGING-VERIFY.yml` and `scripts/ci/staging-verify/workflow.test.cjs` change.
- `node --test scripts/ci/staging-verify/workflow.test.cjs` run against this PR's base commit shows at least the 5
  new/changed cases failing (`commit_sha is optional...`, `an omitted commit_sha gets a full-history checkout...`,
  `the runner and node are available before...`, `` commit_sha omitted (workflow_dispatch): resolves via `run.mjs
  stamp`... ``, `commit_sha omitted and the live commit cannot be resolved...`); the same command on the PR head is
  fully green. Both outputs recorded in `docs/validation/<VTID>/commands.log`.
- `node --test scripts/ci/staging-verify/*.test.cjs scripts/ci/staging-verify/*.test.mjs` (the whole directory) is
  green on the head — no regression in `lib.test.cjs`, `confirm-live.test.mjs`, `deploy-runs.test.mjs`,
  `manifest-drift.test.cjs`, `record-oasis*.test.*`.
- The edited workflow file parses as valid YAML (checked with `js-yaml`) and its `verify` job still has exactly the
  steps named in `plan.md` §"The fix", in the order listed.
- An explicit `commit_sha` on `workflow_dispatch`, a `workflow_run` deploy and a `repository_dispatch` deploy all
  resolve `SHA` exactly as they did before this change (proven by the regression test cases, not just asserted).
- No change to `run.mjs`, `lib.cjs`, any other workflow, any CI variable/secret/token, any production path, any
  migration.
