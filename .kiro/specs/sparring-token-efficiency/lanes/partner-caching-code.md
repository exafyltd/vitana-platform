---
lane: partner-caching-code
state: ready
next_actor: owner
depends_on: [plan-spar-reasons]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/providers/bedrock*.ts
  - services/gateway/src/services/llm-router.ts
  - services/gateway/src/services/llm-telemetry-service.ts
  - services/gateway/src/types/llm-telemetry.ts
  - services/gateway/src/services/plan-sparring/**
  - services/gateway/src/constants/llm-defaults.ts
  - services/gateway/test/plan-sparring-*.test.ts
updated: 2026-10-20T08:30Z
---
# Lane: partner-caching-code

Bedrock prompt caching for `plan_sparring`, cache usage in `modelLog`, right-sized output and tool results, and the
per-session token budget (`token_budget`). Tasks T0–T6 are in `tasks.md`. The lane is held at `next_actor: owner`
until PLAN-SPAR allocates the VTID on convergence; it then flips to `kiro` (seat `jtadic` builds, `hotmail` reviews).

Escalation carry-over (owner approved escalated, 2026-10-20) — R3-F1, task T3a in `tasks.md`. Acceptance: T-d spies
on `completeLLMCallDetached` and asserts the call inside `callViaRouter` receives `cacheReadTokens` and
`cacheWriteTokens` equal to the mocked Bedrock response's values, so dropping them from the spread fails the test.

## Log
### 2026-10-18T22:12Z · kiro-hotmail-202610151618-b437 · ready
Lane created with the plan. The scope is the Bedrock provider path (`providers/bedrock*.ts` and the router's
`bedrockAdapter` in `llm-router.ts`), `plan-sparring/**`, `llm-defaults.ts` and `test/plan-sparring-*.test.ts`.
`llm-router.ts` is included because the router builds the Bedrock request and drops the usage fields
(:984-1056). No VTID yet; CI allocates it on convergence.
### 2026-10-19T17:50Z · kiro-hotmail-202610151618-b437 · ready
Sparring round 1: paths gain `services/gateway/src/services/llm-telemetry-service.ts` so the cache tokens reach the
OASIS `llm.call.completed` event (R1-F2).
### 2026-10-19T18:00Z · kiro-hotmail-202610151618-b437 · ready
Sparring round 2: paths gain `services/gateway/src/types/llm-telemetry.ts`, where `LLMTelemetryPayload` gets the
optional cache fields (R2-F1).
