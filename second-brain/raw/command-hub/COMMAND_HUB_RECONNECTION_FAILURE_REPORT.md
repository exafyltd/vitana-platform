# Command Hub Reconnection Failure Analysis Report

**Status:** CRITICAL  
**Date:** 2025-11-01  
**Component:** Command Hub SSE Streaming Infrastructure  
**Severity:** High Impact - Production System Degradation

---

## Executive Summary

The Command Hub successfully establishes an initial SSE connection (LIVE status) but **fails to automatically reconnect after disconnection**, resulting in a permanent OFFLINE state. This creates a critical operational gap where real-time event monitoring becomes unavailable without manual intervention.

**Root Cause:** Multi-layered connection lifecycle management issues with inadequate error recovery mechanisms.

---

## Technical Analysis

### 1. SSE Connection Lifecycle Issues

#### Problem: React Strict Mode Double Mounting
**Location:** `src/lib/useSSE.ts:20-62`

```typescript
useEffect(() => {
  let aborted = false;
  let backoff = 1000;

  const connect = () => {
    if (aborted) return;
    const es = new EventSource(url.trim());
    connectionIdRef.current = sseManager.register(url, es);
    // ...
  };

  connect();
  
  return () => {
    aborted = true;
    // Cleanup
  };
}, [url, onEvent, onStatus, maxBackoffMs]);
```

**Issue:**
- React 18 Strict Mode causes double mounting in development
- Creates **duplicate SSE connections** to the same endpoint
- First connection establishes (LIVE), second connection may conflict
- When unmounted, cleanup closes the active connection but the component state believes it's still connected
- **Result:** Connection shows LIVE but is actually closed, no reconnection attempts made

**Evidence:**
- User reported "60-80 SSE sessions running" - confirms connection leak
- Initial connection succeeds, but subsequent reconnection attempts fail silently

---

### 2. State Synchronization Failure

#### Problem: Disconnected State Management
**Location:** `src/components/dev/LiveConsole.tsx:89-116`

```typescript
useSSE({
  url: `${BASE_EVENTS}/events/stream`,
  onStatus: (ok) => {
    setStreaming(ok);
    backendStatus.updateSSEStatus(ok);
    if (!ok) {
      setSseFailCount(prev => prev + 1);
      if (sseFailCount >= 2 && !useFallback) {
        setShowFallbackPrompt(true);
      }
    }
  },
  onEvent: (ev: Event) => {
    // Event handling
  }
});
```

**Issue:**
- `onStatus` callback receives disconnection signal (`ok = false`)
- `setStreaming(false)` updates UI to show "RECONNECTING"
- **But:** No mechanism forces reconnection after initial failure
- The `useSSE` hook continues reconnection attempts **internally**, but parent component has no visibility
- Parent component shows "OFFLINE" while `useSSE` is still trying to reconnect in the background

**Gap:**
- No reconnection success callback to update parent state
- UI state and actual connection state become desynchronized
- User sees "OFFLINE" even when reconnection succeeds

---

### 3. Exponential Backoff Without Circuit Breaker

#### Problem: Infinite Silent Reconnection
**Location:** `src/lib/useSSE.ts:45-51`

```typescript
es.onerror = () => {
  console.warn('⚠️ SSE error, reconnecting...');
  onStatus?.(false);
  if (connectionIdRef.current) {
    sseManager.unregister(connectionIdRef.current);
    connectionIdRef.current = null;
  }
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, maxBackoffMs); // Max 30s
};
```

**Issue:**
- Exponential backoff increases to 30 seconds after 5 failed attempts
- **No maximum retry limit** - continues retrying indefinitely
- **No circuit breaker pattern** - never gives up or alerts user
- Console warnings are the only indication of continuous failure
- After 5+ failures, backoff reaches 30s, making reconnection appear "stuck"

**Impact:**
- User perception: "Connection is OFFLINE and not recovering"
- Reality: Connection attempts every 30 seconds in background, all failing
- No user-facing indication that reconnection is being attempted
- No diagnostic information about WHY reconnection is failing

---

### 4. Backend Service Degradation Masking

#### Problem: No Backend Health Validation Before Reconnect
**Location:** `src/hooks/useBackendStatus.ts:62-169`

```typescript
const testServices = useCallback(async () => {
  // Tests Events API REST endpoints
  // Tests Chat API REST endpoints
  // But: SSE Stream status is "deferred" to streaming component
  
  results.push({
    name: "SSE Stream",
    status: data.services.find(s => s.name === "SSE Stream")?.status || "DOWN",
    lastTime: data.services.find(s => s.name === "SSE Stream")?.lastTime
  });
});
```

**Issue:**
- Backend status checker runs every 30 seconds
- Validates REST API endpoints (Events API, Chat API)
- **But:** Assumes SSE status from the streaming component
- **Gap:** No independent validation that SSE endpoint is accepting connections
- If SSE endpoint is down but REST endpoints are up, shows "PARTIAL" status
- Reconnection attempts continue even when SSE endpoint is known to be down

**Missing Logic:**
- No pre-flight check before reconnection attempt
- No distinction between "network error" vs "endpoint unavailable"
- No backoff strategy adjustment based on error type

---

### 5. EventSource Browser API Limitations

#### Problem: Opaque Error Handling
**Browser Behavior:**

```typescript
es.onerror = (e) => {
  // EventSource API provides NO error details
  // Cannot distinguish:
  // - 404 Not Found
  // - 503 Service Unavailable
  // - Network timeout
  // - CORS error
  // - SSL/TLS error
  console.warn('⚠️ SSE error, reconnecting...', e); // 'e' is useless
};
```

**Issue:**
- `EventSource.onerror` event contains **no actionable error information**
- Cannot determine if error is temporary (retry) or permanent (stop)
- All errors treated the same: retry with exponential backoff
- **Result:** Wasting resources retrying when endpoint is permanently unavailable

---

## Failure Sequence Diagram

```
[Initial Connection]
User opens Command Hub
  → useSSE mounts
  → Creates EventSource("...events/stream")
  → es.onopen fires → Status: LIVE ✓
  → Events flowing normally

[Disconnection Event]
Backend SSE endpoint goes down / Network interruption
  → es.onerror fires
  → onStatus(false) called → Status: RECONNECTING
  → Connection unregistered from manager
  → setTimeout(connect, 1000) → First retry in 1s

[Reconnection Attempt #1-5]
After 1s → connect() → new EventSource()
  → es.onerror fires immediately (backend still down)
  → backoff doubles: 1s → 2s → 4s → 8s → 16s
  → UI shows "RECONNECTING" then "OFFLINE"
  → User sees no progress indication

[Terminal State - After 5 Failures]
After 16s → connect() → new EventSource()
  → es.onerror fires
  → backoff capped at 30s (maxBackoffMs)
  → Retries every 30 seconds indefinitely
  → No user notification
  → No automatic fallback to polling
  → Status stuck at "OFFLINE"
  → User must manually refresh page
```

---

## Root Causes Summary

| # | Root Cause | Impact | Severity |
|---|------------|--------|----------|
| 1 | React Strict Mode double mounting creates connection leaks | 60-80 duplicate connections reported | **CRITICAL** |
| 2 | Disconnected state between useSSE hook and parent component | UI shows OFFLINE when reconnection succeeds | **HIGH** |
| 3 | Infinite retry without circuit breaker | Wasted resources, no user feedback | **HIGH** |
| 4 | No backend health check before reconnection | Retries against known-down endpoint | **MEDIUM** |
| 5 | EventSource API provides no error details | Cannot implement smart retry logic | **MEDIUM** |
| 6 | No automatic fallback to polling after repeated failures | User loses real-time updates permanently | **HIGH** |
| 7 | User sees "60-80 connections" but no management UI | No way to diagnose or recover without code changes | **CRITICAL** |

---

## Why Reconnection Fails (Step-by-Step)

### Scenario: Backend SSE Endpoint Returns 503 Service Unavailable

1. **Initial Connection:** EventSource establishes successfully → LIVE
2. **Backend Restart:** Server closes all SSE connections → `es.onerror` fires
3. **Reconnection Attempt #1 (1s later):**
   - Creates new EventSource
   - Backend SSE endpoint responds with 503
   - Browser fires `es.onerror` **immediately** (no details provided)
   - useSSE sees error, schedules retry in 2s
4. **Reconnection Attempt #2-5 (2s, 4s, 8s, 16s):**
   - Same pattern repeats
   - Backend still returning 503
   - UI shows "RECONNECTING" briefly, then "OFFLINE"
5. **Terminal State (after 30s):**
   - Backoff reaches maximum (30s)
   - Retries every 30 seconds indefinitely
   - User sees permanent "OFFLINE" status
   - **Why it looks "stuck":** 30-second intervals feel like no activity
   - **Why it stays offline:** Backend may recover but browser cache prevents reconnection
   - **Why user can't recover:** No manual "Force Reconnect" button

---

## Evidence from Codebase

### Connection Leak Proof
```typescript
// src/lib/useSSE.ts - Old version (pre-fix)
useEffect(() => {
  const es = new EventSource(url.trim());
  // No duplicate prevention
  // React Strict Mode calls this twice
  return () => es.close(); // Only closes last instance
}, [url]);
```

**Result:** User reports "60-80 SSE sessions" - confirms leak over time.

---

### State Desynchronization Proof
```typescript
// src/components/dev/LiveConsole.tsx
const [bufferedEvents, setBufferedEvents] = useState<Event[]>([]);
// ^ State assumes connection is active
// But useSSE may have closed connection internally
// No way for parent to know actual connection state
```

---

### No Circuit Breaker Proof
```typescript
// src/lib/useSSE.ts
es.onerror = () => {
  setTimeout(connect, backoff); // Always retries
  // No: if (failCount > MAX_RETRIES) { giveUp(); }
};
```

---

## Business Impact

### User Experience
- ❌ Real-time monitoring unavailable after initial disconnect
- ❌ No indication that reconnection is being attempted
- ❌ No fallback to polling mode
- ❌ Must manually refresh page to restore connection
- ❌ Diagnostic information hidden (60-80 connections)

### Operational Impact
- ❌ Support burden: Users report "Command Hub not working"
- ❌ Lost confidence in real-time monitoring
- ❌ Engineers waste time investigating "stuck" connections
- ❌ Backend resources wasted on failed reconnection attempts

### Technical Debt
- ❌ Connection leak causes memory growth over time
- ❌ No monitoring/alerting for connection failures
- ❌ No graceful degradation strategy

---

## Recommended Fixes

### Priority 1 (Implemented)
✅ **Connection Manager** - Track and force-close all SSE connections  
✅ **React Strict Mode Protection** - Prevent double mounting with `mountedRef`  
✅ **SSE Connection Monitor UI** - Show active connections and "Force Close All" button

### Priority 2 (Required)
🔴 **Circuit Breaker Pattern**
```typescript
if (failCount >= MAX_RETRIES) {
  console.error('Max retries exceeded, switching to polling');
  onFallback?.(); // Trigger automatic fallback
  return; // Stop retrying
}
```

🔴 **Pre-flight Backend Health Check**
```typescript
const checkBackendHealth = async () => {
  try {
    const res = await fetch(`${BASE_EVENTS}/health`);
    return res.ok;
  } catch {
    return false;
  }
};

if (await checkBackendHealth()) {
  connect(); // Only reconnect if backend is healthy
}
```

🔴 **User-Facing "Force Reconnect" Button**
```typescript
<Button onClick={() => forceReconnect()}>
  Reconnect Command Hub
</Button>
```

### Priority 3 (Enhancement)
🟡 Smart retry based on error type (requires server-side changes)  
🟡 Exponential backoff with jitter to prevent thundering herd  
🟡 Reconnection success notification toast  
🟡 Automatic fallback to polling after 3 failed attempts  

---

## Conclusion

The Command Hub reconnection failure is caused by **architectural gaps in connection lifecycle management**, exacerbated by **React Strict Mode double mounting** and **lack of user-facing diagnostics**.

**Immediate Actions Required:**
1. ✅ Implement connection manager (DONE)
2. 🔴 Add circuit breaker pattern to stop infinite retries
3. 🔴 Add pre-flight health check before reconnection
4. 🔴 Expose "Force Reconnect" button to users
5. 🔴 Implement automatic fallback to polling after 3 failures

**Timeline:**
- Priority 1 fixes: ✅ **COMPLETED**
- Priority 2 fixes: 🔴 **Required within 24 hours**
- Priority 3 enhancements: 🟡 **Next sprint**

---

**Report Prepared By:** AI Technical Analysis System  
**For Review By:** CTO / Engineering Leadership  
**Status:** Action Required - High Priority System Reliability Issue
