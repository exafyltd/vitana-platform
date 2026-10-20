# Tasks — gateway-test-cachebust

<!-- lane: fix-pin -->
- [ ] T1 `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`: pinned tag →
      `/command-hub/app.js?v=20261121-vtid-05082`. No other change.
- [ ] T2 `docs/validation/<VTID>/`: `plan-sparring.md`, `scope.json`, `acceptance.md`, `staging-tests.json` (one
      `existing` entry running the file). Local: `npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts`.

Acceptance: the file passes; gateway Jest green in CI; the diff is that one line plus the validation folder.
