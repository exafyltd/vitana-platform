# Canonical Identity

> The single source of truth for user identity in the Vitana Platform -- how users are identified, resolved, and authorized across the two Supabase projects and the multi-tenant system.

## Content

### The Canonical Identity Object

The Canonical Identity Object is the **only** identity shape accepted by the Platform Gateway and downstream services. It is defined as follows:

**Required fields (request rejected if missing):**

| Field | Type | Source | Enforcement |
|-------|------|--------|-------------|
| `user_id` | UUID | `auth.uid()` via JWT `sub` claim | Gateway + RLS |
| `tenant_id` | UUID | JWT `tenant` claim or request context | Gateway + RLS |
| `active_role` | String | `user_active_roles` table or JWT claim | Gateway + RPC |

**Optional fields:**

| Field | Type | Usage |
|-------|------|-------|
| `email` | String | Display, notifications, audit |
| `display_name` | String | UI display |
| `roles` | String[] | Available roles the user may switch to |
| `active_role_source` | String | Debugging: `supabase_rpc`, `jwt_claim`, or `default` |
| `ts` | ISO8601 | Response timestamp |

### Identity Resolution

Identity is resolved via the `me_context()` PostgreSQL RPC function (located in migration `20251229000000_vtid_01051_me_active_role_fix.sql`). The resolution chain:

1. **User ID** -- `auth.uid()` extracts the UUID from the JWT `sub` claim. If null, returns `UNAUTHENTICATED`.
2. **Email** -- Looked up from `auth.users` table.
3. **Tenant ID** -- Resolved by `current_tenant_id()` with fallback order: `request.tenant_id` > JWT `tenant_id` > JWT `tenant` > NULL.
4. **Active Role** -- Resolved by `current_active_role()` with fallback order: `request.active_role` > JWT `active_role` > JWT `role` > `'community'` (default).
5. **Available Roles** -- Currently returns `['community', active_role]`; will be extended based on user profile.

### Tenant Registry

Four tenants are registered on the Platform:

| Slug | UUID | Status |
|------|------|--------|
| `vitana` | `00000000-0000-0000-0000-000000000001` | Active |
| `maxina` | `00000000-0000-0000-0000-000000000002` | Active |
| `alkalma` | `00000000-0000-0000-0000-000000000003` | Active |
| `earthlings` | `00000000-0000-0000-0000-000000000004` | Active |

Tenant validation rules: invalid tenant returns 403, null tenant returns 401 `IDENTITY_INCOMPLETE`, and tenant switching mid-session is not allowed.

### Role Hierarchy

Roles are hierarchical (highest to lowest):

```
infra > developer > admin > staff > professional > patient > community
```

| Role | Capabilities |
|------|-------------|
| `community` | Read own data, join groups, attend events |
| `patient` | + Health tracking, memory diary, personal AI |
| `professional` | + Access granted patient data, professional tools |
| `staff` | + Administrative functions, user support |
| `admin` | + Tenant configuration, user management |
| `developer` | + API access, dev tools, sandbox environments |
| `infra` | + Infrastructure operations, governance overrides |

Role switching is done via `POST /api/v1/me/active-role` and persists to the `user_active_roles` table. It does not invalidate the JWT.

### Cross-Project Identity Mapping

Lovable uses a similar but not identical identity model. Key mappings:

- **Roles**: Lovable's 6 roles (`community` through `developer`) map directly to Platform roles. Lovable's `exafy_admin` (in `app_metadata`) maps to Platform's `infra` role. Lovable has no `infra` role.
- **Tenants**: Lovable's `maxina` and `alkalma` map directly. Lovable's `earthlinks` must be renamed or aliased to Platform's `earthlings`. Platform's `vitana` tenant has no Lovable equivalent.
- **User IDs**: Both use Supabase-standard UUIDs, so they are format-compatible.

### Enforcement Points

Identity is enforced at two layers:

1. **Gateway** -- Extracts Bearer token, creates user-scoped Supabase client, calls `me_context()`, rejects if identity is incomplete.
2. **Database RLS** -- Every user-data table has policies requiring `tenant_id = current_tenant_id() AND user_id = auth.uid()`.

### Frontend Expectations

The Lovable frontend must: store the Supabase JWT after authentication, include `Authorization: Bearer {token}` in all API requests, call `GET /api/v1/me` to resolve canonical identity, and use `POST /api/v1/me/active-role` to switch roles. It must not mint custom JWTs, modify claims client-side, bypass the Gateway, or create tenant-specific auth flows.

## Related Pages

- [[dual-jwt-auth]]
- [[supabase-platform]]
- [[supabase-lovable]]
- [[platform-supabase-vs-lovable-supabase]]
- [[database-schema]]

## Sources

- `raw/auth/canonical-identity.md`
- `raw/auth/lovable-compatibility-adapter.md`
- `raw/auth/auth-merge-guardrails.md`

## Last Updated

2026-04-12
