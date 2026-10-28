# AI Agent Architecture

> The multi-agent system powering Vitana's autonomous engineering: CrewAI on GCP, a memory indexer with Qdrant, an orchestrator with verification stage gates, and KB integration skills for context-aware task execution.

## Overview

Vitana's AI agent architecture is a coordinated system of specialized services that together enable autonomous software engineering. The architecture follows a command hierarchy (CEO > CTO/OASIS > Claude > Gemini/Workers > Validators) and uses OASIS as the single source of truth for all state transitions.

## Core Components

### 1. CrewAI on GCP

**Source:** `crewai-gcp` service

CrewAI provides the multi-agent framework running on Google Cloud Platform. It serves as the backbone for Vitana's agent services, hosting the planner, worker, and validator agents on Cloud Run.

The service is minimal in its README ("CrewAI multi-agent services for Lovable backend") but is referenced throughout the architecture as the execution runtime for agent crews. Each agent service has a `manifest.json` (established in Phase 2C) specifying:
- Service name, layer, and module
- Provider policy (e.g., `planner: gemini-pro`, `worker: gemini-flash`, `validator: claude-sonnet-4`)
- Telemetry configuration (ready events, heartbeat interval)
- Runtime configuration (Cloud Run min/max instances)
- Dependencies (Gateway URL, OASIS URL)

### 2. Memory Indexer

See [[memory-indexer]] for detailed entity page.

The memory indexer service indexes Vitana's knowledge artifacts for retrieval by other agents. It integrates with Qdrant for vector storage and provides semantic search capabilities across the codebase, documentation, and operational data.

### 3. Vitana Orchestrator (Verification Engine)

See [[vitana-orchestrator]] for detailed entity page.

The orchestrator (VTID-01175) provides verification stage gates that integrate into the Worker Orchestrator (VTID-01163). It does NOT claim completion -- OASIS is the sole authority. It verifies that worker-claimed changes are real by:
1. Checking files exist
2. Checking files were modified
3. Running domain validators (frontend, backend, memory)
4. Executing tests
5. Emitting OASIS verification events

### 4. KB Integration Skills

**VTID:** DEV-AICOR-0025

Three knowledge base access skills enable agents to query documentation autonomously:

| Skill | Purpose | Available To |
|-------|---------|-------------|
| `vitana.kb.get_index` | Browse available documentation categories and files | Planner |
| `vitana.kb.get_doc` | Retrieve a specific document by name | Planner, Worker |
| `vitana.kb.get_bundle` | Retrieve multiple related documents at once | Worker |

**Pre-defined bundles:**
- `cicd_docs` -- CI/CD patterns, GitHub workflow, GCP deployment
- `deployment_docs` -- GCP deployment, services architecture
- `api_docs` -- Services architecture, OASIS schema

**Integration pattern:** The Planner agent uses `get_index` to find relevant docs during planning, then `get_doc` to retrieve top-3 documents by relevance score. The Worker agent uses `get_bundle` to load domain-specific documentation during task execution.

## Agent Lifecycle

1. **Boot:** Agent loads `manifest.json`, emits `agent.ready` event to OASIS
2. **Heartbeat:** Every 60 seconds, agent emits heartbeat via `packages/agent-heartbeat.ts` (coalesced when idle)
3. **Task Claim:** Worker polls `GET /api/v1/worker/orchestrator/tasks/pending`, claims task atomically
4. **Execution:** Worker executes task, emitting OASIS stage events throughout
5. **Verification:** Orchestrator runs verification stage gate on claimed output
6. **Completion:** If verification passes, orchestrator writes terminal success to OASIS; if failed, retries or escalates

## Worker Agent Connector (VTID-01183)

Bridges autonomous worker agents (Claude Code sessions) to the Autopilot Event Loop (VTID-01179):

- Workers register with capabilities and max concurrency
- Tasks are claimed atomically (prevents duplicate execution)
- Every state change emits an OASIS event
- Single worker per VTID enforced
- Heartbeat/timeout handles worker crashes

## Domain Validators

| Domain | Checks |
|--------|--------|
| Frontend | No `console.log` in production, accessibility (alt attributes), no inline styles (prefer Tailwind) |
| Backend | No hardcoded secrets, no SQL injection, error handling required for routes |
| Memory | RLS policies for new tables, no `DROP TABLE` without confirmation, transaction wrappers |

## OASIS Event Flow

Agents emit structured events throughout their lifecycle:

- `vtid.stage.verification.start` / `.passed` / `.failed` -- Verification subsystem events
- `agent.ready` -- Agent boot notification
- `agent.heartbeat` -- Periodic liveness signal
- `kb.skill_executed` -- Knowledge base access audit log

The Worker Orchestrator (VTID-01163) emits terminal events based on verification results.

## Security & Configuration

- KB files are read-only; no user-supplied file paths (prevents directory traversal)
- All file access goes through skill abstraction with audit logging to OASIS
- Environment config: `KB_BASE_PATH`, `KB_CACHE_TTL` (1 hour), `KB_MAX_DOC_SIZE` (1MB)
- Agent governance rules (GOV-AGENT-001 through GOV-AGENT-007) enforce operational protocol

## Related Pages

- [[memory-indexer]] -- Memory indexer service details
- [[vitana-orchestrator]] -- Orchestrator and verification engine details
- [[spec-governance]] -- Governance rules agents must follow (L4 Agent Governance)
- [[self-healing-system]] -- Uses the agent pipeline for autonomous fix execution
- [[summary-agent-services]] -- Source summary of all agent service READMEs
- [[phase-2-evolution]] -- Phase 2C established agent manifests and telemetry

## Sources

- `raw/agents/crewai-gcp-README.md`
- `raw/agents/memory-indexer-README.md`
- `raw/agents/vitana-orchestrator-README.md`
- `raw/agents/KB_INTEGRATION.md`
- `raw/specs/vtids/VTID-01183-WORKER-AGENT-CONNECTOR.md`

## Last Updated

2026-04-12
