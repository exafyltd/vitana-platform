# Lovable Auth Compatibility Adapter Design

> **Status**: DESIGN SPEC ONLY (No Implementation Yet)
> **Author**: Claude (Preparation & Governance Engineer)
> **Date**: 2026-01-07
> **Purpose**: Design the compatibility layer for Lovable Auth integration

---

## Overview

This document specifies the design for a **compatibility adapter** that allows Lovable frontend to authenticate against the Vitana Platform Supabase instance while maintaining Platform identity contracts.

**This is a design spec only. No code will be written until:**
1. Lovable handover is complete
2. Gemini analysis blueprint exists
3. VTID approved for implementation
4. Rollback strategy defined

---

## 1. Problem Statement

### Current State (CONFIRMED via Analysis)

| Component | Lovable (v1) | Platform | Compatibility |
|-----------|--------------|----------|---------------|
| Auth Provider | Supabase Auth | Supabase Auth | ✓ Same |
| Supabase Project | `inmkhvwdcuyhnxkgfvsb.supabase.co` | (Platform instance) | **DIFFERENT** |
| JWT Issuer | Lovable Supabase | Platform Supabase | Requires consolidation |
| Auth Methods | Magic Link, Google OAuth | Same + more | ✓ Compatible |
| Identity Claims | `app_metadata.active_tenant_id`, `exafy_admin` | JWT claims: `tenant`, `role` | Mappable |
| Tenant Model | `tenants` table, 3 tenants | Multi-tenant, 4 tenants | ✓ Similar |
| Role Model | 6 roles (community → developer) | 7 roles (community → infra) | ✓ Subset |
| Schema | 271 tables | ~135 tables | Additive merge possible |

### Desired State

- Lovable frontend authenticates against **Platform Supabase**
- Lovable sessions produce **Platform-compatible JWTs**
- Lovable users mapped to **Platform identity model**
- Tenant isolation **preserved**
- RLS policies **enforced**

---

## 2. Lovable Analysis Results (From Read-Only Inspection)

> **Analysis Date**: 2026-01-07
> **Source**: Read-only GitHub access to `exafyltd/vitana-v1`

### 2.1 Lovable Auth Configuration (CONFIRMED)

| Question | Answer | Impact |
|----------|--------|--------|
| Does Lovable use Supabase Auth? | **YES** - Standard `@supabase/supabase-js` | Migration path easier ✓ |
| Supabase Project | `inmkhvwdcuyhnxkgfvsb.supabase.co` | **DIFFERENT** from Platform - requires consolidation |
| What auth methods? | Magic Link + Google OAuth | Both supported by Platform ✓ |
| Are there custom JWT claims? | `app_metadata.active_tenant_id`, `app_metadata.exafy_admin` | Must be mapped |
| User ID format? | UUID (Supabase standard) | Compatible with Platform ✓ |
| Session storage? | `localStorage` with `persistSession: true` | Standard approach ✓ |

### 2.2 Lovable Identity Configuration (CONFIRMED)

| Question | Answer | Impact |
|----------|--------|--------|
| Is there a tenant/org concept? | **YES** - `tenants` table with `tenant_id` | Maps to Platform tenant_id ✓ |
| Tenant slugs | `maxina`, `earthlinks`, `alkalma` | Note: `earthlinks` ≠ Platform's `earthlings` |
| What roles exist? | `vitana_role` enum: `community`, `patient`, `professional`, `staff`, `admin`, `developer` | Almost identical to Platform ✓ |
| Role hierarchy | community(1) < patient(2) < professional(3) < staff(4) < admin(5) | Matches Platform hierarchy ✓ |
| How are permissions checked? | Role hierarchy + `hasPermission()` function | Similar to Platform ✓ |
| Is there multi-tenancy? | **YES** - All user-data tables have `tenant_id` | RLS compatible ✓ |
| Super-admin concept | `app_metadata.exafy_admin === true` | Maps to Platform's `infra` role |

### 2.3 Lovable Schema Summary

| Metric | Value |
|--------|-------|
| Total Tables | **271** |
| Tables with `tenant_id` | Majority (multi-tenant) |
| Tables with `user_id` | All user-scoped data |
| Role Enums | `vitana_role`, `tenant_role` |
| Role Management | `user_roles` table, `role_preferences` table |

### 2.4 Key Lovable RPC Functions

| Function | Purpose | Platform Equivalent |
|----------|---------|---------------------|
| `get_role_preference(p_tenant_id)` | Get user's active role | `me_context()` |
| `set_role_preference(p_tenant_id, p_role)` | Set active role | `me_set_active_role(p_role)` |
| `switch_to_tenant_by_slug(p_tenant_slug)` | Switch tenant context | N/A (Platform uses JWT claim) |
| `current_active_role()` | Get current role | `current_active_role()` ✓ |

### 2.5 Role Mapping (Lovable → Platform)

| Lovable Role | Platform Role | Notes |
|--------------|---------------|-------|
| `community` | `community` | ✓ Direct mapping |
| `patient` | `patient` | ✓ Direct mapping |
| `professional` | `professional` | ✓ Direct mapping |
| `staff` | `staff` | ✓ Direct mapping |
| `admin` | `admin` | ✓ Direct mapping |
| `developer` | `developer` | ✓ Direct mapping |
| `reseller` (tenant_role only) | `community` + capability | Reseller is capability, not role |
| `exafy_admin` (app_metadata) | `infra` | Super-admin mapping |

### 2.6 Tenant Mapping (Lovable → Platform)

| Lovable Slug | Platform Slug | Platform UUID | Action Required |
|--------------|---------------|---------------|-----------------|
| `maxina` | `maxina` | `00000000-...0002` | ✓ Direct mapping |
| `alkalma` | `alkalma` | `00000000-...0003` | ✓ Direct mapping |
| `earthlinks` | `earthlings` | `00000000-...0004` | **RENAME** or alias |
| (none) | `vitana` | `00000000-...0001` | N/A (Platform-only) |

### 2.7 Compatibility Assessment

| Aspect | Compatibility | Risk Level |
|--------|---------------|------------|
| Auth Method | HIGH - Standard Supabase | LOW |
| User IDs | HIGH - Both UUID | LOW |
| Roles | HIGH - 6/7 match | LOW |
| Tenants | MEDIUM - 3/4 match | MEDIUM |
| Schema | MEDIUM - Similar patterns | MEDIUM |
| RLS | HIGH - Same patterns | LOW |

**Overall Assessment**: HIGH COMPATIBILITY - Consolidation is feasible

---

## 3. Adapter Architecture Options

### Option A: Supabase Project Consolidation (Recommended)

```
┌─────────────────────────────────────────────────────────────────┐
│ BEFORE                                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Lovable Frontend ──► Lovable Supabase ──► Lovable Schema      │
│                                                                 │
│  Platform Frontend ──► Platform Supabase ──► Platform Schema   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ AFTER (Option A)                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Lovable Frontend ──┐                                          │
│                     ├──► Platform Supabase ──► Unified Schema  │
│  Platform Frontend ─┘                                          │
│                                                                 │
│  [Lovable tables added with lovable_ prefix]                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**:
- Single source of truth for auth
- Unified RLS enforcement
- No token translation needed
- Simpler long-term maintenance

**Cons**:
- Requires Lovable schema migration
- User migration complexity
- Downtime during cutover

**Adapter Role**:
- One-time user migration script
- Schema migration (additive only)
- No runtime adapter needed

### Option B: JWT Translation Layer

```
┌─────────────────────────────────────────────────────────────────┐
│ AFTER (Option B)                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Lovable Frontend ──► Lovable Supabase ──► Lovable Auth       │
│         │                                                       │
│         ▼                                                       │
│  [JWT Translation Adapter]                                      │
│         │                                                       │
│         ▼                                                       │
│  Platform Gateway ──► Platform Supabase ──► Platform Schema    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**:
- Lovable can keep using existing auth
- No immediate user migration
- Lower risk during parallel dev

**Cons**:
- Runtime overhead
- Two auth systems to maintain
- Token validation complexity
- Security surface area increased

**Adapter Role**:
- Runtime JWT translation service
- Claim mapping (Lovable → Platform)
- Session bridging

### Option C: Hybrid (Phased Migration)

```
Phase 1: JWT Translation (parallel dev)
Phase 2: Gradual user migration
Phase 3: Full consolidation (Option A)
```

**Recommended for 1-month parallel development**.

---

## 4. Adapter Component Design

### 4.1 JWT Claim Mapper

**Purpose**: Map Lovable JWT claims to Platform canonical claims

```typescript
/**
 * DESIGN ONLY - Not implemented
 */
interface LovableJWTClaims {
  // TBD from Lovable handover
  sub: string;           // User ID
  email?: string;
  // ... other claims
}

interface PlatformJWTClaims {
  sub: string;           // User ID (UUID)
  tenant: string;        // Tenant UUID
  role: string;          // Active role
  email?: string;
}

function mapLovableClaimsToPlatform(
  lovableClaims: LovableJWTClaims
): PlatformJWTClaims {
  return {
    sub: lovableClaims.sub,
    tenant: resolveTenantForLovableUser(lovableClaims),
    role: mapLovableRoleToPlatformRole(lovableClaims),
    email: lovableClaims.email,
  };
}
```

### 4.2 Session Bridge

**Purpose**: Accept Lovable session, return Platform-compatible token

```typescript
/**
 * DESIGN ONLY - Not implemented
 */
interface SessionBridgeRequest {
  lovable_session_token: string;
}

interface SessionBridgeResponse {
  ok: boolean;
  platform_token?: string;
  expires_in?: number;
  error?: string;
}

// Endpoint: POST /api/v1/auth/bridge
async function bridgeSession(
  req: SessionBridgeRequest
): Promise<SessionBridgeResponse> {
  // 1. Validate Lovable token against Lovable Supabase
  const lovableUser = await validateLovableToken(req.lovable_session_token);
  if (!lovableUser) {
    return { ok: false, error: 'INVALID_LOVABLE_TOKEN' };
  }

  // 2. Find or create Platform user
  const platformUser = await findOrCreatePlatformUser(lovableUser);

  // 3. Generate Platform token
  const platformToken = await generatePlatformToken(platformUser);

  return {
    ok: true,
    platform_token: platformToken,
    expires_in: 3600,
  };
}
```

### 4.3 Tenant Resolver

**Purpose**: Determine Platform tenant_id for Lovable users

```typescript
/**
 * DESIGN ONLY - Not implemented
 *
 * Strategy options:
 * 1. All Lovable users → single tenant (e.g., 'vitana')
 * 2. Lovable org → Platform tenant mapping
 * 3. User-level tenant assignment
 */
function resolveTenantForLovableUser(claims: LovableJWTClaims): string {
  // Option 1: Default tenant for all Lovable users
  return '00000000-0000-0000-0000-000000000001'; // vitana

  // Option 2: Map Lovable org to Platform tenant
  // return LOVABLE_ORG_TO_TENANT[claims.org_id];

  // Option 3: Lookup user's assigned tenant
  // return lookupUserTenant(claims.sub);
}
```

### 4.4 Role Mapper

**Purpose**: Map Lovable roles to Platform roles

```typescript
/**
 * DESIGN ONLY - Not implemented
 *
 * Platform roles:
 * - community (default)
 * - patient
 * - professional
 * - staff
 * - admin
 * - developer
 * - infra
 */
const LOVABLE_TO_PLATFORM_ROLE: Record<string, string> = {
  // TBD from Lovable handover
  // 'lovable_user': 'community',
  // 'lovable_admin': 'admin',
};

function mapLovableRoleToPlatformRole(claims: LovableJWTClaims): string {
  // TBD: Extract role from Lovable claims
  const lovableRole = claims.role || 'user';
  return LOVABLE_TO_PLATFORM_ROLE[lovableRole] || 'community';
}
```

---

## 5. Authentication Flow Design

### 5.1 Flow A: Direct Platform Auth (Post-Migration)

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Lovable Frontend │     │ Platform Supabase│     │ Platform Gateway │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         │ 1. signInWithPassword  │                        │
         │───────────────────────►│                        │
         │                        │                        │
         │ 2. Return JWT          │                        │
         │◄───────────────────────│                        │
         │                        │                        │
         │ 3. GET /api/v1/me      │                        │
         │ Authorization: Bearer  │                        │
         │────────────────────────┼───────────────────────►│
         │                        │                        │
         │                        │ 4. rpc('me_context')   │
         │                        │◄───────────────────────│
         │                        │                        │
         │                        │ 5. Return identity     │
         │                        │───────────────────────►│
         │                        │                        │
         │ 6. Canonical identity  │                        │
         │◄────────────────────────────────────────────────│
         │                        │                        │
```

### 5.2 Flow B: Bridged Auth (During Parallel Dev)

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Lovable Frontend │     │ Lovable Supabase │     │ Adapter Service  │     │ Platform Gateway │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │                        │
         │ 1. signInWithPassword  │                        │                        │
         │───────────────────────►│                        │                        │
         │                        │                        │                        │
         │ 2. Lovable JWT         │                        │                        │
         │◄───────────────────────│                        │                        │
         │                        │                        │                        │
         │ 3. POST /auth/bridge   │                        │                        │
         │ (Lovable token)        │                        │                        │
         │────────────────────────┼───────────────────────►│                        │
         │                        │                        │                        │
         │                        │ 4. Validate Lovable    │                        │
         │                        │◄───────────────────────│                        │
         │                        │                        │                        │
         │                        │ 5. User verified       │                        │
         │                        │───────────────────────►│                        │
         │                        │                        │                        │
         │                        │                        │ 6. Generate Platform   │
         │                        │                        │    token for user      │
         │                        │                        │───────────────────────►│
         │                        │                        │                        │
         │                        │                        │ 7. Platform JWT        │
         │                        │                        │◄───────────────────────│
         │                        │                        │                        │
         │ 8. Platform JWT        │                        │                        │
         │◄────────────────────────────────────────────────│                        │
         │                        │                        │                        │
         │ 9. Normal Platform API calls with Platform JWT  │                        │
         │─────────────────────────────────────────────────┼───────────────────────►│
         │                        │                        │                        │
```

---

## 6. Security Considerations

### 6.1 Token Validation

- Lovable tokens MUST be validated against Lovable Supabase before bridging
- Platform tokens MUST only be issued for verified Lovable users
- Token expiration MUST be respected
- Refresh token flow TBD

### 6.2 Attack Vectors to Mitigate

| Vector | Mitigation |
|--------|------------|
| Token forgery | Validate against Lovable Supabase public key |
| Tenant escalation | Tenant assigned at migration, not per-request |
| Role escalation | Role mapping is static, not user-controlled |
| Session hijacking | HTTPS only, token expiration enforced |
| Replay attacks | Nonce or jti claim validation |

### 6.3 RLS Enforcement

- All Platform API calls MUST go through Gateway
- Gateway MUST validate Platform JWT
- Database RLS MUST enforce tenant/user isolation
- No direct Supabase access from Lovable frontend

---

## 7. User Migration Strategy

### 7.1 Pre-Migration (Preparation Phase)

- [ ] Lovable provides user export (ID, email, role)
- [ ] Platform prepares user import script
- [ ] Tenant assignment strategy decided
- [ ] Role mapping defined

### 7.2 Migration Options

**Option A: Big Bang Migration**

1. Export all Lovable users
2. Create Platform users with linked Lovable IDs
3. Switch Lovable frontend to Platform auth
4. Disable Lovable auth

**Option B: Lazy Migration**

1. On first Lovable login post-merge, check if Platform user exists
2. If not, create Platform user from Lovable identity
3. Link accounts via shared email/ID
4. Gradual migration as users log in

**Option C: Dual-Write Period**

1. New signups create users in both systems
2. Existing users migrated in batches
3. Eventually consolidate to Platform only

### 7.3 Data to Migrate

| Data | Migration Strategy |
|------|---------------------|
| User ID | Map or regenerate (TBD) |
| Email | Direct copy |
| Password hash | Supabase handles if same project |
| Roles | Map via role mapping table |
| Sessions | Invalidate, require re-login |

---

## 8. Gateway Integration Points

### 8.1 New Endpoint: Session Bridge

```
POST /api/v1/auth/bridge
Content-Type: application/json

Request:
{
  "lovable_token": "eyJhbGc..."
}

Response (success):
{
  "ok": true,
  "platform_token": "eyJhbGc...",
  "expires_in": 3600,
  "user_id": "uuid",
  "tenant_id": "uuid",
  "active_role": "community"
}

Response (error):
{
  "ok": false,
  "error": "INVALID_LOVABLE_TOKEN"
}
```

### 8.2 CORS Update

If Lovable frontend is on different domain:

```typescript
const ALLOWED_ORIGINS = [
  // Existing...
  "https://vitana-dev-gateway-*.run.app",
  // Add Lovable origins
  "https://lovable.app",
  "https://*.lovable.app",
  "https://vitana-v1.lovable.app",
];
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

- [ ] Lovable JWT claim extraction
- [ ] Claim mapping to Platform format
- [ ] Tenant resolution logic
- [ ] Role mapping logic

### 9.2 Integration Tests

- [ ] Lovable token validation against Lovable Supabase
- [ ] Platform token generation
- [ ] Full bridge flow end-to-end
- [ ] RLS enforcement with bridged users

### 9.3 Security Tests

- [ ] Invalid Lovable token rejection
- [ ] Expired token handling
- [ ] Tenant isolation verification
- [ ] Role escalation prevention

---

## 10. Rollback Strategy

### If Adapter Fails

1. Disable `/auth/bridge` endpoint
2. Lovable frontend reverts to Lovable-only auth
3. Users continue using Lovable auth until fixed
4. No data loss (adapter is stateless)

### If Migration Fails

1. Platform users created from Lovable are soft-deleted
2. Lovable auth remains active
3. Retry migration after fixes

---

## 11. Timeline Considerations

### Week 1-2: Design Finalization

- Receive Lovable auth handover
- Answer all TBD questions
- Finalize adapter architecture choice
- VTID allocation

### Week 3: Implementation

- Build adapter components
- Unit tests
- Integration tests

### Week 4: Staged Rollout

- Deploy to dev-sandbox
- Test with synthetic Lovable tokens
- Deploy to staging
- Controlled production rollout

---

## 12. Open Questions (For Lovable Handover)

1. What Supabase project does Lovable use?
2. What auth methods are enabled? (email, OAuth, magic link?)
3. What custom JWT claims exist?
4. What roles/permissions exist in Lovable?
5. Is there multi-tenancy in Lovable?
6. How many users need to be migrated?
7. What is the acceptable downtime for migration?
8. Are there any OAuth providers that need reconfiguration?

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-07 | Initial adapter design spec | Claude (Preparation Phase) |

---

*This document is a DESIGN SPEC only. No implementation until all approvals and handover complete.*
