# VTID-04555 — ORB voice keeps the member's memory in the Nova instruction

Found in the staging end-to-end memory test (2026-09-25, test user, two real voice sessions over SSE):
session A stated three facts; the session-end commit saved 5 facts and a session summary. Session B,
two minutes later, answered "I don't have access to personal information… unless you've shared it".
`orb.live.diag instruction_budget` for session B: scaffold 32,919 B + bootstrap 12,072 B = 44,991 B
against the 30,720 B Vertex budget → `trimmed_sections: ["bootstrap"]`, still over budget. The brain
bootstrap is where the member's memory lives, and the scaffold alone exceeded the budget, so every
authenticated Nova session lost it. The 30 KB exists for the Vertex Live setup frame; Nova 2 Sonic has
a 1M-token context and this gateway already chunks its instruction.

AC-1: Vertex and unknown providers keep the 30 KB budget; Nova and the cascade get 64 KB; the Nova env
override cannot go below 30 KB.
TEST: services/gateway/test/orb/live/instruction/vtid-04555-instruction-budget-per-provider.test.ts

AC-2: with the measured staging sizes, the bootstrap is dropped under the Vertex budget and kept on Nova.
TEST: services/gateway/test/orb/live/instruction/vtid-04555-instruction-budget-per-provider.test.ts

AC-3: orb-live enforces and reports the budget of the serving provider (the diag carries it).
TEST: services/gateway/test/routes/vtid-04525-conversation-hub-phase-a-routes.test.ts

AC-4 (live, after the staging deploy): a new voice session recalls facts from the previous one, and its
`instruction_budget` diag shows `budget_bytes: 65536`, `trimmed: false`.
TEST: services/gateway/test/orb/live/instruction/vtid-04555-instruction-budget-per-provider.test.ts (live evidence in outputs/)
