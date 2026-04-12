# Supabase Platform

> The Platform Supabase project -- the authoritative authentication and database backend for the Vitana Platform, with secrets managed in GCP.

## Content

### Overview

The Platform Supabase project is the canonical data store and auth provider for the Vitana Platform. It is the target into which the Lovable Supabase project will eventually be consolidated. All Platform Gateway API calls resolve identity and enforce RLS against this project.

### Infrastructure

- **Secrets**: Stored in GCP (Google Cloud Platform). The service role key, anon key, and project URL are managed as GCP secrets and injected into Cloud Run services at deploy time.
- **Service Role Usage**: The `service_role` key is used for server-side operations that bypass RLS, such as writing governance tables, audit logs, and OASIS events. It is never exposed to the frontend.
- **Anon Key**: Used by the frontend for unauthenticated operations (e.g., initial page load, public endpoints).

### Schema

The Platform schema contains approximately **135+ tables** organized across 14 domains:

| Domain | Table Count (approx.) | Classification |
|--------|-----------------------|----------------|
| Platform Core (Identity & Tenancy) | 4+ | PLATFORM_CORE |
| Governance | 7 | GOVERNANCE |
| OASIS (Orchestration) | 2 | OASIS |
| Health | 6 | USER_DATA |
| Longevity Signals | 2 | DOMAIN_OWNED |
| Memory | 9+ | USER_DATA |
| Community & Matchmaking | 16+ | SAFE_EXTEND |
| Personalization | 11+ | USER_DATA |
| Signal Detection | 4 | DOMAIN_OWNED |
| Content & Catalog | 3 | LOOKUP |
| Predictive Signals (D44) | 3 | DOMAIN_OWNED |
| Contextual Opportunities (D48) | 1 | DOMAIN_OWNED |
| Risk Mitigations (D49) | 1 | DOMAIN_OWNED |

### Auth Configuration

- **Auth Methods**: Supabase Auth standard -- email/password, Magic Link, Google OAuth, and potentially more.
- **JWT Issuer**: Platform Supabase is the authoritative JWT issuer for Platform identity.
- **Custom JWT Claims**: `tenant` or `tenant_id` (UUID), `role` or `active_role` (string), `email` (string).
- **Session Handling**: Standard Supabase session management with `persistSession: true`.

### Key RPC Functions

| Function | Purpose |
|----------|---------|
| `me_context()` | Returns canonical identity for authenticated user |
| `me_set_active_role(p_role)` | Persists role switch to `user_active_roles` |
| `current_tenant_id()` | Resolves tenant from JWT or request context |
| `current_active_role()` | Resolves role from JWT or request context |
| `dev_bootstrap_request_context(...)` | Dev-only context setup (service role) |
| `allocate_global_vtid(...)` | Allocates next VTID from sequence |

### RLS Policy Patterns

Four standard patterns are used:

1. **User-scoped** -- `tenant_id = current_tenant_id() AND user_id = auth.uid()` (personal data)
2. **Tenant-scoped** -- `tenant_id = current_tenant_id()` (community, groups, locations)
3. **Service-role write, authenticated read** -- governance, OASIS, audit tables
4. **Immutable audit** -- INSERT and SELECT only, no UPDATE or DELETE

### Tenant Registry

| Slug | UUID |
|------|------|
| `vitana` | `00000000-0000-0000-0000-000000000001` |
| `maxina` | `00000000-0000-0000-0000-000000000002` |
| `alkalma` | `00000000-0000-0000-0000-000000000003` |
| `earthlings` | `00000000-0000-0000-0000-000000000004` |

### Migration Infrastructure

Migration files live in `supabase/migrations/` (86 files, primary) and `database/migrations/` (15 files, legacy). RLS policy files are in `database/policies/`. Historical Prisma migrations exist in `prisma/migrations/` (3 files).

## Related Pages

- [[supabase-lovable]]
- [[canonical-identity]]
- [[dual-jwt-auth]]
- [[database-schema]]
- [[platform-supabase-vs-lovable-supabase]]
- [[additive-migration-pattern]]

## Sources

- `raw/auth/canonical-identity.md`
- `raw/auth/lovable-compatibility-adapter.md`
- `raw/database/DATABASE_SCHEMA.md`
- `raw/database/platform-schema-inventory.md`

## Last Updated

2026-04-12
