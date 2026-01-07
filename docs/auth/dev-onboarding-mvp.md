# Dev Onboarding MVP - Gateway Auth

> **VTID**: VTID-01157
> **Status**: Implemented
> **Date**: 2026-01-07

## Overview

This document describes the Gateway Supabase JWT authentication implementation for the Dev Onboarding MVP. It enables team members to authenticate using their Supabase credentials and access protected Dev system endpoints.

## Features

- **JWT Verification**: Gateway verifies Supabase HS256 JWTs without calling Supabase
- **Identity Extraction**: Extracts user_id, email, tenant_id, and exafy_admin from JWT claims
- **Auth Endpoint**: `GET /api/v1/auth/me` returns the authenticated user's identity
- **Middleware**: Reusable auth middleware for protecting routes

## Architecture

```
Client Request
    │
    │ Authorization: Bearer <supabase_access_token>
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Gateway                                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Extract Bearer token from Authorization header          │
│  2. Verify JWT signature using SUPABASE_JWT_SECRET (HS256)  │
│  3. Validate exp/nbf claims                                 │
│  4. Extract identity from claims:                           │
│     - user_id    ← sub                                      │
│     - email      ← email                                    │
│     - tenant_id  ← app_metadata.active_tenant_id           │
│     - exafy_admin← app_metadata.exafy_admin                │
│  5. Attach identity to request object                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Protected Route Handler
```

## Endpoints

### `GET /api/v1/auth/me`

Returns the authenticated user's identity.

**Request:**
```bash
curl -X GET "$GATEWAY_URL/api/v1/auth/me" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

**Response (200 OK):**
```json
{
  "ok": true,
  "identity": {
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "tenant_id": "00000000-0000-0000-0000-000000000001",
    "exafy_admin": true,
    "role": "authenticated",
    "aud": "authenticated",
    "exp": 1704672000,
    "iat": 1704668400
  }
}
```

**Response (401 Unauthorized):**
```json
{
  "ok": false,
  "error": "UNAUTHENTICATED",
  "message": "Missing or invalid Authorization header. Expected: Bearer <token>"
}
```

### `GET /api/v1/auth/me/debug`

Returns full JWT claims for debugging. Requires `exafy_admin = true`.

### `GET /api/v1/auth/health`

Health check for auth service. No authentication required.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_JWT_SECRET` | **YES** | HS256 secret for JWT verification |
| `SUPABASE_URL` | No | Supabase project URL (for health check display) |

## Setup Instructions

### 1. Get the JWT Secret from Supabase

1. Go to your Supabase project dashboard
2. Navigate to **Settings** > **API**
3. Copy the **JWT Secret** (under "JWT Settings")

### 2. Add Secret to Cloud Run

```bash
# Create secret in Secret Manager
echo -n "your-jwt-secret-here" | gcloud secrets create SUPABASE_JWT_SECRET \
  --project=lovable-vitana-vers1 \
  --data-file=-

# Grant Gateway service account access
gcloud secrets add-iam-policy-binding SUPABASE_JWT_SECRET \
  --project=lovable-vitana-vers1 \
  --member="serviceAccount:gateway-sa@lovable-vitana-vers1.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Deploy Gateway

```bash
./scripts/deploy/deploy-service.sh gateway services/gateway
```

## Team Onboarding Procedure

### For New Team Members (VTID-B)

1. **Create Supabase User**
   - Sign up via email/password or Google OAuth
   - Verify email if required

2. **Set Admin Metadata** (run by existing admin)
   ```sql
   -- In Supabase SQL Editor
   UPDATE auth.users
   SET raw_app_meta_data = raw_app_meta_data ||
     '{"exafy_admin": true, "active_tenant_id": "00000000-0000-0000-0000-000000000001"}'::jsonb
   WHERE email = 'newuser@example.com';
   ```

3. **Verify Access**
   ```bash
   # Get access token (from browser dev tools or Supabase client)
   TOKEN="eyJhbGciOiJIUzI1NiIs..."

   # Test auth endpoint
   curl -X GET "$GATEWAY_URL/api/v1/auth/me" \
     -H "Authorization: Bearer $TOKEN"
   ```

## Middleware Usage

### Require Authentication

```typescript
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

router.get('/protected', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { user_id, email, exafy_admin } = req.identity!;
  // ... handle request
});
```

### Require Admin Access

```typescript
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

router.get('/admin-only', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
  // Only exafy_admin users reach here
});
```

### Optional Authentication

```typescript
import { optionalAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

router.get('/public', optionalAuth, async (req: AuthenticatedRequest, res) => {
  if (req.identity) {
    // User is authenticated
  } else {
    // Anonymous access
  }
});
```

## Testing

### Manual Tests

```bash
# Get Gateway URL
GATEWAY_URL=$(gcloud run services describe gateway \
  --project=lovable-vitana-vers1 \
  --region=us-central1 \
  --format='value(status.url)')

# Test 1: No token → 401
curl -s "$GATEWAY_URL/api/v1/auth/me" | jq
# Expected: {"ok":false,"error":"UNAUTHENTICATED",...}

# Test 2: Invalid token → 401
curl -s "$GATEWAY_URL/api/v1/auth/me" \
  -H "Authorization: Bearer invalid-token" | jq
# Expected: {"ok":false,"error":"UNAUTHENTICATED",...}

# Test 3: Valid token → 200
curl -s "$GATEWAY_URL/api/v1/auth/me" \
  -H "Authorization: Bearer $VALID_TOKEN" | jq
# Expected: {"ok":true,"identity":{...}}

# Test 4: Health check → 200
curl -s "$GATEWAY_URL/api/v1/auth/health" | jq
# Expected: {"ok":true,"service":"auth",...}
```

## Security Notes

1. **JWT Verification Only**: This middleware verifies the JWT signature locally. It does not call Supabase to validate the token.

2. **Token Expiration**: The `exp` claim is validated. Expired tokens are rejected.

3. **HS256 Algorithm**: Only HS256 is accepted. RS256 or other algorithms will fail.

4. **Secret Protection**: The JWT secret is stored in Secret Manager, not in code or environment files.

## Files

| File | Purpose |
|------|---------|
| `services/gateway/src/middleware/auth-supabase-jwt.ts` | JWT verification middleware |
| `services/gateway/src/routes/auth.ts` | Auth endpoints (/me, /health) |
| `docs/auth/dev-onboarding-mvp.md` | This documentation |

## Related VTIDs

- **VTID-01047**: Dev Token Mint Endpoint (Cloud-Shell Friendly)
- **VTID-01046**: Me Context Routes (role context)
- **VTID-01074**: Tenant Context & Role Switching
