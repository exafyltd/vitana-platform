# ADR-001: VCAOP remains the single execution engine; the Mesh extends it

**Status:** Accepted (Phase 0, VTID-03532, 2026-08-08)

## Context
The AI Commerce Mesh brief requires a Connector Factory, canonical model,
public MCP/OAuth gateway, durable workflows, and AI-assisted integration.
A parallel "mesh platform" beside VCAOP would duplicate guardrails, audit,
vault, policy, and tenancy — and inevitably drift.

## Decision
All Mesh capabilities are built as extensions of `services/vcaop/` and the
existing OASIS/Prisma substrate. Every external operation — including ones
initiated by external AI clients through the public MCP gateway — executes
through the existing `Connector` interface and its `BaseConnector` gate
sequence (env-boundary → policy-engine → human-gate → CAPTCHA guard), the
vault, and OASIS event emission. New modules land as siblings
(`src/canonical/`, `src/factory/`, `src/workflows/`, `src/mcp/`), never as a
second platform.

## Consequences
- No guardrail is ever reimplemented; new action types extend the existing
  `human-gate` action list and policy schema.
- The 184-test baseline is a permanent regression floor.
- Anything that cannot pass through VCAOP's gates is not built.
