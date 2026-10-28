# Platform Supabase vs. Lovable Supabase

> Side-by-side comparison of the two Supabase projects in the Vitana ecosystem: purpose, auth flows, schema, and key differences.

## Content

### Overview

The Vitana ecosystem currently runs two separate Supabase projects. The **Platform Supabase** is the authoritative backend for the Vitana Platform (gateway, services, governance). The **Lovable Supabase** (`inmkhvwdcuyhnxkgfvsb`) powers the Lovable-built vitana-v1 frontend. The long-term plan is to consolidate into a single project (Platform Supabase wins).

### Comparison Matrix

| Dimension | Platform Supabase | Lovable Supabase |
|-----------|-------------------|------------------|
| **Project ID** | (managed via GCP secrets) | `inmkhvwdcuyhnxkgfvsb` |
| **Purpose** | Authoritative backend, identity, governance | Community frontend (vitana-v1) |
| **Auth Provider** | Supabase Auth | Supabase Auth |
| **Auth Methods** | Magic Link, Google OAuth, and more | Magic Link, Google OAuth |
| **JWT Issuer** | Platform Supabase | Lovable Supabase |
| **JWT Custom Claims** | `tenant`/`tenant_id`, `role`/`active_role`, `email` | `app_metadata.active_tenant_id`, `app_metadata.exafy_admin` |
| **Number of Tables** | ~135+ | ~271 |
| **Number of Tenants** | 4 (`vitana`, `maxina`, `alkalma`, `earthlings`) | 3 (`maxina`, `alkalma`, `earthlinks`) |
| **Number of Roles** | 7 (`community` through `infra`) | 6 (`community` through `developer`) + `exafy_admin` flag |
| **Role Enum Name** | ActiveRole (TypeScript) | `vitana_role` (Postgres enum) |
| **Super-Admin** | `infra` role | `app_metadata.exafy_admin === true` |
| **Tenant Model** | `tenants` table, UUID-based, 4 tenants | `tenants` table, 3 tenants |
| **RLS Patterns** | `tenant_id = current_tenant_id() AND user_id = auth.uid()` | Same pattern |
| **Identity Resolution** | `me_context()` RPC | `get_role_preference()` + `current_active_role()` |
| **Secrets Management** | GCP Secret Manager | Lovable environment / Supabase dashboard |
| **Migration Files** | 86 (primary) + 15 (legacy) | Part of vitana-v1 codebase |

### Auth Flow Differences

**Platform auth flow:**
1. Frontend calls Supabase Auth (signIn).
2. Supabase returns a Platform JWT.
3. Frontend includes `Authorization: Bearer {token}` on all Gateway requests.
4. Gateway calls `me_context()` to resolve canonical identity.
5. RLS enforces tenant + user isolation.

**Lovable auth flow:**
1. Frontend calls Supabase Auth (signIn) against `inmkhvwdcuyhnxkgfvsb`.
2. Supabase returns a Lovable JWT.
3. Frontend reads `app_metadata.active_tenant_id` and `app_metadata.exafy_admin` from session.
4. Frontend calls RPC functions (`get_role_preference`, `switch_to_tenant_by_slug`) directly against Lovable Supabase.
5. RLS enforces isolation (same pattern).

### Key Differences

1. **JWT Signing Keys**: Each project has its own signing key, so tokens are not cross-compatible without a bridge.
2. **Claim Structure**: Platform uses top-level custom claims (`tenant`, `role`); Lovable uses nested `app_metadata` claims.
3. **Tenant Naming**: Lovable uses `earthlinks`; Platform uses `earthlings`. Requires rename or alias.
4. **Role Set**: Platform has the additional `infra` role. Lovable's `exafy_admin` metadata flag serves the equivalent purpose.
5. **Gateway Routing**: Platform routes all API calls through a Gateway service. Lovable accesses Supabase directly from the frontend.
6. **Schema Size**: Lovable has roughly double the tables (~271 vs. ~135), reflecting its broader community feature set.

### Compatibility Assessment

| Aspect | Compatibility | Risk |
|--------|--------------|------|
| Auth method | HIGH | LOW |
| User IDs (UUID) | HIGH | LOW |
| Roles | HIGH (6/7 match) | LOW |
| Tenants | MEDIUM (3/4 match, name mismatch) | MEDIUM |
| Schema patterns | MEDIUM (similar RLS, different table counts) | MEDIUM |
| RLS enforcement | HIGH (same patterns) | LOW |

**Overall**: HIGH COMPATIBILITY -- consolidation is feasible.

### Consolidation Plan

The recommended path (Option A) consolidates both projects into Platform Supabase:

1. Lovable tables are migrated with a `lovable_` prefix.
2. Lovable users are migrated to Platform auth (big bang, lazy, or dual-write).
3. Lovable frontend is reconfigured to authenticate against Platform Supabase.
4. Lovable Supabase is decommissioned.

During the transition, a JWT Translation Layer (Session Bridge) allows the Lovable frontend to continue using its own auth while Platform tokens are issued behind the scenes.

## Related Pages

- [[supabase-platform]]
- [[supabase-lovable]]
- [[dual-jwt-auth]]
- [[canonical-identity]]
- [[additive-migration-pattern]]
- [[database-schema]]

## Sources

- `raw/auth/canonical-identity.md`
- `raw/auth/lovable-compatibility-adapter.md`
- `raw/auth/auth-merge-guardrails.md`
- `raw/database/DATABASE_SCHEMA.md`
- `raw/database/platform-schema-inventory.md`

## Last Updated

2026-04-12
