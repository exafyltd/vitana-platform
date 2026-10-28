# Summary: Agent Service READMEs

> Summary of all AI agent service documentation: CrewAI GCP runtime, memory indexer, Vitana orchestrator (verification engine), and KB integration skills.

## Source Documents

- `raw/agents/crewai-gcp-README.md` -- CrewAI GCP service README
- `raw/agents/memory-indexer-README.md` -- Memory indexer service README
- `raw/agents/vitana-orchestrator-README.md` -- Vitana orchestrator/verification engine README (VTID-01175)
- `raw/agents/KB_INTEGRATION.md` -- KB skills integration documentation (DEV-AICOR-0025)

## CrewAI GCP

**README Content:** "CrewAI multi-agent services for Lovable backend" (dated Sun Oct 26 2025)

Foundational multi-agent framework on GCP. Minimal README suggests it serves as a template/runtime for other agent services. Phase 2C established its manifest.json.

## Memory Indexer

**README Content:** Identical to CrewAI GCP README, indicating shared bootstrap template. Operational role is understood through KB Integration docs and Phase 2C manifest (layer AGTL, module MEMORY). Indexes knowledge artifacts for semantic retrieval via Qdrant.

## Vitana Orchestrator (Verification Engine)

**VTID:** VTID-01175

- Verification subsystem for the Worker Orchestrator (VTID-01163) -- NOT a standalone orchestrator
- Stage gates: file existence, file modification, domain validators, test execution, OASIS events
- Returns StageGateResult with passed, reason, recommended_action
- OASIS is sole authority for completion
- Python package (pip install -e .)
- Domain validators: Frontend (no console.log, a11y), Backend (no secrets, no SQLi), Memory (RLS, transactions)
- Events: vtid.stage.verification.start/passed/failed

## KB Integration

**VTID:** DEV-AICOR-0025

### Skills
1. **vitana.kb.get_index** -- Browse docs by keyword (Planner)
2. **vitana.kb.get_doc** -- Get specific document (Planner, Worker)
3. **vitana.kb.get_bundle** -- Get document bundles (Worker)

### Pre-defined Bundles
- cicd_docs, deployment_docs, api_docs

### Integration Pattern
- Planner: search -> filter by relevance > 0.7 -> fetch top 3 -> include in plan
- Worker: determine bundle from task tags -> load -> inject into context

### Implementation
KBSkills class in packages/crew-executor with getIndex, getDoc, getBundle methods. Documents auto-categorized by filename patterns. Security: read-only, no user paths, audit logged to OASIS.

## Cross-Cutting Observations

1. Both crewai-gcp and memory-indexer share identical README templates
2. Python (orchestrator) + TypeScript (KB skills) split, unified via OASIS events
3. Phase 2C standardized all manifests
4. OASIS is the universal backbone for state and audit

## Related Pages

- [[agent-architecture]] -- Concept page synthesizing all agent services
- [[memory-indexer]] -- Entity page
- [[vitana-orchestrator]] -- Entity page
- [[phase-2-evolution]] -- Phase 2C established agent manifests

## Sources

- `raw/agents/crewai-gcp-README.md`
- `raw/agents/memory-indexer-README.md`
- `raw/agents/vitana-orchestrator-README.md`
- `raw/agents/KB_INTEGRATION.md`

## Last Updated

2026-04-12
