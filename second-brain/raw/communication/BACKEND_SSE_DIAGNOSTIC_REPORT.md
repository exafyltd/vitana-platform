# SSE Connection Flapping - Backend Diagnostic Report

**Date**: 2025-11-01  
**Severity**: 🔴 **CRITICAL** - Production Issue  
**Component**: SSE Stream (`/api/v1/events/stream`)  
**Status**: Connection flapping causing rapid connect/disconnect cycles

---

## Executive Summary

The Command Hub SSE stream is experiencing **connection flapping**: the EventSource connects successfully (fires `onopen`), then immediately closes (fires `onerror`), repeating 5+ times within 5-10 seconds. This causes:

1. ❌ **Toast notification spam** - Users see "✅ Reconnected" toast 5 times in 5 seconds, then "⚠️ Connection Lost" repeatedly
2. ❌ **Poor UX** - Status indicator flickers green→red→green→red rapidly
3. ❌ **Resource waste** - Excessive reconnection attempts, health checks, and backend load
4. ❌ **Unreliable streaming** - Circuit breaker activates, forcing fallback to polling mode

---

## Root Cause Analysis

### Primary Issue: Backend SSE Stream Instability

The frontend diagnostic logs show:
```
✅ SSE connected successfully (readyState: 1, URL: /api/v1/events/stream?key=X)
⚠️ SSE error (attempt 1/10)
   ReadyState: 2 (CLOSED)
   Time since last success: 847ms
   ⚠️ RAPID FAILURE: Connection closed within 5s - likely BACKEND ISSUE
```

**Key Indicators:**
- Connection succeeds (`readyState: 1` = OPEN)
- Stream closes within **<5 seconds** of opening
- Pattern repeats 5+ times rapidly
- No client-side abort or intentional disconnect

### Why This Happens

EventSource connections close prematurely when:

1. **Missing SSE Heartbeats** - Browser closes idle streams after 30-45s without data
2. **Malformed SSE Data** - Invalid format causes EventSource to error and close
3. **Backend Timeout/Crash** - Handler dies or times out, closing the connection
4. **Proxy/Load Balancer Timeout** - Intermediate proxy kills long-running requests
5. **Missing Required Headers** - Incomplete SSE response headers

---

## Backend Requirements Checklist

### ✅ 1. Required HTTP Response Headers

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
Access-Control-Allow-Origin: [frontend-origin]
Access-Control-Allow-Credentials: true
X-Accel-Buffering: no
```

**Critical:**
- `Content-Type: text/event-stream` - **MANDATORY** for SSE
- `Cache-Control: no-cache, no-transform` - Prevents caching/buffering
- `X-Accel-Buffering: no` - Disables nginx buffering (if behind nginx)
- `Connection: keep-alive` - Keeps HTTP/1.1 connection open
- CORS headers must match exactly (credentials enabled)

### ✅ 2. SSE Data Format

**Correct Format:**
```
data: {"id":"evt_123","kind":"system.health","status":"info"}\n\n
```

**Rules:**
- Each message starts with `data: `
- JSON on same line (or use multiple `data:` lines)
- End with **two newlines** (`\n\n`)
- Field names: `event:`, `data:`, `id:`, `retry:` only

**Common Errors:**
```
❌ data: {"incomplete": 
❌ data: {invalid json}
❌ data: missing double newline
✅ data: {"valid":"json"}\n\n
```

### ✅ 3. Keep-Alive Heartbeats

**REQUIRED**: Send a comment or data every **15-30 seconds** to prevent timeout:

```python
# Python example
async def sse_stream():
    while True:
        # Send event or heartbeat
        yield f"data: {json.dumps(event)}\n\n"
        await asyncio.sleep(15)  # Heartbeat interval
        
        # Or send SSE comment (keeps connection alive without data)
        yield ": heartbeat\n\n"
```

**Why:**
- Browsers/proxies close idle connections after 30-60s
- Heartbeats prove the stream is still active
- Use comments (`:`) to avoid sending fake events

### ✅ 4. Stream Handler Lifecycle

```python
# Pseudo-code for proper SSE handler
async def events_stream(request):
    # 1. Validate session/auth
    user = authenticate(request)
    
    # 2. Send headers immediately
    response = Response(
        content_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )
    
    # 3. Start streaming
    try:
        while True:
            # Check for new events
            events = await db.get_new_events(user)
            for event in events:
                yield f"data: {json.dumps(event)}\n\n"
            
            # Heartbeat every 15s
            await asyncio.sleep(15)
            yield ": heartbeat\n\n"
            
    except asyncio.CancelledError:
        # Client disconnected - clean up
        logger.info(f"Client {user.id} disconnected")
    except Exception as e:
        # Log but don't crash
        logger.error(f"SSE error: {e}")
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
```

**Key Points:**
- Flush response immediately after sending headers
- Use async/await for efficient concurrent connections
- Handle client disconnect gracefully
- Log errors but don't let one client crash the stream
- Always send properly formatted SSE data

### ✅ 5. Proxy/Load Balancer Configuration

If behind **nginx**, add to location block:
```nginx
location /api/v1/events/stream {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    
    # SSE-specific
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    chunked_transfer_encoding on;
}
```

If behind **Cloud Run / GCP**:
```yaml
# app.yaml or equivalent
handlers:
  - url: /api/v1/events/stream
    script: auto
    # Increase timeout for SSE
    http_headers:
      X-Accel-Buffering: "no"
    # Set timeout to max
    deadline: 3600s
```

### ✅ 6. Session/Auth Requirements

The frontend now sends **`credentials: 'include'`** and uses **`EventSource({ withCredentials: true })`**.

Backend MUST:
1. Accept session cookies in SSE request
2. Validate session on initial handshake (before starting stream)
3. Return `401 Unauthorized` if session invalid (don't hang or return empty stream)
4. Set `Access-Control-Allow-Credentials: true` in CORS headers

---

## Testing Checklist

### Manual Testing

```bash
# 1. Test SSE endpoint directly
curl -N -H "Cookie: session=YOUR_SESSION" \
  https://YOUR_BACKEND/api/v1/events/stream

# Expected: Should stay open and send data/heartbeats every 15-30s

# 2. Check response headers
curl -I -H "Cookie: session=YOUR_SESSION" \
  https://YOUR_BACKEND/api/v1/events/stream

# Expected:
# Content-Type: text/event-stream
# Cache-Control: no-cache
# Connection: keep-alive

# 3. Test heartbeat timing
curl -N -H "Cookie: session=YOUR_SESSION" \
  https://YOUR_BACKEND/api/v1/events/stream | \
  while IFS= read -r line; do echo "$(date +%s) $line"; done

# Expected: New line every 15-30s (heartbeat interval)
```

### Frontend Diagnostics

After deploying backend fix, check browser console for:

```
✅ SSE connected successfully (readyState: 1)
[SSE Status] CONNECTED (transition #1)
✅ SSE connected successfully (readyState: 1)  ← Should NOT repeat rapidly
```

**Success Criteria:**
- ✅ Only ONE "SSE connected successfully" log
- ✅ No "RAPID FAILURE" errors
- ✅ No "SSE FLAPPING DETECTED" errors
- ✅ Connection stays open for 5+ minutes
- ✅ Toast shows "✅ Reconnected" only once (or never on first load)

---

## Frontend Mitigations (Already Applied)

To prevent toast spam while backend is fixed:

1. ✅ **Toast Debouncing** - 3-second cooldown between toasts
2. ✅ **Flapping Detection** - Logs "🚨 SSE FLAPPING DETECTED" after 5 rapid transitions
3. ✅ **Enhanced Diagnostics** - Logs readyState, time-since-success, and failure patterns
4. ✅ **Status Change Tracking** - Only shows toast on actual state transitions
5. ✅ **Circuit Breaker** - Falls back to polling after 10 failed attempts

**Result:** Toasts won't spam anymore, but underlying connection flapping must still be fixed.

---

## Expected Backend Behavior

### Scenario 1: Fresh Connection
```
1. Client: EventSource('/api/v1/events/stream', {withCredentials: true})
2. Backend: Validate session, return 200 + headers
3. Backend: Send initial event (optional): data: {"status":"connected"}\n\n
4. Backend: Enter loop: send events or heartbeats every 15-30s
5. Connection stays open indefinitely
```

### Scenario 2: No New Events
```
1. Client connects
2. Backend validates, starts stream
3. No events in queue
4. Backend sends heartbeat: ": keepalive\n\n" (every 15-30s)
5. Client receives nothing (invisible comment), keeps connection open
```

### Scenario 3: Client Disconnect
```
1. User closes tab or navigates away
2. Frontend calls sseManager.closeAll()
3. EventSource closes connection
4. Backend detects disconnect (CancelledError or broken pipe)
5. Backend cleans up resources, logs disconnect
```

### Scenario 4: Backend Error
```
1. Connection open, streaming fine
2. Backend encounters error (DB down, etc.)
3. Backend sends error event: event: error\ndata: {"error":"DB unavailable"}\n\n
4. Backend continues heartbeats (does NOT close connection)
5. Frontend logs error but stays connected
```

---

## Priority Actions

### Immediate (P0 - Fix Today)
1. ✅ Add `Content-Type: text/event-stream` header
2. ✅ Add heartbeat every 15 seconds
3. ✅ Verify SSE data format (double newline)
4. ✅ Check proxy/load balancer timeout settings

### High Priority (P1 - Fix This Week)
1. Add error handling to prevent stream crash
2. Add connection lifecycle logging
3. Test with concurrent clients (100+ connections)
4. Monitor stream duration metrics (avg time before close)

### Medium Priority (P2 - Ongoing)
1. Add SSE-specific monitoring/alerting
2. Document SSE implementation in backend docs
3. Add load testing for SSE endpoint
4. Consider WebSocket upgrade path for future

---

## Contact & Verification

**Frontend Status:** Mitigations applied, diagnostics enhanced  
**Backend Status:** ⏳ Awaiting fixes  

**To Verify Fix:**
1. Deploy backend changes
2. Open Command Hub in browser
3. Open DevTools console
4. Look for `✅ SSE connected successfully` (should appear only once)
5. Wait 5 minutes - connection should stay green
6. Check for `[SSE Status] CONNECTED` logs (should be ONE transition)
7. No "RAPID FAILURE" or "FLAPPING DETECTED" errors

**Success Metrics:**
- Average stream duration: >10 minutes
- Reconnection rate: <1 per hour (normal network issues)
- Zero flapping incidents (5+ transitions in 10s)

---

## Appendix: EventSource States

```
0 = CONNECTING - Initial handshake in progress
1 = OPEN       - Connected and receiving events ✅
2 = CLOSED     - Connection closed (error or intentional)
```

When backend closes stream prematurely:
```
[Time 0s]   readyState: 0 (CONNECTING)
[Time 1s]   readyState: 1 (OPEN) ← onopen fires
[Time 2s]   readyState: 2 (CLOSED) ← onerror fires, connection died
[Time 3s]   readyState: 0 (CONNECTING) ← auto-reconnect
[Time 4s]   readyState: 1 (OPEN)
[Time 5s]   readyState: 2 (CLOSED) ← flapping pattern
```

**Goal:** Stay at readyState 1 indefinitely.

---

## References

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [EventSource Specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [SSE Format Examples](https://www.w3.org/TR/eventsource/#event-stream-interpretation)

---

**END OF REPORT**

Please address the items in the "Immediate (P0)" section first, then test with the frontend diagnostics. The enhanced logging will help identify any remaining issues.
