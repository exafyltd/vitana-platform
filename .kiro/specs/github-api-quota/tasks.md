# Tasks — github-api-quota
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/`. VTIDs: allocated by CI PLAN-SPAR after
policy approval, one per lane; never by hand. Every lane: branch `kiro/github-api-quota/<lane-id>`, PR title
`VTID-xxxxx (github-api-quota/<lane-id>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit, identity
`kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with each
command and its pass/fail counts, red-on-base output for every new test). Common to every lane: nothing outside the
lane's `paths`; no protected gate file; no write to any live system; no test calls GitHub, the gateway or Supabase.

<!-- lane: gh-http -->
## Lane `gh-http` — shared rate-limit classifier, blocked-until state and GET cache (D1-D5)
- [ ] H1 New `services/gateway/src/services/github/github-http.ts` exporting the interface in `plan.md` §5:
      `GithubRateLimitError`, `isGithubRateLimitError`, `githubFetch`, `isRateLimited`, `clearGithubReadCache`, and
      the pure `parseRateLimit(status, headers, body, nowMs)`. Rules D2 and D3 exactly; keys `sha256(token)[0:16]` +
      resource; GET-only cache with `cache: 'bypass'`; TTL, entry cap 500, `2xx`-only; env knobs with the defaults in §5.
- [ ] H2 New `services/gateway/test/github-http-cache-backoff.test.ts` (Jest, fake `fetchImpl` and fake clock):
      TTL hit and expiry; `0` disables; non-2xx not cached; POST never cached; `cache: 'bypass'` always fetches;
      token A and token B never share an entry or a block; 403 with `x-ratelimit-remaining: 0` blocks until
      `x-ratelimit-reset`, with zero `fetch` calls inside the window and one after it; 429 blocks; `retry-after`
      beats reset; a plain 403 is not limited and is returned, not thrown; a GraphQL block does not block `core`;
      the wait is capped at `GITHUB_RATE_LIMIT_MAX_WAIT_MS`; `N` calls inside the window make zero `fetch` calls.
- [ ] H3 Run `cd services/gateway && npx jest test/github-http-cache-backoff.test.ts` (green) and `npm run typecheck`.
      Record red-on-base for H2 (the module is absent on base).
**Acceptance:**
- Change types: Backend, Tooling/docs.
- Outcome: no visible change to a member. A GitHub read inside a rate-limit window returns the limit error at once, not
  after another GitHub call.
- States: first call, cached call, expired entry, blocked window, window end, cap reached.
- Surfaces: none (server module). Callers: `github-service.ts`, `project-manager/github-rest.ts` (wired in `gh-clients`).
- Locales: n/a: server code, no user-visible string.
- Accessibility: n/a: no UI.
- Contract: `githubFetch` returns `{status, statusText, headers, text}` for non-limited responses; throws
  `GithubRateLimitError` (message keeps the `GitHub API error: <status> - …` prefix) for limited ones. No new route.
- Staging proof: not verified on staging: the module is only exercised through its callers; covered by H2.
- Reviewer: the classifier never treats a plain 403 as limited (D2); no `fetch` runs inside a blocked window (D4); no
  token value appears in a key, log line or test name (only `sha256` prefix).

<!-- lane: ci-scripts-backoff -->
## Lane `ci-scripts-backoff` — land guard reads back off until the reset time, not every 60 s
- [ ] C1 New `scripts/collab/github-backoff.mjs`: pure `retryWaitMs(text, nowMs)` that reads `retry-after` or
      `x-ratelimit-reset` from `gh api --include` header output, or a `rate limit` marker in stderr, and returns the
      wait in ms (capped at 3 600 000; fallback 60 000 when neither header is present); `waitForRateLimit(ms)` with
      an injectable sleep.
- [ ] C2 `scripts/collab/land-guard.mjs` `ghJson` (read path only, about `:103`): on a rate-limit marker, wait with C1
      and retry the read at most 3 times, then fail as today. The merge call (about `:200`, `gh api -X PUT`) stays
      unchanged and is not retried.
- [ ] C3 New `scripts/collab/github-backoff.test.mjs` (node:test): header parsing (reset, retry-after precedence,
      fallback, cap); a rate-limited read waits and retries, then succeeds; three failures stop; a non-rate-limit
      error fails at once with no wait; the merge path makes one call. Red-on-base: the module is absent on base.
- [ ] C4 Run `node --test scripts/collab/github-backoff.test.mjs` and `node --test scripts/collab/*.test.mjs`.
**Acceptance:**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the land guard (a CI-side reader) waits for the GitHub reset time instead of hammering a limited token, and
  a merge still happens at most once.
- States: first read ok, limited then ok, limited three times, non-limit error, merge path.
- Surfaces: `scripts/collab/land-guard.mjs` callers only. No member surface.
- Locales: n/a: developer tooling output.
- Accessibility: n/a.
- Contract: `land-guard.mjs` exit codes and output lines unchanged; the merge request body and method unchanged.
- Staging proof: not verified on staging: a script that runs in CI, not in the deployed gateway; covered by C3 and by
  the existing `scripts/collab/*.test.mjs` suite.
- Reviewer: this lane is a governance path (`scripts/collab/**`), so it needs the reviewer accept on the current head;
  no protected file is touched; the merge is never retried.

<!-- lane: gh-clients -->
## Lane `gh-clients` — route REST reads and writes through the shared module; stop the false green (D1, D4, D5, D9)
- [ ] K1 `services/gateway/src/services/github-service.ts` `githubRequest` (`:59`): GET calls go through `githubFetch`
      (cache on); writes (`POST`/`PUT`/`PATCH`/`DELETE`) go through `githubFetch` with `cache: 'bypass'` and clear the
      read cache; the error text and the `formatGitHubApiError` prefix stay exactly as today for non-limited errors.
- [ ] K2 Mark the merge-gate reads `cache: 'bypass'`: every call in the merge path (grep `mergePullRequest`, `safeMerge`,
      and the PR decide path under `services/gateway/src/services/dev-autopilot-*`). List the exact call sites in
      `docs/validation/<VTID>/commands.log`.
- [ ] K3 `getPrStatus` (`github-service.ts:371`): rethrow `GithubRateLimitError` from the `getCombinedStatus` and
      `getCheckRuns` `.catch` defaults; every other error keeps the current default. (D9.)
- [ ] K4 `services/gateway/src/services/project-manager/github-rest.ts` `gh()` (`:27`): use `githubFetch`; keep the 10 s
      timeout, the 404 → `{status: 404, data: null}` and `GithubHttpError`. A limited response throws
      `GithubRateLimitError`, which extends `GithubHttpError` so existing `instanceof` checks still catch it.
- [ ] K5 New `services/gateway/test/github-rate-limit-propagation.test.ts`: `getPrStatus` with a rate-limited statuses
      endpoint throws and does not return `allPassed: true`; `gh()` throws a `GithubHttpError`-compatible error on 403
      with reset; repeated reads in the window make zero calls; writes never cached (two identical `POST`s make two
      calls). Red-on-base for the false-green case.
- [ ] K6 Run `cd services/gateway && npx jest test/github-rate-limit-propagation.test.ts test/vtid-03835-github-service-read-access.test.ts test/vtid-04633-github-api-error-message.test.ts` (green) and `npm run typecheck`.
**Acceptance:**
- Change types: Backend.
- Outcome: no change for a caller when GitHub answers normally. When GitHub rate-limits, the caller gets a clear error
  and no false "all checks passed".
- States: normal `2xx`, cached read, merge-path read, write, rate-limited read, plain 403, 404 (`gh()` null), other 5xx.
- Surfaces: the watcher (`dev-autopilot-watcher.ts` via `getPrStatus`), `routes/cicd.ts`, the PM observer, plan-sparring
  tools (unchanged, protected, out of scope), Command Hub PUBLISH (writes unchanged).
- Locales: n/a: server code.
- Accessibility: n/a.
- Contract: `githubRequest`'s signature and return shape unchanged; `GitHub API error: <status> - …` prefix unchanged
  (`branchExists` 404 match depends on it); `gh()` returns the same `{status, data}`; `GithubHttpError` class kept.
- Staging proof: not verified on staging: a live rate limit cannot be produced on staging without consuming the team's
  quota; covered by K5 and by the existing `vtid-04633` error-text test.
- Reviewer: no write path changed beyond the cache clear; merge-gate reads bypass the cache (list in the log); no
  `Authorization` value appears in logs.

<!-- lane: gh-graphql-core -->
## Lane `gh-graphql-core` — GraphQL transport and pure mapping (D6, D7, D8)
- [ ] G1 New `services/gateway/src/services/github/graphql-client.ts`: `githubGraphql<T>(query, variables, {token, fetchImpl})`
      POSTs `{query, variables}` to `https://api.github.com/graphql` through `githubFetch` with `resource: 'graphql'`;
      throws `GithubGraphqlError` (message `GitHub API error: <status> - graphql: <first error message>`) on `errors`
      without `data`; a GraphQL `RATE_LIMITED` error maps to `GithubRateLimitError`.
- [ ] G2 New `services/gateway/src/services/github/graphql-mapping.ts`: `mapPullRequest`, `mapStatusRollup`,
      `mapMergeState` (interface in `plan.md` §5). Pure; no I/O.
- [ ] G3 New `services/gateway/test/github-graphql-mapping.test.ts`: fixtures for an open PR, a merged PR, a PR with a
      `BLOCKED` merge state, a rollup with `SUCCESS`/`FAILURE`/`ERROR`/`PENDING`/`EXPECTED` statuses and
      `QUEUED`/`IN_PROGRESS`/`COMPLETED` check runs, `totalCount` above the page (must signal fallback), and a
      `errors`-only response. Assert the REST-shaped output field by field. Red-on-base: modules absent.
- [ ] G4 Run `cd services/gateway && npx jest test/github-graphql-mapping.test.ts` (green) and `npm run typecheck`.
**Acceptance:**
- Change types: Backend.
- Outcome: no visible change; the mapper yields the same objects the REST reads yield, so callers read the same fields.
- States: no checks, many checks (more than the page), pending, errors-only, rate limit, malformed response.
- Surfaces: none yet (wired in `gh-graphql-wire` and `pm-observer-graphql`).
- Locales: n/a.
- Accessibility: n/a.
- Contract: request `POST https://api.github.com/graphql`, `Authorization: Bearer <token>`, JSON body `{query, variables}`;
  response mapped to `GitHubPullRequest`, `GitHubCombinedStatus`, `GitHubCheckRun` (`services/gateway/src/types/cicd` or the
  existing type module, read before naming). Statuses and check runs share the page size of 100 (D8).
- Staging proof: not verified on staging: no read-only route calls GraphQL yet; covered by G3.
- Reviewer: every enum mapping is explicit (no default that turns an unknown state into `success`); `totalCount` above the
  page returns a fallback signal, not a truncated list.

<!-- lane: gh-graphql-wire -->
## Lane `gh-graphql-wire` — `getPrStatus` and `listOpenPrsWithStatus` read GraphQL, REST as fallback (D6, D7, D8)
- [ ] W1 `services/gateway/src/services/github-service.ts`: `getPrStatus` (`:371`) and `listOpenPrsWithStatus` (`:989`)
      use one GraphQL query (`repository.pullRequest` with `commits(last:1)` → `statusCheckRollup.contexts(first:100)`)
      through `githubGraphql` and `mapPullRequest`/`mapStatusRollup`. If `GITHUB_GRAPHQL_READS=off`, or the GraphQL call
      fails for a non-rate-limit reason, or `totalCount` is above the page, run today's REST path and log one line.
      A GraphQL rate limit throws `GithubRateLimitError` (D9).
- [ ] W2 Update the existing tests that pin the REST shape of these two functions (list in `plan.md` §4) so they assert
      the new call shape, and keep every other assertion. Any existing test that changes its expectation must say why
      in `commands.log`.
- [ ] W3 New `services/gateway/test/github-graphql-wire.test.ts`: `getPrStatus` issues one POST to `/graphql` and no REST
      `status` or `check-runs` GET; the returned `checks` and `allPassed` equal the REST answer for the same fixture;
      GraphQL error → REST path; `GITHUB_GRAPHQL_READS=off` → REST only; rate limit → throws. Red-on-base: base issues
      REST GETs.
- [ ] W4 Run the full gateway suite: `cd services/gateway && npm test` (jest). Record the counts before and after in
      `commands.log`; nothing may newly fail that was green on base.
**Acceptance:**
- Change types: Backend.
- Outcome: the CI watcher and the cicd status route see the same PR status they saw before, from one request instead of three.
- States: green PR, red PR, pending checks, no checks, GraphQL down, rate limited, kill switch on.
- Surfaces: `dev-autopilot-watcher.ts` (`getPrStatus` at about `:820` and `:994`), `routes/cicd.ts` (`getPrStatus` at about
  `:359`, `:775`, `:1075`, `:1420`, `:1725`), `listOpenPrsWithStatus` callers.
- Locales: n/a.
- Accessibility: n/a.
- Contract: `getPrStatus` return type `{pr, checks, allPassed}` unchanged; `pr` is the REST-shaped `GitHubPullRequest`.
- Staging proof: not verified on staging: a read-only staging route that reaches `getPrStatus` is not known; covered by
  W3 and the full gateway suite.
- Reviewer: `allPassed` logic unchanged; REST fallback reachable from every GraphQL failure path; no GraphQL write
  mutation is present (the query is a read).

<!-- lane: pm-observer-graphql -->
## Lane `pm-observer-graphql` — the PM observer reads open PRs in one GraphQL query per tick (D6, D7)
- [ ] O1 New `services/gateway/src/services/project-manager/observe-live-graphql.ts`: a `GithubReader` implementation
      (interface near `observe-live.ts:62-83`) that answers `openPulls`, `pullMergeable`, `pullFiles`, `pullCommits`,
      `checkRuns` and `behindBy` from one batched `repository.pullRequests(states: OPEN, first: 50)` query per repo per
      tick, and caches `pullFiles` and `pullCommits` by head sha (immutable). `tree`, `blob`, `file`, `variable` and
      `commitsSince` keep REST through the existing `GithubRestReader`.
- [ ] O2 `services/gateway/src/services/project-manager/observe-live.ts`: construct the GraphQL reader for the
      per-PR methods, falling back to `GithubRestReader` when `GITHUB_GRAPHQL_READS=off` or on a fallback signal (D7). The
      `GithubReader` interface and the observer's behaviour are unchanged.
- [ ] O3 New `services/gateway/test/project-manager/observe-live-graphql.test.ts`: fake `fetchImpl`; one POST per repo per
      tick, not one REST call per PR; `files` and `commits` answered from cache for an unchanged head sha; a new head sha
      refetches; `variable` still REST and still treats 404 as unreadable (the case at `observe-live.test.ts:261`); a fallback
      signal uses REST. Record the before and after call counts for a 50-PR fixture in `commands.log` (the measurement
      in `plan.md` §6). Red-on-base: module absent.
- [ ] O4 Run `cd services/gateway && npx jest test/project-manager` (the existing observer tests stay green) and
      `npx jest test/project-manager/observe-live-graphql.test.ts`, then `npm run typecheck`.
**Acceptance:**
- Change types: Backend.
- Outcome: the Project Manager sees the same PR state it saw before; it spends fewer GitHub calls per tick.
- States: no open PRs, PR with no checks, PR whose head sha changed mid-tick, GraphQL down, rate limit, kill switch.
- Surfaces: the PM observer and every decision it feeds (`project-manager/*`). No member surface.
- Locales: n/a.
- Accessibility: n/a.
- Contract: `GithubReader` signatures unchanged; no REST route changes.
- Staging proof: not verified on staging: the PM runs `dry_run` by default (`config.ts:19-21`) and a live tick would use
  the team's quota; covered by O3 with the 50-PR fixture count.
- Reviewer: no write path changed (`writers.ts` untouched); `variable` 404 contract unchanged; the sha-keyed cache is only
  for immutable data.

<!-- lane: polling-cadence -->
## Lane `polling-cadence` — lower watcher and route polling, and skip GitHub calls while rate-limited (D10)
- [ ] P1 `services/gateway/src/services/dev-autopilot-watcher.ts` `:79-81`: `CI_TICK_MS`, `DEPLOY_TICK_MS`,
      `VERIFY_TICK_MS` from 60 000 to 120 000 and exported. Each tick first calls `isRateLimited(token, 'core')` for the
      repo's token and returns without a GitHub call while blocked. The comment on `:79` that says "checks API rate
      limit budget" is made true by this guard.
- [ ] P2 `services/gateway/src/routes/cicd.ts` `pollIntervalMs` (`:1718`): 10 000 to 30 000; the loop (`:1718-1755`)
      checks `isRateLimited` before each `getPrStatus` and stops polling with a clear error when blocked.
- [ ] P3 New `services/gateway/test/github-polling-cadence.test.ts`: the three tick constants equal 120 000; a rate-limited
      tick makes zero `getPrStatus` calls until reset and one after; the cicd loop makes no call while blocked; the PM
      tick default stays 120 000. Red-on-base: constants differ, guard absent.
- [ ] P4 Run `cd services/gateway && npx jest test/github-polling-cadence.test.ts test/dev-autopilot-watcher.test.ts` (and any
      cicd test that covers the loop) and `npm run typecheck`.
**Acceptance:**
- Change types: Backend.
- Outcome: CI, deploy and verify watchers check GitHub a little less often, and a rate-limited token is not called again
  until its reset. A pipeline stage can start up to one tick later.
- States: normal tick, blocked tick, reset passed, cicd loop blocked, cicd loop normal.
- Surfaces: the autopilot CI/deploy/verify stages; the PUBLISH status polling in `routes/cicd.ts`.
- Locales: n/a.
- Accessibility: n/a.
- Contract: the watcher and route response bodies unchanged; a blocked cicd poll returns the same error shape as a
  failed `getPrStatus`.
- Staging proof: not verified on staging: a watcher tick on staging would call GitHub; covered by P3.
- Reviewer: the 2-minute latency increase is recorded in the PR body as an intended change (owner asked for lower polling);
  `plan-driver` heartbeat and `PM_TICK_INTERVAL_MS` are not changed.

## Common checks for every lane (quality-checks)
- [ ] Red-on-base output recorded for every new test; the lane's `commands.log` lists every command run with its result.
- [ ] `npm run typecheck` in `services/gateway` green on the lane head.
- [ ] No file outside the lane's `paths` changed (`queue.mjs scope-check`, Lane scope check).
- [ ] No `CLAUDE.md`, `.claude/**`, `.kiro/steering/**` or protected gate file changed.
- [ ] Closing records: lane file log entry, PR body with "not verified on staging" where it applies.
