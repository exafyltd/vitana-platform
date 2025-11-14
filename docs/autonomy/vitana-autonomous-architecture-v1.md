## Summary

This PR adds the initial Vitana Autonomous Workforce Architecture Specification v1.0 at:

- services/agents/docs/vitana-autonomous-architecture-v1.md

The document defines:

- The three-layer model (AI Agents → Vitana Execution Sandbox → MCP Server Network).
- The shared input envelope for all agents (task, role, recent events, tool manifest).
- Planner, Worker, Validator responsibilities and output schemas.
- Vitana Execution Sandbox responsibilities (code runner, FS workspace, MCP client, governance hooks).
- MCP server catalog for Supabase, Git, Perplexity, Google Drive, and OASIS.
- OASIS integration model (VTID ledger, events, task lifecycle).
- Governance enforcement levels (hard rules, soft rules, contextual rules).
- Context minimization rules and execution flow.

## Intent

This document is the governing architecture spec for all agent-related services under `services/agents`. 
Future agents (Planner-Core, Worker-Core, Validator-Core, QA-Agent, Conductor, OASIS Operator, etc.) must follow this specification.

Once merged, this becomes the canonical reference for:

- crew_template
- agent implementations
- Vitana Execution Sandbox
- MCP server integration
- Governance & OASIS workflows
