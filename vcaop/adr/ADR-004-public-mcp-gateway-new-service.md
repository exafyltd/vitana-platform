# ADR-004: The public MCP/OAuth gateway is a NEW service; internal MCP components are not exposed

**Status:** Accepted (Phase 0, VTID-03532, 2026-08-08)

## Context
`services/mcp/gateway/` is an internal connector hub for the platform's own
agents (GitHub/Supabase/etc.); `mcp/vitana-work/` is stdio dev tooling.
Neither speaks MCP Streamable HTTP to external clients, has OAuth, tenancy,
scopes, or metering. The brief targets `https://mcp.vitanaland.com/mcp` for
ChatGPT, Claude, and future AI clients.

## Decision
Build a new deployable service (working name `services/vcaop-mcp/`) that:
- Speaks MCP Streamable HTTP; implements OAuth 2.1 authorization-code +
  PKCE (S256), protected-resource metadata, AS metadata, dynamic client
  registration, audience validation, short-lived access tokens, refresh +
  revocation, granular scopes.
- Holds NO business logic: every tool call delegates to VCAOP services/API
  with tenant + user context; per-tool scope/risk/confirmation/idempotency
  declarations are data, checked centrally.
- Emits structured logs without secrets/PII/health data; meters usage per
  tenant/client.
- Never touches AI-client consumer credentials; Vitanaland OAuth is the
  authorization boundary. Background automation uses Vitanaland-managed
  model API projects or vault-stored business enterprise credentials.

Internal MCP components remain internal and unchanged.

## Consequences
- DNS/TLS/infra for `mcp.vitanaland.com` and the OAuth AS choice are
  explicit blockers (BLK-006/007) — security-tier decisions, not silently
  self-approved.
- Production exposure stays disabled until Phase 1 security tests pass and
  DoD item 18 is explicitly resolved.
