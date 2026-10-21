 Vitana DEV Hub — Phase 1 Implementation

## Overview

The Vitana DEV Hub is a developer command center for observing platform events, managing VTIDs, and issuing commands. Phase 1 delivers a **read-only shell** with graceful degradation for missing backend endpoints.

## Feature Flags
#
Set these environment variables in `.env`:

```bash
VITE_DEV_HUB_ENABLED=true          # Enable/disable entire Dev Hub
VITE_DEV_HUB_READONLY=true         # Phase 1: Read-only mode (commands disabled)
VITE_GATEWAY_BASE=https://vitana-gateway-86804897789.us-central1.run.app
```

## Routes

- `/` — Public portal with 5th card "Vitana DEV"
- `/dev` — Redirects to `/dev/dashboard`
- `/dev/login` — Supabase Auth (email magic link + Google)
- `/dev/dashboard` — Command hub dashboard (read-only)
- `/dev/settings` — Configuration viewer

## Architecture

### Configuration
- `src/config/devHub.config.ts` — Feature flags and environment config

### API Client
- `src/lib/devGatewayClient.ts` — Gateway API client with graceful error handling

### Components
- `src/components/dev/DevHubHeader.tsx` — Header with user info and navigation
- `src/components/dev/SoftWarningBanner.tsx` — Non-blocking warning banner
- `src/components/dev/LiveEventsPanel.tsx` — Real-time events feed (OASIS)
- `src/components/dev/VTIDSnapshotPanel.tsx` — VTID assignments table
- `src/components/dev/CommandConsolePanel.tsx` — Command console (disabled in Phase 1)

### Custom Hooks
- `src/hooks/dev/useDevEvents.ts` — Fetch and auto-refresh events
- `src/hooks/dev/useDevVTID.ts` — Fetch and auto-refresh VTIDs

### Pages
- `src/pages/dev/DevLogin.tsx` — Authentication page
- `src/pages/dev/DevDashboard.tsx` — Main dashboard
- `src/pages/dev/DevSettings.tsx` — Settings viewer

## Backend Contracts (Expected from Task 4A)

### Health Check
```typescript
GET /events/health
Response: { ok: boolean, service: string, time: string }
```

### Recent Events
```typescript
GET /events/recent?limit=25&tenant=system
Response: Array<{
  id: string,
  service: string,
  event: string,
  status: 'green' | 'blue' | 'yellow' | 'red',
  tenant: string,
  rid: string,
  created_at: string,
  vtid?: { label, global_number, color, layer, module }
}>
```

### Recent VTIDs
```typescript
GET /vtid/recent?limit=25
Response: Array<{
  label: string,
  color: string,
  layer: string,
  module: string,
  global_number: number,
  sub_number: number,
  title: string,
  created_at: string
}>
```

## Testing in Read-Only Mode

1. **Start the app:**
   ```bash
   npm run dev
   ```

2. **Navigate to** `http://localhost:5173/`

3. **Click "Vitana DEV"** card to enter Dev Hub

4. **Sign in** with email magic link or Google

5. **Observe the dashboard:**
   - If gateway is unavailable: soft warning banner appears
   - Events panel shows empty state
   - VTID panel shows "Awaiting endpoint activation"
   - Command console buttons are disabled with tooltips

## Phase 2 Enablement Checklist

- [ ] Backend confirms `/events/recent` and `/vtid/recent` live
- [ ] Flip `VITE_DEV_HUB_READONLY=false` (in preview only)
- [ ] Wire "Emit Test Event" button to `POST /events/ingest`
- [ ] Wire "Issue VTID" to `POST /vtid/issue`
- [ ] Add command approval flow
- [ ] Add real-time WebSocket updates (optional)

## Security Notes

- No secrets in code (all via environment variables)
- Auth via Supabase only
- Read-only mode prevents accidental writes
- All API calls gracefully handle errors

## Accessibility

- Keyboard navigation support
- ARIA labels on interactive elements
- Focus states on all buttons
- Semantic HTML structure
- Responsive design (mobile + desktop)

## Performance

- Auto-refresh intervals:
  - Events: 10 seconds
  - VTIDs: 30 seconds
- Graceful degradation for missing endpoints
- Minimal re-renders with React Query caching

## Handover to Backend Team

The frontend is ready to consume the following endpoints once available:
1. `GET /events/health`
2. `GET /events/recent?limit=25&tenant=system`
3. `GET /vtid/recent?limit=25`

For Phase 2:
4. `POST /events/ingest` (emit test events)
5. `POST /vtid/issue` (issue new VTIDs)

No database schema changes required from frontend.
