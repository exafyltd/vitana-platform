---
lane: partner-budget
state: ready
next_actor: kiro
depends_on: [llm-cache-telemetry, plan-spar-reasons]
executor: claude
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/plan-sparring/**
  - services/gateway/test/plan-sparring-token-efficiency.test.ts
updated: 2026-11-01T15:48Z
repos: [exafyltd/vitana-platform]
---
# partner-budget — sparring-token-efficiency-r2

Plan: `../plan.md`. Tasks, paths and acceptance: `../tasks.md` (`<!-- lane: partner-budget -->`). The VTID comes from
PLAN-SPAR on convergence, never by hand.

This lane is the protected half (`plan-sparring/**`). The exceptions seat builds it while Claude Code is unavailable (§7).
It merges only on the owner's instruction naming this plan, plus a reviewer-agent accept on the current head
(§3a, §7b). It covers the tier-loop budget and the Bedrock-only `quota_tokens`.

Rules (§7a): no VTID allocation, no merge outside §7b, no live write. Branch `kiro/sparring-token-efficiency-r2/partner-budget`
(or the exceptions seat's). PR title `VTID-xxxxx (sparring-token-efficiency-r2/partner-budget): …`. Trailers `Collab-Session` +
`Collab-Lane: sparring-token-efficiency-r2/partner-budget`.

## Log
### 2026-11-01T15:48Z · kiro-hotmail-202611011452-6d16 · created → ready
Created by the re-plan (the protected-path split).
