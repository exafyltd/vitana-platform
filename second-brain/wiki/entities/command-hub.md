# Command Hub

> The Command Hub is Vitana's operator and developer dashboard for real-time system event monitoring and AI-assisted operations via the OASIS Operator.

## Content

### What It Is

The Command Hub is a browser-based dashboard that gives operators and developers a live view of everything happening across the Vitana platform. It combines a real-time event console with an AI chat interface (OASIS Operator) for managing tasks, investigating issues, and monitoring system health.

### What Operators See

**Live Console (left panel):**
- A real-time feed of system events streamed via SSE from `/api/v1/events/stream`
- Events display with color-coded badges by layer (CICDL, AICOR, AGENT, GATEWAY, OASIS) and status (info, success, warn, error)
- Connection status indicator: LIVE (green), RECONNECTING, OFFLINE, or POLLING
- Pause/resume button that buffers events while paused, showing a "N new" badge
- Filters by layer, status, module, and VTID that persist across page reloads
- Infinite scroll to load historical events (default: last 72 hours)
- Click any event to open a detail drawer showing full data, timestamps, links, and metadata

**Operator Chat (right panel):**
- Chat with the OASIS Operator AI, aware of VTID context
- Slash commands: `/task <description>` (create task), `/status <VTID>` (query status)
- Thread history organized by VTID
- Clicking a VTID in any event loads the related chat thread

**Smoke Test:**
- "Run Smoke" button sends a test event; within 5 seconds `telemetry.smoke` should appear in the feed

### Publish Workflow

1. Edit source files in `services/gateway/src/frontend/command-hub/` (index.html, styles.css, app.js)
2. Build: `cd ~/vitana-platform/services/gateway && npm run build`
3. Deploy: `cd ~/vitana-platform && ./scripts/deploy/deploy-service.sh gateway services/gateway`
4. Build output lands in `services/gateway/dist/frontend/command-hub/`

### Layout Rules

- The frontend is vanilla JavaScript with Zustand for state, not React
- Source must only exist at `services/gateway/src/frontend/command-hub/` per governance rule `GOV-FRONTEND-CANONICAL-SOURCE-0001`
- No sibling or shadow directories permitted
- No alternate command-hub paths, no moving the source, no deleting backups
- Express static mounts must not be modified

### Configuration

Environment variables (`.env`):
- `VITE_EVENTS_BASE_URL` -- Events API base (default `/api/v1`)
- `VITE_OPERATOR_BASE_URL` -- Operator chat API base (default `/api/v1`)
- `VITE_DEFAULT_HISTORY_HOURS` -- History window (default 72)
- `VITE_COMMAND_HUB_CHAT_ENABLED` -- Feature flag to enable/disable chat panel (default true)

### Error States

- **401:** "Session expired" toast
- **404:** "No thread history yet" message in chat
- **SSE failure:** Yellow banner offering "Enable 5s refresh fallback?" with POLLING badge
- **Network disconnect:** Status changes to RECONNECTING, then recovers to LIVE

### Accessibility

- Tab navigation through event list
- Enter/Space to activate events
- Chat input maintains focus after send
- `aria-live` regions announce updates

## Related Pages

- [[command-hub-architecture]]
- [[sse-event-streaming]]
- [[wallet-system]]

## Sources

- `raw/command-hub/COMMAND_HUB_WIRING.md`
- `raw/command-hub/BUILD.md`
- `raw/command-hub/COMMAND_HUB_RECONNECTION_FAILURE_REPORT.md`

## Last Updated

2026-04-12
