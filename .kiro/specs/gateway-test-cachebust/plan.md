# Plan — gateway-test-cachebust

Make the gateway Jest suite on `main` green again: one test pins a Command Hub cache-bust tag that a later change
already replaced.

<!-- plan:begin -->
## Problem (verified on `exafyltd/vitana-platform@6bab918f8`)
`services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`, case "the spend route returns the planner
summary and the screen shows it as a chip", asserts
`expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148')`. VTID-05082 (#4182) bumped the tag in
`services/gateway/src/frontend/command-hub/index.html` to `/command-hub/app.js?v=20261121-vtid-05082` and updated the
same pin in four other tests (`test/command-hub/vtid-05067-kiro-console.test.ts:567`,
`vtid-05069-pipeline-tree.test.ts:184`, `vtid-05071-kiro-approval-visibility.test.ts:182`,
`vtid-05084-loops-screen.test.ts:148`), but missed this one. The case's other assertions (the route calls
`summarizePlannerFallback(pv.data || [], devPlannerModel().provider)`; `app.js` has `label: 'Planner fallback 24h'`)
still match, so the planner logic is fine; only the pinned string is stale. Every PR that syncs `main` inherits this
red: `Gateway (Jest, ~7.5k tests)`, `Gateway Service Tests`, `Test Suite Summary` (seen on #4198).

## Change
In that one test, change the pinned string to `/command-hub/app.js?v=20261121-vtid-05082`, the value `index.html` and
the four sibling tests use today. Same convention as the siblings; no other line changes. No product code, no
`index.html` change, no new test, no migration, no route, nothing deployed differently.

## Out of scope
Removing exact-tag pins from tests in general; any change to the planner, `dev-autopilot.ts`, `app.js` or
`index.html`.

## Tests
`npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts` green (was red on that case), and the gateway Jest
suite green in CI. Change suite `docs/validation/<VTID>/staging-tests.json`: one `existing` entry running that file
(test-only change; nothing on staging changes). `kind: "existing"` is a runner kind
(`scripts/ci/staging-verify/lib.cjs:169`), used by e.g. `docs/validation/VTID-05209/staging-tests.json` and
`VTID-04527`. Evidence folder `docs/validation/<VTID>/` also carries `plan-sparring.md`, `scope.json` and an
`acceptance.md` with `AC-` entries, which `VALIDATOR-CHECK.yml:148` and `:158` require.

## Lane
`fix-pin` — executor kiro, seat `exafy` (platform area; no area covers `services/gateway/test/**`), reviewer `jtadic`.
<!-- plan:end -->
