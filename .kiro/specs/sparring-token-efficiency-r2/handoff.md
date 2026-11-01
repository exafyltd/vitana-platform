---
slug: sparring-token-efficiency-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T15:48Z
---
# Handoff — sparring-token-efficiency-r2
Re-plan of `sparring-token-efficiency` (branch `kiro/sparring-token-efficiency/plan`; PLAN-SPAR session `b2df0328`
escalated at the round cap). The plan keeps the Plan Sparring partner from draining the shared Bedrock tokens-per-day
pool. It adds prompt caching, cache usage in telemetry and `model_log`, right-sized output and tool results, and a
per-session token budget with a retryable `token_budget` reason. Plan: `plan.md`.

## Log

### 2026-11-01T15:48Z · kiro-hotmail-202611011452-6d16 · drafted
Owner instruction 2026-11-01: "you make the decisions for me". The escalated plan is re-planned rather than approved
as escalated.
- R3-F1 (the telemetry spy in T-d) is answered in `plan.md` "Re-plan answers".
- The partner premises are rewritten for today's tier loop: one `modelLog.push`, and `quota_tokens` only for
  Bedrock entries.
- The lanes are split along the protected-gate line:
  - `llm-cache-telemetry` is executor `kiro` and merges under §7b.
  - `partner-budget` (`plan-sparring/**`) and `plan-spar-reasons` (`plan-spar.mjs`) are executor `claude` (the
    exceptions seat). They merge only on the owner's instruction naming this plan, which is an owner stop asked once
    at merge time.

The plan PR opens when PLAN-SPAR capacity allows (`collaboration.md` §8a).
