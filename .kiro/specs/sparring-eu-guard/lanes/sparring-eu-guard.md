---
lane: sparring-eu-guard
state: done
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

### 2026-11-13T10:30Z · kiro-exafyltd-202611122052-a6df · review (supersedes the 827c4b315f entry above)
The branch was updated with `origin/main` twice since that accept (first merging in VTID-05764/#5027's Kiro AWS
roles work, then the full span through VTID-05785/#5057 this same session just landed), each a clean merge with
no conflicts — collaboration.md §3 treats that as invalidating the prior review, so this is a fresh one, not a
carry-forward.

review: accept
head: 484585d7f2cc46f51810b5a24d4c276b3412ef8a
reviewer: exafyltd (exceptions seat, this lane's reviewer_seat) via the M4 Bedrock chain, model of record eu.anthropic.claude-opus-5-5 (tier 1, eu-central-1)
PR: https://github.com/exafyltd/vitana-platform/pull/4999
CI on this head: 25 of 25 reported checks success or skipped (non-blocking); confirmed directly via
`gh api repos/exafyltd/vitana-platform/commits/484585d7f2.../check-runs` immediately before this review ran.
Findings: none blocking; all non-blocking:
- [non-blocking] `services/gateway/src/services/plan-sparring/partner.ts:142`: plan C1 says partner.ts and llm-defaults.ts change together; only llm-defaults.ts changed. Behaviour is correct (the tier is gated through isPlanSparringDeepseekFallbackEnabled(), read at call time), but any stale kill-switch comment in partner.ts describing the old default should be fixed in a follow-up — partner.ts is a protected gate file, so that needs the two-model path.
- [non-blocking] `services/gateway/test/plan-sparring/sparring-eu-guard.test.ts:13`: C3(a)/(b) test the flag helper, not the `tiers` list partner.ts builds from it. An integration assertion on the tiers list would pin it end to end; a follow-up.
- [non-blocking] `.kiro/specs/sparring-eu-guard/plan.md`: §3 bullet 3 (a real staging sparring round with no DeepSeek entry in model_log) is still open and can only be done after the staging deploy; record it read-only before Gate 2.
- [non-blocking] `services/gateway/src/services/dev-memory-embedding.ts:65`: the region check now runs before the empty-text check, so empty text with no region set returns `not_configured` instead of `empty_text`. Minor ordering change, no safety impact.
- [non-blocking] `services/gateway/test/providers/bedrock-region.test.ts:33`: the test fixture's role ARN contains what looks like a real AWS account id; use a placeholder (e.g. `000000000000`) in a follow-up.
This review's own local re-run (6 lane suites: 107/107 passed; full `services/gateway` suite: 2 pre-existing
environmental failures only, same as every other head this session) is recorded for context; CI is the check of
record per collaboration.md §3.
Next: rebase-merge (not squash) per the owner's instruction this session — `rebase_merge_allowed: true` on this
repo.

### 2026-11-13T10:34Z · kiro-exafyltd-202611122052-a6df · review → done
merge: edbc99751653325de4f18fe0415b903a687fab3d (PR #4999, **rebase-merge** per the owner's explicit instruction
this session, head 484585d7f2, 25/25 reported checks success/skipped, 0 commits behind `origin/main`). authority:
the review entry immediately above (`Collab-Verdict: accept`, M4 Bedrock chain). Deploys the gateway to staging on
the next `AWS-STAGE-DEPLOY-GATEWAY.yml` run; STAGING-VERIFY watches it.
