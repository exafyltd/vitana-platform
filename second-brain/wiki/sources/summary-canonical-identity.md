# Summary: Canonical Identity Architecture

> Summary of the canonical identity contract and the Lovable compatibility adapter design -- the two core auth architecture documents for the Vitana Platform.

## Content

### Document: `raw/auth/canonical-identity.md`

**Status**: Preparation Phase (2026-01-07)

This document defines the **Canonical Identity Object**, the single identity shape accepted by the Vitana Platform. Key points:

- **Three required fields**: `user_id` (UUID from JWT `sub`), `tenant_id` (UUID from JWT `tenant` claim), `active_role` (string, defaults to `community`).
- **Identity resolution** is performed by the `me_context()` PostgreSQL RPC function, which chains through `auth.uid()`, `current_tenant_id()`, and `current_active_role()`.
- **Enforcement** happens at two layers: the Gateway (Bearer token extraction + `me_context()` call) and database RLS (policies requiring `tenant_id` and `user_id`).
- **Four tenants** are registered: `vitana`, `maxina`, `alkalma`, `earthlings`.
- **Seven roles** form a hierarchy from `community` (lowest) to `infra` (highest).
- **JWT claims contract** requires `sub`, `aud` (`authenticated`), `exp`, `iat` as standard claims, plus `tenant`/`tenant_id` and `role`/`active_role` as custom claims.
- **Error codes**: `UNAUTHENTICATED` (401), `IDENTITY_INCOMPLETE` (401), `INVALID_ROLE` (400), `FORBIDDEN` (403), `INVALID_TENANT` (403).

### Document: `raw/auth/lovable-compatibility-adapter.md`

**Status**: Design Spec Only (2026-01-07)

This document designs the compatibility layer for integrating Lovable Auth with the Platform. Key findings:

- **Lovable uses the same Supabase Auth** but a **different Supabase project** (`inmkhvwdcuyhnxkgfvsb.supabase.co`), so JWT consolidation is required.
- **High compatibility** overall: same auth methods (Magic Link, Google OAuth), both use UUID user IDs, 6 of 7 roles match directly, RLS patterns are similar.
- **Three architecture options**: (A) full Supabase project consolidation (recommended), (B) runtime JWT translation layer, (C) hybrid phased migration.
- **Session Bridge** endpoint (`POST /api/v1/auth/bridge`) would validate a Lovable token, find/create a Platform user, and issue a Platform JWT.
- **Tenant mapping** requires resolving Lovable's `earthlinks` to Platform's `earthlings`.
- **Role mapping**: all 6 Lovable roles map directly; `exafy_admin` maps to `infra`; `reseller` (tenant_role) maps to a capability, not a role.
- **User migration options**: big bang, lazy (on first login), or dual-write period.
- **Security**: Lovable tokens validated against Lovable Supabase public key; Platform tokens only issued for verified users; all bridged traffic goes through Gateway.

### Document: `raw/auth/auth-merge-guardrails.md`

**Status**: Active -- Enforcement Required (2026-01-07)

This document defines non-negotiable guardrails for the auth merger. It lists forbidden schema changes (DROP, RENAME, ALTER TYPE, TRUNCATE), forbidden RLS changes (DROP POLICY, DISABLE RLS, USING(true)), forbidden auth changes (modify JWT signing key, create bypass endpoints), and forbidden production operations (direct DB writes, migration without staging). It establishes four security invariants: tenant isolation, user isolation, authentication required, and identity completeness.

## Related Pages

- [[canonical-identity]]
- [[dual-jwt-auth]]
- [[supabase-platform]]
- [[supabase-lovable]]
- [[platform-supabase-vs-lovable-supabase]]

## Sources

- `raw/auth/canonical-identity.md`
- `raw/auth/lovable-compatibility-adapter.md`
- `raw/auth/auth-merge-guardrails.md`

## Last Updated

2026-04-12
