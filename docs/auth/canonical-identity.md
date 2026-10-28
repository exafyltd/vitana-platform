# Canonical Identity Contract

> **Status**: PREPARATION PHASE
> **Author**: Claude (Preparation & Governance Engineer)
> **Date**: 2026-01-07
> **Purpose**: Define the single source of truth for identity in Vitana Platform

---

## Overview

This document defines the **Canonical Identity Object** that the Vitana Platform uses for all authentication, authorization, and multi-tenancy operations. When Lovable Auth/Supabase is merged, **Platform identity shape wins** — Lovable must adapt to this contract.

---

## 1. Canonical Identity Object

### 1.1 Required Fields (Non-Negotiable)

| Field | Type | Source | Enforcement Point | Notes |
|-------|------|--------|-------------------|-------|
| `user_id` | UUID | `auth.uid()` via Supabase JWT `sub` claim | Gateway + RLS | Primary identity key. Request REJECTED if missing. |
| `tenant_id` | UUID | JWT claim `tenant` or request context | Gateway + RLS | Multi-tenancy isolation. Request REJECTED if missing or invalid. |
| `active_role` | String | `user_active_roles` table or JWT claim | Gateway + RPC | Current operating role. Defaults to `community` if unset. |

### 1.2 Optional Fields

| Field | Type | Source | Usage |
|-------|------|--------|-------|
| `email` | String | JWT claim `email` | Display, notifications, audit |
| `display_name` | String | Application-provided | UI display only |
| `roles` | String[] | User profile + tenant membership | Available roles for user to switch |
| `active_role_source` | String | Runtime metadata | Debugging: `supabase_rpc` or `jwt_claim` |
| `ts` | ISO8601 | Gateway | Response timestamp |

### 1.3 TypeScript Definition

```typescript
/**
 * CANONICAL IDENTITY OBJECT
 * This is the ONLY identity shape accepted by Platform Gateway and downstream services.
 * Lovable frontend MUST conform to this contract.
 */
export interface CanonicalIdentity {
  // === REQUIRED (Request rejected if missing) ===
  user_id: string;      // UUID - from auth.uid() / JWT sub claim
  tenant_id: string;    // UUID - from JWT tenant claim or request context
  active_role: ActiveRole;  // Current operating role

  // === OPTIONAL ===
  email?: string;           // User email for display/notifications
  display_name?: string;    // Friendly display name
  roles?: ActiveRole[];     // All available roles for this user
  active_role_source?: 'supabase_rpc' | 'jwt_claim' | 'default';
  ts?: string;              // ISO8601 timestamp
}

/**
 * Valid roles in the Platform
 */
export type ActiveRole =
  | 'community'     // Default role for all users
  | 'patient'       // Health tracking context
  | 'professional'  // Healthcare provider
  | 'staff'         // Administrative staff
  | 'admin'         // Platform administrator
  | 'developer'     // Development access
  | 'infra';        // Infrastructure operations
```

---

## 2. Enforcement Points

### 2.1 Gateway Enforcement

**Location**: `/services/gateway/src/routes/me.ts`

All protected routes MUST:

1. Extract Bearer token from `Authorization` header
2. Create user-scoped Supabase client with token
3. Resolve identity via `me_context()` RPC
4. REJECT request with 401 if identity resolution fails

```typescript
// ENFORCEMENT PATTERN - All routes must follow this
const token = getBearerToken(req);
if (!token) {
  return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
}

const supabase = createUserSupabaseClient(token);
const { data: me, error } = await supabase.rpc('me_context');

if (!me?.user_id || !me?.tenant_id) {
  return res.status(401).json({ ok: false, error: 'IDENTITY_INCOMPLETE' });
}
```

### 2.2 Supabase RLS Enforcement

**Location**: All tables with user data

Every table containing user data MUST have RLS policies enforcing:

```sql
-- Standard RLS pattern for user-scoped data
POLICY {table}_user_isolation ON {table}
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND user_id = auth.uid()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND user_id = auth.uid()
);
```

### 2.3 Frontend Expectations

Lovable frontend MUST:

1. Store the Supabase JWT after authentication
2. Include `Authorization: Bearer {token}` in ALL API requests
3. Call `GET /api/v1/me` to resolve canonical identity
4. Store `tenant_id`, `user_id`, `active_role` in application state
5. Use `POST /api/v1/me/active-role` to switch roles (not modify JWT)

---

## 3. Identity Resolution Functions

### 3.1 `me_context()` - Primary Identity Resolver

**Returns**: Complete canonical identity for authenticated user

```sql
-- Located: supabase/migrations/20251229000000_vtid_01051_me_active_role_fix.sql
CREATE OR REPLACE FUNCTION public.me_context()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_tenant_id UUID;
    v_active_role TEXT;
    v_roles TEXT[];
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'UNAUTHENTICATED');
    END IF;

    -- Resolve email from auth.users
    SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;

    -- Resolve tenant_id
    v_tenant_id := public.current_tenant_id();

    -- Resolve active_role
    v_active_role := public.current_active_role();

    -- Resolve available roles
    v_roles := ARRAY['community', v_active_role]; -- Extend based on user profile

    RETURN jsonb_build_object(
        'user_id', v_user_id,
        'email', v_email,
        'tenant_id', v_tenant_id,
        'active_role', v_active_role,
        'roles', v_roles
    );
END;
$$;
```

### 3.2 `current_tenant_id()` - Tenant Resolution

```sql
-- Resolution order:
-- 1. request.tenant_id (set by dev_bootstrap_request_context)
-- 2. JWT claim: tenant_id
-- 3. JWT claim: tenant
-- 4. NULL (caller must handle)
```

### 3.3 `current_active_role()` - Role Resolution

```sql
-- Resolution order:
-- 1. request.active_role (set by me_set_active_role)
-- 2. JWT claim: active_role
-- 3. JWT claim: role
-- 4. 'community' (default)
```

---

## 4. Tenant Registry

### 4.1 Valid Tenants

| Tenant Slug | Tenant UUID | Status |
|-------------|-------------|--------|
| `vitana` | `00000000-0000-0000-0000-000000000001` | Active |
| `maxina` | `00000000-0000-0000-0000-000000000002` | Active |
| `alkalma` | `00000000-0000-0000-0000-000000000003` | Active |
| `earthlings` | `00000000-0000-0000-0000-000000000004` | Active |

### 4.2 Tenant Validation Rules

- `tenant_id` MUST be a valid UUID from the registry
- Invalid tenant = request REJECTED with 403
- NULL tenant = request REJECTED with 401 (IDENTITY_INCOMPLETE)
- Tenant switching is NOT allowed mid-session

---

## 5. Role Hierarchy & Permissions

### 5.1 Role Hierarchy

```
infra (highest)
  └── developer
      └── admin
          └── staff
              └── professional
                  └── patient
                      └── community (default)
```

### 5.2 Role Capabilities

| Role | Capabilities |
|------|--------------|
| `community` | Read own data, join groups, attend events |
| `patient` | + Health tracking, memory diary, personal AI |
| `professional` | + Access granted patient data, professional tools |
| `staff` | + Administrative functions, user support |
| `admin` | + Tenant configuration, user management |
| `developer` | + API access, dev tools, sandbox environments |
| `infra` | + Infrastructure operations, governance overrides |

### 5.3 Role Switching Rules

1. User can only switch to roles they are authorized for
2. Role switch via `POST /api/v1/me/active-role` persists to `user_active_roles` table
3. Role switch does NOT invalidate JWT
4. Some roles require tenant-specific membership

---

## 6. JWT Claims Contract

### 6.1 Required Claims (Supabase Standard)

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | UUID | User ID (maps to `user_id`) |
| `aud` | String | Must be `authenticated` |
| `exp` | Timestamp | Token expiration |
| `iat` | Timestamp | Token issued at |

### 6.2 Custom Claims (Platform-Specific)

| Claim | Type | Description |
|-------|------|-------------|
| `tenant` or `tenant_id` | UUID | User's tenant |
| `role` or `active_role` | String | User's active role |
| `email` | String | User's email |

### 6.3 Claim Extraction in Database

```sql
-- Extract user_id
auth.uid()  -- Returns UUID from JWT sub claim

-- Extract tenant_id
current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'
-- OR
current_setting('request.jwt.claims', true)::jsonb->>'tenant'

-- Extract role
current_setting('request.jwt.claims', true)::jsonb->>'active_role'
-- OR
current_setting('request.jwt.claims', true)::jsonb->>'role'
```

---

## 7. Error Codes

| Error Code | HTTP Status | Meaning | Resolution |
|------------|-------------|---------|------------|
| `UNAUTHENTICATED` | 401 | No or invalid JWT | Re-authenticate via Supabase |
| `IDENTITY_INCOMPLETE` | 401 | Missing user_id or tenant_id | Ensure JWT has required claims |
| `INVALID_ROLE` | 400 | Role not in valid list | Use valid role from list |
| `FORBIDDEN` | 403 | Role switch not allowed | User lacks permission for role |
| `INVALID_TENANT` | 403 | Tenant not in registry | Use valid tenant UUID |

---

## 8. Lovable Compatibility Requirements

### 8.1 What Lovable Frontend MUST Do

1. **Use Supabase Auth** - Same Supabase instance as Platform
2. **Store JWT** - After `signIn`, store the access token
3. **Include Bearer Token** - Every API request must include `Authorization: Bearer {token}`
4. **Resolve Identity** - Call `GET /api/v1/me` after auth to get canonical identity
5. **Handle Role Switching** - Use `POST /api/v1/me/active-role` (not custom JWT claims)

### 8.2 What Lovable Frontend MUST NOT Do

1. **Mint custom JWTs** - Only Supabase issues tokens
2. **Modify JWT claims client-side** - Immutable after issuance
3. **Bypass Gateway** - All requests go through Platform Gateway
4. **Create tenant-specific auth flows** - Platform owns tenant routing

### 8.3 Adapter Pattern (See `lovable-compatibility-adapter.md`)

Lovable may need a thin adapter layer to:
- Transform Lovable session to Bearer token format
- Map Lovable roles to Platform roles
- Handle tenant resolution for Lovable users

---

## 9. Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-07 | Initial canonical identity contract | Claude (Preparation Phase) |

---

## 10. Approval Status

- [ ] Technical Review
- [ ] Security Review
- [ ] VTID Allocated for Implementation
- [ ] Lovable Team Acknowledgment

---

*This document is part of the Auth & Supabase Merger Preparation Phase. No implementation until all approvals are complete.*
