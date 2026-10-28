# SSE Event Streaming

> Server-Sent Events (SSE) architecture at Vitana: the `/api/v1/events/stream` endpoint, connection flapping issues, diagnostic findings, and mitigation strategies.

## Content

### Overview

Vitana uses Server-Sent Events (SSE) as the primary mechanism for pushing real-time system events from the backend to browser-based dashboards, most notably the [[command-hub-architecture|Command Hub]]. The canonical SSE endpoint is:

```
GET /api/v1/events/stream
Content-Type: text/event-stream
```

Each event payload is JSON containing fields: `id`, `ts`, `vtid`, `layer`, `module`, `kind`, `status`, `title`, `data`, and optional `links`.

### SSE Protocol Requirements

The backend must send correct HTTP headers for SSE to function:

- `Content-Type: text/event-stream` (mandatory)
- `Cache-Control: no-cache, no-transform` (prevents buffering)
- `Connection: keep-alive` (keeps HTTP/1.1 connection open)
- `X-Accel-Buffering: no` (disables nginx buffering)
- CORS headers with `Access-Control-Allow-Credentials: true`

Data format rules:
- Each message starts with `data: ` followed by JSON
- Messages end with two newlines (`\n\n`)
- Keep-alive heartbeats (comment lines starting with `:`) must be sent every 15-30 seconds to prevent proxy/browser timeouts

### Connection Flapping (Critical Production Issue)

A critical production issue was diagnosed on 2025-11-01 where the Command Hub SSE stream experienced **connection flapping**: the EventSource connected successfully (`readyState: 1`), then immediately closed (`readyState: 2`), repeating 5+ times within 5-10 seconds.

**Symptoms:**
- Toast notification spam ("Reconnected" / "Connection Lost" cycling)
- Status indicator flickering green-red rapidly
- Excessive reconnection attempts and backend load
- Circuit breaker activation, forcing fallback to polling mode

**Root causes identified:**
1. Missing SSE heartbeats -- browsers/proxies close idle streams after 30-60 seconds
2. Malformed SSE data (missing double newlines, invalid JSON)
3. Backend handler timeout or crash closing the connection
4. Proxy/load balancer timeout on long-running requests
5. Incomplete SSE response headers

### Reconnection Failure

A separate but related issue was the failure to reconnect automatically after disconnection, leaving the Command Hub in a permanent OFFLINE state.

**Root causes:**
- React 18 Strict Mode double mounting creating duplicate EventSource connections (user reported 60-80 sessions running)
- State desynchronization between `useSSE` hook and parent LiveConsole component
- Exponential backoff without circuit breaker -- retries every 30 seconds indefinitely with no user feedback
- No pre-flight backend health check before reconnection attempts
- EventSource browser API provides no error details (`onerror` event is opaque)

### Frontend Mitigations Applied

1. **Toast debouncing** -- 3-second cooldown between toasts
2. **Flapping detection** -- logs warning after 5 rapid state transitions
3. **Enhanced diagnostics** -- logs readyState, time-since-success, failure patterns
4. **Status change tracking** -- toasts only on actual state transitions
5. **Circuit breaker** -- falls back to polling after 10 failed attempts
6. **Connection Manager** -- tracks and force-closes all SSE connections to prevent leaks
7. **React Strict Mode protection** -- `mountedRef` prevents double mounting

### Proxy Configuration

For nginx, the SSE location block requires:
- `proxy_buffering off`
- `proxy_cache off`
- `proxy_read_timeout 1h`
- `chunked_transfer_encoding on`

For Cloud Run / GCP, the SSE endpoint needs extended deadlines (up to 3600s).

### Authentication

The frontend uses `EventSource({ withCredentials: true })` with cookie-based authentication. The backend must validate session cookies on initial handshake and return `401 Unauthorized` for invalid sessions rather than hanging or returning an empty stream.

### Success Criteria

- Only ONE "SSE connected successfully" log per session
- Connection stays open for 5+ minutes continuously
- Average stream duration greater than 10 minutes
- Reconnection rate less than 1 per hour
- Zero flapping incidents (5+ transitions in 10 seconds)

## Related Pages

- [[command-hub-architecture]]
- [[command-hub]]
- [[webrtc-integration]]

## Sources

- `raw/communication/BACKEND_SSE_DIAGNOSTIC_REPORT.md`
- `raw/command-hub/COMMAND_HUB_WIRING.md`
- `raw/command-hub/COMMAND_HUB_RECONNECTION_FAILURE_REPORT.md`

## Last Updated

2026-04-12
