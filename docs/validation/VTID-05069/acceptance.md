# VTID-05069 - Live pipeline tree in the Operator Console (Kiro runs Phase 4)

Owner approval 2026-10-10 (Gate 1: "very good. approved"). Sparring: `plan-sparring.md` (session `159d2217…`, converged). Delivered as Phase 4 of the Kiro-runs plan (VTID-05065 record): the Implement nodes read `kiro_runs` / `kiro_run_events` of the threads linked to the VTID; every other node is as in the sparred plan.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `/api/v1/operator/runs` (new file `services/gateway/src/routes/operator-runs.ts`, mounted in `index.ts` next to `/api/v1/operator/kiro/runs`, before the operator router; `requireAdminAuth` on every route). Routes: `GET /by-thread/:threadId`, `GET /:vtid` (`?thread_id=`), `GET /:vtid/stream` (SSE). Atlas: `/^operator-runs$/` in the `agents` domain. Read-only: no write, no migration, no OASIS event.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/runs (staging).

CURL_PROOF: unauthenticated `GET /api/v1/operator/runs/VTID-05065`, `GET /api/v1/operator/runs/VTID-05065/stream` and `GET /api/v1/operator/runs/by-thread/staging-verify-probe` each answer 401 application/json; `/command-hub/` loads `pipeline-tree.js?v=20261112-vtid-05069` and `pipeline-tree.css?v=20261112-vtid-05069` before `app.js?v=20261112-vtid-05069` (`staging-tests.json`, read-only).

## Acceptance criteria

AC-1: `buildRunView(vtid)` returns Plan → Repositories (vitana-platform, vitana-v1: Implement → Pull request → CI → Fix forward → Merge to main) → Staging deploy → STAGING-VERIFY → Gate 2 → Production, each node with a status (pending / running / passed / failed / waiting / skipped / unknown), detail, meta, links, the failing check as `error` and the running Kiro step as `live`; for the three mock states the statuses are exact (running in both repos; CI failed + fix attempt 1 of 3; staging verified, Gate 2 waiting) and a finished run is `done` + terminal.
  TEST: services/gateway/test/operator-runs-view.test.ts
AC-2: Implement comes from the run record: the Kiro runs (`kiro_runs`, tool-call count and latest tool title from `kiro_run_events`) of the threads linked to the VTID by `operator.kiro.*` events (plus the viewer's thread), created after the ledger row; Dev Autopilot execution for a platform VTID it runs. Kiro working before any push shows one "Kiro workspace" node.
  TEST: services/gateway/test/operator-runs-view.test.ts
AC-3: Fix forward counts the PR's pushes after its first failed CI (the newest 4 commits checked) — "attempt n of 3"; after 3 failed attempts the node fails and the run is terminal.
  TEST: services/gateway/test/operator-runs-view.test.ts
AC-4: Gate 2 waits only when every merged repo passed STAGING-VERIFY and production does not contain the merge; its box lists every commit between the production commit and the verified commit (what PUBLISH ships), this VTID's highlighted; Publish opens the existing PUBLISH flow (gateway) / links the existing vitana-v1 production deploy workflow (community-app).
  TEST: services/gateway/test/operator-runs-view.test.ts
  TEST: services/gateway/test/command-hub/vtid-05069-pipeline-tree.test.ts
AC-5: A failing source marks only its nodes `unknown` and is named in `unavailable[]` (GitHub search, check runs, sparring store, production version); the view never fails as a whole.
  TEST: services/gateway/test/operator-runs-view.test.ts
AC-6: GitHub budget: views cached 30 s per VTID for every viewer; one batched search (`"VTID-a" OR "VTID-b" in:title`, both repos) per thread; at most 10 searches a minute from this module — beyond that the last result is reused with `stale: true`; immutable answers (merged PR detail, completed check runs, compares, commit ranges) cached for good.
  TEST: services/gateway/test/operator-runs-view.test.ts
AC-7: `GET /by-thread/:threadId` returns the VTIDs of the thread's `operator.kiro.*` events and the ledger-backed VTIDs the assistant named in it, newest first, at most 5, with their views; no linked VTID → no views (no card); another user's thread → 403.
  TEST: services/gateway/test/operator-runs-view.test.ts
AC-8: `GET /:vtid/stream` sends the view, then again only when it changed; checks every 15 s while a node runs and every 60 s otherwise; ends 60 s after the view is terminal, after 2 h, or when the client leaves.
  TEST: services/gateway/test/operator-runs-view.test.ts
  CURL: staging GET of the stream route without a token -> 401 application/json
AC-9: Every route is admin-only: no token 401 JSON, non-admin 403; invalid VTID or thread id 400.
  TEST: services/gateway/test/operator-runs-view.test.ts
  CURL: staging GET of the run view route without a token -> 401 application/json
AC-10: Console: the run cards render at the bottom of the Operator thread (newest VTID first, finished runs collapsed to their header) with status icons, chips, the "now:" and red error lines, Collapse/Expand, Stop (only while a Kiro run or Dev Autopilot execution of the VTID runs; calls the existing cancel routes), the Gate 2 box and a footer naming unavailable sources; a status dot per thread row; the stream is read with fetch (hub auth headers), one per visible expanded unfinished card, closed on leave/collapse, reopened on focus; no innerHTML, no inline style; spinners still under `prefers-reduced-motion`.
  TEST: services/gateway/test/command-hub/vtid-05069-pipeline-tree.test.ts
  UI: docs/validation/VTID-05069/outputs/desktop-s1.png, desktop-s2.png, desktop-s3.png (1400x900)
  UI: docs/validation/VTID-05069/outputs/mobile-s1.png, mobile-s2.png, mobile-s3.png (390x844, no horizontal overflow)

## Decisions taken (inside the approved plan)

- No "Workspace" or "Checks" node: no existing record says when a Kiro workspace was opened or which local checks ran; the branch name is the repo row's detail instead (plan: "nothing is inferred").
- Stream read with `fetch()` instead of `EventSource`, because an EventSource cannot send the Command Hub's Authorization header; same one-stream-per-visible-running-card lifecycle.
- `by-thread` is limited to the caller's own thread (403 otherwise), like the Kiro run routes.
- Thread-list dots poll only the 8 most recent threads (every 2 min) plus the open thread (every 60 s), at most 12 loads a minute, so the dots cannot spend the GitHub search budget.
- STAGING-VERIFY stands in for "deployed" when present (a verification only runs on the deployed commit); otherwise the staging deploy workflow runs after the merge are read.
- Production for community-app reads the public version stamp of vitanaland.com (the same read STAGING-VERIFY makes); the gateway reads production build-info as the resume pack does.
- `getCommitsBetween` gained `{ files: false, tokenOverride }` (one compare call for up to 250 commits); `getCheckRuns` an optional `per_page`; `getWorkflowRuns` an optional token and typed `head_sha`; `searchPullRequests` accepts several terms (OR); new `getPullRequestCommits`. Existing callers unchanged.
- The cache-bust bump to `20261112-vtid-05069` moves app.js and styles.css together (tests pin them equal) and updates the staging suites that name the old version (VTID-04696 rule).
- The staging check is unauthenticated (401 probes + served assets): STAGING-VERIFY has no exafy_admin test identity, and the test user is not an admin. The authenticated end-to-end view is proven by the jest suites over fixture sources.

## Changed existing tests

- `services/gateway/test/command-hub/vtid-05064-operator-turn-thread.test.ts` — the exact `?v=20261110-vtid-05064` pin and the "VTID-05064 first in the allowlist" pin become at-or-after / anywhere-in-the-allowlist (the same form the older suites use), because this change bumps the version and adds VTID-05069 first.
