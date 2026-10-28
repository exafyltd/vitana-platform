# VTID-05274 — acceptance (lane kiro-autonomy-fallback/pm-fallback)
VALIDATION_PROFILE: gateway_backend
Scope: `services/gateway/src/services/project-manager/**`, `services/gateway/src/routes/project-manager.ts`,
`services/gateway/src/index.ts` (PM block only), `services/gateway/test/project-manager/**`,
`docs/validation/VTID-05274/**`. No workflow, migration or task-definition change. Staging suite: `staging-tests.json`.
OASIS impact: no (no OASIS event added or changed; Gate 2 is recorded in `pm_digests`).

AC-1 — Governance guard: the reviewer agent's accept on the current head merges any lane; a protected gate file
(each entry of `scripts/collab/protected-gate-files.json`) never merges on an agent accept alone; stale-head,
foreign-reviewer, `changes` and self-review entries do not count (T9-T12, T25, M1-M5).
TEST: npx jest test/project-manager/governance.test.ts (services/gateway)

AC-2 — Claude optional: `CLAUDE_AVAILABLE=false` or an item waiting 4 h for Claude with no Claude action sends
end-of-rotation reassigns, parks and stale claims to the exceptions seat `exafyltd`; Claude available keeps today's
routing (T1-T8, M6).
TEST: npx jest test/project-manager/fallback.test.ts (services/gateway)

AC-3 — Speed: 2 h / 4 h windows without a live driver, one merge per repo per tick, update_branch when behind,
W1 verify, merge_plan for a converged spec-only plan PR, W2 bookkeeping merge, Gate 2 ignores a parked sibling, tick
120000 ms, cap-6 reassign guard, ledger in_progress once (T13-T20, T22); no deploy / dispatch / allocate reachable (M7).
TEST: npx jest test/project-manager/fallback.test.ts test/project-manager/tick-and-config.test.ts (services/gateway)

AC-4 — Gate 2 evidence carries services, STAGING-VERIFY run links and counts, migrations, decisions taken, timings;
the poster writes one Operator Chat message with the existing question and a pm_digests record; timings exact,
missing sources null (T21, T23).
TEST: npx jest test/project-manager/timings.test.ts (services/gateway)

AC-5 — Live seams: observer (lanes, PRs, §4.1 trailers, review_only_since, claims, driver heartbeat, Claude inputs),
pm_lease (acquired / held_by_other / table_absent / error, last_lease), pm-agent writer W1/W2, startPmLoop (act in
live, decide otherwise) (T26).
TEST: npx jest test/project-manager/loop.test.ts test/project-manager/observe-live.test.ts (services/gateway)

AC-6 — `/status` stays auth-gated and carries `claude`, `fallback`, `build_lanes_in_flight`, `last_lease`; the
public `/mode` answers 200 without a token with exactly `ok, enabled, mode, executor_mode` (T24).
TEST: npx jest test/project-manager/route.test.ts (services/gateway)

ROUTE_MOUNT: `GET /api/v1/project-manager/mode` added to the existing router `routes/project-manager.ts`, mounted at
`/api/v1/project-manager` (`src/index.ts`, `mountRouterSync(app, '/api/v1/project-manager', projectManagerRouter)`,
unchanged).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/project-manager/mode (staging)
CURL_PROOF: pre-deploy proof is supertest over the real router (route.test.ts T24: `GET /api/v1/project-manager/mode`
without a token → 200, keys `enabled, executor_mode, mode, ok`). The staging proof is the read-only STAGING-VERIFY
run of `staging-tests.json` on the merge commit; no request is made by hand.
