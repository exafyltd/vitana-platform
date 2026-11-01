---
change_class: standard
---
# plan(github-api-quota): cut GitHub REST quota use in the gateway and CI scripts
Author: Kiro, seat `exafy` (planner run `wf_86ea1b7889ccc773`, RUN `.agents/tasks/pipeline-wf_86ea1b7889ccc773/`).
Repos: `exafyltd/vitana-platform` only. `exafyltd/vitana-v1` has no GitHub API client (inv-tests §6), so it is out of
scope. Premises pinned to `origin/main` `62990ce285`. Detail per lane: `tasks.md`; lane files: `lanes/*.md`.
<!-- plan:begin -->
## 1. Goal
Owner task (verbatim, 2026-11-01): *"Reduce GitHub API quota use in the Vitana gateway and CI code, in
exafyltd/vitana-platform (and exafyltd/vitana-v1 only if it has its own GitHub API client). (A) Move read-only GitHub
REST calls for PR, check, status and branch reads to GraphQL, which has its own 5000-point/hour quota; keep writes on
REST. (B) Cache repeated identical GitHub reads for a short TTL, lower polling frequency of watchers and heartbeats,
and make any caller that receives a 403/429 rate-limit response back off until x-ratelimit-reset instead of retrying
in a loop. Find the GitHub clients by searching for api.github.com, octokit, gh api and fetch calls. No behaviour
change for callers; add unit tests for the cache, backoff and GraphQL mapping. Tests only, no writes to production or
any live system. Pipeline rules apply: plan(...) PR, CI plan-sparring, lanes, staging verify."*

Context: the owner hit "GitHub rate limit reached for this connection" and asked for the 5000/h budget to last. The
core REST pool (5000/h per token) is the limit under pressure: `run.json` recorded `core_remaining` 2591 and
`graphql_remaining` 4933 at setup.

"Tests only" is read as: verification is by unit tests, and nothing runs against production or a live system. The
code changes themselves are the owner's request (A) and (B).

## 2. Today (verified on `origin/main` `62990ce285`)
1. **One shared gateway read path, no cache, no rate-limit handling.** `services/gateway/src/services/github-service.ts:59`
   `githubRequest<T>` does a plain `fetch` and throws `formatGitHubApiError(...)` on any non-OK status (`:76-81`). It
   never reads `x-ratelimit-*` or `retry-after`. The error text keeps the `GitHub API error: <status> - …` prefix, and
   `branchExists` matches the substring `404` in it (`:105`).
2. **PR-status reads are three REST calls each.** `getPrStatus` (`github-service.ts:371`) calls `pulls/N`
   (`getPullRequest`, `:298`), `commits/<sha>/status` (`getCombinedStatus`, `:329`) and `commits/<sha>/check-runs`
   (`getCheckRuns`, `:340`). The last two sit inside `.catch(() => …)` defaults, so a rate-limited 403 there becomes
   an empty check list. With no checks, `allPassed` is `true` (`checks.length === 0`). That is a false green, and the
   backoff must stop it.
3. **PM reader is REST only.** `services/gateway/src/services/project-manager/github-rest.ts:27` `gh()` makes one
   `fetch` per call (10 s timeout), returns `null` on 404 and throws `GithubHttpError(status)` otherwise. No retry, no
   header read. `observe-live.ts` `GithubRestReader` (about `:654`) makes the per-PR reads each tick. It has an
   immutable blob cache keyed by sha and nothing else.
4. **Watchers and loops poll REST on a fixed clock.** `services/gateway/src/services/dev-autopilot-watcher.ts:79-81`
   sets `CI_TICK_MS`, `DEPLOY_TICK_MS`, `VERIFY_TICK_MS` to 60 000 ms, and `:1441-1443` registers the timers. The CI tick
   calls `getPrStatus` per execution, and a failure logs and retries on the next tick (about `:820-823`). That is the
   retry loop the owner describes. `services/gateway/src/services/project-manager/config.ts:25` has
   `DEFAULT_PM_TICK_MS = 120000`, and the observer runs every tick. `services/gateway/src/routes/cicd.ts:1718` polls
   every 10 s (`pollIntervalMs`), with the loop at `:1755` calling `getPrStatus` (`:1725`).
5. **Scripts.** `scripts/collab/land-guard.mjs` `ghJson` (`:103`) is the read path of the land guard. Its wait loop sleeps
   60 s (`:135-141`). `scripts/collab/plan-spar.mjs:82` reads `commits/<ref>` over REST with `POLL_MS = 20_000`
   (`:45`). `scripts/collab/queue.mjs:1079-1111` lists plan PRs through `gh` and reads one contents file over REST.
6. **No GraphQL anywhere in the gateway or CI.** Grep for `graphql` finds only Shopify and Octokit packages. Nothing
   reads `x-ratelimit-*` or `retry-after`. The one "rate limit" in a GitHub test is a mocked error string
   (`test/vtid-03835-operator-console-read-tools.test.ts:110`).
7. **Existing tests pin REST URLs.** `test/project-manager/observe-live.test.ts:261` (variables),
   `test/vtid-05014-kiro-v1-writes.test.ts:218`, `test/worker-orchestrator-await-autopilot.test.ts:79`,
   `test/vtid-04218-pipeline-resilience.test.ts:100`, `test/vtid-03835-github-service-read-access.test.ts` (fetch mock by URL),
   `test/vtid-04465-operator-pipeline-regression.test.ts` with `test/operator-pipeline/fake-operator-platform.ts:209`.
   The `commits/<ref>` REST shape is pinned by `scripts/collab/plan-spar.test.mjs:438`.

Quota shape, an estimate and not a measurement: the PM tick reads roughly 3 to 5 REST resources per open PR. With about
50 open PRs that is 150 to 250 core calls per tick, and 30 ticks an hour makes 4 500 to 7 500 core calls an hour. That
is at or above the 5000/h core limit. The live number is not measured here. Lane `pm-observer-graphql` records a
before/after count (section 6).

## 3. Design decisions (the planner's choices, one line of rationale each)
- **D1 Shared module first.** One new module `services/gateway/src/services/github/github-http.ts` owns: rate-limit
  classification, the per-token-and-resource blocked-until state, and a GET-only TTL cache. Every GitHub REST and GraphQL
  call goes through it. Rationale: one place to get backoff right; the lanes that follow only import it.
- **D2 Rate-limit classification.** Limited means: status `429`, or status `403` with `x-ratelimit-remaining: 0`, a
  `retry-after` header, or a body message matching `/rate limit/i`. A plain 403 (wrong scope, not found) is not limited
  and keeps today's error. Rationale: GitHub uses 403 for the primary limit and the secondary limit; a generic 403
  must not start backing off.
- **D3 Wait time.** `retry-after` (seconds) wins when present (secondary limits). Otherwise `x-ratelimit-reset` (epoch
  seconds) is the blocked-until time. With neither header, wait 60 s. Every wait is capped at
  `GITHUB_RATE_LIMIT_MAX_WAIT_MS` (default 3 600 000). Blocked state is keyed by `sha256(token)[0:16]` and the resource
  (`core` or `graphql`), so one token's limit does not block another token, and a GraphQL limit does not block REST.
  Rationale: owner rule "until x-ratelimit-reset"; the token key stops cross-token blocking, which is the owner's
  multi-account setup.
- **D4 No retry loop.** A blocked call throws `GithubRateLimitError` before any `fetch`. Callers see the same error
  shape, and nothing is retried inside the window. Rationale: the owner asked for no loop.
- **D5 Cache.** GET-only, keyed by `method + full URL + tokenKey`, TTL `GITHUB_READ_CACHE_TTL_MS` (default 30 000; `0`
  disables), at most 500 entries, only `2xx` responses. Any write through `githubRequest` or `gh()` clears the process
  cache. Merge-gate reads pass `cache: 'bypass'`. Rationale: a stale mergeability or check read on the merge path
  could merge a red PR, and §7b needs the current head.
- **D6 GraphQL for read-only PR, check and status reads.** Endpoint `POST https://api.github.com/graphql`, the same
  token and the same permission set the REST reads already need. Scope: `getPrStatus` (one query replaces three
  REST calls), `listOpenPrsWithStatus`, and the PM observer's per-PR reads. Writes stay REST (`createPullRequest`,
  `updatePullRequestBranch`, `mergePullRequest`, `triggerWorkflow`, `triggerRepositoryDispatch`, comment and close,
  `writers.ts`). Search endpoints stay REST (separate 30/min search pool). Rationale: the owner's split.
- **D7 GraphQL falls back to REST.** A GraphQL transport error, a response with `errors` (other than a rate limit), or
  `contexts.totalCount` above the page size makes the read use the REST path, with one log line. A GraphQL rate limit
  is not a fallback: it blocks the `graphql` resource (D3). Kill switch: `GITHUB_GRAPHQL_READS=off` restores REST for
  every read. Rationale: GraphQL acceptance under the production tokens is not verified here (risk R1), so a refusal
  must degrade to today's behaviour, not break the pipeline.
- **D8 Mapping keeps REST shapes.** GraphQL results are mapped back to the existing REST-shaped objects
  (`GitHubPullRequest`, `GitHubCombinedStatus`, `GitHubCheckRun`, `CheckStatus`) so callers do not change. Page size is
  `first: 100` for statuses and check runs together, not REST's default 30 per type. That is the one intended change in
  what a caller sees: a PR with more than 30 checks now reports all of them. Rationale: REST's 30 truncation is a latent
  bug that would hide a late red check; recorded here so reviewers can check it.
- **D9 Errors reach the caller under a rate limit.** In `getPrStatus`, the `.catch` defaults swallow every error,
  including a rate limit. The change: rethrow `GithubRateLimitError`, keep the existing defaults for every other error.
  Rationale: stops the false green (section 2.2). Non-rate-limit behaviour is unchanged.
- **D10 Watcher and loop cadence.** `CI_TICK_MS`, `DEPLOY_TICK_MS`, `VERIFY_TICK_MS`: 60 s to 120 s (exported, so
  tests can pin them). `cicd.ts` `pollIntervalMs`: 10 s to 30 s. The PM tick stays at 120 s (the env override
  `PM_TICK_INTERVAL_MS` is unchanged). Each watcher tick first asks `isRateLimited(...)` and skips the GitHub call while
  blocked. Rationale: the owner asked for lower frequency; with D6 and D5 the calls are already cheaper, so the step is
  modest on purpose. Pipeline latency grows by at most one tick per stage.
- **D11 Heartbeat unchanged.** `scripts/collab/plan-driver.mjs` `HEARTBEAT_INTERVAL_MS` (15 min) pushes a git ref, not a
  REST read, so it spends no GitHub quota. Changing it would not reduce quota and would risk the 45-minute liveness
  check (`driver-wake`). Not changed.
- **D12 Protected gate files are out of this plan.** `scripts/collab/queue.mjs`, `scripts/collab/plan-spar.mjs`,
  `.github/workflows/PR-GATE.yml` and `services/gateway/src/services/plan-sparring/**` are on the protected list
  (`scripts/collab/protected-gate-files.json`). A change to them needs an owner instruction that names the plan, plus a
  reviewer accept on the current head. Their GitHub volume is low (one contents read per queue run, one commit read per
  sparring poll, and `gh pr list` is already GraphQL). Deferred to a follow-up plan, recorded in `blockers.md`.
- **D13 Kiro Web is not changed.** The Kiro Web proxy refuses GraphQL and `gh pr`/`gh issue` (`scripts/collab/kiro-web-session.mjs:237`).
  The changes here reduce the gateway's and CI's use of the token, not Kiro Web's own `gh api` calls. Per-account tokens
  are a separate question (the owner's messages about four Kiro accounts) and are not part of this plan.
- **D14 Out of scope.** `services/mcp-gateway/src/connectors/github-mcp.ts` and `services/mcp/gateway/...` (deployment
  not verified, inv-code §1f); `scripts/ci/**` readers (`slot.mjs`, `staging-verify/run.mjs`, `rerun-policy.mjs`), one
  `gh` call per run, low volume; `scripts/native/orb-parity.mjs` in vitana-v1 (one contents call per file). Logged in
  `blockers.md` as deferred with the reason.

## 4. Lanes (interfaces defined here, not by the agents)
Every lane: `executor: kiro`, `seat: exafy` (platform area in `docs/programs/areas.yaml`), `reviewer_seat:
agent:vitana-lane-reviewer`, branch `kiro/github-api-quota/<lane-id>`, paths as listed. Evidence in `docs/validation/<VTID>/`.

| Lane | Depends on | Files (new = N) | Tests (fail on base) |
|---|---|---|---|
| `gh-http` | none | N `services/gateway/src/services/github/github-http.ts`; N `services/gateway/test/github-http-cache-backoff.test.ts` | the new module does not exist on base; every test fails there |
| `ci-scripts-backoff` | none | N `scripts/collab/github-backoff.mjs`; N `scripts/collab/github-backoff.test.mjs`; `scripts/collab/land-guard.mjs` (read path `ghJson` only) | new module absent on base; land-guard wait loop asserts no fixed 60 s retry under a limit |
| `gh-clients` | `gh-http` | `services/gateway/src/services/github-service.ts` (`githubRequest`, `getPrStatus` `.catch`); `services/gateway/src/services/project-manager/github-rest.ts` (`gh`); N `services/gateway/test/github-rate-limit-propagation.test.ts` | a 403-with-reset and a 429 each drive one blocked window with zero second `fetch`; `getPrStatus` throws on rate limit, does not report `allPassed` |
| `gh-graphql-core` | `gh-http` | N `services/gateway/src/services/github/graphql-client.ts`; N `services/gateway/src/services/github/graphql-mapping.ts`; N `services/gateway/test/github-graphql-mapping.test.ts` | pure mapping and transport; fails on base (module absent) |
| `gh-graphql-wire` | `gh-clients`, `gh-graphql-core` | `services/gateway/src/services/github-service.ts` (`getPrStatus`, `listOpenPrsWithStatus`); N `services/gateway/test/github-graphql-wire.test.ts`; the existing tests that pin the REST `pulls/N`, `status`, `check-runs` shape for those two functions (`test/vtid-04218-pipeline-resilience.test.ts`, `test/worker-orchestrator-await-autopilot.test.ts`, `test/vtid-03835-github-service-read-access.test.ts`, `test/vtid-04465-operator-pipeline-regression.test.ts`, `test/operator-pipeline/fake-operator-platform.ts`) updated to the new call shape | GraphQL call counted (one POST, no REST `status`/`check-runs` GET); REST fallback on GraphQL error; kill switch |
| `pm-observer-graphql` | `gh-clients`, `gh-graphql-core` | `services/gateway/src/services/project-manager/observe-live.ts` (wire the reader); N `services/gateway/src/services/project-manager/observe-live-graphql.ts`; N `services/gateway/test/project-manager/observe-live-graphql.test.ts` | one batched read per tick instead of per-PR REST; blob/file/variable paths unchanged |
| `polling-cadence` | `gh-clients` | `services/gateway/src/services/dev-autopilot-watcher.ts` (tick constants, export, `isRateLimited` guard); `services/gateway/src/routes/cicd.ts` (`pollIntervalMs`); N `services/gateway/test/github-polling-cadence.test.ts` | pinned tick values; a rate-limited tick makes zero `getPrStatus` calls until reset |

File ownership: `github-service.ts` is edited by `gh-clients` and then by `gh-graphql-wire`, so `gh-graphql-wire`
depends on `gh-clients` (sequential, not parallel). `github-rest.ts` only by `gh-clients`. `observe-live.ts` only by
`pm-observer-graphql`. `dev-autopilot-watcher.ts` and `cicd.ts` only by `polling-cadence`. No other shared files.
Hot files named in `collaboration.md` §8a (migrations, `DATABASE_SCHEMA.md`, `src/App.tsx`, `screens.json`,
`exclusions.json`, the parity ledger, i18n shards, `CLAUDE.md`) are not touched.

Parallel waves: wave 1 `gh-http` and `ci-scripts-backoff`; wave 2 `gh-clients` and `gh-graphql-core` (after
`gh-http`); wave 3 `gh-graphql-wire`, `pm-observer-graphql`, `polling-cadence` (after their deps). At most 3 lanes are
in flight at once, under the cap of 6.

## 5. Interfaces between lanes (fixed here)
`services/gateway/src/services/github/github-http.ts` exports:
- `class GithubRateLimitError extends Error { status: number; resource: 'core' | 'graphql'; resetAt: Date }`
  and `isGithubRateLimitError(e: unknown): e is GithubRateLimitError`. `GithubRateLimitError` extends `Error` and keeps
  the `GitHub API error: <status> - …` message prefix.
- `githubFetch(url: string, init: RequestInit & { cache?: 'default' | 'bypass' }, opts: { token: string; resource?: 'core' | 'graphql'; fetchImpl?: typeof fetch; nowMs?: () => number }): Promise<{ status: number; statusText: string; headers: Headers; text: string }>`.
  Throws `GithubRateLimitError` when blocked or limited. Other statuses are returned, not thrown.
- `isRateLimited(token: string, resource: 'core' | 'graphql', nowMs?: number): Date | null`: the blocked-until time, or
  `null`. Used by the watcher guard (`polling-cadence`).
- `clearGithubReadCache(): void`.
- Env: `GITHUB_READ_CACHE_TTL_MS` (default 30000), `GITHUB_RATE_LIMIT_MAX_WAIT_MS` (default 3600000),
  `GITHUB_GRAPHQL_READS` (`off` disables GraphQL reads).

`services/gateway/src/services/github/graphql-client.ts` exports
`githubGraphql<T>(query: string, variables: Record<string, unknown>, opts: { token: string; fetchImpl?: typeof fetch }): Promise<T>`
(POST to the GraphQL endpoint through `githubFetch` with `resource: 'graphql'`). It throws `GithubGraphqlError` on
`errors` and returns `data` otherwise.

`services/gateway/src/services/github/graphql-mapping.ts` exports pure functions: `mapPullRequest(node)` (returns the
`GitHubPullRequest` shape), `mapStatusRollup(contexts)` (returns `{ statuses: GitHubCombinedStatus['statuses'], check_runs: GitHubCheckRun[] }`;
`SUCCESS` to `success`, `FAILURE`/`ERROR` to `failure`/`error`, `PENDING`/`EXPECTED` to `pending`; check-run
status and conclusion lower-cased to REST values), and `mapMergeState(mergeStateStatus)` (lower-cased
`mergeable_state`).

`services/gateway/src/services/project-manager/observe-live.ts` `GithubReader` (the interface near `:62-83`) keeps its
signatures. The GraphQL reader implements the per-PR methods; `tree`, `blob`, `file`, `variable` and `commitsSince`
stay REST. `variable` keeps its 404-means-unreadable behaviour.

`scripts/collab/github-backoff.mjs` exports `retryWaitMs(stderrOrHeaders, nowMs)` (pure) and
`waitForRateLimit(...)`. `land-guard.mjs` `ghJson` calls it on a read. The merge call stays a single REST `PUT` with no
retry change.

## 6. Tests and commands (real commands from `services/gateway/package.json`)
- Gateway unit tests: `cd services/gateway && npx jest <file>`; the full gateway suite is `npm test` (jest). Types:
  `npm run typecheck` (`tsc --noEmit`). Build: `npm run build`.
- CI scripts: `node --test scripts/collab/github-backoff.test.mjs` and `node --test scripts/collab/*.test.mjs`.
- Every new test must fail on `origin/main` first (red-on-base output in `docs/validation/<VTID>/commands.log`).
- Tests use injected `fetchImpl` and fake clocks only. No test calls GitHub, the gateway, or Supabase.
- Measurement (`docs/validation/<VTID>/timings.json` per collaboration §8b, plus `commands.log`): fake-`fetch` call counts
  per `getPrStatus` and per PM tick, before and after. Live `GET /rate_limit` before and after is optional and read-only;
  the driver records it only if a read token is present, and never falls back to an unauthenticated call (common rule 7).

## 7. Staging proof
This change deploys the gateway (`AWS-STAGE-DEPLOY-GATEWAY.yml`), so STAGING-VERIFY runs after merge. A staging test is
read-only and cannot drive a GitHub write, and no read-only staging route is known to call `getPrStatus` or the PM
observer. So the outcome cannot be seen on staging. The PR body and the lane log must state:
**not verified on staging: rate-limit and GraphQL behaviour needs a live GitHub quota, and staging is read-only; covered
by the unit tests named in section 4.** STAGING-VERIFY still checks `/alive` and build-info on the merge commit (CLAUDE.md
rule 20). Gate 2 quotes the unit-test counts and the measurement.

## 8. Risks
- **R1 GraphQL refused by the production tokens** (inv-rules §5.1). Mitigation: D7 fallback and the kill switch; the
  first watcher tick after deploy logs the path taken.
- **R2 Stale merge-path reads.** Mitigation: D5 `cache: 'bypass'` on merge-gate reads; the lane lists them by grep
  (`mergePullRequest`, `safeMerge`, PR decide).
- **R3 A rate-limit error turned into a false green.** Mitigation: D9, with a test.
- **R4 Per-process cache and blocked state.** The gateway runs several ECS tasks. Each task has its own cache and
  window, so the fleet-wide saving is less than the per-task figure. The plan does not claim a fleet-wide number.
- **R5 Protected files.** Mitigation: D12, none in this plan.
- **R6 `github-service.ts` is shared** by the watcher, plan-sparring and PM code. Mitigation: sequential lanes, the
  REST path kept as fallback, and the full gateway jest suite run by the `gh-graphql-wire` lane.
- **R7 `scripts/collab/**` is a governance path.** `ci-scripts-backoff` and the lane files need the reviewer accept on
  the current head (collaboration §3a); the lane is not `executor: claude`.

## 9. Unchanged
Write paths and their REST calls; merge authority and §7b checks; the error text prefix; the `branchExists` 404 match;
the 404 contract of `gh()`; the blob cache; the search endpoints; the plan driver heartbeat; the reviewer and sparring
chains; `vitana-v1`; every protected gate file; production.
<!-- plan:end -->
