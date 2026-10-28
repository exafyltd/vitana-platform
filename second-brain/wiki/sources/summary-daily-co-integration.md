# Summary: Daily.co Live Rooms Integration

> Summary of the Daily.co video integration specification (VTID-01228) and the Live Rooms frontend integration spec (VTID-01230).

## Source Documents

- `raw/specs/daily-co-live-rooms-integration.md` -- Daily.co video integration spec (VTID-01228, APPROVED, 2026-02-09)
- `raw/specs/VTID-01230-live-rooms-frontend-integration.md` -- Live Rooms frontend integration spec (VTID-01230, Draft, 2026-02-09)

## Daily.co Integration Spec (VTID-01228)

### Purpose
Enable users to host and join live video sessions through Daily.co in Vitana LIVE Rooms, with free and paid access modes.

### Why Daily.co
- No subscription required (pay-per-use)
- Simple Bearer token API (no complex OAuth)
- Up to 100,000 concurrent rooms
- Node.js first-class support

### Governance Boundary
LIVE Rooms / Go Live is NOT Start Stream. Start Stream is private 1:1 AI sidebar. Merging them is a governance violation.

### Critical Finding: Dual Schema
Two separate Live Rooms implementations exist:
1. Frontend: `community_live_streams` (Lovable UI)
2. Backend: `live_rooms` (Gateway API, VTID-01090)

Recommended: Migrate frontend to backend schema (superior architecture with OASIS integration, multi-tenant scaling).

### Migration Strategy
Phase 1: Daily.co + Payment on backend -> Phase 2: Frontend uses backend API -> Phase 3: Remove legacy table -> Phase 4: Monorepo merge

### Backend Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/live/rooms` | Create room |
| POST | `/live/rooms/:id/start` | Start room |
| POST | `/live/rooms/:id/end` | End room |
| POST | `/live/rooms/:id/join` | Join (access controlled) |
| POST | `/live/rooms/:id/leave` | Leave room |
| GET | `/live/rooms/:id/summary` | Session summary |
| POST | `/live/rooms/:id/daily` | Create Daily.co room |
| DELETE | `/live/rooms/:id/daily` | Delete Daily.co room |
| POST | `/live/rooms/:id/purchase` | Purchase access (Stripe) |

### Daily.co Room Creation
Via DailyClient class: POST to https://api.daily.co/v1/rooms with name `vitana-{roomId}`, 24h expiration, chat and screenshare enabled.

## Frontend Integration Spec (VTID-01230)

### Tech Stack
React 18.3.1 + TypeScript + Vite, Shadcn UI, React Query, Zustand, Supabase Auth. New deps: @stripe/react-stripe-js, @daily-co/daily-js, @daily-co/daily-react.

### New Files
- Service layer: liveRoomService.ts (typed API client)
- Hooks: useLiveRoom, useLiveRoomList, useLiveRoomAccess, useDailyRoom, useStripePayment
- Components: LiveRoomCard, LiveRoomGrid, CreateLiveRoomDialog (enhanced), LiveRoomViewer (enhanced), DailyVideoRoom, PurchaseRoomAccessDialog, and more
- Store: liveRoomStore.ts (Zustand)

### User Flows
- **Host:** Create -> Start -> Daily.co video -> Manage -> End -> Summary
- **Viewer:** Browse -> Purchase/Confirm -> Join -> Participate -> Leave

## Related Pages

- [[stripe-connect]] -- Payment integration for paid rooms
- [[stripe]] -- Stripe entity
- [[summary-stripe-connect]] -- Stripe spec summaries

## Sources

- `raw/specs/daily-co-live-rooms-integration.md`
- `raw/specs/VTID-01230-live-rooms-frontend-integration.md`

## Last Updated

2026-04-12
