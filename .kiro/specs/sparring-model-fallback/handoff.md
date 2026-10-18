---
slug: sparring-model-fallback
author: kiro
author_seat: exafy
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-18T17:49Z
---
# Handoff — sparring-model-fallback

Makes the Plan Sparring partner resilient to the Opus 4.6 fresh-subscription daily-token throttle without
weakening VTID-04868 (Opus 4.6 primary, never a silent fallback). On a retryable throttle only
(`Too many tokens per day` / rate limit), the partner pass retries once on Claude Sonnet 4.6
(`eu.anthropic.claude-sonnet-4-6`, verified ACTIVE in eu-central-1, 6M tokens/min, no fresh-subscription
daily cap), logs the fallback loudly, and gates `output_config.effort`/`thinking` by model so each model
gets a request shape it accepts (fixes the class of bug where Opus 4.5 rejected `output_config.effort`).

Plan: `plan.md` (between the plan markers — what PLAN-SPAR spars). Requirements, design, tasks alongside.
Drafted — sparred by PLAN-SPAR; VTID allocated on convergence; the lane then flips from `owner`-held to `kiro`.

Lanes:
- `partner-fallback-code` — repo vitana-platform, executor **kiro** (seat `exafy`, reviewer `jtadic`),
  gateway code: `partner.ts` throttle-retry, `bedrock.ts` field gating, `llm-defaults.ts` fallback
  constant, plus the regression test. HELD at `next_actor: owner` until PLAN-SPAR allocates the VTID.

## Log

### 2026-10-18T15:10Z · kiro-exafy-202610181512-fb92 · drafted
Authored the spec grounded in the real code (partner.ts runPartnerPass, bedrock.ts buildBedrockRequestBody,
llm-defaults.ts NO_FALLBACK_STAGES). Pushed as plan( PR for PLAN-SPAR to spar. No VTID allocated by this
session. Next: PLAN-SPAR round 1.

### 2026-10-18T15:16Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T17:49Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
