# Tasks — kiro-session-monitor
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/monitor-core.md`, `lanes/dispatch-acceptance.md`.
VTIDs: allocated by CI PLAN-SPAR after policy approval; never by hand. Branch `kiro/kiro-session-monitor/<lane>`, PR
title `VTID-xxxxx (kiro-session-monitor/<lane>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit,
identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/`
(`commands.log` with every command and pass/fail counts, `red-on-base.txt`). Acceptance below is what the reviewer
agent `vitana-lane-reviewer` checks the PR diff against.

<!-- lane: monitor-core -->
## Lane `monitor-core` — vitana-platform
- [ ] T1 Test first `services/gateway/test/kiro-session-monitor.test.ts`, red on `origin/main` (module missing), recorded in `docs/validation/<VTID>/red-on-base.txt`: every state of plan §4 from crafted snapshots; `recommended_action` per state; thresholds equal the imported constants; `findViolations` for the four invariants; a failing source is `ok=false`, never healthy; the response carries no message, reply or token field.
- [ ] T2 `services/kiro/session-monitor.ts`: `classifySession`, `findViolations`, `collectSessions(readers)`; imports the existing limits; no write, no OASIS emit.
- [ ] T3 `routes/operator-kiro-monitor.ts` (`requireAdminAuth`, GET only) and one `mountRouterSync(..., { owner: 'operator-kiro-monitor' })` line in `index.ts` next to the `operator-kiro-runs` mount (route guard, never bare `app.use()`); the reader is typed `Pick<GithubReader, 'refDate'>`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json` (unauthenticated GET → 401 JSON) and `scope.json`.
- [ ] T5 Checks: `npx jest test/kiro-session-monitor.test.ts`, `npm run typecheck`, `npm run test:operator`, `vtid-05065` and `vtid-05068` tests; all in `commands.log`; preflight on the head.

**Acceptance**
- Change types: Backend.
- **Outcome** — an admin reads one list of Kiro sessions (operator runs, plan drivers, lane claims) with state, reason, recommended action and invariant violations.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI; admin JSON only.
- **Contract** — `GET /api/v1/operator/kiro/monitor` → `{generated_at, counts_by_state, sessions[], sources[], violations[]}`; 401 without admin auth; no run message, reply or token in any field.
- The route is registered through `mountRouterSync` with `owner: 'operator-kiro-monitor'`; a test asserts the mount line.
- Reuses `KIRO_RUN_LIMITS`, `KIRO_PROMPT_TIMEOUT_MS`, `DRIVER_ALIVE_MS`, `MAX_BUILD_LANES_PER_PLAN` and `GithubReader.refDate`; none is redefined.
- No write to any table, no migration, no new OASIS event type, no change to `kiro-runs.ts`, `kiro-turn.ts`, `worker-orchestrator.ts` or the Project Manager.
- **Staging proof** — `staging-tests.json` read-only; the unauthenticated request answers 401 JSON on staging.
- Only the lane's `paths` change.

<!-- lane: dispatch-acceptance -->
## Lane `dispatch-acceptance` — vitana-platform
Builds after `monitor-core`.
- [ ] T1 `services/gateway/test/kiro-dispatch-acceptance.test.ts` with sections A (parallel), B (persistence), C (idempotency), D (recovery) of plan §4, over the real `kiro-runs.ts` and the real classifier, in-memory database in the style of `vtid-04465-operator-pipeline-regression.test.ts`. Record the red-on-base proof for the classifier-dependent cases.
- [ ] T2 Mutation check: break the stale guard, the queue cap and the `after_seq` replay once each locally and show the suite fails, in `commands.log`.
- [ ] T3 Add `test:kiro-dispatch` to `services/gateway/package.json` scripts.
- [ ] T4 Checks: the suite, `npm run typecheck`, `npm run test:operator`; preflight on the head.

**Acceptance**
- Change types: Tooling/docs (tests only).
- **Outcome** — one suite states and proves parallel execution, session persistence, idempotency and recovery for Kiro sessions.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI.
- **Contract** — no production code changes; the suite fails when the stale guard, the queue cap or the replay is broken (mutation evidence in `commands.log`).
- No existing test is changed or weakened; no network; no write to a real database.
- **Staging proof** — not verified on staging: deploys nothing; covered by the suite.
- Only the lane's `paths` change.
