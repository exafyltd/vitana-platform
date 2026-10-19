# Plan — collab-throughput

Three fixes to the collaboration tooling that slow the plan → spar → build pipeline: a queue that takes minutes,
sparring answers that fail late and silently, and a broken sparring token that went unnoticed for a day.

<!-- plan:begin -->
## Problem

Measured 2026-10-18 on the owner's Windows checkout and in CI:

1. **`queue.mjs` takes minutes.** `collect()` (`scripts/collab/queue.mjs` ~L246–269) lists every remote branch
   updated in the last 30 days. For each one it spawns `git diff --name-only <main>...<ref> -- .kiro/specs`, then one
   `git show` per spec file. One diff measured ~0.9 s here. vitana-platform has 105 such branches and vitana-v1 has
   391, so a two-repo queue run is roughly 7–8 minutes. Every session's first queue call times out at 120 s.
   vitana-v1's `delete_branch_on_merge` is `false`, so its branch count keeps growing (vitana-platform: `true`).
2. **A badly formatted sparring answer fails late and silently.** `submitPlannerRound`
   (`plan-sparring-service.ts` ~L340–350) requires exactly one answer per finding of the previous round and rejects
   anything else (`unknown_finding:<id>`, `duplicate_response:<id>`, `unanswered_findings:<ids>`). `plan-spar.mjs`
   `step()` sends `responses-<n>.md` without checking it. The gateway's 400 makes the Spar step exit 1, and the
   PLAN-SPAR.yml `Comment` step (no `if: always()`) is skipped. The PR shows a red check and no explanation. Seen
   2026-10-18 on native-g1-wiring (run 39157408933, `unknown_finding:R1-F1`): the planner reported "round 3 is
   queued" when it had actually failed.
3. **A broken sparring token is invisible until plans pile up.** `hasCodeAccess` only checks that
   `PLAN_SPARRING_GITHUB_TOKEN` is set (`plan-sparring-service.ts` ~L77). On 2026-10-17 the token was set but could
   not read. Ten plans ran round 1 with 0 successful reads in 15–30 attempts and were recorded as plan failures. No
   alarm fired. (Relabelling those rounds is `plan(sparring-floor-retry)` #4186. This plan adds the detection.)

## Changes

### A. Queue in one pass (`queue.mjs`)
- Replace the per-branch loop in `collect()` with one call (argv array, no shell):
  `git log --exclude=refs/remotes/origin/collab-claim/* --exclude=refs/remotes/origin/HEAD --remotes=origin
  --not <main> --since=<days>.days.ago --source --name-only --format=%x1e%S -- .kiro/specs`.
  - `--since` uses the explicit `<days>.days.ago` form (R2-F1).
  - `%S` comes back as a full refname (`refs/remotes/origin/<branch>`). Normalise each value with
    `ref.replace(/^refs\/remotes\//, '')` before any comparison, so the existing guards (`origin/HEAD`, `origin`,
    `origin/collab-claim/…`) keep working. Claim refs are also kept out at the source by `--exclude`, which must
    come before `--remotes` (R2-F2).
  - For each record keep the normalised source ref and the changed paths that `classifyPath` accepts.
- Read all candidate `(ref, path)` contents with one `git cat-file --batch` process (stdin `ref:path` lines),
  replacing the per-file `git show`. Specs on `main` use the same batch.
- Behaviour kept: newest `updated` wins across refs, `--days` default 30, the output rows and table are identical.
- Deterministic tie-break (s2 R1-F5): `consider()` keeps its strict newest-`updated` rule. Candidates are fed in a
  fixed order: main first, then branch refs sorted lexically. On equal `updated` the first one wins, so main
  beats any branch and otherwise the lexically smallest ref wins, independent of git log output order. The fixture
  includes two branches with an identical `updated` to pin the `branch` column.
- Known difference: `--source` names the first ref that reached a commit. When several branches carry the same spec
  commit, only one is reported as its source. The `consider()` newest-`updated` rule then picks the same file
  content, but the `branch` column may name a different branch that carries it. The test pins this.
- Target: under 10 s for both repos on the owner's machine (from ~7–8 min).

### B. Check sparring answers before sending them (`plan-spar.mjs`, PLAN-SPAR.yml)
- In `step()`'s `in_progress` branch, after `client.get(cur.id)` (already fetched as `live`), compare the parsed
  responses with `live.rounds[n-1].review.findings[].id`. Collect three lists: unknown ids, duplicate ids, and
  missing ids.
- If any list is non-empty: send nothing to the gateway and return `{ action: 'responses_invalid', problems }`.
  `step()` writes no file outside its spec directory.
- **Missing review guard:** if `live.rounds[n-1]?.review` is absent (a partner-error round), `step()` sends nothing
  and returns `{ action: 'responses_invalid', problems: ['no_review_to_answer: round <n> has no findings to
  answer'] }` without indexing `.findings` (s2 R1-F3).
- **One failure path in `main()`:** `main()` takes a new `--comment-file <path>` argument (PLAN-SPAR.yml passes
  `$RUNNER_TEMP/plan-spar-comment.md`). Its whole body, including argument parsing, runs inside one `try/catch`.
  `--comment-file` is read first, before any validation, so even a `Usage` error writes the comment file (exit 2,
  as today; s2 R1-F2). `--comment-file` is optional. When it is absent (a manual run), every report goes to stdout
  and the step summary only, and nothing is written to a file, so a missing path can never turn a Usage report into
  a crash (s2 R2-F2). It handles every failure the same way:
  - a returned failure action (`responses_invalid` here, `code_access_down` from C): `main()` writes the report
    to the step summary and the comment file, then returns 1;
  - a thrown error from `step()`: `main()` wraps `await step(…)` in `try/catch`. That covers `client.create` /
    `client.round` / `client.allocate` errors (`create: HTTP <status> …`, `round <n>: HTTP <status> …`, e.g.
    `already_approved` 409, `plan_text_too_large` 400, `store_error` 502), `waitFor` timeouts and
    `parseResponses` errors. The catch writes a report naming the step, the HTTP status and the gateway's `error`
    field when present, then returns 1 (2 for `Usage`, as today). It never re-throws, so the comment file always
    exists when the job fails.
  - The report always ends with the next action ("fix responses-<n>.md and push" / "partner outage: push again
    later" / "gateway rejected the request: <error>").
  - The `responses_invalid` report names each id and states the rule ("answer every finding of round n exactly
    once; earlier rounds' findings go in the plan text").
- PLAN-SPAR.yml `Comment` step: `if: always() && steps.guard.outputs.skip != 'true'`. Use
  `--body-file "$RUNNER_TEMP/plan-spar-comment.md"` when that file exists, otherwise today's body. The `Commit the
  round` step stays success-only.
- Same check for a malformed `responses-<n>.md` (no json block, not an array), which `parseResponses` already
  detects. Today that also fails without a comment.

### C. Sparring code-access health (gateway + scheduled alert)
- Gateway: `GET /api/v1/plans/spar/health` (same auth as the other `plans-spar` routes:
  `requireServiceOrAdmin`). For each repo in `PLAN_SPARRING_REPOS` it does one contents read of `README.md` with
  `PLAN_SPARRING_GITHUB_TOKEN` and **no `ref` parameter**, so GitHub serves the repo's own default branch whatever
  it is named (s2 R2-F1). A 404 (no README on the default branch) counts as reachable (`ok: true`, status recorded),
  because only 0/401/403/429/5xx mean the token cannot read. The Jest test pins that the request URL has no `ref=`
  and that a 404 gives `ok: true`. It returns
  `{ ok, repos: { <repo>: { ok, status } }, token_configured }`. It sends no model call and writes nothing.
  `router.get('/health', …)` is registered **before** `router.get('/:id', …)` in `plans-spar.ts` (Express matches
  in order, and `/:id` would take `id = 'health'` and fail the UUID check). A Jest test pins that
  `GET /api/v1/plans/spar/health` reaches the health handler, not the session read.
- `plan-spar.mjs`: `step()` calls the health route once, before `client.create` / `client.round`. If it says
  `ok: false`, `step()` returns `{ action: 'code_access_down', repos }` without calling either.
  `main()`'s single failure path from B writes "sparring partner cannot read code (<repo>: HTTP <status>); no
  session was started" and returns 1. That way an outage never creates a session the plan has to pay for. If the
  health call itself fails (network, 5xx, 404 from an older gateway), `step()` carries on as today. Only an explicit
  `ok: false` blocks, so the check never blocks sparring on a gateway that predates it.
- `.github/workflows/ALERT-PLAN-SPARRING-CODE-ACCESS.yml`: every 30 min plus `workflow_dispatch`. It GETs the
  **staging** gateway health route (PLAN-SPAR spars through staging, `vars.PLAN_SPAR_GATEWAY_URL`) with
  `secrets.GATEWAY_SERVICE_TOKEN`, and fails the job on a non-200, a non-JSON answer, or `ok: false`. Same shape as
  `ALERT-PUSH-DISPATCH-HEALTH.yml`. It is read-only and never touches production.

### D. Sparring token budget (gateway)
Measured 2026-10-18: on account 472838866351 both Bedrock partner models returned `Too many tokens per day`,
including the Sonnet 4.6 fallback (session model logs 798679a9…, b9c1eb9b…, d0be51a3…: primary and fallback both
throttled). Since #4192 (VTID-05236) a DeepSeek tier sits behind Sonnet, so a pass no longer escalates at that
point. It still spends the shared Bedrock budget first.
Sonnet 4.6 took ~6.6M input tokens in the 19:16–20:16Z hour, during a batch of ~13 concurrent plan pushes.
Service Quotas lists only per-minute token quotas for both models, so this daily limit is not a quota we can
raise. Every gateway stage in `llm-defaults.ts` (planner, worker, validator, operator, memory, triage, vision,
classifier) also runs on `eu.anthropic.claude-sonnet-4-6` in the same account, so sparring draws from the
budget member-facing calls use.
- **No concurrency cap (removed after sparring, s2 R1-F4).** A server-side queue would hold round requests with
  nothing written to the store. A round queued longer than PLAN-SPAR's 25-min wait would then fail with no
  recoverable record. Making that safe needs a durable pending-round state, which is a larger change than this plan
  should carry. Cost per pass is handled by `plan(sparring-token-efficiency)` #4189 (prompt caching and a
  per-session token budget, seat hotmail). Bursts of pushes are an operating rule, not code: push plans a few at a
  time.
- **Not here:** prompt caching, per-session token budgets and per-turn quota accounting are all #4189.
- **A throttle is an outage:** when both models are throttled, the round escalates `model_unavailable` (already
  infra and retryable). This change only adds the cause and the next try time to the round file ("partner models
  throttled until the daily limit resets; push again after it").

## Lanes

One lane, `throughput-code`, **executor: claude**. A–C touch `scripts/collab/**` and `.github/**`, which are
governance paths (collaboration §3a). The gateway route rides in the same PR so the health check and its first
consumer ship together. Reviewer seat `exafy`. It runs after `sparring-floor-retry` (#4186) merges, because both
edit `plan-spar.mjs` `step()`. Each lane is in its own spec, so the order is enforced by the Claude Code session,
not `depends_on`.

## Out of scope (owner settings, recorded so they are not lost)

- vitana-v1 "Automatically delete head branches" (currently off), and a one-off cleanup of branches whose PRs are
  merged or closed.
- How often the Kiro Web automations of the authoring seats run (hourly today).
- Changing `MAX_SESSIONS`, the round caps, or the evidence floor.

## Risks

- A: a wrong `--source` mapping could hide a lane file that exists only on one branch. Mitigated by a test with
  two branches that carry different versions of one lane file, plus a one-off comparison of the old and new
  `collect()` output on both real repos before merge (identical rows, or every difference explained).
- B: a stricter local check than the gateway's would block a valid answer. The check copies the gateway's three
  rules exactly, and a test feeds the same cases to both.
- C: the health route spends one GitHub read per repo per PLAN-SPAR run and per alert run (~100/day). That is far
  under the fine-grained token's rate limit.
- D: a waiting pass can outlast PLAN-SPAR's 25-min wait. Then the existing poll recovers it on the next push, as
  today.
- `plan-spar.mjs` is edited by this plan, #4186 (`sparring-floor-retry`) and #4189's `plan-spar-reasons` lane.
  All three are Claude Code lanes. Build them in one session, in the order #4186 → #4189 reasons → this plan, each
  rebased on the last.

## Verification

- `node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs`:
  - A: one-pass `collect()` produces the same rows as the old implementation on a fixture repo with main + 4
    branches (one with no spec change, two with competing lane versions, and one `collab-claim/<slug>/<lane>` ref
    on a spec commit). The claim ref never appears as a row's branch. The process count is fixed whatever the
    branch count. The spawned `git log` argv contains `--since=<days>.days.ago`, and every reported ref is in the
    short `origin/…` form.
  - B: unknown, duplicate, missing and malformed responses each give `responses_invalid` with the right ids, no
    gateway `round` call, and a comment file. A valid set still calls `round`.
  - C: health `ok: false` means no `create` / `round` call and exit 1.
  - B/C: `step()` writes nothing outside the spec directory. `main()` with `--comment-file` writes the report
    for a returned `responses_invalid`, a returned `code_access_down`, a `client.round` that throws a simulated
    `round 2: HTTP 400 {"error":"plan_text_too_large"}`, and a `client.create` that throws a 409. Each case writes
    the comment file containing the status and gateway error, and exits 1. A health call that fails with a network
    error does not block (`create` is still called).
- Gateway Jest (D): a throttle escalation's round file names the cause and says to push again later.
- `plan-spar.test.mjs` (s2): a prior round without a review gives `responses_invalid` with `no_review_to_answer`; a
  missing `--dir` still writes the comment file and exits 2; a run with neither `--dir` nor `--comment-file` prints
  the Usage report and exits 2 without throwing; two branches with identical `updated` resolve to the
  lexically smaller ref.
- Gateway Jest: the health route answers 401 without auth, `ok: true` when both reads return 200, `ok: false` with a
  per-repo status when one fails, and `token_configured: false` when the token is unset. `npx tsc --noEmit`.
- After merge and the staging deploy: `GET https://preview-aws-gateway.vitanaland.com/api/v1/plans/spar/health`
  (Bearer `GATEWAY_SERVICE_TOKEN`) returns `ok: true`, and one `workflow_dispatch` of the alert goes green. Time a
  queue run on the owner's machine and record it. Everything is read-only, with no production calls.
<!-- plan:end -->
