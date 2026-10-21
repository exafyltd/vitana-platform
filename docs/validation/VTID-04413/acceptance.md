# VTID-04413 — Orchestrator P3: specialist delegation on the cascade voice path

Plan: docs/ORCHESTRATOR-REDESIGN-PLAN.md §5, P3 (dispatcher + specialists).

The cascade (Transcribe → Bedrock → Polly/Fish — ru, pl, tr, zh, ar, sr)
declared only the two hand-off tools, so a member speaking one of those
languages could not reach the support or commerce specialist a Nova session
reaches. `CASCADE_TOOL_ALLOWLIST` now also names `ask_support_specialist`,
`ask_commerce_specialist`, `get_delegation_result` and `cancel_delegation`.

They are declared only when the catalog passed to `connect()` already
carries them — `ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED` /
`ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED` and the surface gate decide that
upstream, unchanged. The call runs through the existing path
(`onToolCall` → `handleToolCall` → `executeLiveApiTool` → the same
`case 'ask_*_specialist'` Nova uses). The dispatcher acks within 1.5 s, well
inside the cascade's 20 s tool-result timeout. No other catalog tool is added.

## Acceptance

AC-1 The allowlist names exactly the two hand-off tools and the four delegation tools.
TEST: services/gateway/test/orb/live/upstream/vtid-04413-cascade-delegation-tools.test.ts

AC-2 Every allowlisted delegation name matches the real tool declaration (drift guard).
TEST: services/gateway/test/orb/live/upstream/vtid-04413-cascade-delegation-tools.test.ts

AC-3 A member catalog carrying the support tool gets it declared with its real schema; unrelated tools (navigate, log_water) stay off.
TEST: services/gateway/test/orb/live/upstream/vtid-04413-cascade-delegation-tools.test.ts

AC-4 With the flags off (tools absent from the catalog) the cascade declares nothing beyond the hand-off tools; the VTID-04336 suites pass unchanged.
TEST: services/gateway/test/orb/live/upstream/cascaded-persona-swap.test.ts

## Not verified live

Staging still serves `e09eb26` (AWS task-placement block) and neither
specialist flag is pinned there yet. The live signal is a cascade session
(`reason:'cascade'`) whose tool telemetry shows `ask_support_specialist`.
