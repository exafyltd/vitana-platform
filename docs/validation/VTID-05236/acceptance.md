# VTID-05236 — Plan sparring: DeepSeek last-resort partner tier

Owner decision 2026-10-19 (in session, Kiro): sparring must never stop because Bedrock quota is burned.
Owner explicitly waived sparring for this change and instructed Kiro to merge it (§7b, staging only).

AC-1: When Opus 4.6 fails, the partner pass continues on Bedrock Sonnet 4.6.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts — "any Bedrock failure on Opus (AccessDenied) moves on to Sonnet"

AC-2: When Opus 4.6 and Sonnet 4.6 both fail, the round runs on DeepSeek `deepseek-v4-pro`, sticky for every following turn.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts — "Opus and Sonnet out of quota ⇒ DeepSeek serves the round, sticky"

AC-3: Only all three tiers failing escalates `model_unavailable`; every tier is tried exactly once.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts — "every tier fails ⇒ escalated / model_unavailable"

AC-4: Kill switch `PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED=false` removes the DeepSeek tier.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts — "kill switch … no DeepSeek call"

AC-5: The router lets `plan_sparring` run on DeepSeek only for a call flagged `planSparringLastResort`; no other provider is unlocked, and the router never falls back for the stage.
TEST: services/gateway/test/vtid-04868-plan-sparring-stage.test.ts — "runs on DeepSeek ONLY for an explicit last-resort call", "the last-resort flag never unlocks any provider other than DeepSeek"

AC-6: Real router path: Opus → Sonnet → DeepSeek, one call each, DeepSeek request on `deepseek-v4-pro` with thinking disabled and the same four tools.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts — "real router path: Opus → Sonnet → DeepSeek"

AC-7: Live: a full partner round completes on DeepSeek with Bedrock unavailable.
TEST: outputs/live-deepseek-e2e.txt (local run, real router, real DeepSeek API, no database)
