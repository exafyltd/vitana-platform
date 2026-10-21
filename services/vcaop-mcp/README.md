# vcaop-mcp — Vitanaland Public MCP/OAuth Gateway (Commerce Mesh Phase 1)

**VTID:** VTID-03533 · **Status:** dev/staging only — public exposure gated on BLK-006 (DNS/infra) and BLK-007 (authorization-server decision). See `vcaop/MESH-PHASE0-REPORT.md` and `vcaop/adr/ADR-004`, `ADR-005`.

The public, multi-tenant MCP endpoint (`https://mcp.vitanaland.com/mcp` once
approved) that lets ChatGPT, Claude, and other AI clients use Vitanaland
tools under the user's **Vitanaland OAuth** authorization. This service holds
no business logic and no secrets beyond its own token-verification config —
every tool delegates to VCAOP with tenant + user context taken exclusively
from the verified token.

## Phase 1 surface (read-only)

10 capability-scoped tools: `search_products`, `get_product`,
`compare_offers`, `get_inventory`, `get_cart`, `get_order`,
`get_order_status`, `get_wallet`, `get_rewards`,
`get_partner_capabilities`. Each is declared in
`src/tools/registry.ts` with input schema, required scopes, risk level,
read-only/destructive flags, confirmation + idempotency requirements, audit
event type, and policy checks. There is deliberately **no** generic tool
that proxies arbitrary internal APIs.

Scopes: `vitana:catalog:read`, `vitana:cart:read`, `vitana:orders:read`,
`vitana:wallet:read`, `vitana:rewards:read`, `vitana:partners:read`.

Security properties (all covered by tests in `test/`):

- OAuth 2.1 resource-server: bearer-only, HS256 test verifier behind the
  swappable `TokenVerifier` interface (production JWKS verifier lands with
  BLK-007); audience validation; expiry; revocation checked on every request.
- RFC 9728 protected-resource metadata at
  `/.well-known/oauth-protected-resource`; 401s carry `WWW-Authenticate`
  with the metadata URL.
- **Scope-filtered discovery**: `tools/list` only shows tools the token can
  call; calling an unauthorized tool is indistinguishable from calling a
  nonexistent one.
- Tenant + user identity come only from the token — no tool accepts a tenant
  or user parameter.
- Per-subject rate limiting (429 + `Retry-After`).
- Every call emits a sanitized audit event (no inputs/outputs/PII/secrets —
  asserted by `assertAuditSafe` on every emit).
- Stable error codes: `invalid_input`, `unauthorized`, `forbidden_scope`,
  `forbidden_tenant`, `not_found`, `rate_limited`, `backend_unavailable`,
  `internal`.

## Running (dev)

```bash
npm install && npm run build
MCP_TEST_AS_HS256_SECRET=<dev-secret> npm start   # port 8080, /alive health
```

Env: `MCP_RESOURCE_URL` (default `http://localhost:8080/mcp`),
`MCP_AUTHORIZATION_SERVERS`, `MESH_BACKEND=memory|gateway` (default
`memory`; `gateway` needs `VCAOP_GATEWAY_URL` + `VCAOP_GATEWAY_TOKEN_REF`
and only serves the endpoints the gateway actually exposes today — the rest
return `backend_unavailable` until the Phase 2 canonical read-model API).

Verified with MCP Inspector CLI (2026-08-08): `initialize`, scope-filtered
`tools/list`, and `tools/call` against a local instance.

## Tests

`npm test` — 5 suites / 30 tests: protocol behavior, token failure modes
(expired/revoked/tampered/wrong-audience/missing-claims), scope filtering,
tenant isolation, per-tool behavior, rate limits, audit sanitization.
