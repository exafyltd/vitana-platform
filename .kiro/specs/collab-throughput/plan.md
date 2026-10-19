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
- Replace the per-branch loop in `collect()` with one call:
  `git log --remotes=origin --not <main> --since=<days>.days --source --name-only --format=%x1e%S -- .kiro/specs`.
  For each record keep the `%S` source ref and the changed paths that `classifyPath` accepts. Skip
  `collab-claim/*` and `origin/HEAD`, as today.
- Read all candidate `(ref, path)` contents with one `git cat-file --batch` process (stdin `ref:path` lines),
  replacing the per-file `git show`. Specs on `main` use the same batch.
- Behaviour kept: newest `updated` wins across refs, `--days` default 30, the output rows and table are identical.
- Known difference: `--source` names the first ref that reached a commit. When several branches carry the same spec
  commit, only one is reported as its source. The `consider()` newest-`updated` rule then picks the same file
  content, but the `branch` column may name a different branch that carries it. The test pins this.
- Target: under 10 s for both repos on the owner's machine (from ~7–8 min).

### B. Check sparring answers before sending them (`plan-spar.mjs`, PLAN-SPAR.yml)
- In `step()`'s `in_progress` branch, after `client.get(cur.id)` (already fetched as `live`), compare the parsed
  responses with `live.rounds[n-1].review.findings[].id`. Collect three lists: unknown ids, duplicate ids, and
  missing ids.
- If any list is non-empty: send nothing to the gateway, return `{ action: 'responses_invalid', problems }`, write a
  plain-language report to the step summary and to `$RUNNER_TEMP/plan-spar-comment.md`, and exit 1. The report names
  each id and states the rule ("answer every finding of round n exactly once; earlier rounds' findings go in the
  plan text").
- PLAN-SPAR.yml `Comment` step: `if: always() && steps.guard.outputs.skip != 'true'`. Use
  `--body-file "$RUNNER_TEMP/plan-spar-comment.md"` when that file exists, otherwise today's body. The `Commit the
  round` step stays success-only.
- Same check for a malformed `responses-<n>.md` (no json block, not an array), which `parseResponses` already
  detects. Today that also fails without a comment.

### C. Sparring code-access health (gateway + scheduled alert)
- Gateway: `GET /api/v1/plans/spar/health` (same auth as the other `plans-spar` routes:
  `requireServiceOrAdmin`). For each repo in `PLAN_SPARRING_REPOS` it does one contents read of `README.md` at that
  repo's `main` HEAD with `PLAN_SPARRING_GITHUB_TOKEN`. It returns
  `{ ok, repos: { <repo>: { ok, status } }, token_configured }`. It sends no model call and writes nothing.
- `plan-spar.mjs`: before `client.create` / `client.round`, call the health route once. If `ok: false`, exit 1 with
  "sparring partner cannot read code (<repo>: HTTP <status>); no session was started". That way an outage never
  creates a session the plan has to pay for. The comment step from B carries the message.
- `.github/workflows/ALERT-PLAN-SPARRING-CODE-ACCESS.yml`: every 30 min plus `workflow_dispatch`. It GETs the
  **staging** gateway health route (PLAN-SPAR spars through staging, `vars.PLAN_SPAR_GATEWAY_URL`) with
  `secrets.GATEWAY_SERVICE_TOKEN`, and fails the job on a non-200, a non-JSON answer, or `ok: false`. Same shape as
  `ALERT-PUSH-DISPATCH-HEALTH.yml`. It is read-only and never touches production.

### D. Sparring token budget (gateway)
Measured 2026-10-18: on account 472838866351 both partner models now return `Too many tokens per day`, including
the Sonnet 4.6 fallback (session model logs 798679a9…, b9c1eb9b…, d0be51a3…: primary and fallback both throttled).
Sonnet 4.6 took ~6.6M input tokens in the 19:16–20:16Z hour, during a batch of ~13 concurrent plan pushes.
Service Quotas lists only per-minute token quotas for both models, so this daily limit is not a quota we can
raise. Every gateway stage in `llm-defaults.ts` (planner, worker, validator, operator, memory, triage, vision,
classifier) also runs on `eu.anthropic.claude-sonnet-4-6` in the same account, so sparring draws from the
budget member-facing calls use.
- **Concurrency cap:** at most `PLAN_SPARRING_MAX_CONCURRENT_PASSES` (default 2) partner passes run at once per
  gateway task. Extra creates and rounds wait their turn inside the existing PLAN-SPAR wait window
  (`plan-spar.mjs` already polls `GET /:id` for up to 25 min). They never fail because they waited.
- **Smaller history:** tool results stored in the conversation history are clipped to 4,000 chars once the turn
  that read them is over. The current turn still gets the full 20,000-char result. This cuts the input that grows
  every turn (round-1 turns reach ~77k input tokens today).
- **A visible budget:** the session record and `round-<n>.md` show the input and output token totals per round,
  so a runaway pass shows up in the PR.
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
- D: clipping old tool results could drop evidence the partner wants to re-cite. It can re-read the file, since
  `read_file` is pinned to the same ref, and the evidence check uses the tool log, not the history. A waiting
  pass can outlast PLAN-SPAR's 25-min wait. Then the existing poll recovers it on the next push, as today.

## Verification

- `node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs`:
  - A: one-pass `collect()` produces the same rows as the old implementation on a fixture repo with main + 3
    branches (one with no spec change, two with competing lane versions), and spawns a fixed number of processes
    whatever the branch count.
  - B: unknown, duplicate, missing and malformed responses each give `responses_invalid` with the right ids, no
    gateway `round` call, and a comment file. A valid set still calls `round`.
  - C: health `ok: false` means no `create` / `round` call and exit 1.
- Gateway Jest (D): a third concurrent pass waits until one of two running passes finishes; history tool results
  older than the current turn are clipped and current-turn results are not; round token totals are recorded.
- Gateway Jest: the health route answers 401 without auth, `ok: true` when both reads return 200, `ok: false` with a
  per-repo status when one fails, and `token_configured: false` when the token is unset. `npx tsc --noEmit`.
- After merge and the staging deploy: `GET https://preview-aws-gateway.vitanaland.com/api/v1/plans/spar/health`
  (Bearer `GATEWAY_SERVICE_TOKEN`) returns `ok: true`, and one `workflow_dispatch` of the alert goes green. Time a
  queue run on the owner's machine and record it. Everything is read-only, with no production calls.
<!-- plan:end -->
