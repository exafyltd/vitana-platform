# Command Hub Architecture

> Command Hub: real-time operator/developer dashboard with SSE event streaming, OASIS Operator AI chat, vanilla JS frontend, and resilient connection management.

## Content

### Overview

The Command Hub is Vitana's real-time event monitoring and operator chat interface for the DEV platform. It provides live streaming of system events via [[sse-event-streaming|Server-Sent Events (SSE)]] and a chat interface with the OASIS Operator AI. The frontend is built with vanilla JavaScript (not React) and state is managed via Zustand.

### Backend Endpoints

All endpoints are served from: `https://oasis-operator-86804897789.us-central1.run.app`

**Events API:**
- `GET /api/v1/events` -- paginated event history with cursor, limit (default 50), hours (default 72), and filters for layer, status, module, VTID
- `GET /api/v1/events/stream` -- SSE stream for live events

**Operator Chat API:**
- `POST /api/v1/chat` -- send message with optional VTID, topic, urgency; returns reply with follow-ups and links
- `GET /api/v1/chat/thread?vtid=<vtid>` -- get thread history for a VTID

Event layers: CICDL, AICOR, AGENT, GATEWAY, OASIS. Status levels: info, success, warn, error.

### State Management (Zustand)

Store at `src/state/commandHubStore.ts`:
- `events` -- deduplicated, sorted newest-first
- `nextCursor` -- for infinite scroll pagination
- `filters` -- active filter state (layer, status, module, VTID)
- `streaming` -- SSE connection status
- `paused` -- user paused live updates
- `activeVTID` -- currently selected VTID
- `threads` -- chat history by VTID

### SSE Connection (`src/lib/useSSE.ts`)

- EventSource with automatic reconnection
- Exponential backoff: 1s -> 2s -> 4s -> max 30s
- Tracks failures and triggers fallback prompt after 3 failures
- Optional polling fallback (5-second interval)
- Session persistence via `sessionStorage` for filters and VTID selection

### Features

1. **Real-Time Event Stream** -- SSE with auto-reconnection, pause/resume with event buffering
2. **Event Filtering** -- by layer, status, module, VTID; persisted across reloads
3. **Infinite Scroll** -- cursor-based pagination, loads older events at top 10% scroll
4. **Operator Chat** -- VTID-aware conversations, slash commands (`/task`, `/status`)
5. **Event Detail Drawer** -- click to view full event data, VTID clickable to load thread
6. **Error Handling** -- 401 "Session expired" toast, 404 "No thread history", SSE failure banner with fallback

### Canonical Source & Build

Per governance rule `GOV-FRONTEND-CANONICAL-SOURCE-0001`:

- **Source directory:** `services/gateway/src/frontend/command-hub/` (index.html, styles.css, app.js)
- **Build output:** `services/gateway/dist/frontend/command-hub/`
- **Deployment:** `npm run build` in gateway, then `deploy-service.sh gateway services/gateway`
- No other directory may contain Command Hub UI files
- No sibling or shadow directories allowed

### Authentication

- All API calls include JWT via `credentials: "include"`
- EventSource uses `withCredentials: true` for cookie-based auth
- SSE does not support custom headers; two options are cookie-based auth (current) or SSE proxy

### Reconnection Issues

The Command Hub experienced a critical reconnection failure where, after initial disconnection, it remained permanently OFFLINE. Root causes included React Strict Mode double mounting (creating 60-80 duplicate connections), state desynchronization between `useSSE` and parent component, and infinite retry without circuit breaker. See [[sse-event-streaming]] for full analysis.

**Implemented fixes:** Connection Manager to track/force-close connections, Strict Mode protection with `mountedRef`, SSE Connection Monitor UI.

**Required fixes:** Circuit breaker pattern (stop retrying after max failures, switch to polling), pre-flight backend health check, user-facing "Force Reconnect" button, automatic polling fallback after 3 failures.

### Performance

- Consider `react-window` or `react-virtualized` if event lists exceed 1,000 items
- Deduplication ensures no duplicate events stored
- Target 60 FPS scroll performance

## Related Pages

- [[sse-event-streaming]]
- [[command-hub]]
- [[wallet-system]]
- [[live-rooms]]

## Sources

- `raw/command-hub/COMMAND_HUB_WIRING.md`
- `raw/command-hub/COMMAND_HUB_RECONNECTION_FAILURE_REPORT.md`
- `raw/command-hub/BUILD.md`

## Last Updated

2026-04-12
