# VTID-04238 — Model policy verification (build plan item 6)

Docs-only: `docs/AGENT-REGISTRY.md` §6 records, from the live project, the
stage → provider/model table of the ACTIVE `llm_routing_policy` row, which
agents sit on each stage, what each stage actually served in the last 24 h,
whether every agent model is in `llm_allowed_models`, and the
vertex/anthropic catalog flags — with the decisions that are the owner's
named as such.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — The stage table in §6.1 is the ACTIVE `llm_routing_policy` row (v17), read live, not a workflow file.
TEST: `outputs/llm-routing-policy-v17-and-catalog-2026-09-21.json` (read-only SQL, is_active=true).

AC-2 — No stage's primary or fallback is `vertex` or `anthropic`; the 24 h telemetry shows zero `anthropic`/`vertex`/`openai` calls, zero `llm.call.failed`, zero fallbacks.
TEST: `outputs/llm-call-telemetry-24h-2026-09-21.json` (`absent` block).

AC-3 — Every provider/model pair v17 names is an active `llm_allowed_models` row.
TEST: `outputs/llm-routing-policy-v17-and-catalog-2026-09-21.json` (`llm_allowed_models_active` vs `policy.stages`).

AC-4 — The vertex/anthropic catalog rows, the retired DeepSeek aliases and the Google-first `RECOMMENDED_MODELS` are flagged with the decision each needs, none of them changed here.
TEST: `docs/AGENT-REGISTRY.md` §6.3 (docs-only diff — `git diff --name-only origin/main...HEAD` lists only `docs/**` and `CLAUDE.md`).

OASIS_PROOF: none — no code, no event, no schema; reads only.
