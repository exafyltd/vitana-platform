# Supabase Lovable

> The Lovable/community Supabase project (inmkhvwdcuyhnxkgfvsb) -- the auth and database backend powering the Lovable-built vitana-v1 frontend.

## Content

### Overview

The Lovable Supabase project is the separate Supabase instance used by the Lovable-built frontend application (vitana-v1). It has its own auth system, schema, and JWT signing key. The project is identified by the Supabase project ID `inmkhvwdcuyhnxkgfvsb` (i.e., `inmkhvwdcuyhnxkgfvsb.supabase.co`).

### Auth Configuration

| Property | Value |
|----------|-------|
| **Project ID** | `inmkhvwdcuyhnxkgfvsb` |
| **Auth Provider** | Supabase Auth (standard `@supabase/supabase-js`) |
| **Auth Methods** | Magic Link + Google OAuth |
| **Session Storage** | `localStorage` with `persistSession: true` |
| **Anon Key** | Used by the Lovable frontend for client-side Supabase access |

### Identity Model

Lovable uses a comparable but distinct identity model from the Platform:

- **User IDs**: UUID (Supabase standard), format-compatible with Platform.
- **Custom JWT Claims**: `app_metadata.active_tenant_id` (tenant assignment), `app_metadata.exafy_admin` (super-admin flag).
- **Role Enum**: `vitana_role` with values: `community`, `patient`, `professional`, `staff`, `admin`, `developer` (6 roles, a subset of the Platform's 7).
- **Tenant Role Enum**: `tenant_role` (includes `reseller` which maps to a capability, not a Platform role).
- **Super-Admin**: `app_metadata.exafy_admin === true` maps to the Platform's `infra` role.

### Tenant Configuration

Lovable has three tenants:

| Lovable Slug | Platform Equivalent | Notes |
|--------------|---------------------|-------|
| `maxina` | `maxina` | Direct mapping |
| `alkalma` | `alkalma` | Direct mapping |
| `earthlinks` | `earthlings` | Spelling difference -- requires rename or alias |

The Platform's `vitana` tenant has no Lovable counterpart.

### Schema

| Metric | Value |
|--------|-------|
| **Total Tables** | 271 |
| **Tables with `tenant_id`** | Majority (multi-tenant) |
| **Tables with `user_id`** | All user-scoped data |
| **Role Enums** | `vitana_role`, `tenant_role` |
| **Role Management** | `user_roles` table, `role_preferences` table |

### Key RPC Functions

| Lovable Function | Purpose | Platform Equivalent |
|-----------------|---------|---------------------|
| `get_role_preference(p_tenant_id)` | Get user's active role | `me_context()` |
| `set_role_preference(p_tenant_id, p_role)` | Set active role | `me_set_active_role(p_role)` |
| `switch_to_tenant_by_slug(p_tenant_slug)` | Switch tenant context | N/A (Platform uses JWT claim) |
| `current_active_role()` | Get current role | `current_active_role()` (same name) |

### Consolidation Plan

The long-term plan is to consolidate the Lovable Supabase project into the Platform Supabase project (Option A: Supabase Project Consolidation). During the transition:

1. **Phase 1**: A JWT Translation Layer (Session Bridge at `POST /api/v1/auth/bridge`) validates Lovable tokens against this project and issues Platform tokens.
2. **Phase 2**: Gradual user migration from Lovable to Platform auth.
3. **Phase 3**: Full consolidation -- Lovable frontend points to Platform Supabase, Lovable Supabase is decommissioned.

Lovable tables migrated into Platform will use the `lovable_` prefix.

### CORS Considerations

If the Lovable frontend runs on a different domain, CORS must be updated to allow:

- `https://lovable.app`
- `https://*.lovable.app`
- `https://vitana-v1.lovable.app`

## Related Pages

- [[supabase-platform]]
- [[canonical-identity]]
- [[dual-jwt-auth]]
- [[platform-supabase-vs-lovable-supabase]]
- [[additive-migration-pattern]]

## Sources

- `raw/auth/lovable-compatibility-adapter.md`
- `raw/auth/canonical-identity.md`
- `raw/auth/auth-merge-guardrails.md`

## Last Updated

2026-04-12
