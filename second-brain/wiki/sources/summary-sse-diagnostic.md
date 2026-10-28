# Summary: SSE Diagnostic Report

> Summary of the backend SSE diagnostic report documenting connection flapping on the `/api/v1/events/stream` endpoint.

## Content

### Document Overview

**Source:** `raw/communication/BACKEND_SSE_DIAGNOSTIC_REPORT.md`
**Date:** 2025-11-01
**Severity:** Critical -- production issue
**Component:** SSE Stream (`/api/v1/events/stream`)

### Problem Statement

The Command Hub SSE stream experienced connection flapping: EventSource connects (fires `onopen` with `readyState: 1`), then immediately closes (fires `onerror` with `readyState: 2`), repeating 5+ times within 5-10 seconds. The connection closes within less than 5 seconds of opening with no client-side abort.

### Impact

- Toast notification spam (5 "Reconnected" toasts in 5 seconds)
- Status indicator flickering green/red rapidly
- Excessive reconnection attempts causing backend resource waste
- Circuit breaker activation forcing fallback to polling mode

### Root Causes

1. **Missing SSE heartbeats** -- browsers close idle streams after 30-45 seconds without data
2. **Malformed SSE data** -- invalid format causes EventSource error and close
3. **Backend timeout/crash** -- handler dies, closing the connection
4. **Proxy/load balancer timeout** -- intermediate proxy kills long-running requests
5. **Missing required headers** -- incomplete SSE response headers

### Key Requirements Documented

The report specifies a comprehensive backend requirements checklist:
- Required HTTP headers (Content-Type, Cache-Control, Connection, X-Accel-Buffering, CORS)
- SSE data format rules (data prefix, JSON on same line, double newline terminator)
- Keep-alive heartbeats every 15-30 seconds
- Proper stream handler lifecycle with async/await, error handling, and graceful disconnect
- Nginx proxy configuration (`proxy_buffering off`, `proxy_read_timeout 1h`)
- Cloud Run / GCP extended deadlines
- Cookie-based session authentication with `withCredentials: true`

### Frontend Mitigations Already Applied

1. Toast debouncing (3-second cooldown)
2. Flapping detection (logs after 5 rapid transitions)
3. Enhanced diagnostics (readyState, time-since-success, failure patterns)
4. Status change tracking (toasts only on actual transitions)
5. Circuit breaker (polling fallback after 10 failed attempts)

### Priority Actions

- **P0 (fix today):** Add `Content-Type: text/event-stream`, add 15s heartbeat, verify SSE format, check proxy timeouts
- **P1 (fix this week):** Error handling to prevent stream crash, connection lifecycle logging, concurrent client testing
- **P2 (ongoing):** SSE monitoring/alerting, documentation, load testing, WebSocket upgrade path consideration

### Success Metrics

- Average stream duration greater than 10 minutes
- Reconnection rate less than 1 per hour
- Zero flapping incidents

## Related Pages

- [[sse-event-streaming]]
- [[command-hub-architecture]]
- [[command-hub]]
- [[summary-command-hub-wiring]]

## Sources

- `raw/communication/BACKEND_SSE_DIAGNOSTIC_REPORT.md`

## Last Updated

2026-04-12
