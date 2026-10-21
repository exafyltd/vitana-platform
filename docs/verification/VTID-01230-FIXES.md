# VTID-01230: Critical Fixes for Production Safety

**Date:** 2026-02-10
**Issues Found:** Code review identified 5 security/safety concerns
**Status:** FIXES REQUIRED BEFORE MERGE

---

## Issue #1: Hardcoded Production Fallback (CRITICAL)

**Problem:**
```typescript
const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE || 'https://gateway-q74ibpv6ia-uc.a.run.app';
```

This silently hits production if `VITE_GATEWAY_BASE` is undefined in Lovable builds.

**Fix:**
```typescript
const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE;
if (!GATEWAY_BASE) {
  throw new Error('[VTID-01230] VITE_GATEWAY_BASE environment variable is required');
}
```

**File:** `src/hooks/useCreator.ts` (line 10)

---

## Issue #2: Stripe URL Validation (SECURITY)

**Problem:**
Frontend blindly redirects to any URL returned from backend.

**Fix - Backend (Required):**
```typescript
// In services/gateway/src/routes/creators.ts

// After creating accountLink
if (!accountLink.url.startsWith('https://connect.stripe.com/')) {
  throw new Error('Invalid Stripe URL returned');
}
```

**Fix - Frontend (Defense in Depth):**
```typescript
// In src/hooks/useCreator.ts - useCreatorOnboard

onSuccess: (onboardingUrl) => {
  if (!onboardingUrl.startsWith('https://connect.stripe.com/')) {
    throw new Error('Invalid onboarding URL');
  }
  window.location.href = onboardingUrl;
},
```

```typescript
// In src/hooks/useCreator.ts - useCreatorDashboard

onSuccess: (dashboardUrl) => {
  if (!dashboardUrl.startsWith('https://connect.stripe.com/')) {
    throw new Error('Invalid dashboard URL');
  }
  window.open(dashboardUrl, '_blank');
},
```

---

## Issue #3: Incomplete Paid Room Gating (FUNCTIONAL BUG)

**Problem:**
Current code only shows button but doesn't BLOCK creation.

**Fix:**
```tsx
// In src/components/liverooms/CreateLiveRoomDialog.tsx

<Button
  onClick={handleSubmit}
  disabled={
    isPending ||
    !title ||
    (accessLevel === 'group' && (
      !price ||
      !creatorStatus?.charges_enabled ||  // HARD BLOCK
      !creatorStatus?.payouts_enabled      // HARD BLOCK
    ))
  }
  className="w-full"
>
  {isPending ? 'Creating...' : 'Create Room'}
</Button>
```

**Add Clear Warning:**
```tsx
{accessLevel === 'group' && !creatorStatus?.charges_enabled && (
  <div className="p-3 bg-red-50 border border-red-200 rounded-md">
    <p className="text-sm font-medium text-red-800">
      ⛔ Cannot create paid rooms
    </p>
    <p className="text-sm text-red-700 mt-1">
      Complete payment setup first to enable paid room creation.
    </p>
  </div>
)}
```

---

## Issue #4: Backend Enforcement (REQUIRED)

**Problem:**
Frontend gating is not enough - backend must also enforce.

**Fix:**
```typescript
// In services/gateway/src/routes/live.ts - POST /rooms

if (metadata?.price && metadata.price > 0) {
  // Verify creator is onboarded
  const creatorStatusResult = await callRpc(token, 'get_user_stripe_status', {});

  if (!creatorStatusResult.ok || !creatorStatusResult.data?.[0]?.stripe_charges_enabled) {
    return res.status(403).json({
      ok: false,
      error: 'CREATOR_NOT_ONBOARDED',
      message: 'Complete payment setup before creating paid rooms',
    });
  }
}
```

---

## Issue #5: Live Room Creation "Access Denied" (SEPARATE BUG)

**Root Cause:**
`live_rooms` table missing `access_level` and `metadata` columns.

**Database Migration Required:**
```sql
-- File: supabase/migrations/20260210_vtid_01090_fix_live_room_creation.sql

-- Add missing columns
ALTER TABLE live_rooms
  ADD COLUMN IF NOT EXISTS access_level TEXT DEFAULT 'public' CHECK (access_level IN ('public', 'group')),
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Update RPC function
CREATE OR REPLACE FUNCTION live_room_create(p_payload JSONB)
RETURNS TABLE (
  id UUID,
  title TEXT,
  description TEXT,
  creator_user_id UUID,
  access_level TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  INSERT INTO live_rooms (
    title,
    description,
    creator_user_id,
    tenant_id,
    access_level,
    metadata
  ) VALUES (
    p_payload->>'title',
    p_payload->>'description',
    (p_payload->>'creator_user_id')::UUID,
    current_tenant_id(),
    COALESCE(p_payload->>'access_level', 'public'),
    COALESCE((p_payload->>'metadata')::JSONB, '{}'::jsonb)
  )
  RETURNING
    live_rooms.id,
    live_rooms.title,
    live_rooms.description,
    live_rooms.creator_user_id,
    live_rooms.access_level,
    live_rooms.metadata,
    live_rooms.created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Gateway Schema Update:**
```typescript
// In services/gateway/src/routes/live.ts

const CreateRoomSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  access_level: z.enum(['public', 'group']).optional().default('public'),
  metadata: z.object({
    price: z.number().min(0).optional(),
    description: z.string().optional(),
  }).optional(),
});
```

---

## Checklist Before Merge

### Backend Changes
- [ ] Add Stripe URL validation in `services/gateway/src/routes/creators.ts`
- [ ] Add creator onboarding check in `services/gateway/src/routes/live.ts` POST /rooms
- [ ] Run database migration for `access_level` and `metadata` columns
- [ ] Update CreateRoomSchema to accept `access_level` and `metadata`
- [ ] Test: `curl POST /api/v1/live/rooms` with paid room requires onboarded creator

### Frontend Changes
- [ ] Remove `GATEWAY_BASE` prod fallback in `src/hooks/useCreator.ts`
- [ ] Add Stripe URL validation in `useCreatorOnboard` and `useCreatorDashboard`
- [ ] Hard-block paid room creation if `!charges_enabled || !payouts_enabled`
- [ ] Add red error message for blocked paid room creation
- [ ] Set `VITE_GATEWAY_BASE` in Lovable environment variables
- [ ] Test: Cannot submit paid room without payments enabled

### Integration Tests
- [ ] Test onboarding flow with Stripe test account
- [ ] Verify dashboard link opens Stripe Express
- [ ] Verify paid room creation blocked without onboarding
- [ ] Verify paid room creation succeeds after onboarding
- [ ] Verify `access_level` and `price` stored correctly in database

---

## Deployment Order

1. **Database Migration First:**
   ```bash
   supabase db push
   ```

2. **Backend Deploy:**
   ```bash
   ENVIRONMENT=dev-sandbox ./scripts/deploy/deploy-service.sh gateway
   ```

3. **Frontend Environment:**
   - Set `VITE_GATEWAY_BASE=https://gateway-q74ibpv6ia-uc.a.run.app` in Lovable

4. **Frontend Deploy:**
   - Deploy via Lovable.dev with updated code

---

## Test Plan

### Test 1: Environment Variable Enforcement
```bash
# Should throw error if VITE_GATEWAY_BASE not set
unset VITE_GATEWAY_BASE
npm run dev  # Should fail loudly
```

### Test 2: Creator Onboarding
```bash
JWT="..." # Get from Lovable dev
curl -X POST https://gateway.../api/v1/creators/onboard \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json"

# Should return URL starting with https://connect.stripe.com/
```

### Test 3: Paid Room Gating (Frontend)
1. Open Lovable app
2. Navigate to Create Live Room
3. Select "Paid (Group)"
4. Without onboarding → Button should be DISABLED
5. After onboarding → Button should be ENABLED

### Test 4: Paid Room Gating (Backend)
```bash
# Without onboarded creator
curl -X POST https://gateway.../api/v1/live/rooms \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","access_level":"group","metadata":{"price":9.99}}'

# Should return 403 CREATOR_NOT_ONBOARDED
```

---

## Summary of Changes

| Component | File | Change Type | Priority |
|-----------|------|-------------|----------|
| Frontend | `src/hooks/useCreator.ts` | Security Fix | CRITICAL |
| Frontend | `src/hooks/useCreator.ts` | URL Validation | HIGH |
| Frontend | `src/components/liverooms/CreateLiveRoomDialog.tsx` | Hard Block | HIGH |
| Backend | `services/gateway/src/routes/creators.ts` | URL Validation | HIGH |
| Backend | `services/gateway/src/routes/live.ts` | Enforcement | CRITICAL |
| Backend | `services/gateway/src/routes/live.ts` | Schema Update | CRITICAL |
| Database | `supabase/migrations/...sql` | Schema Fix | CRITICAL |

**Total Files:** 4 backend, 2 frontend, 1 database migration

**Estimated Time:** 2-3 hours (including testing)

**Risk Level:** Medium (backwards compatible schema changes, defensive fixes)
