# VTID-03841 — DeepSeek adapter request timeout

## Report

After VTID-03839 reached staging (`978d494`), the operator on-ramp test for
VTID-03829 finally produced a real execution: `autopilot_execute_task`
returned `status: "queued"`, `dev_autopilot_executions` row `beeb2c55` was
created with the DeepSeek override in its metadata, and the executor picked
it up at 07:40:03 UTC and started the worker LLM call on
`deepseek/deepseek-flash` at 07:40:04.

**Then nothing.** No `llm.call.completed`, no `llm.call.failed`, no further
execution event for 20 minutes, until the stuck-running watchdog reclaimed
the row at 08:00:10 ("stuck in 'running' > 20m"). The self-healing bridge
spawned a retry child whose worker call — on the default Bedrock policy,
because the child does not inherit the on-ramp override — completed in 30
seconds and then failed on the GitHub step because the staging gateway task
definition carries no `GITHUB_SAFE_MERGE_TOKEN`. Full read-only trace in
`outputs/staging-observation-2026-09-13.txt`.

The defect this VTID fixes, verified in code rather than assumed:
`llm-router.ts`'s `deepseekAdapter` issued a plain `fetch` to
`api.deepseek.com` with **no `AbortSignal` and no timeout**. A stalled
request therefore never returned. That matters twice over: the execution
sits in `running` until a 20-minute watchdog, and `callViaRouter`'s
`allowFallback` can never engage because it needs a *failure* to fall back
from. The operator chat's own DeepSeek call on the same task completed in
2.4 seconds, so DeepSeek was reachable; the worker-shaped request (32,000
`max_tokens`, full execution prompt) is what never came back. Whether the
connection stalled or the in-process promise died with a recycled container
cannot be told apart from this session (no CloudWatch access); the timeout
makes both cases surface as a bounded, named failure instead of silence.

Fix: every DeepSeek request now carries `AbortSignal.timeout(ms)`, with
`ms` from `DEEPSEEK_TIMEOUT_MS` (default 10 minutes — under the worker
execution budget of 12 minutes and the 20-minute watchdog, far above any
legitimate call observed). An abort/timeout returns
`{ ok: false, error: "DeepSeek request timed out after <ms>ms (DEEPSEEK_TIMEOUT_MS)" }`
so the router fallback and `llm.call.*` telemetry fire. Invalid or
non-positive env values resolve to the default, never to "no timeout".

## Acceptance Criteria

AC-1 — `resolveDeepseekTimeoutMs` honours a positive `DEEPSEEK_TIMEOUT_MS`
and resolves unset, empty, non-numeric, zero and negative values to the
10-minute default.

TEST: `test/vtid-03841-deepseek-adapter-timeout.test.ts` —
"resolveDeepseekTimeoutMs: env override, and a 10-minute default for
unset/invalid values".

AC-2 — Every DeepSeek request carries an `AbortSignal`.

TEST: same file — "every DeepSeek request carries an AbortSignal".

AC-3 — A request that never completes on its own fails within the
configured timeout with the named error, in milliseconds rather than
minutes.

TEST: same file — "a stalled request fails within the timeout with a
named error, instead of hanging".

AC-4 — The bounded failure is what lets the stage's policy fallback engage;
the stall previously made fallback unreachable.

TEST: same file — "the timeout is what lets the policy fallback engage".

AC-5 — The defect shape is pinned: without a signal the same stalled
request never settles (mutation check).

TEST: same file — "mutation check: without a signal the same stalled
request would never settle".

AC-6 — No regression: `tsc --noEmit` clean; router suites green; full
gateway suite green.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-scoped-router.txt`
(3/3 suites, 20 tests); `outputs/jest-full-suite-tail.txt`.

## Not fixed here — separate findings from the same run

1. **Staging gateway has no GitHub token.** The retry child failed with
   `base branch lookup: GITHUB_SAFE_MERGE_TOKEN not set`. `getGithubToken()`
   accepts `DEV_AUTOPILOT_GITHUB_TOKEN`, `GITHUB_SAFE_MERGE_TOKEN` or
   `GITHUB_TOKEN`; `AWS-STAGE-DEPLOY-GATEWAY.yml` upserts none of them
   (its secrets block resolves only jwt/anon/gemini/openai/deepseek/aurora).
   So no on-ramp execution can open a PR from staging today regardless of
   the LLM. Adding a write-capable GitHub token to staging is a
   security-relevant decision: `POST /api/v1/operator/chat` on staging
   accepted this session's request with no Authorization header, so the
   on-ramp trigger is reachable unauthenticated there. Left to the platform
   owner.
2. **Self-heal children drop the on-ramp override.** The bridge's child
   `fb3d86f8` carried no `llm_on_ramp_override`, so the retry silently ran
   on the default worker policy (Bedrock) instead of DeepSeek. Design gap
   in `dev-autopilot-bridge`'s `spawnChildExecution`; its own VTID.
3. **Staging runs executions in-process.** No `DEV_AUTOPILOT_USE_JOB` /
   `DEV_AUTOPILOT_JOB_CLOUD` on the staging workflow, so a fire-and-forget
   promise on the gateway task is the execution runtime — the exact
   fragility the code's own watchdog comment describes. Prod's workflow
   pins neither var either; whatever the live prod task definition carries
   is not verifiable from this session.
4. **§2b's Bedrock table is stale on one row.** The retry's worker call on
   `eu.anthropic.claude-opus-4-5-20251101-v1:0` completed normally
   (29.6s, 3517 in / 2768 out), so that Opus profile is invokable today.
   Doc update only.
5. **`dev_autopilot_outcomes` skips `operator_onramp` findings** — its
   `fetchFinding` accepts only `dev_autopilot` / `dev_autopilot_impact`,
   so no outcome row was written for this run. Its own VTID.

## Not verified here

The timeout is verified structurally and by regression, not against a live
DeepSeek stall — this session cannot make DeepSeek hang on demand. The next
real signal is the next on-ramp execution on staging: a DeepSeek stall must
now surface within 10 minutes as `llm.call.failed` plus a fallback attempt,
never as a 20-minute watchdog reclaim.
