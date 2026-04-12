# Command Hub Wiring Documentation

## Overview

The Command Hub is a real-time event monitoring and operator chat interface for the Vitana DEV platform. It provides live streaming of system events via Server-Sent Events (SSE) and a chat interface with the OASIS Operator AI.

## Environment Variables

Configure these in your `.env` file:

```bash
# Events API base URL
VITE_EVENTS_BASE_URL=/api/v1

# Operator chat API base URL  
VITE_OPERATOR_BASE_URL=/api/v1

# Default history timeframe in hours (default: 72)
VITE_DEFAULT_HISTORY_HOURS=72

# Feature flag to enable/disable chat (default: true)
VITE_COMMAND_HUB_CHAT_ENABLED=true
```

## Backend Endpoints

All endpoints are currently served from:
`https://oasis-operator-86804897789.us-central1.run.app`

### Events API

**1. Get Event History**
```
GET /api/v1/events
Query Parameters:
  - cursor?: string (pagination cursor)
  - limit?: number (default: 50)
  - hours?: number (default: 72)
  - layer?: Layer (CICDL | AICOR | AGENT | GATEWAY | OASIS)
  - status?: Status (info | success | warn | error)
  - module?: string
  - vtid?: string

Response:
{
  items: Event[],
  next_cursor?: string
}
```

**2. Stream Events (SSE)**
```
GET /api/v1/events/stream
Content-Type: text/event-stream

Each event payload (JSON):
{
  id: string,
  ts: string (ISO timestamp),
  vtid?: string,
  layer: Layer,
  module?: string,
  kind: string,
  status: Status,
  title: string,
  data?: object,
  links?: { label: string, href: string }[]
}
```

### Operator Chat API

**1. Send Message**
```
POST /api/v1/chat
Headers: 
  Content-Type: application/json
  Authorization: Bearer <JWT>

Body:
{
  message: string,
  vtid?: string,
  topic?: string,
  urgency?: "low" | "normal" | "high"
}

Response:
{
  vtid: string,
  reply: string,
  followups?: string[],
  links?: { label: string, href: string }[]
}
```

**2. Get Thread History**
```
GET /api/v1/chat/thread?vtid=<vtid>
Headers:
  Authorization: Bearer <JWT>

Response:
{
  vtid: string,
  items: ChatItem[]
}

ChatItem:
{
  role: "user" | "operator",
  ts: string,
  text: string,
  links?: { label: string, href: string }[],
  meta?: object
}
```

## Architecture

### State Management (Zustand)

**Store: `src/state/commandHubStore.ts`**

```typescript
interface State {
  events: Event[]           // Deduplicated, sorted newest-first
  nextCursor?: string       // For infinite scroll pagination
  filters: Filters          // Active filter state
  streaming: boolean        // SSE connection status
  paused: boolean          // User paused live updates
  activeVTID?: string      // Currently selected VTID
  threads: Record<string, ChatThread>  // Chat history by VTID
}
```

### SSE Connection

**Hook: `src/lib/useSSE.ts`**

- Establishes EventSource connection with automatic reconnection
- Exponential backoff: 1s → 2s → 4s → max 30s
- Tracks connection failures and triggers fallback prompt after 3 failures
- Supports optional polling fallback (5s interval)

### Session Persistence

The following state is saved to `sessionStorage`:
- Active filters (layer, status, module, VTID)
- Active VTID selection
- Restored automatically on page reload

## Features

### 1. Real-Time Event Stream
- SSE connection for live events
- Automatic reconnection with exponential backoff
- Optional 5s polling fallback if SSE repeatedly fails
- Pause/resume with event buffering

### 2. Event Filtering
- Filter by: layer, status, module, VTID
- Filters applied to both history and streaming events
- Persisted across page reloads

### 3. Infinite Scroll
- Loads older events when scrolled to top 10%
- Cursor-based pagination
- Maintains scroll position during load

### 4. Operator Chat
- VTID-aware conversations
- Auto-creates VTID if none selected
- Thread history loading
- Slash command support: `/task`, `/status`

### 5. Event Detail Drawer
- Click any event to view full details
- Shows: title, timestamp, data, links, metadata
- VTID clickable to load chat thread

### 6. Error Handling
- **401 errors**: "Session expired" toast
- **404 errors**: "No thread history yet" message
- **SSE failures**: Banner with fallback option
- Graceful degradation throughout

## Slash Commands

Users can type natural language or use shortcuts:

```bash
/task <description>
  → Creates new task with Operator

/status <VTID>
  → Queries status of specific VTID
  → Example: /status VTID-2025-0001
```

## Testing & QA Script

### 1. Initial Load Test
```
✓ Navigate to Command Hub
✓ History loads (last 72h)
✓ Status shows "LIVE"
✓ Events display with correct badges
```

### 2. Real-Time Updates
```
✓ Keep page open
✓ Backend sends new event (e.g., telemetry.smoke)
✓ Event appears in list within ≤5s
✓ No page refresh required
```

### 3. Chat Functionality
```
✓ Type: "Set up weekly pipeline audit every Monday 09:00"
✓ Operator replies within seconds
✓ New VTID badge appears
✓ Events show: chat.message.in, chat.message.out, task.created
```

### 4. VTID Thread Loading
```
✓ Click event with VTID
✓ Right panel loads full conversation thread
✓ Input focuses automatically
✓ Can reply within thread context
```

### 5. Pause/Resume
```
✓ Click Pause checkbox
✓ New events buffer (badge shows "N new")
✓ Click Pause again to resume
✓ Buffered events flush into list
```

### 6. Filters
```
✓ Select layer filter (e.g., "OASIS")
✓ Event list updates immediately
✓ Streaming events respect filter
✓ Refresh page → filter persists
```

### 7. Run Smoke Test
```
✓ Click "Run Smoke" button
✓ Toast: "Smoke test sent ✓"
✓ Within ≤5s: telemetry.smoke event appears
✓ Toast: "Smoke test received ✓"
```

### 8. Network Resilience
```
✓ Disconnect network for 10s
✓ Status changes to "RECONNECTING"
✓ Reconnect network
✓ Status returns to "LIVE"
✓ No events lost
```

### 9. SSE Failure Fallback
```
✓ Simulate 3+ SSE failures
✓ Yellow banner appears: "Enable 5s refresh fallback?"
✓ Click "Yes"
✓ Badge shows "POLLING"
✓ Events continue arriving via polling
```

### 10. Session Persistence
```
✓ Set filters, select VTID
✓ Refresh page
✓ Filters restored
✓ VTID selection restored
```

### 11. Accessibility
```
✓ Navigate event list with Tab
✓ Activate events with Enter/Space
✓ Chat input maintains focus after send
✓ aria-live regions announce updates
```

### 12. Event Detail Drawer
```
✓ Click any event
✓ Drawer opens from right
✓ Shows: title, timestamp, kind, layer, module, VTID, data, links
✓ Click outside or X to close
```

## Runtime Setup & Configuration

### Environment Variables Setup

The Command Hub requires the following environment variables in `.env`:

```env
# Command Hub Configuration
VITE_EVENTS_BASE_URL=https://oasis-operator-86804897789.us-central1.run.app/api/v1
VITE_OPERATOR_BASE_URL=https://oasis-operator-86804897789.us-central1.run.app/api/v1
VITE_DEFAULT_HISTORY_HOURS=72
VITE_COMMAND_HUB_CHAT_ENABLED=true

# Legacy Dev Hub Configuration (for backward compatibility)
VITE_DEV_HUB_ENABLED=true
VITE_DEV_HUB_READONLY=true
VITE_GATEWAY_BASE=https://oasis-operator-86804897789.us-central1.run.app
VITE_DEVHUB_SSE_BASE=https://oasis-operator-86804897789.us-central1.run.app
```

### Backend Connection Verification

Test the backend is reachable:

```bash
# Test events endpoint
curl -s https://oasis-operator-86804897789.us-central1.run.app/api/v1/events | head

# Test SSE stream (should keep connection open)
curl -N https://oasis-operator-86804897789.us-central1.run.app/api/v1/events/stream
```

Expected response format:
```json
{
  "items": [
    {
      "id": "evt_123",
      "vtid": "VTID-2025-0001",
      "ts": "2025-01-30T10:30:00Z",
      "kind": "telemetry.smoke",
      "layer": "infra",
      "status": "SUCCESS",
      "title": "Smoke test completed",
      "data": {}
    }
  ],
  "next_cursor": "cursor_token_here"
}
```

### CORS Configuration

The backend must have CORS enabled for the frontend domain:

```python
# FastAPI example
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Or specific domains
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### SSE Authentication

EventSource doesn't support custom headers. Two options:

1. **Cookie-based auth** (recommended): Backend sets HttpOnly cookies on login
2. **SSE Proxy**: Frontend server proxies SSE with auth headers injected server-side

Current implementation uses `withCredentials: true` for cookie-based auth.

## Performance Notes

- **Virtualization**: Consider implementing `react-window` or `react-virtualized` if event lists regularly exceed 1000 items
- **Memory**: Deduplication ensures no duplicate events stored
- **Scroll Performance**: Target 60 FPS; monitor with Chrome DevTools Performance tab

## Security

- **Authentication**: All API calls include JWT via `credentials: "include"`
- **No client-side secrets**: All sensitive operations happen server-side
- **XSS Protection**: Event data is sanitized before rendering
- **CORS**: Configured for `withCredentials: true` on SSE

## Troubleshooting

### SSE Not Connecting
1. Check `VITE_EVENTS_BASE_URL` is correct
2. Verify JWT is valid and not expired
3. Check browser console for CORS errors
4. Confirm backend SSE endpoint is accessible

### Chat Not Sending
1. Check `VITE_OPERATOR_BASE_URL` is correct
2. Verify `VITE_COMMAND_HUB_CHAT_ENABLED=true`
3. Check for 401/403 authentication errors
4. Confirm backend `/api/v1/chat` endpoint is live

### Events Not Filtering
1. Clear sessionStorage: `sessionStorage.clear()`
2. Refresh page
3. Re-apply filters

### Performance Issues
1. Check event count: `console.log(useCommandHub.getState().events.length)`
2. If >1000, consider implementing virtualization
3. Monitor with React DevTools Profiler

## Feature Flags

### Disable Chat
```bash
VITE_COMMAND_HUB_CHAT_ENABLED=false
```
This hides the Operator Chat panel entirely, showing only Live Console.

## Future Enhancements

- [ ] Virtualized event list (react-window)
- [ ] Advanced search/query syntax
- [ ] Export events to CSV/JSON
- [ ] Event bookmarking
- [ ] Multi-VTID comparison view
- [ ] Custom event kind color mapping
- [ ] Audio notifications for critical events
- [ ] Dark mode optimizations

## Support

For issues or questions:
- Check browser console for errors
- Review network tab for failed requests
- Contact: dev-support@vitana.io
- Docs: https://docs.vitana.io/command-hub
