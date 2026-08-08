# VCAOP — DECISIONS (Tier-A engineering + dependency verifications)

> Tier-A engineering decisions (runbook Sec. 0.4) and Sec. 0.8 dependency
> verifications (source + date + conclusion).

## Engineering decisions (Tier-A)

| ID | VTID | Decision | Rationale |
|----|------|----------|-----------|
| DEC-001 | CTRL-GUARD-0001 | New package at `services/vcaop/` with its own `package.json`, `tsconfig.json`, `jest.config.js`. | Matches monorepo convention (per-service package, ts-jest like `services/gateway`). Keeps VCAOP isolated as runbook Sec. 1.1 directs ("New initiative root: services/vcaop/"). |
| DEC-002 | CTRL-GUARD-0001 | Guardrails written as **dependency-free TypeScript** (no runtime deps; zod-style validation hand-rolled). | Minimizes supply-chain surface for security-critical code; guardrails must be auditable and must not silently pull in a CAPTCHA/PII-leaking transitive dep. Test toolchain (jest/ts-jest/typescript) is the only dev dependency. |
| DEC-003 | CTRL-GUARD-0001 | Test runner: `jest` + `ts-jest`, script `test:guardrails` runs the `test/guardrails` suite. | Runbook Sec. 3 AC requires `npm run test:guardrails` as a named CI gate; matches gateway's jest setup. |
| DEC-004 | CTRL-GUARD-0001 | Environment classification reads `VCAOP_ENV` (preferred) then `NODE_ENV`; anything not explicitly `dev`/`development`/`staging`/`test` is treated as **prod = refused** (default-deny). | Fail-closed: an unset/unknown env must not be allowed to perform deploy/migration/IAM/billing ops (runbook Sec. 0.2). |
| DEC-005 | CTRL-SCHEMA-0002 | Extend the existing root `prisma/schema.prisma` in place with 16 VCAOP models; reuse `oasis_events` as the audit ledger. | Runbook Sec. 1.1/4.7 ("extend in place, do NOT fork"; reuse OasisEvent). |
| DEC-006 | CTRL-SCHEMA-0002 | `user_id`/`tenant_id` stored as plain text references (no cross-schema FK to Supabase auth/app_users). | Those tables are managed by Supabase migrations, not this Prisma schema; matches `oasis_events.tenant` convention and keeps the migration self-contained/verifiable. |
| DEC-007 | CTRL-SCHEMA-0002 | UP SQL generated canonically from Prisma via `migrate diff` (baseline = pre-edit 3-table schema → full schema), down hand-written as `DROP … CASCADE`. | Guarantees the migration SQL exactly matches the Prisma models; satisfies Sec. 0.7 reversibility with a tested down path. |
| DEC-008 | CTRL-SCHEMA-0002 | RLS enable+policies deferred to `IAM-ROLES-0001`; OASIS-same-tx discipline deferred to `CTRL-API-0004`. | Honors the Sec. 6 VTID separation rather than half-implementing IAM/API concerns in the schema VTID. |
| DEC-009 | CTRL-SCHEMA-0002 | Verified migration on an **ephemeral local Postgres 16** (run as the `postgres` OS user) rather than mocking. | Postgres binaries are available locally; an ephemeral throwaway DB is a valid dev/test target under `env-boundary`. Turns the AC ("migrate up/down clean") into a real pass, not a mock. |

## Dependency verifications (Sec. 0.8)

| ID | Tool/SDK | Source | Date | Conclusion |
|----|----------|--------|------|------------|
| VER-001 | (none yet — guardrails layer has no third-party adapters) | — | 2026-06-04 | Connector/vendor verification begins at Layer CONN/RWD; deferred until those VTIDs. |
| VER-003 | eBay Browse/Sell API + OAuth2 + eBay Partner Network (EPN) | not independently fetched this pass | 2026-06-08 | First real integration (affiliate-first). Built `EbayApiClient`/`EbayOAuthClient` + EPN link decorator behind the existing connector interfaces, **mock-only** (no live calls; `live` flag refuses without vault creds). Verify eBay developer docs + EPN terms and supply sandbox creds → wire live. Logged BLK-004. |
| VER-002 | Amazon SP-API, eBay, Walmart, CJ (ApiConnector targets) | not independently fetched this pass | 2026-06-05 | Per Sec. 0.8 step 3: live SDK/auth model NOT re-verified against official docs in this environment (no confirmed outbound access to vendor docs; treat as unverified/gated). Built `ApiConnector` against a swappable `ApiClient` interface with **mock** provider stubs only — no live calls, none in CI. Real-vendor wiring + auth model verification is a runtime task; logged in BLOCKERS (BLK-002). |

## 2026-08-08 — Commerce Mesh Phase 1 (VTID-03533), Tier-A decisions

- **MCP SDK:** official `@modelcontextprotocol/sdk` ^1.30.0, Streamable HTTP in
  stateless JSON mode (fresh `McpServer` + transport per request — no session
  state, trivial horizontal scaling). Verified via MCP Inspector CLI against a
  running local instance (initialize / tools/list / tools/call), 2026-08-08.
- **Scope-filtered discovery via per-request registration:** tools whose scopes
  the token lacks are simply not registered, so the SDK answers "Tool not
  found" — an under-scoped client cannot enumerate the full tool surface.
  A second scope check runs inside the call wrapper (defense in depth).
- **Token verification seam:** `TokenVerifier` interface; dev/test impl is
  HS256 against a spec-shaped test AS (secret via env, never committed). The
  production JWKS/RS256 verifier is a drop-in behind the same interface once
  the AS decision (BLK-007, Tier-B security) is approved. This service never
  mints tokens. Revocation is checked on every request (`RevocationStore`).
- **registerTool typing:** the SDK's generic inference over a dynamic
  `ZodRawShape` (tools registered from a data registry, not literals) trips
  TS2589; bound a narrow explicitly-typed view of `registerTool` rather than
  loosening tsconfig or abandoning the declarative registry.
- **GatewayReadBackend honesty:** only wallet/commissions/providers are wired
  (the endpoints the gateway verifiably serves); catalog/cart/order reads
  throw `backend_unavailable` with an actionable message instead of inventing
  endpoint shapes. CI uses the synthetic `MemoryReadBackend` only.

## 2026-08-08 — Commerce Mesh Phase 2 (VTID-03535), Tier-A decisions

- **Mapping proposals are deterministic, not LLM calls.** The ingestion
  pipeline scores partner→canonical field mappings with a transparent lexical
  model (exact > token overlap > substring, camelCase-aware). An LLM proposer
  can later feed *candidates* into the same MappingDecision review flow, but
  certification must never depend on a model call — AI plans, deterministic
  systems execute (ADR-005), and a certification gate that needs an API key
  is a certification gate that silently stops running.
- **Destructive manifest actions must be human-gated OR idempotency-keyed** —
  schema-enforced in validateManifest, no third option. OpenAPI ingestion
  defaults DELETE to destructive+human_gated and all writes to
  idempotency_key; a human review may relax, the compiler never does.
- **Generated connectors extend BaseConnector** rather than reimplementing
  gate logic (ADR-002) — guardrail inheritance is proved by tests
  (default-deny, human-gate halt before transport, human-gated registration).
- **Output-validation failure is a drift signal**, surfaced as
  `invalid_output` rather than passing unvalidated partner data downstream.
- **Migration verified on ephemeral PG16 in-session** (initdb as unprivileged
  user, up→down→up + FK cascade). Live apply deliberately NOT done: no dev DB
  (BLK-001), and prod DDL via session tooling is not a Phase 2 action.
- **zod added to services/vcaop** (house convention §10 mandates Zod; vcaop
  previously had no validation dependency).
