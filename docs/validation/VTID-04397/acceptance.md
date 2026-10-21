# VTID-04397 — Orchestrator P3: support specialist for members (agent-as-tool)

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.4 pattern 2 ("single specialist as a tool") and §5 P3 ("first specialists as agent-as-tool: support/account (community)"). This is the second target for `delegate_to_agent`. It is the first one on the member ORB, and the first that runs through the VTID-04375 dispatcher somewhere other than the Command Hub.

The specialist returns findings and Vitana answers in her own words (NEVER-rule 41). It is read-only. It can see the member's own tickets and the knowledge base. It never sees the unapproved draft answer or the dev spec. It ships inert behind `ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED` (exact `'true'`).

## Acceptance criteria

AC-1 Off by default. Without the flag no target registers, no tool is declared, the member catalog is unchanged, and the tool refuses with `not enabled`.
TEST: services/gateway/test/services/orchestrator/vtid-04397-support-specialist.test.ts

AC-2 With the flag on, the member (vitanaland) catalog declares `ask_support_specialist`, `get_delegation_result` and `cancel_delegation` once each. The anonymous, command-hub and commerce catalogs do not get them. At the Nova 64 KB budget the packer keeps all three and every existing priority tool. The names live in a separate `FLAG_GATED_PRIORITY_TOOLS` list, so the existing check that every priority name exists in the catalog keeps its meaning.
TEST: services/gateway/test/services/orchestrator/vtid-04397-support-specialist.test.ts
TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts

AC-3 Every read is pinned to the caller's own user id. The repository lookup filters by `user_id` and never selects `draft_answer_md`, `spec_md`, `raw_transcript` or `supervisor_notes`. A spoken ticket number normalises to the stored `FB-YYYY-MM-NNNNNN` shape; a bare number matches the member's own ticket by suffix. Tools never throw and honour cancellation.
TEST: services/gateway/test/services/orchestrator/vtid-04397-support-specialist.test.ts

AC-4 The specialist runs the shared VTID-04231 stage loop on the `triage` stage, with `service: support-specialist`, its three read tools, at most 4 turns and 6 tool calls, and a 45 s limit. Findings are capped at 1,500 characters and labelled "not a script". A loop failure or empty answer fails the job; a signed-out caller never runs.
TEST: services/gateway/test/services/orchestrator/vtid-04397-support-specialist.test.ts

AC-5 The call goes through the dispatcher:
- A community member on voice gets the findings inside the 1.5 s ack window.
- A slow lookup returns `working` with a job id, and `get_delegation_result` later returns the findings.
- Signed-out callers are refused, and so is the command-hub surface.
- `orb-live.ts` dispatches `ask_support_specialist`.

Existing delegation behaviour (VTID-04375/04386) is unchanged.
TEST: services/gateway/test/services/orchestrator/vtid-04397-support-specialist.test.ts
TEST: services/gateway/test/orb/live/vtid-04386-voice-delegation.test.ts

## Not verified live, stated plainly

- The flag is not set on any task definition; this PR changes no deploy workflow.
- Both LLM providers are refusing today, so a real specialist run could not complete even if the flag were on. Bedrock access and the DeepSeek balance are owner-owed.
- Staging cannot place ECS tasks (AWS block since 2026-09-22 22:57 UTC).

The first live signal: with the flag pinned on staging, a member asking about their ticket produces an `llm.call.completed` with `stage=triage` and `service=support-specialist`.

## Not done here, and why

- **Cascade path:** the cascade (ru/pl/tr/zh/ar/sr) declares only `report_to_specialist` and `switch_persona` (VTID-04336), so the specialist is Nova/Vertex-only until the cascade gains the tool. That is a separate change to the shared cascade pipeline (§2c-fish-scope).
- **Text chat:** delegation from member text chat is a later slice. Voice is where P3's exit criterion is measured.
