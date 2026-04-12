# Daily.co Video Integration Specification
**VTID: 01228** | **Status: APPROVED** | **Date: 2026-02-09**

---

## Table of Contents
1. [Overview](#overview)
2. [Governance Alignment](#governance-alignment)
3. [Current Architecture](#current-architecture)
4. [Future Architecture Strategy](#future-architecture-strategy)
5. [Daily.co Prerequisites](#dailyco-prerequisites)
6. [Daily.co API Integration](#dailyco-api-integration)
7. [Payment & Access Control](#payment--access-control)
8. [Backend Implementation](#backend-implementation)
9. [Frontend Implementation](#frontend-implementation)
10. [Database Schema](#database-schema)
11. [API Endpoints](#api-endpoints)
12. [Room Lifecycle & Grant Revocation](#room-lifecycle--grant-revocation)
13. [Multi-Tenancy & RLS Rigor](#multi-tenancy--rls-rigor)
14. [Security & Abuse Controls](#security--abuse-controls)
15. [Implementation Phases](#implementation-phases)
16. [Testing & Verification](#testing--verification)

---

## Overview

### Goal
Enable users to host and join live video sessions through Daily.co integration in Vitana's LIVE Rooms feature. Users can create both free and paid live sessions, with proper access control and payment verification.

### Key Requirements
- ✅ Each user can create live rooms with Daily.co video sessions
- ✅ Free rooms: Users confirm join (no payment required)
- ✅ Paid rooms: Users must confirm payment before joining
- ✅ Payment verification enforced at backend
- ✅ Daily.co rooms generated via REST API (no subscription required)
- ✅ Architecture prepared for future project merger

### Non-Goals (Out of Scope)
- ❌ Daily.co iframe embedding (use redirect to room URL instead for MVP)
- ❌ Per-user Daily.co accounts (use platform API key)
- ❌ Recording management (future enhancement)
- ❌ Breakout rooms (future enhancement)

---

## Governance Alignment

### Feature Scope Clarification

**This is LIVE Rooms / Go Live — NOT Start Stream**

- ✅ **LIVE Rooms** = Community-facing group sessions (public or paid)
- ✅ **Go Live** = User-hosted sessions with audience participation
- ❌ **Start Stream** = Private AI + screen share (sidebar-only, stays separate)

**Critical Rule:** This spec must **NEVER** touch or reference Start Stream concepts, UI, or infrastructure. Start Stream remains:
- Private (1:1 with AI)
- Sidebar utility zone only
- No community visibility
- Separate from this feature entirely

**Governance Note:** If any implementation step accidentally merges LIVE Rooms with Start Stream, it must be blocked immediately as a violation of core product architecture (per CLAUDE.md Part 1, Rules 21-23).

---

## Current Architecture

### Two-Repository Setup

**Repository Structure:**
```
vitana-platform/                    # Backend (this repository)
├── services/
│   ├── gateway/                    # Main API service (Cloud Run)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   └── live.ts        # Existing LIVE Rooms API
│   │   │   ├── services/
│   │   │   │   └── [daily-client.ts]  # NEW
│   │   │   └── frontend/
│   │   │       └── command-hub/   # Command Hub UI (optional)
│   └── ...
├── supabase/
│   └── migrations/                 # Database schema
└── temp_vitana_v1/                 # Lovable frontend (embedded)
    ├── src/
    │   ├── components/
    │   │   └── liverooms/
    │   │       ├── LiveRoomCard.tsx
    │   │       └── LiveRoom.tsx
    │   ├── pages/
    │   │   └── community/
    │   │       └── LiveRooms.tsx
    │   └── hooks/
    │       └── useLiveStreams.ts
    └── supabase/
        └── migrations/             # Frontend-specific migrations
```

**Current Frontend Database:**
- Table: `community_live_streams` (in temp_vitana_v1/supabase)
- Fields: `id`, `title`, `access_level`, `status`, `created_by`, `metadata`, etc.

**Current Backend Database:**
- Table: `live_rooms` (in vitana-platform/supabase)
- API: `/api/v1/live/rooms` endpoints in Gateway

### Critical Finding
**TWO SEPARATE LIVE ROOMS IMPLEMENTATIONS EXIST:**
1. **Frontend (`community_live_streams`)** - Used by Lovable UI
2. **Backend (`live_rooms`)** - Used by Gateway API (VTID-01090)

**Action Required:** Determine which to use as canonical source of truth for merger.

---

## Future Architecture Strategy

### Preparation for Project Merger

**Recommended Approach:**

#### Option A: Migrate Frontend to Use Backend Schema (Recommended)
**Why:** Backend schema (`live_rooms`) has superior architecture:
- ✅ OASIS event integration
- ✅ Relationship graph strengthening
- ✅ Attendance tracking with social signals
- ✅ Governed API with VTID tracking
- ✅ Better suited for multi-tenant scaling

**Migration Steps:**
1. Add `access_level` field to backend `live_rooms` table
2. Migrate existing `community_live_streams` data to `live_rooms`
3. Update frontend to use Gateway API (`/api/v1/live/rooms`)
4. Deprecate direct Supabase queries from frontend
5. Use backend as single source of truth

#### Option B: Keep Dual Schema (Temporary)
**Why:** Faster MVP, defer migration
- Frontend continues using `community_live_streams`
- Backend manages Google Meet links and payments
- Sync data between schemas via API calls
- **Caveat:** Technical debt, eventual migration required

**Recommendation:** **Use Option A** for long-term maintainability.

### Migration Timeline
- **Phase 1 (MVP):** Implement Google Meet + Payment on backend `live_rooms`
- **Phase 2 (Migration):** Move frontend to use backend API exclusively
- **Phase 3 (Cleanup):** Remove `community_live_streams` table
- **Phase 4 (Merger):** Combine repositories into single monorepo

### Data Model Alignment (Critical for Merger)

**Explicit Deprecation Strategy for `community_live_streams`:**

| Phase | Table | Status | Frontend Reads | Frontend Writes | Backend API |
|-------|-------|--------|----------------|-----------------|-------------|
| **Phase 1** | `community_live_streams` | Active | ✅ Direct Supabase | ✅ Direct Supabase | ❌ Not used |
| | `live_rooms` | New | ❌ Not used | ❌ Not used | ✅ Gateway only |
| **Phase 2** | `community_live_streams` | **Deprecated** | ❌ Blocked by RLS | ❌ Blocked by RLS | ❌ Not used |
| | `live_rooms` | **Canonical** | ✅ Via Gateway API | ✅ Via Gateway API | ✅ Gateway only |
| **Phase 3** | `community_live_streams` | **Deleted** | ❌ Table dropped | ❌ Table dropped | ❌ Not used |
| | `live_rooms` | Canonical | ✅ Via Gateway API | ✅ Via Gateway API | ✅ Gateway only |

**Migration Mapping:**

```sql
-- One-time data migration script (Phase 2)
INSERT INTO live_rooms (
  id,
  tenant_id,
  title,
  topic_keys,
  host_user_id,
  starts_at,
  ends_at,
  status,
  metadata,
  created_at,
  updated_at
)
SELECT
  id,
  -- Derive tenant_id from created_by user
  (SELECT tenant_id FROM app_users WHERE id = cls.created_by),
  title,
  COALESCE(tags, ARRAY[]::TEXT[]),  -- Map tags → topic_keys
  created_by,  -- Map created_by → host_user_id
  created_at,  -- Use created_at as starts_at for legacy data
  ended_at,
  status,
  jsonb_build_object(
    'access_level', access_level,
    'stream_type', stream_type,
    'enable_replay', enable_replay,
    'cover_image_url', cover_image_url,
    'legacy_id', id  -- Preserve old ID for reference
  ),
  created_at,
  COALESCE(updated_at, created_at)
FROM community_live_streams cls
WHERE NOT EXISTS (
  -- Prevent duplicates if migration is run multiple times
  SELECT 1 FROM live_rooms lr WHERE lr.id = cls.id
);
```

**Cutover Criteria (When Dual-Write Stops):**

1. ✅ All existing `community_live_streams` data migrated to `live_rooms`
2. ✅ Frontend updated to use Gateway API exclusively
3. ✅ Zero direct Supabase queries from frontend code
4. ✅ RLS policies updated to block frontend access to `community_live_streams`
5. ✅ 7-day monitoring period shows no errors or regressions
6. ✅ Backup of `community_live_streams` table created before deletion

**Rollback Plan:**
- Keep `community_live_streams` table for 30 days after cutover
- Maintain backup in Cloud Storage for 90 days
- Document rollback procedure (revert frontend, restore table)

---

## Daily.co Prerequisites

### Why Daily.co?

**Daily.co was selected because:**
- ✅ **No subscription required** - Each user can create unlimited rooms
- ✅ **Simple pricing model** - Pay-per-use (participant-minutes), no upfront costs
- ✅ **Production-ready infrastructure** - Battle-tested, managed service
- ✅ **Clean REST API** - Bearer token authentication, straightforward integration
- ✅ **Scalability** - Up to 100,000 concurrent rooms supported
- ✅ **Node.js first-class support** - Official SDK and examples
- ✅ **No complex setup** - No Google Workspace or Domain-Wide Delegation needed

### Prerequisites Checklist

**Required:**
1. ✅ **Daily.co account** (Sign up at https://dashboard.daily.co)
2. ✅ **Daily.co API key** (Generated from dashboard)
3. ✅ **GCP Secret Manager** (Store API key securely)

**Not Required:**
- ❌ No Google Workspace account needed
- ❌ No Domain-Wide Delegation setup
- ❌ No service account impersonation
- ❌ No Calendar API configuration

### Setup Steps

#### 1. Create Daily.co Account

```bash
# 1. Visit https://dashboard.daily.co
# 2. Sign up for an account
# 3. Navigate to "Developers" section
# 4. Generate an API key
```

#### 2. Store API Key in GCP Secret Manager

```bash
# Create secret
echo -n "YOUR_DAILY_API_KEY" | gcloud secrets create daily-api-key \
  --data-file=- \
  --project=lovable-vitana-vers1 \
  --replication-policy=automatic

# Grant Gateway service access
gcloud secrets add-iam-policy-binding daily-api-key \
  --member="serviceAccount:gateway@lovable-vitana-vers1.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=lovable-vitana-vers1
```

#### 3. Environment Variables

Add to `.env` (local development):
```bash
DAILY_API_KEY=your_daily_api_key_here
```

For Cloud Run deployment, bind the secret:
```bash
--set-secrets=DAILY_API_KEY=daily-api-key:latest
```

---

## Daily.co API Integration

### Authentication Setup

**Daily.co uses simple Bearer token authentication** - no complex OAuth or service account setup.

### API Key Authentication

```typescript
// services/gateway/src/services/daily-client.ts

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_API_BASE = 'https://api.daily.co/v1';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${DAILY_API_KEY}`
};
```

### Room Creation
gcloud projects add-iam-policy-binding lovable-vitana-vers1 \
  --member="serviceAccount:meet-creator@lovable-vitana-vers1.iam.gserviceaccount.com" \
  --role="roles/calendar.eventsCreator"
```

**4. Generate and Store Key**
```bash
# Generate JSON key
gcloud iam service-accounts keys create meet-creator-key.json \
  --iam-account=meet-creator@lovable-vitana-vers1.iam.gserviceaccount.com

# Store in GCP Secret Manager
gcloud secrets create google-meet-sa-key \
  --data-file=meet-creator-key.json \
  --project=lovable-vitana-vers1

# Clean up local key file
rm meet-creator-key.json
```

**5. Cloud Run Secret Binding**
Update deploy command to include:
```bash
--set-secrets=GOOGLE_MEET_SERVICE_ACCOUNT_KEY=google-meet-sa-key:latest
```

**CRITICAL:** Gateway secrets are **REPLACED** on deploy, not merged. Must list ALL secrets:
```bash
--set-secrets=\
SUPABASE_SERVICE_ROLE=supabase-service-role-key:latest,\
GITHUB_SAFE_MERGE_TOKEN=github-safe-merge-token:latest,\
GOOGLE_MEET_SERVICE_ACCOUNT_KEY=google-meet-sa-key:latest
```

### Google Calendar API Integration

#### Required NPM Package
```bash
npm install node-fetch  # or use built-in fetch in Node 18+
```

#### Room Creation Flow

**File:** `services/gateway/src/services/daily-client.ts`

```typescript
export interface DailyRoomDetails {
  roomId: string;
  title: string;
  expiresInHours?: number; // Default: 24 hours
}

export interface DailyRoomResult {
  roomUrl: string;
  roomName: string;
}

export class DailyClient {
  private apiKey: string;
  private apiBase = 'https://api.daily.co/v1';

  constructor() {
    this.apiKey = process.env.DAILY_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('DAILY_API_KEY environment variable is required');
    }
  }

  async createRoom(details: DailyRoomDetails): Promise<DailyRoomResult> {
    const { roomId, title, expiresInHours = 24 } = details;

    // Calculate expiration time
    const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);

    const response = await fetch(`${this.apiBase}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: `vitana-${roomId}`, // Room name (idempotency key)
        properties: {
          exp,  // Expiration timestamp
          enable_chat: true,
          enable_screenshare: true,
          enable_recording: 'cloud',  // Optional: enable recording
          start_video_off: false,
          start_audio_off: false,
          max_participants: 100  // Adjust as needed
        }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Daily.co API error: ${error.error || response.statusText}`);
    }

    const data = await response.json();

    return {
      roomUrl: data.url,      // Full room URL (e.g., https://vitana.daily.co/vitana-XXXXX)
      roomName: data.name     // Room name (e.g., vitana-XXXXX)
    };
  }

  async deleteRoom(roomName: string): Promise<void> {
    const response = await fetch(`${this.apiBase}/rooms/${roomName}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.json();
      throw new Error(`Daily.co delete error: ${error.error || response.statusText}`);
    }
  }

  async getRoomInfo(roomName: string): Promise<any> {
    const response = await fetch(`${this.apiBase}/rooms/${roomName}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.json();
      throw new Error(`Daily.co get room error: ${error.error || response.statusText}`);
    }

    return response.json();
  }
}
```

**Key Features:**
- ✅ Simple REST API (no complex OAuth)
- ✅ Idempotent room creation (same name = same room)
- ✅ No subscription required per user
- ✅ Configurable room properties (chat, screenshare, recording)
- ✅ Automatic expiration (24 hours default)
- ✅ Error handling for API failures

---

## Payment & Access Control

### Hard Server-Side Enforcement (Critical Security Rule)

**ABSOLUTE REQUIREMENT:** Daily.co room URLs must **NEVER** be returned to unauthorized users.

**Enforcement Rules:**
1. ✅ **Never trust the client** - Stripe redirect success page is NOT proof of payment
2. ✅ **Stripe webhook is the ONLY authority** for payment confirmation
3. ✅ **daily_room_url ONLY returned after verified access grant exists**
4. ✅ **No daily_room_url in error responses** (even on 403 PAYMENT_REQUIRED)
5. ✅ **Access check MUST happen server-side on every /join request**
6. ✅ **No client-side bypass possible** (RLS + service role enforcement)

**Example of WRONG implementation (NEVER DO THIS):**
```typescript
// ❌ WRONG - Returns daily_room_url before verifying payment
if (room.access_level === 'group' && !hasAccess) {
  return res.status(403).json({
    error: 'PAYMENT_REQUIRED',
    daily_room_url: room.metadata.daily_room_url  // ❌ LEAKED!
  });
}
```

**Example of CORRECT implementation:**
```typescript
// ✅ CORRECT - Never exposes daily_room_url without verified grant
if (room.access_level === 'group') {
  const grant = await callRpc(token, 'live_room_check_access', {
    p_user_id: userId,
    p_room_id: roomId
  });

  if (!grant.data) {
    // No daily_room_url in response!
    return res.status(403).json({
      ok: false,
      error: 'PAYMENT_REQUIRED',
      price: room.metadata?.price || 0
    });
  }
}

// Only return daily_room_url after all checks pass
return res.json({
  ok: true,
  daily_room_url: room.metadata.daily_room_url  // ✅ Safe - access verified
});
```

### Access Levels

| Level | Value | Description | Join Requirement |
|-------|-------|-------------|------------------|
| **Public** | `'public'` | Free rooms, anyone can join | Confirmation only |
| **Group** | `'group'` | Paid rooms, payment required | Payment verification |

### Payment Verification Flow

#### 1. Free Room Join Flow
```
User clicks "Join Free Room"
    ↓
Frontend calls POST /api/v1/live/rooms/:id/join
    ↓
Backend checks:
    ├─ Room exists? ✓
    ├─ Room status = 'live'? ✓
    ├─ access_level = 'public'? ✓
    └─ User authenticated? ✓
    ↓
Backend returns { ok: true, daily_room_url: "https://vitana.daily.co/vitana-XXXXX" }
    ↓
Frontend redirects to Daily.co room URL (new tab)
```

#### 2. Paid Room Join Flow
```
User clicks "Join Paid Room"
    ↓
Frontend checks if user has access
    ↓
If NO access:
    ├─ Show payment dialog
    ├─ User clicks "Pay $X"
    ├─ POST /api/v1/live/rooms/:id/purchase
    ├─ Backend creates Stripe checkout session
    ├─ User completes payment on Stripe
    ├─ Stripe webhook confirms payment
    └─ Backend creates access grant record
    ↓
If YES access:
    └─ POST /api/v1/live/rooms/:id/join
    ↓
Backend checks:
    ├─ Room exists? ✓
    ├─ Room status = 'live'? ✓
    ├─ access_level = 'group'? ✓
    ├─ User has valid access grant? ✓ (NEW CHECK)
    └─ User authenticated? ✓
    ↓
Backend returns { ok: true, daily_room_url: "https://vitana.daily.co/vitana-XXXXX" }
    ↓
Frontend redirects to Daily.co room URL (new tab)
```

### Access Grant Model

**Database Table:** `live_room_access_grants`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `tenant_id` | UUID | Tenant isolation |
| `user_id` | UUID | User who purchased access |
| `room_id` | UUID | Reference to live_rooms.id |
| `access_type` | TEXT | 'owner', 'paid', 'free', 'granted' |
| `purchased_at` | TIMESTAMPTZ | When access was granted |
| `expires_at` | TIMESTAMPTZ | Expiration (NULL = permanent) |
| `stripe_payment_intent_id` | TEXT | Stripe payment reference |
| `created_at` | TIMESTAMPTZ | Record creation |
| `metadata` | JSONB | Additional data |

**RLS Policies:**
```sql
-- Users can view their own access grants
CREATE POLICY "Users can view own access grants"
  ON live_room_access_grants FOR SELECT
  USING (auth.uid() = user_id);

-- Backend can create access grants via service role
-- (No INSERT policy for regular users)
```

**Check Access Function:**
```sql
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM live_room_access_grants
    WHERE user_id = p_user_id
      AND room_id = p_room_id
      AND (expires_at IS NULL OR expires_at > NOW())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## Backend Implementation

### File Structure

```
services/gateway/
├── src/
│   ├── routes/
│   │   └── live.ts                    # MODIFY: Add Daily.co endpoints
│   ├── services/
│   │   ├── daily-client.ts            # NEW: Daily.co API client
│   │   └── payment-service.ts         # NEW: Payment verification
│   └── middleware/
│       └── access-control.ts          # NEW: Room access checks
└── package.json                        # UPDATE: Add node-fetch (if needed)
```

### Updated Live Rooms API

**File:** `services/gateway/src/routes/live.ts`

#### New Endpoints

##### 1. Create Daily.co Room for Live Room
```typescript
// POST /api/v1/live/rooms/:id/daily
router.post('/rooms/:id/daily', requireAuth, async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  const { id: roomId } = req.params;

  // Verify user owns the room
  const room = await callRpc(token, 'live_room_get', { p_live_room_id: roomId });
  if (!room.ok || room.data.host_user_id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'NOT_ROOM_OWNER' });
  }

  // Check if Daily.co room already exists
  if (room.data.metadata?.daily_room_url) {
    return res.json({ ok: true, daily_room_url: room.data.metadata.daily_room_url });
  }

  // Create Daily.co room
  const dailyClient = new DailyClient();
  const dailyRoom = await dailyClient.createRoom({
    roomId,
    title: room.data.title,
    expiresInHours: 24  // 24 hours expiration
  });

  // Update room metadata with Daily.co room URL
  await callRpc(token, 'live_room_update_metadata', {
    p_live_room_id: roomId,
    p_metadata: {
      ...room.data.metadata,
      daily_room_url: dailyRoom.roomUrl,
      daily_room_name: dailyRoom.roomName,
      video_provider: 'daily_co'
    }
  });

  // Emit OASIS event
  await emitOasisEvent({
    vtid: 'VTID-01228',
    type: 'live.daily.created',
    source: 'live-gateway',
    status: 'success',
    message: `Daily.co room created for live room ${roomId}`,
    payload: { room_id: roomId, daily_room_url: dailyRoom.roomUrl }
  });

  return res.json({ ok: true, daily_room_url: dailyRoom.roomUrl });
});
```

##### 2. Purchase Room Access (Paid Rooms)
```typescript
// POST /api/v1/live/rooms/:id/purchase
router.post('/rooms/:id/purchase', requireAuth, async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  const { id: roomId } = req.params;
  const userId = req.user.id;

  // Get room details
  const room = await callRpc(token, 'live_room_get', { p_live_room_id: roomId });
  if (!room.ok) {
    return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  }

  // Verify room is paid
  if (room.data.access_level !== 'group') {
    return res.status(400).json({ ok: false, error: 'ROOM_IS_FREE' });
  }

  // Check if user already has access
  const hasAccess = await callRpc(token, 'live_room_check_access', {
    p_user_id: userId,
    p_room_id: roomId
  });

  if (hasAccess.data) {
    return res.status(400).json({ ok: false, error: 'ALREADY_HAS_ACCESS' });
  }

  // Get room price from metadata
  const price = room.data.metadata?.price || 0;
  if (price <= 0) {
    return res.status(400).json({ ok: false, error: 'PRICE_NOT_SET' });
  }

  // Create Stripe checkout session
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Live Room: ${room.data.title}`,
          description: 'Access to paid live session'
        },
        unit_amount: Math.round(price * 100) // Convert to cents
      },
      quantity: 1
    }],
    mode: 'payment',
    success_url: `${process.env.FRONTEND_URL}/live-rooms/${roomId}?payment=success`,
    cancel_url: `${process.env.FRONTEND_URL}/live-rooms/${roomId}?payment=cancelled`,
    metadata: {
      room_id: roomId,
      user_id: userId,
      purchase_type: 'live_room_access'
    }
  });

  return res.json({ ok: true, checkout_url: session.url });
});
```

##### 3. Updated Join Endpoint (with Access Control)
```typescript
// POST /api/v1/live/rooms/:id/join
router.post('/rooms/:id/join', requireAuth, async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  const { id: roomId } = req.params;
  const userId = req.user.id;

  // Get room details
  const room = await callRpc(token, 'live_room_get', { p_live_room_id: roomId });
  if (!room.ok) {
    return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  }

  // Check room status
  if (room.data.status !== 'live') {
    return res.status(400).json({ ok: false, error: 'ROOM_NOT_LIVE' });
  }

  // ACCESS CONTROL CHECK (NEW)
  if (room.data.access_level === 'group') {
    // Paid room - verify access grant
    const hasAccess = await callRpc(token, 'live_room_check_access', {
      p_user_id: userId,
      p_room_id: roomId
    });

    if (!hasAccess.data) {
      return res.status(403).json({
        ok: false,
        error: 'PAYMENT_REQUIRED',
        price: room.data.metadata?.price || 0
      });
    }
  }
  // else: public room, no payment check needed

  // Create attendance record (existing logic)
  const result = await callRpc(token, 'live_room_join', {
    p_live_room_id: roomId
  });

  if (!result.ok) {
    return res.status(400).json(result);
  }

  // Return Meet link
  return res.json({
    ok: true,
    daily_room_url: room.data.metadata?.daily_room_url || null,
    attendance: result.data
  });
});
```

### Stripe Webhook Handler

**File:** `services/gateway/src/routes/stripe-webhook.ts`

```typescript
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { room_id, user_id, purchase_type } = session.metadata;

    if (purchase_type === 'live_room_access') {
      // Create access grant using service role token
      const serviceToken = process.env.SUPABASE_SERVICE_ROLE;

      await callRpc(serviceToken, 'live_room_grant_access', {
        p_user_id: user_id,
        p_room_id: room_id,
        p_access_type: 'paid',
        p_stripe_payment_intent_id: session.payment_intent
      });

      // Emit OASIS event
      await emitOasisEvent({
        vtid: 'VTID-01228',
        type: 'live.room.access_granted',
        source: 'stripe-webhook',
        status: 'success',
        message: `Access granted to room ${room_id}`,
        payload: { room_id, user_id, payment_intent: session.payment_intent }
      });
    }
  }

  res.json({ received: true });
});
```

---

## Frontend Implementation

### temp_vitana_v1 (Lovable) Integration

#### Updated LiveRoomCard Component

**File:** `temp_vitana_v1/src/components/liverooms/LiveRoomCard.tsx`

```tsx
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';

interface LiveRoomCardProps {
  room: LiveRoom;
}

export function LiveRoomCard({ room }: LiveRoomCardProps) {
  const [isJoining, setIsJoining] = useState(false);
  const { toast } = useToast();

  const handleJoin = async () => {
    setIsJoining(true);

    try {
      // Check if paid room
      if (room.isPremium) {
        // Check if user has access
        const response = await fetch(
          `${process.env.VITE_GATEWAY_URL}/api/v1/live/rooms/${room.id}/check-access`,
          {
            headers: { 'Authorization': `Bearer ${supabaseToken}` }
          }
        );

        const { has_access } = await response.json();

        if (!has_access) {
          // Redirect to purchase flow
          const purchaseResponse = await fetch(
            `${process.env.VITE_GATEWAY_URL}/api/v1/live/rooms/${room.id}/purchase`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${supabaseToken}` }
            }
          );

          const { checkout_url } = await purchaseResponse.json();
          window.location.href = checkout_url; // Redirect to Stripe
          return;
        }
      }

      // Join room (free or paid with access)
      const joinResponse = await fetch(
        `${process.env.VITE_GATEWAY_URL}/api/v1/live/rooms/${room.id}/join`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${supabaseToken}` }
        }
      );

      const joinData = await joinResponse.json();

      if (!joinData.ok) {
        if (joinData.error === 'PAYMENT_REQUIRED') {
          toast({
            title: "Payment Required",
            description: `This room costs $${joinData.price}. Redirecting to payment...`,
            variant: "default"
          });
          // Trigger purchase flow
          return;
        }
        throw new Error(joinData.error);
      }

      // Open Daily.co room in new tab
      if (joinData.daily_room_url) {
        window.open(joinData.daily_room_url, '_blank');
        toast({
          title: "Joined!",
          description: "Opening video room in new tab...",
          variant: "success"
        });
      } else {
        toast({
          title: "No Room Link",
          description: "Room host hasn't created a video room yet.",
          variant: "warning"
        });
      }

    } catch (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive"
      });
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div className="live-room-card">
      {/* Existing card UI */}

      <button
        onClick={handleJoin}
        disabled={isJoining || room.status !== 'live'}
      >
        {room.isPremium ? `Join ($${room.metadata?.price || 0})` : 'Join Free'}
      </button>
    </div>
  );
}
```

#### Host Room Creation Flow

**File:** `temp_vitana_v1/src/components/liverooms/CreateLiveRoomDialog.tsx`

```tsx
export function CreateLiveRoomDialog() {
  const [formData, setFormData] = useState({
    title: '',
    access_level: 'public', // or 'group'
    price: 0,
    create_daily_room_url: true
  });

  const handleCreate = async () => {
    // 1. Create room via Gateway API
    const createResponse = await fetch(
      `${process.env.VITE_GATEWAY_URL}/api/v1/live/rooms`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: formData.title,
          starts_at: new Date().toISOString(),
          metadata: {
            access_level: formData.access_level,
            price: formData.access_level === 'group' ? formData.price : 0
          }
        })
      }
    );

    const { live_room_id } = await createResponse.json();

    // 2. Start the room
    await fetch(
      `${process.env.VITE_GATEWAY_URL}/api/v1/live/rooms/${live_room_id}/start`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${supabaseToken}` }
      }
    );

    // 3. Create Google Meet link (if enabled)
    if (formData.create_daily_room_url) {
      await fetch(
        `${process.env.VITE_GATEWAY_URL}/api/v1/live/rooms/${live_room_id}/meet`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${supabaseToken}` }
        }
      );
    }

    // Redirect to room view
    navigate(`/live-rooms/${live_room_id}`);
  };

  return (
    <Dialog>
      {/* Form fields for title, access_level, price, etc. */}
    </Dialog>
  );
}
```

---

## Database Schema

### New Migration: Daily.co Video Integration (VTID-01228)

**File:** `supabase/migrations/20260209_vtid_01228_daily_co_integration.sql`

```sql
-- ============================================================================
-- VTID-01228: Daily.co Video Integration for LIVE Rooms
-- UP Migration
-- ============================================================================

-- 1. Add access_level column to live_rooms
ALTER TABLE live_rooms
ADD COLUMN IF NOT EXISTS access_level TEXT DEFAULT 'public'
  CHECK (access_level IN ('public', 'group'));

COMMENT ON COLUMN live_rooms.access_level IS
  'Access level: public (free) or group (paid)';

-- 2. Create access grants table
CREATE TABLE IF NOT EXISTS live_room_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,

  access_type TEXT NOT NULL CHECK (access_type IN ('owner', 'paid', 'free', 'granted')),

  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NULL,

  -- Revocation support
  is_valid BOOLEAN DEFAULT true,
  is_revoked BOOLEAN DEFAULT false,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,

  stripe_payment_intent_id TEXT NULL,
  refund_id TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::JSONB,

  UNIQUE (user_id, room_id)
);

COMMENT ON TABLE live_room_access_grants IS
  'Tracks user access to paid live rooms with revocation support';

-- 3. Add indexes
CREATE INDEX idx_access_grants_user ON live_room_access_grants(user_id);
CREATE INDEX idx_access_grants_room ON live_room_access_grants(room_id);
CREATE INDEX idx_access_grants_tenant ON live_room_access_grants(tenant_id);
CREATE INDEX idx_access_grants_payment ON live_room_access_grants(stripe_payment_intent_id);

-- Unique index for valid grants only
CREATE UNIQUE INDEX idx_access_grants_unique
  ON live_room_access_grants(user_id, room_id)
  WHERE is_valid = true AND is_revoked = false;

-- 4. RLS policies
ALTER TABLE live_room_access_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own access grants"
  ON live_room_access_grants FOR SELECT
  USING (
    tenant_id = (SELECT tenant_id FROM app_users WHERE id = auth.uid())
    AND user_id = auth.uid()
  );

CREATE POLICY "Prevent cross-tenant grant creation"
  ON live_room_access_grants FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT tenant_id FROM app_users WHERE id = user_id)
    AND tenant_id = (SELECT tenant_id FROM live_rooms WHERE id = room_id)
  );

-- 5. Create public view to hide sensitive metadata (daily_room_url)
CREATE OR REPLACE VIEW live_rooms_public AS
SELECT
  id, tenant_id, title, topic_keys, host_user_id,
  starts_at, ends_at, status, created_at, updated_at,
  access_level, -- Expose access_level
  -- Filter metadata to exclude daily_room_url
  jsonb_build_object(
    'price', metadata->'price',
    'stream_type', metadata->'stream_type',
    'enable_replay', metadata->'enable_replay',
    'cover_image_url', metadata->'cover_image_url'
    -- Explicitly EXCLUDE daily_room_url, daily_room_name
  ) as metadata
FROM live_rooms;

COMMENT ON VIEW live_rooms_public IS
  'Public view of live_rooms without sensitive video room URL data';

-- 6. RPC: Check if user has access to room (3-parameter version with tenant)
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID,
  p_tenant_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_room_tenant_id UUID;
  v_user_tenant_id UUID;
BEGIN
  -- Verify room belongs to tenant
  SELECT tenant_id INTO v_room_tenant_id
  FROM live_rooms WHERE id = p_room_id;

  IF v_room_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Room % not in tenant %', p_room_id, p_tenant_id;
  END IF;

  -- Verify user belongs to tenant
  SELECT tenant_id INTO v_user_tenant_id
  FROM app_users WHERE id = p_user_id;

  IF v_user_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: User % not in tenant %', p_user_id, p_tenant_id;
  END IF;

  -- Check ownership
  IF EXISTS (
    SELECT 1 FROM live_rooms
    WHERE id = p_room_id
      AND host_user_id = p_user_id
      AND tenant_id = p_tenant_id
  ) THEN
    RETURN TRUE;
  END IF;

  -- Check valid, non-revoked grant
  RETURN EXISTS (
    SELECT 1 FROM live_room_access_grants
    WHERE user_id = p_user_id
      AND room_id = p_room_id
      AND tenant_id = p_tenant_id
      AND is_valid = true
      AND is_revoked = false
      AND (expires_at IS NULL OR expires_at > NOW())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. RPC: Backward-compatible 2-parameter version
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  -- Derive tenant from user
  RETURN live_room_check_access(
    p_user_id,
    p_room_id,
    (SELECT tenant_id FROM app_users WHERE id = p_user_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. RPC: Grant access to user
CREATE OR REPLACE FUNCTION live_room_grant_access(
  p_user_id UUID,
  p_room_id UUID,
  p_access_type TEXT,
  p_stripe_payment_intent_id TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_tenant_id UUID;
  v_grant_id UUID;
BEGIN
  -- Get tenant_id from room
  SELECT tenant_id INTO v_tenant_id FROM live_rooms WHERE id = p_room_id;

  -- Create access grant (upsert)
  INSERT INTO live_room_access_grants (
    tenant_id, user_id, room_id, access_type, stripe_payment_intent_id,
    is_valid, is_revoked
  ) VALUES (
    v_tenant_id, p_user_id, p_room_id, p_access_type, p_stripe_payment_intent_id,
    true, false
  )
  ON CONFLICT (user_id, room_id)
  DO UPDATE SET
    access_type = EXCLUDED.access_type,
    stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, live_room_access_grants.stripe_payment_intent_id),
    purchased_at = NOW(),
    is_valid = true,
    is_revoked = false
  RETURNING id INTO v_grant_id;

  RETURN v_grant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. RPC: Revoke access (for refunds)
CREATE OR REPLACE FUNCTION live_room_revoke_access(
  p_grant_id UUID,
  p_reason TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE live_room_access_grants
  SET
    is_revoked = true,
    is_valid = false,
    revoked_at = NOW(),
    revoked_reason = p_reason
  WHERE id = p_grant_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. RPC: Invalidate all grants for a room (cancellation)
CREATE OR REPLACE FUNCTION live_room_invalidate_all_grants(
  p_room_id UUID
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE live_room_access_grants
  SET is_valid = false
  WHERE room_id = p_room_id AND is_valid = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. RPC: Update room metadata (for Meet link storage)
CREATE OR REPLACE FUNCTION live_room_update_metadata(
  p_live_room_id UUID,
  p_metadata JSONB
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE live_rooms
  SET metadata = p_metadata, updated_at = NOW()
  WHERE id = p_live_room_id
    AND host_user_id = auth.uid(); -- Only owner

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

### Rollback Migration

**File:** `supabase/migrations/20260209_vtid_01228_daily_co_integration_down.sql`

```sql
-- ============================================================================
-- VTID-01228: Daily.co Video Integration for LIVE Rooms
-- DOWN Migration (Rollback)
-- ============================================================================

-- Drop RPC functions
DROP FUNCTION IF EXISTS live_room_update_metadata(UUID, JSONB);
DROP FUNCTION IF EXISTS live_room_invalidate_all_grants(UUID);
DROP FUNCTION IF EXISTS live_room_revoke_access(UUID, TEXT);
DROP FUNCTION IF EXISTS live_room_grant_access(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS live_room_check_access(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS live_room_check_access(UUID, UUID);

-- Drop view
DROP VIEW IF EXISTS live_rooms_public;

-- Drop indexes
DROP INDEX IF EXISTS idx_access_grants_unique;
DROP INDEX IF EXISTS idx_access_grants_payment;
DROP INDEX IF EXISTS idx_access_grants_tenant;
DROP INDEX IF EXISTS idx_access_grants_room;
DROP INDEX IF EXISTS idx_access_grants_user;

-- Drop table
DROP TABLE IF EXISTS live_room_access_grants;

-- Remove access_level column from live_rooms
ALTER TABLE live_rooms DROP COLUMN IF EXISTS access_level;

-- Log rollback
DO $$
BEGIN
  RAISE NOTICE 'VTID-01228 rollback complete - Daily.co integration removed';
END $$;
```

---

## API Endpoints

### Complete API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| **Existing Endpoints** ||||
| POST | `/api/v1/live/rooms` | Required | Create a new live room |
| POST | `/api/v1/live/rooms/:id/start` | Required | Start a room (set status='live') |
| POST | `/api/v1/live/rooms/:id/end` | Required | End a room |
| POST | `/api/v1/live/rooms/:id/join` | Required | **UPDATED:** Join room (with access control) |
| POST | `/api/v1/live/rooms/:id/leave` | Required | Leave a room |
| **New Endpoints** ||||
| POST | `/api/v1/live/rooms/:id/daily` | Required | Create Daily.co room |
| DELETE | `/api/v1/live/rooms/:id/daily` | Required | Remove Daily.co room |
| GET | `/api/v1/live/rooms/:id/check-access` | Required | Check if user has access to paid room |
| POST | `/api/v1/live/rooms/:id/purchase` | Required | Purchase access to paid room (Stripe) |
| POST | `/api/v1/stripe/webhook` | None | Stripe webhook for payment confirmation |

### API Request/Response Examples

#### Create Room with Daily.co Video
```http
POST /api/v1/live/rooms
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Daily Standup",
  "starts_at": "2026-02-09T10:00:00Z",
  "metadata": {
    "access_level": "public",
    "create_daily_room_url": true
  }
}

Response:
{
  "ok": true,
  "live_room_id": "uuid-here",
  "daily_room_url": "https://vitana.daily.co/vitana-XXXXX"
}
```

#### Purchase Paid Room Access
```http
POST /api/v1/live/rooms/:id/purchase
Authorization: Bearer <token>

Response:
{
  "ok": true,
  "checkout_url": "https://checkout.stripe.com/..."
}
```

#### Join Room (with Access Control)
```http
POST /api/v1/live/rooms/:id/join
Authorization: Bearer <token>

Response (Success):
{
  "ok": true,
  "daily_room_url": "https://meet.google.com/abc-defg-hij",
  "attendance": { ... }
}

Response (Payment Required):
{
  "ok": false,
  "error": "PAYMENT_REQUIRED",
  "price": 9.99
}
```

---

## Room Lifecycle & Grant Revocation

### Grant Lifecycle States

**Access grants are NOT permanent** - they must respect room lifecycle and business events.

| Event | Action | Database Operation |
|-------|--------|-------------------|
| **Payment succeeded** | Create grant | INSERT into `live_room_access_grants` |
| **Room canceled** | Invalidate all grants | UPDATE grants SET `is_valid = false` |
| **Refund issued** | Revoke grant | UPDATE grants SET `is_revoked = true`, `revoked_at = NOW()` |
| **Room ended** | Optionally expire | UPDATE grants SET `expires_at = NOW()` (if time-bounded) |
| **User banned** | Revoke all user grants | UPDATE grants SET `is_revoked = true` WHERE user_id = X |

### Updated Access Grant Schema

**Add these columns to `live_room_access_grants`:**

```sql
ALTER TABLE live_room_access_grants
ADD COLUMN is_valid BOOLEAN DEFAULT true,
ADD COLUMN is_revoked BOOLEAN DEFAULT false,
ADD COLUMN revoked_at TIMESTAMPTZ NULL,
ADD COLUMN revoked_reason TEXT NULL,
ADD COLUMN refund_id TEXT NULL;
```

### Revocation RPC Functions

```sql
-- Revoke a specific grant (e.g., after refund)
CREATE OR REPLACE FUNCTION live_room_revoke_access(
  p_grant_id UUID,
  p_reason TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE live_room_access_grants
  SET
    is_revoked = true,
    is_valid = false,
    revoked_at = NOW(),
    revoked_reason = p_reason
  WHERE id = p_grant_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Invalidate all grants for a canceled room
CREATE OR REPLACE FUNCTION live_room_invalidate_all_grants(
  p_room_id UUID
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE live_room_access_grants
  SET is_valid = false
  WHERE room_id = p_room_id
    AND is_valid = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Updated Access Check Logic

**Modify `live_room_check_access` to respect revocation:**

```sql
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  -- Owner always has access
  IF EXISTS (
    SELECT 1 FROM live_rooms
    WHERE id = p_room_id AND host_user_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;

  -- Check for valid, non-revoked grant
  RETURN EXISTS (
    SELECT 1 FROM live_room_access_grants
    WHERE user_id = p_user_id
      AND room_id = p_room_id
      AND is_valid = true           -- NEW
      AND is_revoked = false        -- NEW
      AND (expires_at IS NULL OR expires_at > NOW())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Stripe Refund Webhook Handler

**Add to `stripe-webhook.ts`:**

```typescript
// Handle refund events
if (event.type === 'charge.refunded') {
  const charge = event.data.object;
  const paymentIntentId = charge.payment_intent;

  // Find and revoke the grant
  await callRpc(serviceToken, 'live_room_revoke_access_by_payment', {
    p_stripe_payment_intent_id: paymentIntentId,
    p_revoked_reason: 'refund_issued'
  });

  // Emit OASIS event
  await emitOasisEvent({
    vtid: 'VTID-01228',
    type: 'live.room.access_revoked',
    source: 'stripe-webhook',
    status: 'success',
    message: `Access revoked due to refund: ${paymentIntentId}`,
    payload: { payment_intent: paymentIntentId }
  });
}
```

### Room Cancellation Flow

**Add endpoint: DELETE `/api/v1/live/rooms/:id`**

```typescript
router.delete('/rooms/:id', requireAuth, async (req: Request, res: Response) => {
  const { id: roomId } = req.params;
  const userId = req.user.id;

  // Verify ownership
  const room = await callRpc(token, 'live_room_get', { p_live_room_id: roomId });
  if (room.data.host_user_id !== userId) {
    return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
  }

  // 1. Invalidate all grants
  const invalidatedCount = await callRpc(token, 'live_room_invalidate_all_grants', {
    p_room_id: roomId
  });

  // 2. Delete Daily.co room
  const dailyRoomName = room.data.metadata?.daily_room_name;
  if (dailyRoomName) {
    const dailyClient = new DailyClient();
    await dailyClient.deleteRoom(dailyRoomName);
  }

  // 3. Mark room as canceled
  await callRpc(token, 'live_room_cancel', { p_live_room_id: roomId });

  // 4. Emit OASIS event
  await emitOasisEvent({
    vtid: 'VTID-01228',
    type: 'live.room.canceled',
    source: 'live-gateway',
    status: 'success',
    message: `Room canceled: ${roomId}`,
    payload: { room_id: roomId, grants_invalidated: invalidatedCount }
  });

  return res.json({ ok: true, invalidated_grants: invalidatedCount });
});
```

---

## Multi-Tenancy & RLS Rigor

### Tenant Isolation Requirements

**CRITICAL:** All room access checks must enforce tenant boundaries.

**Violation Scenarios to Prevent:**
1. ❌ User from Tenant A accesses room in Tenant B (even with valid link)
2. ❌ Grant created in Tenant A applied to room in Tenant B
3. ❌ Cross-tenant join attempts (even if access grant exists)

### Tenant-Scoped Access Check

**Updated `live_room_check_access` with tenant enforcement:**

```sql
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID,
  p_tenant_id UUID  -- NEW: Explicitly pass tenant context
) RETURNS BOOLEAN AS $$
DECLARE
  v_room_tenant_id UUID;
  v_user_tenant_id UUID;
BEGIN
  -- 1. Verify room belongs to the tenant
  SELECT tenant_id INTO v_room_tenant_id
  FROM live_rooms
  WHERE id = p_room_id;

  IF v_room_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Room % not in tenant %', p_room_id, p_tenant_id;
  END IF;

  -- 2. Verify user belongs to the tenant
  SELECT tenant_id INTO v_user_tenant_id
  FROM app_users
  WHERE id = p_user_id;

  IF v_user_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: User % not in tenant %', p_user_id, p_tenant_id;
  END IF;

  -- 3. Check ownership (tenant-scoped)
  IF EXISTS (
    SELECT 1 FROM live_rooms
    WHERE id = p_room_id
      AND host_user_id = p_user_id
      AND tenant_id = p_tenant_id  -- Explicit tenant check
  ) THEN
    RETURN TRUE;
  END IF;

  -- 4. Check grant (tenant-scoped)
  RETURN EXISTS (
    SELECT 1 FROM live_room_access_grants
    WHERE user_id = p_user_id
      AND room_id = p_room_id
      AND tenant_id = p_tenant_id  -- Explicit tenant check
      AND is_valid = true
      AND is_revoked = false
      AND (expires_at IS NULL OR expires_at > NOW())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### RLS Policy Updates

**Strengthen RLS policies to enforce tenant isolation:**

```sql
-- live_rooms: Users can only view rooms in their tenant
CREATE POLICY "Users view rooms in own tenant"
  ON live_rooms FOR SELECT
  USING (
    tenant_id = (SELECT tenant_id FROM app_users WHERE id = auth.uid())
  );

-- live_room_access_grants: Users can only view grants in their tenant
CREATE POLICY "Users view grants in own tenant"
  ON live_room_access_grants FOR SELECT
  USING (
    tenant_id = (SELECT tenant_id FROM app_users WHERE id = auth.uid())
    AND user_id = auth.uid()
  );

-- Block cross-tenant writes (even via service role, use explicit checks in RPCs)
CREATE POLICY "Prevent cross-tenant grant creation"
  ON live_room_access_grants FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT tenant_id FROM app_users WHERE id = user_id)
    AND tenant_id = (SELECT tenant_id FROM live_rooms WHERE id = room_id)
  );
```

### Backend Join Endpoint (Tenant-Enforced)

```typescript
// POST /api/v1/live/rooms/:id/join
router.post('/rooms/:id/join', requireAuth, async (req: Request, res: Response) => {
  const { id: roomId } = req.params;
  const userId = req.user.id;
  const tenantId = req.user.tenant_id;  // From JWT token

  // Get room (already filtered by RLS to ensure same tenant)
  const room = await callRpc(token, 'live_room_get', { p_live_room_id: roomId });

  if (!room.ok) {
    return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  }

  // EXPLICIT tenant check (defense in depth)
  if (room.data.tenant_id !== tenantId) {
    // Log as potential security violation
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: 'security.cross_tenant_attempt',
      source: 'live-gateway',
      status: 'error',
      message: `Cross-tenant join attempt: user ${userId} → room ${roomId}`,
      payload: { user_id: userId, room_id: roomId, user_tenant: tenantId, room_tenant: room.data.tenant_id }
    });

    return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  }

  // Check access (with explicit tenant_id parameter)
  if (room.data.access_level === 'group') {
    const hasAccess = await callRpc(token, 'live_room_check_access', {
      p_user_id: userId,
      p_room_id: roomId,
      p_tenant_id: tenantId  // Explicit tenant context
    });

    if (!hasAccess.data) {
      return res.status(403).json({
        ok: false,
        error: 'PAYMENT_REQUIRED',
        price: room.data.metadata?.price || 0
      });
    }
  }

  // Rest of join logic...
});
```

### Tenant Context Propagation

**Ensure tenant_id is extracted from JWT and passed to all RPCs:**

```typescript
// Middleware: Extract tenant from JWT
app.use((req, res, next) => {
  if (req.user) {
    // Decode JWT and extract tenant_id claim
    const decoded = jwt.decode(req.headers.authorization.split(' ')[1]);
    req.user.tenant_id = decoded.tenant_id;
  }
  next();
});
```

---

## Security & Abuse Controls

### Rate Limiting

**Endpoint-specific rate limits (using express-rate-limit):**

```typescript
import rateLimit from 'express-rate-limit';

// Prevent rapid purchase attempts (abuse/fraud)
const purchaseRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 purchases per 15 min per user
  keyGenerator: (req) => req.user.id,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED' }
});

router.post('/rooms/:id/purchase', requireAuth, purchaseRateLimiter, async (req, res) => {
  // ... purchase logic
});

// Prevent join spam
const joinRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 joins per minute per user
  keyGenerator: (req) => req.user.id
});

router.post('/rooms/:id/join', requireAuth, joinRateLimiter, async (req, res) => {
  // ... join logic
});

// Prevent Meet link creation spam
const meetCreateRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // 3 Meet links per 5 min per user
  keyGenerator: (req) => req.user.id
});

router.post('/rooms/:id/meet', requireAuth, meetCreateRateLimiter, async (req, res) => {
  // ... meet creation logic
});
```

### Idempotency & Replay Prevention

**1. Stripe Webhook Replay Protection:**

```typescript
// Track processed webhook events (prevent replay attacks)
const processedEvents = new Set(); // In production: use Redis or DB

router.post('/webhook', async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, sig, secret);

  // Check if already processed
  if (processedEvents.has(event.id)) {
    console.log(`Duplicate webhook event ignored: ${event.id}`);
    return res.json({ received: true });
  }

  // Process event
  // ...

  // Mark as processed
  processedEvents.add(event.id);
  // In production: await redis.setex(`webhook:${event.id}`, 86400, 'processed');

  res.json({ received: true });
});
```

**2. Prevent Duplicate Grants (Database Constraint):**

```sql
-- Unique constraint already exists, but add explicit check
CREATE UNIQUE INDEX idx_access_grants_unique
  ON live_room_access_grants(user_id, room_id)
  WHERE is_valid = true AND is_revoked = false;
```

**3. Idempotent Meeting Creation:**

```typescript
// In GoogleMeetClient.createMeeting()
conferenceData: {
  createRequest: {
    requestId: `vitana-${roomId}`,  // Same roomId = same requestId
    conferenceSolutionKey: { type: 'hangoutsMeet' }
  }
}
// Google Calendar API uses requestId for idempotency - same requestId = returns existing event
```

### Abuse Logging & Monitoring

**Log all suspicious activity to OASIS:**

```typescript
// Audit trail for security events
async function logSecurityEvent(type: string, details: any) {
  await emitOasisEvent({
    vtid: 'VTID-01228',
    type: `security.${type}`,
    source: 'live-gateway',
    status: 'warning',
    message: `Security event: ${type}`,
    payload: {
      timestamp: new Date().toISOString(),
      ...details
    }
  });
}

// Examples of events to log:
logSecurityEvent('payment_required_bypass_attempt', { user_id, room_id });
logSecurityEvent('cross_tenant_join_attempt', { user_id, room_id, tenant_mismatch });
logSecurityEvent('expired_grant_access_attempt', { grant_id, user_id, room_id });
logSecurityEvent('multiple_purchase_attempts', { user_id, room_id, attempt_count });
```

### Alert Triggers

**Set up Cloud Monitoring alerts for:**
- More than 10 `PAYMENT_REQUIRED` errors per user per hour
- Any `cross_tenant_attempt` event
- More than 5 failed Stripe payments per room
- More than 3 Daily.co room creations per user per 10 minutes
- Any RLS policy violation attempts

---

## Security Considerations

### Authentication & Authorization

1. **API Key Security**
   - ✅ Store Daily.co API key in GCP Secret Manager (never in code)
   - ✅ Use Cloud Run secret binding
   - ✅ Rotate keys periodically (quarterly recommended)
   - ✅ Least privilege principle (API key scoped to necessary operations)

2. **Room Access Control**
   - ✅ Verify JWT token on all endpoints
   - ✅ Check room ownership before allowing Daily.co room creation
   - ✅ Enforce access grants for paid rooms
   - ✅ RLS policies prevent direct database access

3. **Payment Security**
   - ✅ Use Stripe Checkout (PCI compliant)
   - ✅ Verify webhook signatures
   - ✅ Never expose Stripe secret key to frontend
   - ✅ Idempotent payment processing

### Data Privacy

1. **Daily.co Room URL Exposure**
   - ⚠️ Daily.co room URLs are accessible URLs (but can be configured with privacy settings)
   - ✅ Store in `metadata` JSONB (not exposed via public API)
   - ✅ Only return to authorized users via `/join` endpoint
   - ⚠️ Users could share links (mitigated by room expiration + privacy settings)

2. **Mitigation Strategy**
   - Use Daily.co room expiration (24 hours default)
   - Configure room privacy settings (require knock to enter, password protection)
   - Delete Daily.co room after live session ends (auto-cleanup)
   - Log access attempts for audit trail

### Rate Limiting

**Daily.co API Limits:**
- No strict documented rate limits for room creation
- Fair use policy applies
- Contact Daily.co for enterprise limits

**Recommendation:**
- Implement caching for Daily.co room URLs (store in DB)
- Reuse existing rooms instead of creating duplicates
- Idempotency via room name prevents duplicate room creation

---

## Implementation Phases

### Phase 1: Backend Foundation + Proof of Enforcement (Week 1)
**Goal:** Daily.co integration in Gateway + Verify Access Control Works

#### Part A: Daily.co Account Setup (Simple - No Complex Setup Required)
- [ ] Create Daily.co account at https://dashboard.daily.co
- [ ] Generate API key from Daily.co dashboard
- [ ] Store API key in GCP Secret Manager
- [ ] Bind secret to Gateway Cloud Run service

**Note:** No Google Workspace, Domain-Wide Delegation, or complex OAuth setup needed! ✅

#### Part B: Backend Implementation (Daily.co + Stripe + Access Control)
- [ ] **Install dependencies**: `npm install node-fetch stripe express-rate-limit` (or use built-in fetch)
- [ ] Implement `DailyClient` service (simple Bearer token auth)
- [ ] Add POST `/api/v1/live/rooms/:id/daily` endpoint
- [ ] Update `live_rooms` schema (add `access_level` column)
- [ ] Create `live_room_access_grants` table with revocation columns
- [ ] Implement `live_room_check_access` RPC (2-param + 3-param overload for backward compatibility)
- [ ] Implement `live_room_grant_access` RPC
- [ ] Implement `live_room_revoke_access` RPC
- [ ] **Add Stripe checkout integration**: POST `/api/v1/live/rooms/:id/purchase` endpoint
- [ ] **Add Stripe webhook handler**: POST `/api/v1/stripe/webhook` endpoint
- [ ] Update POST `/api/v1/live/rooms/:id/join` endpoint (with access control + payment verification)
- [ ] Add rate limiters to all endpoints (purchase, join, meet creation)
- [ ] **Create RLS policy for metadata protection** (hide daily_room_url from direct queries)
- [ ] Create database migration (with rollback script)
- [ ] Store Stripe secrets in GCP Secret Manager
- [ ] Deploy to Cloud Run with updated secrets binding

#### Part C: **PROOF OF ENFORCEMENT TEST** (Critical!)
**Test that an unpaid user CANNOT obtain a daily_room_url under ANY circumstances.**

**Test Cases:**
1. **Unauthorized Join Attempt:**
   ```bash
   # Create paid room as User A
   ROOM_ID=$(curl -X POST .../api/v1/live/rooms \
     -H "Authorization: Bearer $USER_A_TOKEN" \
     -d '{"title":"Paid Room","metadata":{"access_level":"group","price":9.99}}' \
     | jq -r '.live_room_id')

   # Start room and create Daily.co room
   curl -X POST .../api/v1/live/rooms/$ROOM_ID/start \
     -H "Authorization: Bearer $USER_A_TOKEN"
   curl -X POST .../api/v1/live/rooms/$ROOM_ID/daily \
     -H "Authorization: Bearer $USER_A_TOKEN"

   # Attempt to join as User B (no payment)
   RESPONSE=$(curl -X POST .../api/v1/live/rooms/$ROOM_ID/join \
     -H "Authorization: Bearer $USER_B_TOKEN")

   # MUST return 403 with NO daily_room_url in response
   echo $RESPONSE | jq -e '.error == "PAYMENT_REQUIRED"' || exit 1
   echo $RESPONSE | jq -e '.daily_room_url == null' || exit 1
   echo "✅ PASS: Unpaid user blocked, no daily_room_url leaked"
   ```

2. **Direct Database Query Attempt (via Supabase client):**
   ```typescript
   // User B tries to read daily_room_url directly from Supabase
   const { data, error } = await supabase
     .from('live_rooms')
     .select('metadata')
     .eq('id', roomId)
     .single();

   // RLS policy should block this OR metadata should not expose daily_room_url
   // Verify response does NOT contain daily_room_url
   assert(data?.metadata?.daily_room_url === undefined);
   ```

3. **Cross-Tenant Join Attempt:**
   ```bash
   # User from Tenant B attempts to join room in Tenant A
   RESPONSE=$(curl -X POST .../api/v1/live/rooms/$TENANT_A_ROOM_ID/join \
     -H "Authorization: Bearer $TENANT_B_USER_TOKEN")

   # MUST return 403 or 404 (RLS filters it out)
   echo $RESPONSE | jq -e '.ok == false' || exit 1
   echo "✅ PASS: Cross-tenant access blocked"
   ```

**Success Criteria:**
- ✅ Daily.co API key authenticates successfully
- ✅ Daily.co room URLs are created and stored in `metadata`
- ✅ **CRITICAL: Unpaid user receives 403 with NO daily_room_url in response**
- ✅ **CRITICAL: Direct DB query does not expose daily_room_url**
- ✅ **CRITICAL: Cross-tenant access is blocked**
- ✅ Daily.co room URLs open in browser for authorized users only

---

### Phase 2: Frontend Integration (Week 2)
**Goal:** Update Lovable UI to use new Gateway API

- [ ] Add environment variable `VITE_GATEWAY_URL`
- [ ] Create `useLiveRoomsApi` hook for Gateway integration
- [ ] Update `LiveRoomCard` component with join logic + payment redirect
- [ ] Add "Create Room" dialog with access_level and price input
- [ ] Display Daily.co room URL to room owners only
- [ ] Handle payment success/failure redirects from Stripe
- [ ] Test end-to-end user journey (free + paid rooms)
- [ ] Verify RLS blocks direct Supabase queries
- [ ] Fix UI bugs and edge cases

**Success Criteria:**
- ✅ Users can create free and paid rooms via Gateway API
- ✅ Paid rooms trigger Stripe checkout
- ✅ Users can join after payment confirmation
- ✅ Daily.co room URLs open in new tab (not iframe)
- ✅ Frontend does NOT query `community_live_streams` directly

---

### Phase 3: Schema Migration (Week 3)
**Goal:** Consolidate to single Live Rooms schema

- [ ] Audit differences between `community_live_streams` and `live_rooms`
- [ ] Create migration script to copy data
- [ ] Update frontend to use Gateway API exclusively
- [ ] Remove direct Supabase queries from frontend
- [ ] Deprecate `community_live_streams` table
- [ ] Test all LIVE Rooms features
- [ ] Deploy unified schema

**Success Criteria:**
- ✅ Single source of truth (`live_rooms` table)
- ✅ All frontend uses Gateway API
- ✅ No data loss during migration
- ✅ All features working with new schema

---

### Phase 4: Production Hardening (Week 4)
**Goal:** Security, monitoring, and scale prep

- [ ] Add rate limiting to Daily.co room creation endpoint
- [ ] Implement Daily.co room URL caching/reuse logic
- [ ] Add error monitoring (Sentry/Cloud Logging)
- [ ] Create OASIS dashboard for Live Rooms events
- [ ] Load test payment flow
- [ ] Set up alerts for failed payments
- [ ] Document API in OpenAPI spec
- [ ] Conduct security review

**Success Criteria:**
- ✅ System handles 100 concurrent room creations
- ✅ Error rate < 0.1%
- ✅ All errors logged to OASIS
- ✅ Security review passed

---

## Testing & Verification

### Manual Verification Checklist

#### Google Meet Integration
- [ ] Service account authenticates successfully
- [ ] Meet link is created when room starts
- [ ] Meet link is stored in `live_rooms.metadata`
- [ ] Meet link opens in browser
- [ ] Multiple users can join same Meet link
- [ ] Meet link is deleted when room ends

#### Access Control - Free Rooms
- [ ] Authenticated user can join public room
- [ ] Unauthenticated user is rejected (401)
- [ ] User receives Meet link after joining
- [ ] Attendance is recorded in database
- [ ] Relationship graph is strengthened

#### Access Control - Paid Rooms
- [ ] User without access is blocked (403 PAYMENT_REQUIRED)
- [ ] Purchase endpoint returns Stripe checkout URL
- [ ] User completes payment on Stripe
- [ ] Stripe webhook creates access grant
- [ ] User can now join paid room
- [ ] User receives Meet link after joining
- [ ] Duplicate purchase is handled gracefully

#### Edge Cases
- [ ] User tries to join room that hasn't started
- [ ] User tries to join room that has ended
- [ ] User tries to create Meet link for room they don't own
- [ ] Room owner can always join their own paid room
- [ ] Payment fails (card declined) - user cannot join
- [ ] Webhook is replayed (idempotency check)

### Automated Tests

```typescript
// Example Jest test
describe('Live Room Access Control', () => {
  it('should block unpaid user from joining paid room', async () => {
    const response = await request(app)
      .post('/api/v1/live/rooms/paid-room-id/join')
      .set('Authorization', `Bearer ${unpaidUserToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('PAYMENT_REQUIRED');
  });

  it('should allow paid user to join paid room', async () => {
    // Mock access grant exists
    const response = await request(app)
      .post('/api/v1/live/rooms/paid-room-id/join')
      .set('Authorization', `Bearer ${paidUserToken}`);

    expect(response.status).toBe(200);
    expect(response.body.daily_room_url).toMatch(/meet\.google\.com/);
  });
});
```

---

## Appendix

### Environment Variables

**Gateway Service (`services/gateway/.env`):**
```bash
# Existing
PORT=8080
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE=xxx
GITHUB_SAFE_MERGE_TOKEN=xxx

# New for Google Meet
GOOGLE_MEET_SERVICE_ACCOUNT_KEY={"type":"service_account",...}  # From Secret Manager

# New for Stripe
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Frontend URL for Stripe redirects
FRONTEND_URL=https://vitanaland.com
```

**Frontend (`temp_vitana_v1/.env`):**
```bash
VITE_GATEWAY_URL=https://gateway-xxx.run.app
```

### VTID Creation

Before implementation, create VTID in OASIS ledger:

```sql
INSERT INTO vtid_ledger (
  vtid,
  title,
  description,
  status,
  spec_status,
  target_roles
) VALUES (
  'VTID-01228',
  'Daily.co Video Integration for LIVE Rooms',
  'Integrate Daily.co video API to enable live video sessions in LIVE Rooms with payment verification',
  'in_progress',
  'approved',
  ARRAY['DEV', 'INFRA']
);
```

### Related VTIDs
- **VTID-01090** - LIVE Rooms Events & Relationship Graph
- **VTID-0416** - Gateway Deploy Governance
- **VTID-0542** - VTID Allocator Hard Gate

---

## Document Metadata

| Field | Value |
|-------|-------|
| **Author** | Claude (Sonnet 4.5) |
| **Created** | 2026-02-09 |
| **Updated** | 2026-02-09 (Switched to Daily.co) |
| **Status** | **APPROVED** - Ready for Implementation |
| **VTID** | **01228** - Daily.co Video Integration for LIVE ROOMS |
| **Reviewers** | Product, Engineering, Security |
| **Target Completion** | 4 weeks (4 phases) |

---

## Approval Sign-Off

**✅ APPROVED - With Critical Additions**

The user has approved the overall approach with the following required spec deltas (all added to this document):

**Approved:**
- ✅ Single canonical backend schema (`live_rooms`) + OASIS events
- ✅ Daily.co room creation via REST API, open in new tab (no iframe)
- ✅ Access grants table (`live_room_access_grants`) as enforcement primitive
- ✅ Migrate frontend to use backend API exclusively (Option A)
- ✅ Stripe checkout + webhook authority for payments
- ✅ Idempotency + governance events

**Critical Additions Made:**
1. ✅ **Daily.co Integration** - Simple API key setup (no complex OAuth/DWD)
2. ✅ **Hard Server-Side Enforcement** - Never return daily_room_url without verified access
3. ✅ **Multi-Tenancy RLS Rigor** - Explicit tenant_id checks on all operations
4. ✅ **Room Lifecycle & Grant Revocation** - Refund handling, cancellation flows
5. ✅ **Data Model Alignment** - Explicit deprecation of `community_live_streams`
6. ✅ **Security & Abuse Controls** - Rate limiting, replay prevention, audit logging
7. ✅ **Governance Alignment** - Confirmed this is LIVE Rooms (NOT Start Stream)
8. ✅ **Proof of Enforcement Test** - Phase 1 MUST verify unpaid users cannot obtain daily_room_url

**Critical Fixes Applied (Per Review):**
1. ✅ **VTID allocated**: VTID-01228 - Video API Integration for LIVE ROOMS
2. ✅ **Provider switch**: Replaced Google Meet with Daily.co (no subscription required)
3. ✅ **`access_level` column** added to migration
4. ✅ **Backward-compatible RPC** - 2-param and 3-param `live_room_check_access` overloads
5. ✅ **Dependencies updated** to Phase 1B: `node-fetch`, `stripe`, `express-rate-limit`
6. ✅ **RLS metadata leak fixed** - `live_rooms_public` view hides `daily_room_url`
7. ✅ **Simplified Phase 1A** - No complex Google Workspace/DWD setup needed
8. ✅ **Stripe moved to Phase 1** (required for Proof of Enforcement)
9. ✅ **Rollback migration** provided (`*_down.sql`)

**Next Steps (Immediate Actions):**
1. ✅ ~~Create VTID in OASIS ledger~~ **DONE** (VTID-01228)
2. **Create Daily.co account** and generate API key
3. **Phase 1A starts with simple API key setup** (no complex OAuth/DWD)
4. **Phase 1B includes Stripe** → enables Proof of Enforcement tests in Phase 1C
5. **Track all implementation via OASIS events**

**Governance Note:**
This spec aligns with LIVE Rooms / Go Live feature territory. **NEVER** merge with Start Stream (private AI + screen share, sidebar-only).

---

**END OF SPECIFICATION**
