# VTID-0526-D: Telemetry Standardization & Auto-Load Enforcement

**Layer:** DEV | **Module:** CICDL/OPERATOR
**Status:** Completed
**Date:** 2025-12-09

## Overview

VTID-0526-D implements telemetry standardization to make the 4-stage model reliable enough for VTID-0527 "Task Stage View" to trust the data.

## The 4-Stage Model

All execution events are mapped to exactly one of these 4 macro stages:

| Stage | Description | Color |
|-------|-------------|-------|
| `PLANNER` | Planning, scheduling, queue, preparation, initialization | Blue (#3b82f6) |
| `WORKER` | Execution, running, processing, building, compiling | Orange (#f59e0b) |
| `VALIDATOR` | Testing, validation, verification, checks, review | Purple (#8b5cf6) |
| `DEPLOY` | Deployment, release, publishing, completion | Green (#10b981) |

### Stage Mapping Logic

Events are automatically mapped to stages based on keywords in their `kind`, `title`, or `status` fields:

```typescript
// From services/gateway/src/lib/stage-mapping.ts
function mapRawToStage(raw: string, ...context: string[]): TaskStage | null
```

Examples:
- `"task.scheduled"` → `PLANNER`
- `"pipeline.running"` → `WORKER`
- `"test.executing"` → `VALIDATOR`
- `"deploy.completed"` → `DEPLOY`

## Database Schema

### New Column: `task_stage`

Added to `oasis_events` table:

```sql
ALTER TABLE oasis_events
  ADD COLUMN task_stage TEXT
  CONSTRAINT oasis_events_task_stage_check
  CHECK (task_stage IN ('PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'));
```

### RPC Function: `count_events_by_stage`

```sql
SELECT * FROM count_events_by_stage(since_time => NOW() - INTERVAL '24 hours');
-- Returns: [{task_stage: 'PLANNER', count: 5}, ...]
```

## API Endpoints

### GET /api/v1/telemetry/snapshot

Returns a telemetry snapshot with events and stage counters.

**Query Parameters:**
- `limit` (optional): Number of events (default: 20, max: 100)
- `hours` (optional): Time window in hours (default: 24, max: 168)

**Response:**
```json
{
  "ok": true,
  "timestamp": "2025-12-09T21:00:00.000Z",
  "events": [
    {
      "id": "uuid",
      "created_at": "...",
      "vtid": "VTID-0526",
      "kind": "deploy.started",
      "status": "in_progress",
      "title": "Deploying gateway to dev",
      "task_stage": "DEPLOY",
      "source": "cicd",
      "layer": "DEV"
    }
  ],
  "counters": {
    "PLANNER": 5,
    "WORKER": 12,
    "VALIDATOR": 8,
    "DEPLOY": 3
  },
  "valid_stages": ["PLANNER", "WORKER", "VALIDATOR", "DEPLOY"]
}
```

### POST /api/v1/telemetry/event

Extended to accept optional `task_stage`:

```json
{
  "vtid": "VTID-0526",
  "layer": "DEV",
  "module": "CICDL",
  "source": "gateway",
  "kind": "deploy.started",
  "status": "in_progress",
  "title": "Deploying gateway",
  "task_stage": "DEPLOY"  // Optional - auto-mapped if not provided
}
```

## Frontend Auto-Load

### Behavior

1. When Operator Console opens → `startOperatorLiveTicker()` is called
2. Immediately fetches `/api/v1/telemetry/snapshot`
3. Populates:
   - Stage counters (P|W|V|D badges in status banner)
   - Live Ticker events (with stage badges)
4. Starts 3-second auto-refresh for counters during active execution

### UI Components

**Stage Counter Row:**
```
┌─────────────────────────────────────────────────┐
│ Status: LIVE | Tasks: 24 | CICD: OK             │
│ Scheduled: 5 | In Progress: 3 | Completed: 16   │
│ [P] 5  [W] 12  [V] 8  [D] 3                     │
└─────────────────────────────────────────────────┘
```

**Ticker Event Items:**
```
│ 14:32:05 [D] Deploy gateway to dev     deploy │
│ 14:31:42 [V] Running test suite        test   │
│ 14:31:15 [W] Building gateway          build  │
```

### Polling Model

- Auto-refresh: Every 3 seconds while Operator Console is open
- Stops when console is closed
- Can be disabled via `state.telemetryAutoRefreshEnabled = false`

## Files Changed

### New Files
- `services/gateway/src/lib/stage-mapping.ts` - Stage mapping utility
- `supabase/migrations/20251209000000_add_task_stage.sql` - DB migration

### Modified Files
- `services/gateway/src/routes/telemetry.ts` - Added snapshot endpoint + stage support
- `services/gateway/src/frontend/command-hub/app.js` - Auto-load + UI counters
- `services/gateway/src/frontend/command-hub/styles.css` - Stage counter styles

## Verification

After deployment, verify:

1. **Health check:**
   ```bash
   curl -s "$GATEWAY_URL/api/v1/health"
   ```

2. **Telemetry snapshot:**
   ```bash
   curl -s "$GATEWAY_URL/api/v1/telemetry/snapshot" | jq '.counters'
   ```

3. **Tasks API (backward compatibility):**
   ```bash
   curl -s "$GATEWAY_URL/api/v1/tasks?limit=5"
   ```

4. **Frontend:**
   - Open `/command-hub/`
   - Click Operator Console
   - Verify Live Ticker shows events without pressing heartbeat
   - Verify stage counters (P|W|V|D) are visible

## Dependencies

- Requires VTID-0526-A/B/C (Live Ticker infrastructure)
- Unblocks VTID-0527 (Task Stage View)

## Related VTIDs

- VTID-0526-A: Initial telemetry infrastructure
- VTID-0526-B: Auto-start Live Ticker
- VTID-0526-C: Ticker event persistence
- VTID-0526-D: This ticket (Telemetry Standardization)
- VTID-0527: Task Stage View (blocked on this)
