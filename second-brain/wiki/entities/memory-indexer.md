# Memory Indexer

> Service that indexes Vitana's knowledge artifacts (documentation, codebase, operational data) into Qdrant vector storage for semantic retrieval by AI agents.

## Overview

The Memory Indexer is an agent service within Vitana's multi-agent architecture. It is responsible for ingesting, chunking, embedding, and storing knowledge artifacts so that other agents (Planner, Worker) can perform semantic search to find relevant context during task execution.

## Service Identity

| Field | Value |
|-------|-------|
| Service Name | memory-indexer |
| Layer | AGTL |
| Module | MEMORY |
| Runtime | Cloud Run |
| Manifest | `services/agents/memory-indexer/manifest.json` |

The service README is minimal ("CrewAI multi-agent services for Lovable backend"), indicating it was bootstrapped from the CrewAI GCP template. Its operational details are inferred from the broader agent architecture and Phase 2C manifests.

## What It Indexes

Based on the KB integration skills and agent architecture documentation, the memory indexer processes:

- **Documentation files** -- Markdown files in the knowledge base (deployment guides, architecture docs, OASIS schema, etc.)
- **Spec files** -- VTID specifications and governance documents
- **Codebase artifacts** -- Source files relevant to agent task execution
- **OASIS events** -- Operational event history for pattern analysis

## Qdrant Integration

The memory indexer uses Qdrant as its vector database backend. Qdrant stores embeddings of indexed documents, enabling:
- **Semantic search** -- Agents query by natural language to find relevant documents
- **Relevance scoring** -- Results ranked by cosine similarity to the query embedding
- **Category filtering** -- Documents tagged by category (deployment, tracking, architecture, general) for targeted retrieval

## How Agents Use It

The memory indexer feeds into three KB skills registered in `crew_template/crew.yaml`:

1. **`vitana.kb.get_index`** -- Returns a catalog of available documents filtered by keyword query. Used by the Planner agent to identify relevant documentation during planning.
2. **`vitana.kb.get_doc`** -- Retrieves a specific document by name. Used by both Planner and Worker to load precise documentation.
3. **`vitana.kb.get_bundle`** -- Retrieves pre-defined document bundles (e.g., `cicd_docs`, `deployment_docs`, `api_docs`). Used by Worker to load all context needed for a specific task domain.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `KB_BASE_PATH` | `/mnt/project` | Root path for knowledge base files |
| `KB_CACHE_TTL` | `3600` (1 hour) | Cache time-to-live for index queries |
| `KB_MAX_DOC_SIZE` | `1048576` (1MB) | Maximum document size for retrieval |

## Telemetry

Per the Phase 2C manifest standard:
- Emits `agent.ready` on boot with manifest hash
- Emits heartbeat every 60 seconds (coalesced when idle)
- All KB access is audit-logged to OASIS as `kb.skill_executed` events

## Security

- KB files are read-only
- No user-supplied file paths (prevents directory traversal attacks)
- All file access goes through the skill abstraction layer
- Service role authentication for OASIS event emission

## Related Pages

- [[agent-architecture]] -- Overall AI agent architecture
- [[vitana-orchestrator]] -- Orchestrator that consumes indexed knowledge
- [[spec-governance]] -- Governance rules for agent services
- [[summary-agent-services]] -- Source summary of all agent READMEs

## Sources

- `raw/agents/memory-indexer-README.md`
- `raw/agents/KB_INTEGRATION.md`
- `raw/agents/crewai-gcp-README.md`

## Last Updated

2026-04-12
