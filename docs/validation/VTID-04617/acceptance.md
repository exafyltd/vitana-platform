# VTID-04617 — the agent runner runs the tests that read a changed frontend asset

Observed 2026-09-26 on staging, operator test task VTID-04614 (Command Hub
Autopilot Live failure-reason recency, execution d085fdd6, PR #3736): the
agent changed `app.js`, `styles.css` and `index.html`. Before opening the PR,
the runner re-verified with `selectJestTargets`, which only pairs a changed
`.ts` source with `<name>.test.ts`. It therefore ran one suite, the agent's
own new test. Running every suite that names those files against the branch
showed three failures (VTID-04334, VTID-04354 and VTID-04491 cache-bust
pins), all of which CI would catch after the PR was opened.

Rule now: for a changed file under `services/<p>/src/frontend/**` that is not
TypeScript, the runner also runs every test file under `services/<p>/test`
whose source names that file's basename, merged with the paired suites.

## Acceptance criteria

AC-1: `selectAssetReferencingTests` returns exactly the suites naming a changed frontend asset and ignores TypeScript sources and other paths.
TEST: services/gateway/test/vtid-04617-runner-asset-tests.test.ts

AC-2: `selectRunnerJestTargets` merges the paired and asset-reading suites per project, and equals the paired selection when no asset changed.
TEST: services/gateway/test/vtid-04617-runner-asset-tests.test.ts

AC-3: end to end over the in-memory platform, an operator run that edits the Command Hub `app.js` has its runner jest target include the suite that reads `app.js` and exclude an unrelated suite (rule 42f scenario, mutation-checked: reverting the wiring makes it fail).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-4: the existing runner selection and scope checks are unchanged.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts
