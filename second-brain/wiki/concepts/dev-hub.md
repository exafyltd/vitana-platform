# Dev Hub

> The Vitana DEV Hub: a developer command center for observing platform events, managing VTIDs, and issuing commands, with its auth flow and implementation status.

## Content

### Purpose

The Dev Hub is a developer-facing command center embedded in the vitana-v1 frontend app. It provides:

- Real-time platform event observation (via OASIS)
- VTID assignment viewing and management
- Command console for issuing platform commands (Phase 2)
- Configuration and settings viewer

### Feature Flags

```bash
VITE_DEV_HUB_ENABLED=true          # Enable/disable entire Dev Hub
VITE_DEV_HUB_READONLY=true         # Phase 1: Read-only mode (commands disabled)
VITE_GATEWAY_BASE=https://vitana-gateway-86804897789.us-central1.run.app
```

### Routes

| Route | Purpose |
|-------|---------|
| `/` | Public portal with 5th card "Vitana DEV" |
| `/dev` | Redirects to `/dev/dashboard` |
| `/dev/login` | Supabase Auth (email magic link + Google) |
| `/dev/dashboard` | Command hub dashboard (read-only in Phase 1) |
| `/dev/settings` | Configuration viewer |

### Architecture

**Configuration:** `src/config/devHub.config.ts` -- feature flags and environment config.

**API Client:** `src/lib/devGatewayClient.ts` -- gateway API client with graceful error handling.

**Components:**
- `DevHubHeader.tsx` -- header with user info and navigation
- `SoftWarningBanner.tsx` -- non-blocking warning banner
- `LiveEventsPanel.tsx` -- real-time events feed (OASIS)
- `VTIDSnapshotPanel.tsx` -- VTID assignments table
- `CommandConsolePanel.tsx` -- command console (disabled in Phase 1)

**Custom Hooks:**
- `useDevEvents.ts` -- fetch and auto-refresh events (10-second interval)
- `useDevVTID.ts` -- fetch and auto-refresh VTIDs (30-second interval)

### Auth Flow and the Phase 1 Fix

A critical auth redirect bug was fixed in Phase 1 where Dev Hub users were being sent to Admin routes after login. The fix included:

1. **DevAuthGuard** (`src/components/dev/DevAuthGuard.tsx`) -- dedicated auth guard for `/dev/*` routes that redirects to `/dev/login?next=<path>` instead of the main app login.
2. **useSmartRouting** -- updated to exclude `/dev` from portal path inference, preventing the main app's smart routing from interfering.
3. **DevLogin** -- enhanced with `onAuthStateChange` handler that respects the `?next=` query parameter.
4. **App.tsx routing** -- replaced generic `AuthGuard` with `DevAuthGuard` for all Dev Hub routes.

### Backend Contracts

Phase 1 expects these gateway endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /events/health` | Health check |
| `GET /events/recent?limit=25&tenant=system` | Recent platform events |
| `GET /vtid/recent?limit=25` | Recent VTIDs |

Phase 2 will add:
- `POST /events/ingest` (emit test events)
- `POST /vtid/issue` (issue new VTIDs)

### Implementation Status

**Phase 1 (Complete):**
- Read-only shell with graceful degradation
- Auth flow with dedicated DevAuthGuard
- Events panel, VTID panel, disabled command console
- Soft warning banners for unavailable backend

**Phase 1.1 (Planned):**
- DevLayout with dedicated sidebar (10 navigation items)
- Horizontal tabs system
- Read-only panels for all Dev Hub features

**Phase 2 (Planned):**
- Backend confirms `/events/recent` and `/vtid/recent` live
- Flip `VITE_DEV_HUB_READONLY=false`
- Wire command buttons to POST endpoints
- Command approval flow
- Optional real-time WebSocket updates

## Related Pages

- [[vitana-v1]]
- [[vtid-governance]]
- [[api-gateway-pattern]]
- [[supabase]]

## Sources

- `raw/architecture/README_DEV_HUB.md`
- `raw/architecture/DEV_HUB_PHASE1_AUTH_FIX.md`

## Last Updated

2026-04-12
