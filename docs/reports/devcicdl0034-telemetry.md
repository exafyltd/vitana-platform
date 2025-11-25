# VTID DEV-CICDL-0034 — Gateway Telemetry Diagnosis Report

**Date:** 2025-10-29  
**Status:** Root Cause Identified  
**Severity:** HIGH (blocks Phase 3 telemetry)

---

## A) CURRENT ROUTE INVENTORY

### Registered Routes (from index.ts)

```typescript
app.use("/", eventsRouter);      // POST /events/ingest, GET /events, GET /api/v1/oasis/events
app.use("/", vtidRouter);        // POST /vtid/create, GET /vtid/:vtid
app.use("/", executeRouter);     // POST /execute/ping, POST /execute/workflow
app.use("/", devhubRouter);      // GET /api/v1/devhub/feed (SSE)
app.use("/", webhooksRouter);    // POST /webhooks/github
```

### Actual Paths Available

| Method | Path | Purpose | Status |
|--------|------|---------|--------|
| GET | / | Root health | ✅ Active |
| POST | /events/ingest | Legacy OASIS event ingestion | ✅ Active |
| GET | /events | Query OASIS events | ✅ Active |
| GET | /api/v1/oasis/events | VTID-aware event query | ✅ Active |
| GET | /events/health | Events health check | ✅ Active |
| POST | /vtid/create | Create VTID ledger entry | ✅ Active |
| GET | /vtid/:vtid | Get VTID details | ✅ Active |
| POST | /execute/ping | Execution ping | ✅ Active |
| POST | /execute/workflow | Workflow execution | ✅ Active |
| GET | /api/v1/devhub/feed | SSE event stream | ✅ Active |
| POST | /webhooks/github | GitHub webhook handler | ✅ Active |
| GET | /webhooks/health | Webhooks health | ✅ Active |

### Missing Routes (CAUSING 404)

| Method | Path | Expected Purpose | Status |
|--------|------|------------------|--------|
| POST | /api/v1/telemetry/event | Single telemetry event | ❌ NOT IMPLEMENTED |
| POST | /api/v1/telemetry/batch | Batch telemetry events | ❌ NOT IMPLEMENTED |
| GET | /api/v1/health | Gateway health | ❌ NOT IMPLEMENTED |

---

## B) ROOT CAUSE ANALYSIS

### Primary Issue: Route Not Implemented

**Finding:** The telemetry endpoints were **never implemented** in the Gateway codebase.

**Evidence:**
1. No telemetry router registered in `src/index.ts`
2. No `src/routes/telemetry.ts` file exists
3. Attempted calls to `/api/v1/telemetry/event` fall through to 404 handler

### Schema Mismatch

**Finding:** Two competing event schemas exist:

#### 1. Legacy Schema (OasisEventSchema in events.ts)
```typescript
{
  service: string;      // e.g., "gateway"
  event: string;        // e.g., "webhook.received"
  tenant: string;
  status: "start" | "success" | "fail" | "blocked" | "warning" | "info";
  notes?: string;
  git_sha?: string;
  rid?: string;
  metadata?: Record<string, any>;
}
```

#### 2. Target Schema (TickerEvent in devhub.ts)
```typescript
{
  ts: string;           // ISO timestamp
  vtid: string;         // e.g., "DEV-CICDL-0034"
  layer: string;        // e.g., "CICDL"
  module: string;       // e.g., "GATEWAY"
  source: string;       // e.g., "github.actions"
  kind: string;         // e.g., "deploy.complete"
  status: string;       // e.g., "success", "failure", "info"
  title: string;        // e.g., "CICDL-GATEWAY-DEPLOY"
  ref: string;          // e.g., "vt/DEV-CICDL-0034-deploy"
  link?: string | null; // Optional URL
}
```

**Conclusion:** Need to implement telemetry endpoints using TickerEvent schema.

---

## C) REPRODUCTION & VERIFICATION

### 404 Reproduction

```bash
# Attempted during Phase 2C
curl -X POST https://vitana-gateway-86804897789.us-central1.run.app/api/v1/telemetry/event \
  -H "Content-Type: application/json" \
  -H "X-VTID: DEV-CICDL-0033" \
  -d '{...}'

# Result: HTTP 404
# Response: {"error":"Not found"}
```

### Gateway Logs Analysis

From Cloud Logging (last 1 hour):
- **No handler match logs** for `/api/v1/telemetry/*`
- All requests fall through to 404 catch-all handler
- SSE endpoint `/api/v1/devhub/feed` working correctly

### Router Chain Analysis

```
Request: POST /api/v1/telemetry/event
  ↓
Middleware: helmet, cors, json parser ✅
  ↓
Logging middleware ✅
  ↓
Router check: eventsRouter → NO MATCH
Router check: vtidRouter → NO MATCH
Router check: executeRouter → NO MATCH
Router check: devhubRouter → NO MATCH (SSE only)
Router check: webhooksRouter → NO MATCH
  ↓
404 catch-all handler → {"error":"Not found"}
```

---

## D) ARCHITECTURAL OBSERVATIONS

### SSE Broadcast Mechanism (Working)

The Gateway already has a working SSE broadcaster in `devhub.ts`:

```typescript
let eventCache: TickerEvent[] = [];

function updateCache(event: TickerEvent) {
  eventCache.unshift(event);
  // Triggers SSE broadcast to connected clients
}
```

**Key Finding:** We can reuse this infrastructure! Just need to call `updateCache()` from telemetry endpoint.

### OASIS Persistence Pattern

Two approaches exist:
1. **Direct Supabase REST** (used in events.ts): `POST ${supabaseUrl}/rest/v1/OasisEvent`
2. **Via oasis_events table** (used for queries): `oasis_events` table

**Recommendation:** Use `oasis_events` table (newer schema) for telemetry.

---

## E) IMPLEMENTATION PLAN

### Required Changes

1. **Create `/src/routes/telemetry.ts`**
   - POST /api/v1/telemetry/event
   - POST /api/v1/telemetry/batch (optional)
   - GET /api/v1/health

2. **Register telemetry router in index.ts**
   ```typescript
   import { router as telemetryRouter } from "./routes/telemetry";
   app.use("/", telemetryRouter);
   ```

3. **Implement telemetry handler**
   - Validate TickerEvent schema (Zod)
   - Persist to `oasis_events` table
   - Call `updateCache()` from devhub for SSE broadcast
   - Return 202 Accepted

4. **Add security** (optional Phase 1)
   - X-VTID header validation
   - Rate limiting per source
   - Optional HMAC signature

5. **Update OpenAPI spec**
   - Add `/api/v1/telemetry/event` endpoint
   - Document TickerEvent schema
   - Add examples

---

## F) SECURITY CONSIDERATIONS

### Current State
- ✅ CORS enabled (allows Dev app origin)
- ✅ Helmet for security headers
- ✅ JSON body limit (1MB)
- ❌ No authentication on telemetry endpoint
- ❌ No rate limiting
- ❌ No HMAC signature validation

### Recommendations
1. **Phase 1 (Required):** Basic X-VTID validation
2. **Phase 2 (Nice-to-have):** Rate limiting (100 req/min per source)
3. **Phase 3 (Future):** HMAC signature for external producers

---

## G) SUCCESS CRITERIA

### ✅ Implementation Complete When:
1. `POST /api/v1/telemetry/event` returns 202 Accepted
2. Event persisted to `oasis_events` table
3. Event broadcasted via SSE (visible in Live Console)
4. OpenAPI spec updated and validates
5. CI tests passing (unit + integration)
6. Live smoke test produces visible event

### 📊 Acceptance Test:
```bash
curl -X POST $GATEWAY_URL/api/v1/telemetry/event \
  -H "Content-Type: application/json" \
  -H "X-VTID: DEV-CICDL-0034" \
  -d '{
    "ts": "2025-10-29T12:00:00Z",
    "vtid": "DEV-CICDL-0034",
    "layer": "CICDL",
    "module": "GATEWAY",
    "source": "gateway.selftest",
    "kind": "telemetry.smoke",
    "status": "info",
    "title": "GATEWAY-TELEMETRY-SMOKE",
    "ref": "vt/DEV-CICDL-0034-smoke",
    "link": null
  }'

# Expected: HTTP 202 {"ok":true,"id":"..."}
# Expected: Event visible in Live Console within 5s
```

---

## H) ESTIMATED EFFORT

- **Diagnosis:** ✅ COMPLETE
- **Implementation:** ~30 minutes
- **Testing:** ~15 minutes
- **Deployment & Validation:** ~15 minutes
- **Total:** ~60 minutes

---

## I) NEXT STEPS

1. ✅ Create branch vt/DEV-CICDL-0034-gateway-telemetry-fix
2. ⏳ Implement telemetry router
3. ⏳ Add tests
4. ⏳ Update OpenAPI spec
5. ⏳ Deploy to Cloud Run
6. ⏳ Live validation
7. ⏳ Create PR

---

**Report Status:** COMPLETE  
**Root Cause:** Telemetry endpoints never implemented  
**Solution:** Add telemetry router with TickerEvent schema + SSE broadcast  
**Ready to Proceed:** YES ✅
