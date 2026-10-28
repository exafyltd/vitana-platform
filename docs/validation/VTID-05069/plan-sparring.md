# Plan sparring record — VTID-05069 (live pipeline tree in the Operator Console)

- Sparring session: `159d2217-5654-4ebc-a8d2-005ffac35800`
- Plan hash: `645fc64086859e27a30c17adece57bbef176a6af214db1f575873d06a6a596fe`
- Verdict: **converged**
- Owner approval: 2026-10-10, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "very good. approved"
- Delivered as Phase 4 of the Kiro-runs plan (`docs/validation/VTID-05065/plan-sparring.md`, "Phase 4 — Pipeline tree on top of runs"): the Implement nodes read the run record (`kiro_runs` / `kiro_run_events` of the thread + VTID) instead of client-side Kiro frames; every other node is as in the plan below.

---

# Plan — Live pipeline tree in the Operator Console (Kiro-IDE-style run view)

<!-- plan:begin -->
## Change class
standard (2 new read-only gateway routes, new service module, Command Hub frontend, atlas registration; no migration, no write path, no auth model change, no LLM routing).

## Goal
Inside an Operator thread, show each VTID the thread is working on as a live, collapsible tree: Plan → Repositories (parallel: vitana-platform, vitana-v1; each Workspace → Implement → Checks → Pull request → CI → Fix forward (attempt n of 3) → Merge) → Staging deploy (per service) → STAGING-VERIFY → Gate 2 → Production. Each node: status icon (pending / running spinner / passed / failed / waiting-for-owner / not needed), one-line detail, right-aligned meta (duration, PR link, check counts, commit). A "now:" line under the running node shows Kiro's current action live; a red line under a failed node shows the failing check. Mockups: scratchpad/mock/desktop-s1/s2/s3.png, mobile-s1.png (390 px, no horizontal overflow).

## Data per node (all existing sources; nothing new is written)
| Node | Source | Join key |
|---|---|---|
| Plan | `plan_sparring` record via `services/plan-sparring/plan-sparring-repository.ts` (rounds, verdict, approval time); fallback ledger metadata | vtid |
| Repo branch / Workspace / Implement (Kiro path; Dev Autopilot executions only for platform VTIDs run by Dev Autopilot instead of Kiro) | `operator.kiro.branch_pushed` {repo, branch, commit_sha, for_vtid} + `operator.kiro.write_tool_called`; `dev_autopilot_executions` (platform only, via recommendation.activated_vtid) status running | payload.for_vtid / vtid |
| Pull request | GitHub search `VTID-xxxxx in:title` in both repos (same query `services/dev-memory/resume-pack.ts` uses, uncached here) | vtid in PR title (PR contract) |
| CI | GitHub check-runs for the PR head sha (counts passed/failed/running, first failing check name + summary line) | PR head sha |
| Fix forward | count of pushes to the PR branch after the first failed CI (GitHub PR commits) — shown "attempt n of 3" | PR |
| Merge | PR `merged_at` + `merge_commit_sha` | PR |
| Staging deploy | GitHub Actions runs of `AWS-STAGE-DEPLOY-GATEWAY.yml` (platform) / `AWS-STAGE-DEPLOY-FRONTEND.yml` (v1) whose head_sha is the merge sha or a later main commit containing it | merge sha |
| STAGING-VERIFY | OASIS `staging.verify.passed|failed|superseded` (all three are live topics, written by `.github/workflows/STAGING-VERIFY.yml`; 7-day counts 2026-10-10: 148 passed, 59 failed, 11 superseded) where metadata.vtids contains the VTID or metadata.commit contains the merge sha (service gateway / community-app) | vtid / commit |
| Gate 2 | derived: verify passed for the commit and production build-info not yet at/after it | commit |
| Production | GitHub Actions runs of `AWS-PROD-DEPLOY-*` + production build-info commit (`/api/v1/admin/build-info`) | commit |
| "now:" line | the live Kiro SSE frames already streamed to the console (`kiro.tool_call` title) for the thread's running turn — client-side only | thread |
A node with no data yet is pending; a repo with no PR once the other repo's PR is merged and the run reached staging is "not needed". Nothing is inferred beyond these rules (no invented states).

## Server (services/gateway)
1. `src/services/operator-runs/run-view.ts`: `buildRunView(vtid)` → `{ vtid, title, status, started_at, nodes: RunNode[] }` (`RunNode = { id, label, status, detail?, meta?, link?, children?, error? }`), assembled from the table above. GitHub calls use the repo token helper `repoGitHubToken` (vitana-repos.ts); results cached 30 s per VTID (shared by all viewers); one GitHub search per thread, batching that thread's VTIDs as `(VTID-a OR VTID-b …) in:title` across both repos; check-runs/PR-commit/workflow-run calls only for PRs not yet merged or commits not yet in production; budget guard: if the gateway's GitHub search calls exceed 10/min the view serves the cached result and marks `stale: true` (search limit is 30/min shared with resume-pack, Kiro writes and Dev Autopilot); each source failure marks only its nodes `unknown` (grey "?" icon) and is listed in `unavailable[]`, never fails the whole view.
2. `src/routes/operator-runs.ts`, mounted at `/api/v1/operator/runs`, `requireAdminAuth` (same guard as other operator routes):
   - `GET /:vtid` → run view (VTID format validated `^VTID-\d{5}$`).
   - `GET /:vtid/stream` → SSE; sends the view, then re-sends it only when it changed (server polls `buildRunView` every 15 s while a run has a running node, every 60 s while it only waits on Gate 2; terminal = Production passed, or a repo failed after 3 fix attempts, or ledger terminal; closes 60 s after terminal or after 2 h, the client reconnects on window focus). Same SSE pattern as `routes/dev-autopilot.ts:1218-1273`.
   - `GET /by-thread/:threadId` → VTIDs linked to the thread: distinct `payload.for_vtid` of `operator.kiro.*` events with that `thread_id`, plus VTIDs named in that thread's `operator_messages` by the assistant in the form "VTID-xxxxx" (newest 5). No linked VTID → the thread shows no run card at all (no empty card).
3. Register the route file in `orb/developer/domain-atlas.ts`: add `/^operator-runs$/` to the `agents` domain's `routes` (which already owns `/^operator$/`), so `npm run test:roles` passes (rule 42h).
4. `services/github-service.ts`: reuse `searchPullRequests` (:199), `getPullRequest` (:295), `getCheckRuns` (:337), `getWorkflowRuns` (:785); add only a PR-commits fetcher if none fits (in scope).

## Console (frontend/command-hub app.js + styles.css + index.html ?v= bump; ownership guard allowlist line)
1. Render the run card at the bottom of the thread (above the composer) for each linked VTID, newest first; terminal runs collapsed to their header.
2. One EventSource per visible running card; closed when the thread is left or the card collapses; `prefers-reduced-motion` stops the spinner animation.
3. Thread list: a status dot per thread (running / failed / waiting for you / done) from the latest linked run.
4. Header buttons: Collapse/Expand; Stop appears only while a Kiro turn of this thread or a dev_autopilot execution of this VTID is running and calls the EXISTING cancel paths (Kiro cancel route, `autopilot_cancel_execution` route) — both, when both run. No new stop semantics.
5. Gate 2 box: shows the question and "Show commits" = ALL commits between the production commit and the verified staging commit (what PUBLISH actually ships, from `getCommitsBetween` :618), with this VTID's commits highlighted and others labelled. Its "Publish" button opens the EXISTING Command Hub PUBLISH flow (`POST /api/v1/operator/publish`, gateway — full staging build promotion with its STAGING-VERIFY gate, not an in-session scoped deploy); for community-app it links to the existing frontend publish control. No new production path.
6. Admin console text, English by design (13b admin exclusion), same as existing Kiro console strings. Dark theme tokens from styles.css `:root`; layout verified at 1400×900 and 390×844.

## Out of scope
Persisting Kiro tool calls server-side; a review-iteration counter (shown as push/attempt counts instead); runs not linked to a thread (a global runs page); write actions beyond the existing cancel/publish entry points.

## Dependency and phasing
VTID-05064 (Kiro reliability, approved, in implementation) adds `chatTurnThreadId`; this VTID is implemented after it merges. Every node works without it (all server data). The "now:" line is the only part that uses it: it shows the latest `kiro.tool_call` title of the running turn under the run card of `chatTurnThreadId`'s thread; if that field is absent it falls back to the thread on screen while a turn runs (the common single-turn case).

## Tests
- Jest `test/operator-runs-view.test.ts`: buildRunView with fixture GitHub + OASIS + sparring data for the 3 mock states (running both repos; CI failed + fix attempt; staging verified awaiting Gate 2) → exact node statuses; a GitHub failure → nodes unknown + `unavailable`; VTID validation; by-thread linking; auth (401/403 without admin).
- SSE: stream sends initial view, sends again only on change, closes on terminal.
- Operator pipeline suite (`npm run test:operator`) stays green; role-separation suite (`npm run test:roles`) for the atlas entry.
- Staging (read-only, `docs/validation/<VTID>/staging-tests.json`): GET `/api/v1/operator/runs/<a past merged VTID>` as the staging test admin returns nodes with Merge passed and STAGING-VERIFY passed; Playwright on staging opens the Operator Console thread for that VTID and screenshots the card (desktop + mobile), asserting no horizontal overflow.
<!-- plan:end -->

## Scope (files)
services/gateway/src/services/operator-runs/run-view.ts (new), src/services/github-service.ts, src/routes/operator-runs.ts (new), src/index.ts (mount), src/orb/developer/domain-atlas.ts, src/frontend/command-hub/app.js, styles.css, index.html, scripts/ci/command-hub-ownership-guard.js, test/operator-runs-view.test.ts (new), docs/validation/<VTID>/staging-tests.json

## Planner responses — round 1
- F1 minor — REJECTED with evidence: `staging.verify.superseded` is a live topic. oasis_events last 7 days (queried 2026-10-10): staging-verify-gateway 7, staging-verify-community-app 4 rows, latest 2026-10-10 13:57 UTC; it is emitted by the workflow, not gateway src, which is why src grep finds nothing. Plan row now cites this.
- F2 major — ACCEPTED: 30 s cache, one batched OR search per thread, calls only for unmerged PRs / unshipped commits, 10/min search budget guard with `stale` flag, slower SSE polling (15 s / 60 s).
- F3 major — ACCEPTED: explicit phasing — after VTID-05064 merges; all nodes independent of it; "now:" line fallback specified.
- F4 major — ACCEPTED: `/^operator-runs$/` added to the `agents` domain.
- F5 minor — ACCEPTED: github-service.ts in scope; existing fetchers named.
- F6 minor — ACCEPTED: :1218-1273.
- F7 minor — ACCEPTED: Gate 2 = full PUBLISH; "Show commits" lists ALL commits prod→staging, this VTID's highlighted.
- F8 minor — ACCEPTED: no linked VTID → no card.
- Q1 — Dev Autopilot executions only for platform VTIDs executed by Dev Autopilot (non-Kiro path); Kiro events otherwise.
- Q2 — both cancel paths when both run.
- Q3 — terminal defined; Gate-2 wait polls every 60 s; 2 h cap with reconnect on focus.
