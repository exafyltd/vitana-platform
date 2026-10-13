# VTID-05077 — Dev Autopilot autonomy, Phase A: the planner writes its own plans again, and a fallback is never silent

Owner approval 2026-10-12 ("yes" at Gate 1 on the sparred master plan; owner amendment: planner fallback = Bedrock Opus 4.6). Sparring: `plan-sparring.md` (standard, 3 rounds, CONVERGED). Outcome analysis: `outcome-analysis.md`.

Problem: 128 of 246 Dev Autopilot planner calls (2026-10-05..11) failed with "deepseek/deepseek-flash returned no text: output cap reached (stop_reason=length, output_tokens=8000)" — DeepSeek Flash reasons by default and spent the whole cap on hidden reasoning (VTID-04794). Each of those plans was then written by the shared `planner` row's fallback (Bedrock Sonnet 4.6) with nothing on the plan or the screen saying so, and `plan.failed` events reported "unknown error".

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: GET /api/v1/dev-autopilot/spend (existing route; now also returns `planner`), mounted in services/gateway/src/index.ts under /api/v1/dev-autopilot.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/command-hub/ (Autopilot screen status strip, "Planner fallback 24h" chip).

OASIS_PROOF: `dev_autopilot.plan.fallback_used` (new, status warning) fires for every plan version the fallback wrote; `dev_autopilot.plan.generated|version_added` payloads now carry `planner_provider`, `planner_model`, `fallback_used`.

CURL_PROOF: `GET /api/v1/dev-autopilot/spend` without a token → 401 JSON (staging-tests.json); with a developer token the body has `planner: { plans_24h, fallback_24h, fallback_rate_24h }`.

## Acceptance criteria

AC-1: The planner call sends DeepSeek `thinking: {type: "disabled"}`; any other caller's DeepSeek request body is unchanged (no `thinking` field).
  TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
AC-2: `callViaRouter` accepts a per-call `fallbackOverride`; a failed primary is served by it (Opus 4.6), not by the policy row; it is refused for vertex/anthropic/claude_subscription and ignored on a no-fallback stage; it never writes into the cached policy.
  TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
AC-3: `runStageToolLoop` passes `fallbackOverride` and `deepseekThinking` to every turn (Phase B's planner loop keeps the Opus fallback).
  TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
AC-4: The planner fallback defaults to `bedrock/eu.anthropic.claude-opus-4-6-v1`; an env override naming vertex/anthropic/claude_subscription is refused.
  TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
AC-5: Every plan version records `planner_provider`/`planner_model` (migration 20261012110000); a fallback-written plan emits `dev_autopilot.plan.fallback_used`; the spend route returns the 24 h fallback rate and the Autopilot screen shows it.
  TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
AC-6: A planner failure always carries a reason (router error, or "<provider>/<model> returned an empty plan (stop_reason=…)"); an empty capped DeepSeek reply names its reasoning tokens.
  TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
AC-7: The 4 executions frozen in `ci` since the kill switch was armed (#4016–#4019) are closed out: PRs closed with a comment; the reconciler archives the executions.
  TEST: docs/validation/VTID-05077/outcome-analysis.md

## Decisions taken
- A1 step 1 (measure before fixing) was answered by the evidence already recorded: every one of the 128 failures returned EMPTY content at exactly 8,000 output tokens — a long plan would have returned truncated text, not none — and VTID-04794 had already identified hidden reasoning as the cause. The reasoning-token count is now parsed and logged, so the 48 h acceptance (≥ 95 % of plans from DeepSeek) is measured on staging, not assumed.
- The Opus 4.6 invoke check could not run from this session (no AWS CLI; `/api/v1/llm/providers/verify` needs an exafy_admin login and has never been called). The first real fallback on staging is the check: a denial surfaces as `llm.call.failed` for `eu.anthropic.claude-opus-4-6-v1` and a `plan.failed` naming it — never a silent substitution — and stops Phase B for the owner.
- `app.js` and `styles.css` share the new `?v=20261115-vtid-05077` (repo convention: both bumped together); the three tests pinning the previous version were updated to it.
- `GET /dev-autopilot/spend` gains a `planner` field (contract change on purpose); `test/routes/dev-autopilot.test.ts`'s exact-body assertions now include it, with two new cases (rate from plan-version rows; a failed read leaves `planner: null` and never fails the answer).
- Every staging suite that named the previous `app.js`/`styles.css` version follows the bump (VTID-04696 rule); `kiro-console.*` versions are unchanged.
- Cause 2 in the outcome analysis (deploy-event topic) was already fixed by VTID-04215; no change here.

## Limits
Local: `npx tsc --noEmit` clean; `npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts test/command-hub` 651/651 + 12/12 (cache-copy guard mutation-checked: removing the copy turns one test red); router/planning/model/override suites 34/34; `npm run test:operator` 64/64; gateway build, golden fingerprint, ownership guard and symbol-index check pass.
