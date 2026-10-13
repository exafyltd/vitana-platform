# VTID-05144 — outputs

Local evidence (no staging, no production, no workflow dispatch):

- `node-test-head.txt` — `node --test` of lib.test.cjs, record-oasis.test.cjs,
  workflow.test.cjs and confirm-live.test.mjs on this branch: 77/77 pass.
- `node-test-new-tests-on-base-code.txt` — the same four test files run against
  the origin/main runner, lib, record-oasis.sh and STAGING-VERIFY.yml: 19 fail
  (every new VTID-05144 case; confirm-live.test.mjs cannot import a
  `confirmLive` export on base), 53 pass (all pre-existing cases). Red → green.
- `jest-head.txt` — gateway Jest: publish-gate, operator-runs-view,
  operator-runs, vtid-05069 pipeline tree, vtid-04715 workflow, vtid-04868
  skill: 6 suites / 100 tests pass.
- `tsc-noemit.txt` — `npx tsc --noEmit -p .` in services/gateway: 3 errors, all
  TS2307 "Cannot find module" for `libphonenumber-js` and
  `@aws-sdk/client-pinpoint-sms-voice-v2` in files this change does not touch;
  the local node_modules predates those dependencies (CI runs `npm ci`). No
  error in publish-gate.ts or run-view.ts.
- `pr-gate.txt` — `scripts/ci/pr-gate/gate.mjs` scope / sparring / weakening /
  red-green against origin/main.

## Staging evidence (AC-12) — to be added after merge, before Gate 2

- Gateway full run with a gateway merge during it: run link, the
  `staging.verify.superseded` event with `metadata.superseded_by`, and the
  chained run (`chain=1`).
- Quiet-window or nightly gateway full run: run link and the
  `staging.verify.passed` event with `metadata.full=true`.
