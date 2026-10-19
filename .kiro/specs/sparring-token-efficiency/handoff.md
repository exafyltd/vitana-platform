---
slug: sparring-token-efficiency
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-19T17:50Z
---
# Handoff — sparring-token-efficiency

This plan keeps the Plan Sparring partner from draining the account-wide Bedrock tokens-per-day pool, which it shares
with the Sonnet 4.6 fallback and every production Bedrock stage:
- explicit Bedrock prompt caching (`cache_control` over InvokeModel), on for `plan_sparring` only, with a kill switch;
- cache read/write and quota tokens recorded in `modelLog`;
- right-sized `max_tokens` and tool-result size;
- a per-session token budget that stops with the new retryable reason `token_budget`.

Opus 4.6 stays the partner model (rule 53 untouched).

Plan: `plan.md`, the text between the plan markers, which PLAN-SPAR spars. Requirements, design and tasks are
alongside. The VTIDs are allocated by CI on convergence.

Lanes:
- `partner-caching-code`: repo vitana-platform, executor kiro (seat `jtadic`, reviewer `hotmail`). Gateway code and
  the unit tests. Held at `next_actor: owner` until the VTID exists. Depends on `plan-spar-reasons`.
- `plan-spar-reasons`: repo vitana-platform, executor claude (governance path `scripts/collab/**`). Adds
  `token_budget` to the CI driver's infra/retryable reason lists. Held at `next_actor: owner` until the VTID exists.

## Log
### 2026-10-18T22:12Z · kiro-hotmail-202610151618-b437 · drafted
Authored the spec on origin/main a7433dfe and verified every premise at file:line (partner.ts :37/:39/:41/:111-126,
github-tools.ts :22-23, bedrock.ts :222-285, llm-router.ts :984-1056, plan-spar.mjs :32-33/:186-187). There are no
`cachePoint`/`cache_control` hits in the gateway providers, router or plan-sparring code.

Corrections built into the plan:
- InvokeModel uses `cache_control`, not `cachePoint`.
- The router `bedrockAdapter` is part of the Bedrock path.
- CI needs the new reason too, which is why there is a Claude lane.

Pushed as a `plan(` PR for PLAN-SPAR. No VTID was allocated by this session. Next: PLAN-SPAR round 1; this seat
answers the rounds in `sparring/responses-<n>.md`.

### 2026-10-18T22:20Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-19T17:50Z · kiro-hotmail-202610151618-b437 · drafted
Answered sparring round 1 in `sparring/responses-1.md` (3 accepted, 1 rejected with the Anthropic prefix-order
citation). Lane `partner-caching-code` gains `llm-telemetry-service.ts`.
