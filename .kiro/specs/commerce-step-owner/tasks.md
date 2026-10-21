# Tasks — commerce-step-owner

<!-- lane: gateway-step-owner -->
- [ ] T1 `StepOwner` + `stepOwner(step)` in `partner-onboarding-checklist.ts` (plan Change 1.1); `buildChecklist`
      sets `owner` on open required steps (1.2).
- [ ] T2 `commerce-mcp.ts`: derive `ON_SCREEN_STEPS` from the checklist module; `owner` on open steps and
      `next_action`; one `INSTRUCTIONS` sentence (1.3).
      **Sparring R2-F1 (minor, raised in the converging round):** derive it as "fixed owner `supplier` AND an entry in
      `STEP_SUPPLIER_ACTIONS`", which is exactly today's five keys (terms, dpa, billing_mandate, results_channel,
      tracking_test). `team` (owner `supplier`, no supplier action, never `not_required`) must NOT gain
      `done_on_vitanaland`/`link`; this keeps the plan's "byte for byte" promise. A Jest case asserts the derived set
      equals those five keys.
- [ ] T3 Jest: the `stepOwner` table per step key and per verification code (unknown → supplier, review_note →
      supplier); `buildChecklist` adds only `owner`; `shapeStatus` keeps every existing field; `ON_SCREEN_STEPS` /
      `STEP_TOOLS` consistency.
- [ ] T4 `docs/validation/<VTID>/`: `plan-sparring.md`, `scope.json`, `acceptance.md`, `staging-tests.json` (HTTP 401
      JSON probe on `GET /partner-onboarding/<uuid>` + the Jest suites as `existing`). Local: gateway Jest for the
      touched suites, `tsc --noEmit`.

Acceptance: requirements 1–4 and 8 hold; all listed suites green.

<!-- lane: frontend-still-needed -->
- [ ] T5 `SetupHub.tsx`: `parseChecklist` reads `owner`; `openSteps` adds `in_progress` and the owner; the grouped
      "Still needed" with the assistant hint, gated on `fetchMcpReady` (plan Change 2.1–2.2).
- [ ] T6 i18n: four keys, `de` first, then all other locales; `npm run i18n:inventory`.
- [ ] T7 Vitest: grouping, order, `in_progress`, missing/unknown owner, MCP not reachable, keys in all locales.
- [ ] T8 Read-only Playwright staging spec (390×844, 1280×900; demo business in the browser, writes aborted);
      `docs/validation/<VTID>/` with `staging-tests.json`; PR "UX acceptance" section. Local: `npm run lint`,
      `npx tsc --noEmit`, `npm test`, `npm run build`.

Acceptance: requirements 5–8 hold; all listed suites green.
