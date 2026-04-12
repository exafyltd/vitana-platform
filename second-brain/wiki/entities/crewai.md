# CrewAI

> CrewAI is the agent framework used in Vitana's autonomous architecture to define multi-agent crews with Planner, Worker, and Validator roles, configured via `crew.yaml` templates that map roles to LLM models.

## Content

### What CrewAI Is

CrewAI is an open-source framework for orchestrating multi-agent AI systems. In Vitana, it provides the structure for defining agent "crews" -- teams of AI agents that collaborate on tasks with distinct roles and responsibilities.

### How It's Used in Vitana

CrewAI is the foundational framework for Vitana's autonomous workforce under `services/agents/`. The architecture specification (v1) defines that all future agents must follow the CrewAI-based specification.

### Crew Templates

The primary crew template (`crew_template/crew.yaml`) defines role-to-model mappings:

| Role | Model (crew.yaml) | Responsibility |
|------|-------------------|----------------|
| Planner | gemini | Task decomposition, rollback plans, risk assessment, idempotency keys |
| Worker | claude | Command execution, dry-run mode, PR creation, rollback commands |
| Validator | chatgpt | Output verification, quality checks, compliance validation |

Each role has a defined contract (from `autonomy_guardrails.yaml`):
- **Planner contract**: Must output rollback_plan, idempotency_key, risk_level, approvals_needed
- **Worker contract**: Must output commands, dry_run flag, pr_required flag, rollback_commands

### Crew Template as Canonical Config

The autonomous architecture specification states that `crew.yaml` should be the single source of truth for role-to-model mappings. However, as of the 2026-02-13 execution review, this is not yet the case -- three different config sources disagree:

- `crew_template/crew.yaml` -- Declarative template (gemini/claude/chatgpt)
- `conductor/llm-router/router.py` -- Runtime routing logic (claude-3-5-sonnet / gemini-1.5-flash / claude-3-5-sonnet)
- `worker-runner/execution-service.ts` -- Hardcoded model string (gemini-2.5-pro)

The P0 recommendation is to make `crew.yaml` the sole source of truth and eliminate all hardcoded model strings.

### Agent Services in Vitana

| Service | Location | Status |
|---------|----------|--------|
| Worker Runner | `services/worker-runner/` | Active -- executes tasks via Vertex AI |
| LLM Router | `services/agents/conductor/llm-router/` | Active -- routes by role with fallbacks |
| Conductor | `services/agents/conductor/` | 17-line stub -- effectively non-functional |
| Memory Indexer | `services/agents/memory-indexer/` | Deprecated (VTID-01184) -- Flask + Mem0 + Qdrant |
| Cognee Extractor | `services/agents/cognee-extractor/` | New -- entity extraction from transcripts |

### Governance Integration

CrewAI agents in Vitana operate under OASIS governance:
- Every action checks `EXECUTION_DISARMED` and `AUTOPILOT_LOOP_ENABLED` flags
- VTID lifecycle tracking: allocation -> execution -> PR -> validation -> merge -> deploy -> verify -> complete
- Event emission for monitoring and audit
- Max iterations per task (`max_iterations_per_rid` from guardrails)

### Known Issues

1. **Config drift** -- Three sources of truth for model assignments need consolidation to `crew.yaml`
2. **No schema enforcement** -- LLM outputs are not validated against crew contracts before execution
3. **No feedback loop** -- Failed tasks are logged but not analyzed for pattern extraction or prompt improvement
4. **Disconnected planes** -- Worker-runner and LLM Router operate independently without communication

## Related Pages

- [[autonomous-execution]]
- [[autopilot-system]]
- [[cognee]]
- [[cognee-integration]]

## Sources

- `raw/autonomy/vitana-autonomous-architecture-v1.md`
- `raw/autonomy/autonomous-execution-review-2026-02-13.md`

## Last Updated

2026-04-12
