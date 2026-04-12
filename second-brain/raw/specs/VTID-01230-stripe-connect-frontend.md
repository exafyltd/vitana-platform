# VTID-01230: Stripe Connect Frontend UI

**Status:** COMPLETE
**Date:** 2026-02-09
**Owner:** Frontend
**Depends On:** VTID-01231 (Backend APIs)

---

## Overview

Frontend integration for Stripe Connect Express creator payments. Enables creators to onboard to Stripe, view payment status, and create paid Live Rooms.

### Goals
1. Creator onboarding UI
2. Payment status display
3. Integration with paid room creation
4. Onboarded success experience

---

## Components Created

### 1. useCreator Hooks (`src/hooks/useCreator.ts`)

Three React Query hooks for Stripe Connect functionality:

```typescript
useCreatorStatus()      // Get creator's payment status
useCreatorOnboard()     // Start Stripe onboarding flow
useCreatorDashboard()   // Open Stripe Express dashboard
```

**API Integration:**
- `GET /api/v1/creators/status` - Fetch payment status
- `POST /api/v1/creators/onboard` - Start onboarding
- `GET /api/v1/creators/dashboard` - Get dashboard link

### 2. EnablePaymentsButton (`src/components/creator/EnablePaymentsButton.tsx`)

Intelligent button component that shows different states:
- **Not Onboarded**: "Enable Payments" button
- **Partially Onboarded**: "Complete Setup" button (yellow)
- **Fully Onboarded**: Green checkmark "Payments Enabled"

### 3. CreatorPaymentsSection (`src/components/creator/CreatorPaymentsSection.tsx`)

Full payment management section for Settings > Billing page.

**Features:**
- Payment status badge
- Revenue split display (90% creator, 10% platform)
- Action buttons (Enable/Dashboard)
- Revenue examples table
- Context-aware messaging based on onboarding state

### 4. CreatorOnboarded Page (`src/pages/CreatorOnboarded.tsx`)

Success page shown after Stripe onboarding completion.

**Features:**
- Success animation
- Benefit highlights
- Status refresh (checks for webhook updates)
- CTA buttons (Create Room, View Settings)
- Graceful handling of incomplete onboarding

---

## Integration Points

### CreateLiveRoomDialog
**File:** `src/components/liverooms/CreateLiveRoomDialog.tsx`

**Integration:**
- Shows `EnablePaymentsButton` when user selects "Paid" access level
- Blocks paid room creation if `charges_enabled` is false
- Displays warning message about payment setup requirement

### Billing Settings
**File:** `src/pages/settings/Billing.tsx`

**Integration:**
- Added `CreatorPaymentsSection` between subscription and plans
- Full payment management in Settings UI

### App Routing
**File:** `src/App.tsx`

**Added Routes:**
- `/creator/onboarded` - Success page after Stripe onboarding

---

## User Flow

### First-Time Creator Flow
```
1. User creates Live Room
   ↓
2. Selects "Paid (Group)" access
   ↓
3. Warning shows: "Payment setup required"
   ↓
4. Clicks "Enable Payments"
   ↓
5. Redirects to Stripe Connect onboarding
   ↓
6. Completes Stripe form
   ↓
7. Returns to /creator/onboarded
   ↓
8. Sees success page
   ↓
9. Can now create paid rooms
```

### Returning Creator Flow
```
1. User goes to Settings > Billing
   ↓
2. Sees Creator Payments section
   ↓
3. Status shows "Payments Enabled"
   ↓
4. Can click "View Dashboard" to manage earnings
   ↓
5. Opens Stripe Express dashboard in new tab
```

---

## Technical Details

### Type Definitions
```typescript
interface CreatorStatus {
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarded_at: string | null;
}
```

### Gateway Base URL
```typescript
const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE ||
  'https://gateway-q74ibpv6ia-uc.a.run.app';
```

### Authentication
All API calls use Supabase JWT token:
```typescript
const token = await supabase.auth.getSession();
headers: { 'Authorization': `Bearer ${token}` }
```

---

## Revenue Display

**Creator Share:** 90% of room price
**Platform Fee:** 10% of room price

### Examples Shown
| Room Price | Creator Receives | Platform Fee |
|------------|------------------|--------------|
| $9.99      | $8.99            | $1.00        |
| $19.99     | $17.99           | $2.00        |
| $49.99     | $44.99           | $5.00        |

---

## Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `src/hooks/useCreator.ts` | CREATED | Creator API hooks |
| `src/components/creator/EnablePaymentsButton.tsx` | CREATED | Payment enable button |
| `src/components/creator/CreatorPaymentsSection.tsx` | CREATED | Billing settings section |
| `src/pages/CreatorOnboarded.tsx` | CREATED | Onboarding success page |
| `src/components/liverooms/CreateLiveRoomDialog.tsx` | MODIFIED | Added payment check |
| `src/pages/settings/Billing.tsx` | MODIFIED | Added payments section |
| `src/App.tsx` | MODIFIED | Added `/creator/onboarded` route |

---

## Testing Checklist

- [x] useCreatorStatus hook fetches from backend
- [x] useCreatorOnboard redirects to Stripe
- [x] useCreatorDashboard opens in new window
- [x] EnablePaymentsButton shows correct state
- [x] CreateLiveRoomDialog blocks paid rooms when not onboarded
- [x] CreatorPaymentsSection displays in Billing page
- [x] CreatorOnboarded page shows success state
- [x] Revenue examples calculate correctly
- [ ] End-to-end onboarding flow tested with real Stripe account
- [ ] Webhook updates reflected in UI after onboarding
- [ ] Dashboard link opens Stripe Express dashboard

---

## Deployment

### Prerequisites
1. Backend APIs deployed (VTID-01231)
2. Stripe Connect webhook configured
3. Frontend environment variable set: `VITE_GATEWAY_BASE`

### Deploy Steps
```bash
# Frontend is deployed via Lovable.dev
# No manual deployment required

# Verify deployment:
# 1. Visit https://vitana-lovable-vers1.lovable.app
# 2. Navigate to Community > Create Live Room
# 3. Select "Paid" access
# 4. Verify "Enable Payments" button appears
```

---

## Monitoring

### User Analytics Events to Track
- `creator.onboard.started` - User clicked Enable Payments
- `creator.onboard.completed` - User returned from Stripe
- `creator.dashboard.opened` - User opened Stripe dashboard
- `creator.room.created.paid` - User created paid room

### Success Metrics
- % of creators who complete onboarding
- Time to first paid room creation
- Creator retention (active creators month-over-month)

---

## Future Enhancements

### Phase 2 (Optional)
- Earnings dashboard within Vitana app
- Transaction history
- Payout schedule display
- In-app earnings notifications

---

## Related Documents
- [VTID-01231 Backend Spec](./VTID-01231-stripe-connect-backend.md)
- [VTID-01228 Daily.co Live Rooms](./VTID-01228-daily-live-rooms-backend.md)
