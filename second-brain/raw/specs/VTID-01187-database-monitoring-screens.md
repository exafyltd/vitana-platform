# VTID-01187 — Database Monitoring Screens (Supabase + Vectors + Cache + Analytics)

**VTID:** 01187
**Title:** Build Database Monitoring Screens in Command Hub
**Owner:** Claude (Worker)
**Validator:** Claude (Validator)
**Creativity:** LOW (UI patterns exist, follow them)
**Type:** Frontend + Backend API
**Priority:** P1 - HIGH (Visibility into system health)

---

## 0) PROBLEM STATEMENT

### Current State
- Database screens exist in Command Hub navigation (Supabase, Vectors, Cache, Analytics, Clusters)
- **ALL SCREENS ARE EMPTY** - No monitoring data displayed
- Qdrant Cloud was down and **nobody knew**
- No visibility into memory system health
- No way to diagnose "memory not working" issues

### Impact
- Hours wasted debugging memory issues
- User frustration ("memory doesn't work")
- No proactive alerting on database failures

---

## 1) SOLUTION: BUILD ALL DATABASE MONITORING SCREENS

### 1.1 Screen Inventory

| Tab | Data Source | Purpose |
|-----|-------------|---------|
| **Supabase** | Supabase Management API | Table stats, RLS health, connection pool |
| **Vectors** | Qdrant Cloud API | Collections, vector counts, health status |
| **Cache** | Redis/Memory stats | Cache hit rates, memory usage |
| **Analytics** | OASIS events | Query patterns, error rates, latency |
| **Clusters** | GCP/Qdrant | Infrastructure health |

---

## 2) VECTORS TAB (PRIORITY 1 - Memory System)

### 2.1 Required Metrics

```typescript
interface VectorDashboard {
  // Connection Status
  qdrant_status: 'connected' | 'disconnected' | 'error';
  qdrant_url: string;
  last_health_check: string;

  // Collections
  collections: {
    name: string;
    vectors_count: number;
    points_count: number;
    indexed_vectors_count: number;
    status: 'green' | 'yellow' | 'red';
  }[];

  // Resource Usage
  disk_used_bytes: number;
  disk_total_bytes: number;
  ram_used_bytes: number;
  ram_total_bytes: number;

  // Operations (last 24h)
  writes_count: number;
  reads_count: number;
  errors_count: number;
  avg_latency_ms: number;
}
```

### 2.2 Backend API Endpoint

**File:** `services/gateway/src/routes/databases.ts`

```typescript
// GET /api/v1/databases/vectors/status
router.get('/vectors/status', async (req, res) => {
  const QDRANT_URL = process.env.QDRANT_URL;
  const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

  if (!QDRANT_URL) {
    return res.json({
      ok: false,
      status: 'not_configured',
      error: 'QDRANT_URL not set'
    });
  }

  try {
    // Health check
    const healthRes = await fetch(`${QDRANT_URL}/health`, {
      headers: { 'api-key': QDRANT_API_KEY }
    });

    // Collections
    const collectionsRes = await fetch(`${QDRANT_URL}/collections`, {
      headers: { 'api-key': QDRANT_API_KEY }
    });
    const collections = await collectionsRes.json();

    // Cluster info
    const clusterRes = await fetch(`${QDRANT_URL}/cluster`, {
      headers: { 'api-key': QDRANT_API_KEY }
    });
    const cluster = await clusterRes.json();

    return res.json({
      ok: true,
      status: 'connected',
      qdrant_url: QDRANT_URL.substring(0, 50) + '...',
      collections: collections.result?.collections || [],
      cluster: cluster.result,
      checked_at: new Date().toISOString()
    });
  } catch (error) {
    return res.json({
      ok: false,
      status: 'error',
      error: error.message,
      qdrant_url: QDRANT_URL?.substring(0, 50) + '...'
    });
  }
});

// GET /api/v1/databases/vectors/collections/:name
router.get('/vectors/collections/:name', async (req, res) => {
  // Get detailed collection info including vector count, config, etc.
});

// GET /api/v1/databases/vectors/metrics
router.get('/vectors/metrics', async (req, res) => {
  // Get operation metrics from OASIS events
});
```

### 2.3 Frontend Component

**File:** `services/gateway/src/frontend/command-hub/pages/databases/vectors.js`

```javascript
// Vectors Dashboard Component
function VectorsDashboard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchVectorsStatus();
    const interval = setInterval(fetchVectorsStatus, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  async function fetchVectorsStatus() {
    try {
      const res = await fetch('/api/v1/databases/vectors/status');
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="vectors-dashboard">
      {/* Status Banner */}
      <StatusBanner
        status={status?.status}
        message={status?.ok ? 'Qdrant Cloud Connected' : status?.error}
      />

      {/* Collections Grid */}
      <CollectionsGrid collections={status?.collections} />

      {/* Resource Gauges */}
      <ResourceGauges
        disk={status?.cluster?.disk}
        ram={status?.cluster?.ram}
      />

      {/* Operations Chart (24h) */}
      <OperationsChart />

      {/* Recent Errors */}
      <RecentErrors />
    </div>
  );
}
```

### 2.4 Visual Design

```
┌─────────────────────────────────────────────────────────────────┐
│  VECTORS                                            🔄 Refresh  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  🟢 CONNECTED to Qdrant Cloud                           │    │
│  │  https://d1ddc241-...us-east4-0.gcp.cloud.qdrant.io     │    │
│  │  Last check: 5 seconds ago                               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  COLLECTIONS                                                     │
│  ┌──────────────┬──────────────┬──────────────┬────────────┐    │
│  │ mem0_default │ 1,234 vectors│ 384 dims     │ 🟢 Healthy │    │
│  └──────────────┴──────────────┴──────────────┴────────────┘    │
│                                                                  │
│  RESOURCES                                                       │
│  ┌────────────────────┐  ┌────────────────────┐                 │
│  │ DISK: 0.5/4 GiB    │  │ RAM: 0.13/1 GiB    │                 │
│  │ ████░░░░░░░░ 12%   │  │ ██░░░░░░░░░░ 13%   │                 │
│  └────────────────────┘  └────────────────────┘                 │
│                                                                  │
│  OPERATIONS (24h)                                                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Writes: 456  │  Reads: 1,234  │  Errors: 2  │  Avg: 45ms│    │
│  │  [chart visualization]                                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  RECENT ERRORS                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 14:23:45 │ Connection timeout │ memory.write.failed     │    │
│  │ 14:20:12 │ Rate limit exceeded│ memory.read.failed      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3) SUPABASE TAB

### 3.1 Required Metrics

```typescript
interface SupabaseDashboard {
  // Connection
  status: 'connected' | 'error';
  project_ref: string;

  // Tables
  tables: {
    name: string;
    row_count: number;
    size_bytes: number;
    rls_enabled: boolean;
  }[];

  // Health
  connection_pool: {
    active: number;
    idle: number;
    max: number;
  };

  // Recent activity
  recent_queries: number;
  slow_queries: number;
  errors: number;
}
```

### 3.2 Key Tables to Monitor

| Table | Importance | Alerts |
|-------|------------|--------|
| `memory_items` | Critical | Row count, size growth |
| `memory_deletions` | High | Deletion rate |
| `oasis_events` | Medium | Event rate, errors |
| `tenants` | Low | Count |
| `users` | Low | Count |

---

## 4) CACHE TAB

### 4.1 Required Metrics (if Redis used)

```typescript
interface CacheDashboard {
  status: 'connected' | 'not_configured' | 'error';

  // Memory
  used_memory_bytes: number;
  max_memory_bytes: number;

  // Operations
  hits: number;
  misses: number;
  hit_rate: number;

  // Keys
  total_keys: number;
  expiring_keys: number;
}
```

---

## 5) ANALYTICS TAB

### 5.1 OASIS-Powered Metrics

```typescript
interface AnalyticsDashboard {
  // Memory operations
  memory_writes_24h: number;
  memory_reads_24h: number;
  memory_errors_24h: number;

  // Latency percentiles
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;

  // By tenant
  top_tenants: {
    tenant_id: string;
    operations: number;
  }[];

  // Error breakdown
  errors_by_type: {
    type: string;
    count: number;
  }[];
}
```

### 5.2 Query OASIS Events

```sql
-- Memory operations last 24h
SELECT
  type,
  COUNT(*) as count,
  AVG((payload->>'latency_ms')::int) as avg_latency
FROM oasis_events
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND type LIKE 'memory.%' OR type LIKE 'orb.memory_indexer.%'
GROUP BY type;
```

---

## 6) CLUSTERS TAB

### 6.1 Infrastructure Overview

```typescript
interface ClustersDashboard {
  // Qdrant Cloud
  qdrant: {
    cluster_id: string;
    status: 'healthy' | 'degraded' | 'down';
    nodes: number;
    version: string;
    region: string;
  };

  // Cloud Run Services
  services: {
    name: string;
    status: 'serving' | 'starting' | 'stopped';
    revision: string;
    instances: number;
    cpu: number;
    memory: number;
  }[];
}
```

---

## 7) ALERTING INTEGRATION

### 7.1 Alert Conditions

| Condition | Severity | Action |
|-----------|----------|--------|
| Qdrant disconnected | Critical | Banner + OASIS event |
| Supabase connection pool > 80% | Warning | Log + OASIS event |
| Memory error rate > 5% | Warning | OASIS event |
| Disk usage > 80% | Warning | OASIS event |
| No memory writes in 1h | Info | Log |

### 7.2 OASIS Event Emission

```typescript
// Emit on health check failure
emitOasisEvent({
  vtid: 'VTID-01187',
  type: 'database.health.degraded',
  source: 'database-monitor',
  status: 'error',
  message: 'Qdrant Cloud connection failed',
  payload: {
    database: 'qdrant',
    error: error.message,
    last_successful_check: lastCheck
  }
});
```

---

## 8) FILES TO CREATE/MODIFY

### New Files
| File | Purpose |
|------|---------|
| `services/gateway/src/routes/databases.ts` | API endpoints |
| `services/gateway/src/frontend/command-hub/pages/databases/vectors.js` | Vectors UI |
| `services/gateway/src/frontend/command-hub/pages/databases/supabase.js` | Supabase UI |
| `services/gateway/src/frontend/command-hub/pages/databases/cache.js` | Cache UI |
| `services/gateway/src/frontend/command-hub/pages/databases/analytics.js` | Analytics UI |
| `services/gateway/src/frontend/command-hub/pages/databases/clusters.js` | Clusters UI |

### Modify
| File | Change |
|------|--------|
| `services/gateway/src/index.ts` | Mount /api/v1/databases routes |
| `services/gateway/src/frontend/command-hub/app.js` | Route to database pages |

---

## 9) ENVIRONMENT VARIABLES NEEDED

```env
# Already exist
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE=...

# Need to add
QDRANT_URL=https://d1ddc241-17f0-4fb4-84b8-8fa8d3f59911.us-east4-0.gcp.cloud.qdrant.io
QDRANT_API_KEY=...

# Optional (for Cloud Run monitoring)
GCP_PROJECT_ID=lovable-vitana-vers1
```

---

## 10) SUCCESS CRITERIA

- [ ] Vectors tab shows Qdrant Cloud connection status
- [ ] Vectors tab shows collections and vector counts
- [ ] Vectors tab shows resource usage (disk, RAM)
- [ ] Supabase tab shows table stats and RLS status
- [ ] Analytics tab shows memory operation metrics from OASIS
- [ ] Automatic refresh every 30 seconds
- [ ] Visual alerts when databases are degraded/down
- [ ] OASIS events emitted on health check failures

---

## 11) IMPLEMENTATION ORDER

1. **Phase 1:** Vectors tab (critical - memory system visibility)
2. **Phase 2:** Supabase tab (table stats, RLS)
3. **Phase 3:** Analytics tab (OASIS metrics)
4. **Phase 4:** Clusters tab (infrastructure)
5. **Phase 5:** Cache tab (if Redis used)
