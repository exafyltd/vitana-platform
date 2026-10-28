# Summary: Autonomous Architecture v1

> Summary of the Vitana Autonomous Workforce Architecture Specification v1.0 and the Autonomous Execution Review (2026-02-13), which together define the intended agent architecture and its actual implementation gaps.

## Content

### Architecture Spec (v1.0)

The specification (`vitana-autonomous-architecture-v1.md`) defines the governing architecture for all agent-related services under `services/agents/`. It covers:

- **Three-layer model**: AI Agents (Planner/Worker/Validator) -> Vitana Execution Sandbox (code runner, FS workspace, MCP client, governance hooks) -> MCP Server Network (Supabase, Git, Perplexity, Google Drive, OASIS)
- **Shared input envelope**: Every agent receives task, role, recent events, and tool manifest
- **Role output schemas**: Planner outputs rollback plans and risk levels; Worker outputs commands and dry-run flags; Validator outputs pass/fail with evidence
- **MCP server catalog**: Supabase MCP, Git MCP, Perplexity MCP, Google Drive MCP, OASIS MCP
- **OASIS integration**: VTID ledger, event emission, task lifecycle management
- **Governance levels**: Hard rules (always enforced), soft rules (enforced with exceptions), contextual rules (domain-dependent)
- **Context minimization rules** and execution flow specifications

This document is canonical for: crew templates, agent implementations, Vitana Execution Sandbox, MCP server integration, and governance/OASIS workflows.

### Execution Review (2026-02-13)

The review (`autonomous-execution-review-2026-02-13.md`) is a code-level analysis comparing external advisory claims against actual implementation state.

#### Ground Truth Findings

| Component | Status |
|-----------|--------|
| Supabase + Prisma | Stable and confirmed |
| Gateway on Cloud Run | Confirmed (78+ route files) |
| GitHub -> OASIS webhooks | Confirmed (HMAC verification, VTID extraction) |
| Crew Template v1.2 | Not actually versioned as 1.2 |
| Constitution in DB | Does not exist -- governance via YAML + VTID control |
| Memory Indexer | Exists but deprecated (VTID-01184), Flask + Mem0 + Qdrant |
| Conductor | 17-line stub, effectively non-functional |
| VTID governance | Active (300+ event types, VtidLedger table) |
| End-to-end autonomous | Not reliable, but root causes differ from external diagnosis |

#### Three Root Causes of Failure

1. **Two disconnected execution planes**: Worker-runner (hardcoded Gemini 2.5 Pro) and LLM Router (role-based routing with fallbacks) operate independently without interaction
2. **Unenforced contracts**: `autonomy_guardrails.yaml` declares schemas but nothing validates LLM outputs before action execution
3. **No feedback loop**: Failed VTIDs are logged but never analyzed for patterns, prompt improvement, or routing adjustment

#### Config Drift

Three config sources give three different answers for role-to-model mappings:
- `crew.yaml`: gemini / claude / chatgpt
- `router.py`: claude-3-5-sonnet / gemini-1.5-flash / claude-3-5-sonnet
- `execution-service.ts`: N/A / gemini-2.5-pro (hardcoded) / N/A

#### Priority Recommendations

| Priority | Fix |
|----------|-----|
| P0 | Resolve config drift to single source |
| P0 | Unify execution planes (wire LLM Router into worker-runner) |
| P1 | JSON Schema validation on LLM outputs |
| P1 | DB-level VTID state transition constraints |
| P2 | Close projector->worker push loop |
| P2 | Build failure analyzer |
| P3 | Prompt versioning + performance tracking |
| P3 | Consolidate memory to pgvector |

#### Anti-Patterns to Avoid

- Do not add another orchestration framework
- Do not rebuild core infrastructure (Supabase, OASIS, Gateway)
- Do not add more LLM providers until configs are unified
- Design for deterministic task execution, not general AGI

## Related Pages

- [[autonomous-execution]]
- [[crewai]]
- [[autopilot-system]]
- [[summary-cognee-integration]]

## Sources

- `raw/autonomy/vitana-autonomous-architecture-v1.md`
- `raw/autonomy/autonomous-execution-review-2026-02-13.md`

## Last Updated

2026-04-12
