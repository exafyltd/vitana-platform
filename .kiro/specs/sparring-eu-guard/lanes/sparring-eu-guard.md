---
lane: sparring-eu-guard
state: ready
next_actor: kiro
branch: claude/sparring-eu-guard/code
depends_on: []
executor: claude
seat: exafy
area: platform
repos: [exafyltd/vitana-platform]
reviewer_seat: exafyltd
updated: 2026-11-11T21:37Z
reviewer: exafyltd (exceptions seat; the reviewer agent is refused on claude lanes)
paths:
  - services/gateway/src/constants/llm-defaults.ts
  - services/gateway/src/services/plan-sparring/partner.ts
  - services/gateway/src/providers/bedrock.ts
  - services/gateway/test/plan-sparring/sparring-eu-guard.test.ts
  - services/gateway/test/providers/bedrock-region.test.ts
vtid: VTID-05762
---
# Lane sparring-eu-guard (C1–C3 of plan sparring-eu-guard)
Build C1, C2 and C3 exactly as the plan states. Red tests first on main, then the change. Nothing else.

### 2026-11-11T21:37Z · ci-plan-spar · ready (VTID allocated)
VTID-05762 allocated after policy approval (converged-auto-v1).

### 2026-11-12T20:11Z · kiro-exafyltd-202611111044-8f1d · review
review: accept
head: 827c4b315fd780708f4ff40c1db040e5b95a0adf
reviewer: exafyltd (exceptions seat, this lane's reviewer_seat) via the M4 Bedrock chain, model of record eu.anthropic.claude-opus-5-5 (tier 1, eu-central-1); DeepSeek off (config)
PR: https://github.com/exafyltd/vitana-platform/pull/4999 (verdict comment https://github.com/exafyltd/vitana-platform/pull/4999#issuecomment-6834342827)
Findings: none blocking; all non-blocking:
- [non-blocking] `services/gateway/src/services/plan-sparring/partner.ts`: Prior tier-3 blocking finding re-judged as non-blocking. Plan C1's 'partner.ts and llm-defaults.ts change together' is about behaviour: the gate and the tier list must agree. partner.ts builds its tiers from isPlanSparringDeepseekFallbackEnabled(), which is read at call time when the tiers array is built in runPartnerPass. Flipping that function therefore flips the partner tier list with no edit to partner.ts. partner.ts also matches the protected glob services/gateway/src/services/plan-sparring/**. Editing it only to restate the change would trigger checklist item 9 and the two-model protected-gate path for no behavioural gain. The plan item is met in substance.
- [non-blocking] `services/gateway/src/services/plan-sparring/partner.ts:19`: The header comment still says 'Kill switch for the DeepSeek tier: PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED=false'. That is stale: the tier is now opt-in with 'true'. Fix it in a later protected-gate change.
- [non-blocking] `services/gateway/src/constants/llm-defaults.ts:146`: The PLAN_SPARRING_LAST_RESORT_MODEL docstring still describes the tier as on, with a 'Kill switch: PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED=false'. That contradicts the new default-off doc on isPlanSparringDeepseekFallbackEnabled. This file is in the diff and in the lane paths; update the comment.
- [non-blocking] `services/gateway/test/plan-sparring/sparring-eu-guard.test.ts:13`: C3(a)/(b) test the gate function, not the partner 'tiers' list the plan names. Integration is covered only by composition: the existing kill-switch case in test/vtid-04868-plan-sparring-service.test.ts proves that a false gate means no DeepSeek call. A direct runPartnerPass case with the flag unset (no DeepSeek call, escalates after Sonnet) would pin it end to end.
- [non-blocking] `docs/validation/VTID-05762/staging-tests.json`: Plan section 3 bullet 3 (a real sparring round converges with no DeepSeek entry in model_log) has no evidence and is not scheduled. It can only be shown after the staging deploy. Record it read-only from a staging round's model_log before Gate 2; staging-tests.json lists only Jest suites.
- [non-blocking] `services/gateway/src/providers/bedrock.ts:213`: The new not_configured result is a router-visible Bedrock failure. For other stages whose LLM_SAFE_DEFAULTS fallback is deepseek, a missing region could still route to DeepSeek through the router fallback. This is pre-existing and unchanged: the base us-east-1 call failed and fell back the same way. It is out of scope per plan C4/§5, but D5 applies there too.
- [non-blocking] `docs/validation/VTID-05762/commands.log:5`: Bookkeeping drift. commands.log validates branch claude/sparring-eu-guard/sparring-eu-guard while the lane file says branch claude/sparring-eu-guard/code. The report-only PR-GATE sparring check fails because the sparring record lives at .kiro/specs/sparring-eu-guard/sparring/verdict.md, not docs/validation/VTID-05762/plan-sparring.md.
Earlier runs on the same head: tier 3 (Opus 4.6) said changes on partner.ts, reached only because the request carried a parameter the 5.5 models refuse; tier 1 then ran out of output tokens before its JSON. The run of record judged both points non-blocking.
Next: the PR head is now 177d12c071 (main merged in, governance files came with it), so M4 runs again on the head that merges. Main is red on Gateway Jest (loop-catalog, vtid-04018, vtid-05041; commits a199f9ac9a and c8ecb6eb3f), so nothing lands until main is green (owner spec v5 M7).
