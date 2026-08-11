# ADR-002: The Connector Factory compiles manifests INTO the existing Connector interface

**Status:** Accepted (Phase 0, VTID-03532, 2026-08-08)

## Context
Connectors today are handwritten classes (`ApiConnector`, `OAuthConnector`,
`BrowserConnector`, `ManualConnector`) plus six handwritten marketplace-sync
provider adapters in the gateway (admitad, amazon, awin, cj, rakuten,
shopify). The brief requires a compiler-driven factory over versioned
`ConnectorManifest`s.

## Decision
`ConnectorFactory.compile(manifest)` produces objects implementing the
**unchanged** `Connector` interface (plus generated validators, transformers,
webhook handlers, health checks, contract tests, and MCP tool definitions).
Because generated connectors extend `BaseConnector`, every guardrail fires
before any generated adapter hook — generated code cannot bypass policy,
human gates, or env boundaries by construction.

Manifests store secret **references** only (vault pattern), carry
`certification_status`, and are versioned; a connector version is immutable
once certified. The existing precedence API → OAuth → SCIM → browser →
manual is expressed as manifest `connection_type` ordering, not new code
paths.

Handwritten connectors remain valid (`origin: handwritten` vs `generated`);
marketplace-sync providers are re-expressed as manifests incrementally with
parity contract tests before any cutover, never big-bang.

## Consequences
- One interface, two origins; the execution engine cannot tell them apart.
- Certification is a pipeline state, not a boolean flag someone sets.
- Rollback of a bad generated connector = reactivate the prior certified
  version (both persisted).
