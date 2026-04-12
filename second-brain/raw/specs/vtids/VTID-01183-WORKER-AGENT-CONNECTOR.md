# VTID-01183: Worker Agent Connector — Autonomous Task Execution Bridge

**Layer:** DEV | **Module:** OPERATOR
**Owner:** Claude (Worker)
**Validator:** Claude (Validator)
**Status:** Pending
**Date:** 2026-01-16

---

## 1. Purpose

Connect autonomous worker agents (Claude Code sessions) to the Autopilot Event Loop (VTID-01179) so dispatched tasks are automatically picked up and executed without human intervention.

**Current State:**
- VTID-01179 event loop dispatches tasks to worker orchestrator
- Dispatch succeeds (`dispatched: true`) but no worker picks up the task
- Tasks sit in `in_progress` state indefinitely

**Target State:**
- Worker agents poll for dispatched tasks
- Tasks are claimed, executed, and progress events emitted
- Event loop advances state machine: `in_progress` → `building` → `pr_created` → ...

---

## 2. Non-Negotiables

| ID | Rule |
|----|------|
| N1 | Worker must claim task atomically (prevent duplicate execution) |
| N2 | Worker must emit OASIS events for every state change |
| N3 | Worker must respect governance gates (validator pass required for merge) |
| N4 | Worker must handle crashes gracefully (heartbeat/timeout) |
| N5 | Single worker per VTID (no parallel execution of same task) |

---

## 3. Design

### 3.1 Worker Registration

Workers register with the orchestrator on startup:

```
POST /api/v1/worker/orchestrator/register
{
  "worker_id": "claude-code-session-abc123",
  "capabilities": ["typescript", "react", "node"],
  "max_concurrent": 1
}
```

Response:
```json
{
  "ok": true,
  "worker_id": "claude-code-session-abc123",
  "registered_at": "2026-01-16T21:30:00Z"
}
```

### 3.2 Task Polling

Workers poll for available tasks:

```
GET /api/v1/worker/orchestrator/tasks/pending
```

Response:
```json
{
  "ok": true,
  "tasks": [
    {
      "vtid": "VTID-01180",
      "title": "Autopilot Recommendation Inbox API v0",
      "state": "in_progress",
      "dispatched_at": "2026-01-16T21:26:22Z",
      "spec_snapshot_id": "9fa1a01a-e571-4ea2-943f-d429b48ae4a0",
      "priority": 1
    }
  ]
}
```

### 3.3 Task Claiming

Worker claims a task atomically:

```
POST /api/v1/worker/orchestrator/tasks/{vtid}/claim
{
  "worker_id": "claude-code-session-abc123"
}
```

Response (success):
```json
{
  "ok": true,
  "claimed": true,
  "vtid": "VTID-01180",
  "spec": "# VTID-01180 — Autopilot Recommendation Inbox...",
  "claim_expires_at": "2026-01-16T22:30:00Z"
}
```

Response (already claimed):
```json
{
  "ok": false,
  "claimed": false,
  "reason": "Task already claimed by another worker"
}
```

### 3.4 Progress Reporting

Worker emits OASIS events as it progresses:

| Event | When |
|-------|------|
| `worker.execution.started` | Worker begins execution |
| `worker.building` | Writing code |
| `worker.pr.created` | PR opened |
| `worker.execution.completed` | Work done, ready for validation |
| `worker.execution.failed` | Unrecoverable error |

```
POST /api/v1/worker/orchestrator/tasks/{vtid}/progress
{
  "worker_id": "claude-code-session-abc123",
  "event": "worker.building",
  "message": "Implementing API endpoints",
  "metadata": {
    "files_changed": 3,
    "lines_added": 150
  }
}
```

### 3.5 Heartbeat & Timeout

Workers send heartbeats every 30 seconds:

```
POST /api/v1/worker/orchestrator/heartbeat
{
  "worker_id": "claude-code-session-abc123",
  "active_vtid": "VTID-01180"
}
```

If no heartbeat for 5 minutes:
- Task claim expires
- Task returns to pending queue
- OASIS event: `worker.claim.expired`

### 3.6 Event Loop Integration

The event loop (VTID-01179) watches for worker events:

| Worker Event | Loop Transition |
|--------------|-----------------|
| `worker.execution.started` | `in_progress` → `in_progress` (no change, confirms receipt) |
| `worker.building` | `in_progress` → `building` |
| `worker.pr.created` | `building` → `pr_created` |
| `worker.execution.completed` | `pr_created` → `reviewing` |
| `worker.execution.failed` | any → `failed` |

---

## 4. Database Schema

### 4.1 Worker Registry Table

```sql
CREATE TABLE IF NOT EXISTS worker_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id TEXT UNIQUE NOT NULL,
  capabilities TEXT[] DEFAULT '{}',
  max_concurrent INTEGER DEFAULT 1,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  metadata JSONB DEFAULT '{}'
);
```

### 4.2 Task Claims Table

```sql
CREATE TABLE IF NOT EXISTS worker_task_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vtid TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES worker_registry(worker_id),
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  UNIQUE(vtid, released_at) -- Only one active claim per VTID
);

CREATE INDEX idx_claims_active ON worker_task_claims(vtid)
  WHERE released_at IS NULL;
```

---

## 5. Files Changed

### New Files
- `services/gateway/src/services/worker-connector-service.ts` — Core connector logic
- `services/gateway/src/routes/worker-connector.ts` — API endpoints
- `supabase/migrations/20260117000000_vtid_01183_worker_connector.sql` — Schema

### Modified Files
- `services/gateway/src/services/autopilot-event-mapper.ts` — Add worker event mappings
- `services/gateway/src/routes/index.ts` — Mount worker-connector routes
- `services/gateway/src/index.ts` — Initialize worker connector

---

## 6. Event Mapping Additions

Add to `autopilot-event-mapper.ts`:

```typescript
// IN_PROGRESS → BUILDING
{
  eventTypes: [
    'worker.building',
    'worker.execution.building',
  ],
  fromStates: ['in_progress'],
  toState: 'building',
  description: 'Worker started building',
},

// BUILDING → PR_CREATED
{
  eventTypes: [
    'worker.pr.created',
    'github.pull_request.opened',
  ],
  fromStates: ['building'],
  toState: 'pr_created',
  description: 'PR created',
},

// PR_CREATED → REVIEWING
{
  eventTypes: [
    'worker.execution.completed',
  ],
  fromStates: ['pr_created'],
  toState: 'reviewing',
  triggerAction: 'validate',
  description: 'Worker done, trigger validation',
},
```

---

## 7. Success Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | Worker can register and appear in registry | Query `worker_registry` table |
| 2 | Worker can poll and see dispatched tasks | GET `/tasks/pending` returns VTID-01180 |
| 3 | Worker can claim task atomically | Second claim attempt fails |
| 4 | Worker events advance event loop state | VTID state progresses in DB |
| 5 | Expired claims release task | Task returns to pending after timeout |
| 6 | End-to-end: Activate → Worker execution → PR | Full autonomous flow |

---

## 8. Test Plan

### Unit Tests
- `worker-connector-service.test.ts`
  - Registration success/failure
  - Claim atomicity (concurrent claims)
  - Heartbeat tracking
  - Claim expiration

### Integration Tests
- Register worker → Poll tasks → Claim → Progress → Complete
- Simulate crash (no heartbeat) → Verify claim expires
- Event loop state transitions from worker events

---

## 9. Sequence Diagram

```
User          Command Hub       Event Loop        Worker Connector      Worker Agent
  |               |                 |                    |                   |
  |--Activate---->|                 |                    |                   |
  |               |--lifecycle.started-->|              |                   |
  |               |                 |--dispatch-------->|                   |
  |               |                 |                    |<---poll----------|
  |               |                 |                    |---task list----->|
  |               |                 |                    |<---claim---------|
  |               |                 |                    |---claimed------->|
  |               |                 |<--worker.building--|                   |
  |               |                 |   (transition)     |<--progress--------|
  |               |                 |<--worker.pr.created-|                  |
  |               |                 |   (transition)     |                   |
  |               |                 |<--worker.completed--|                  |
  |               |                 |--validate--------->|                   |
  |               |                 |   (auto-trigger)   |                   |
```

---

## 10. Dependencies

- VTID-01179: Autopilot Event Loop (COMPLETED)
- VTID-01178: Autopilot Controller (COMPLETED)
- VTID-01163: Worker Orchestrator (EXISTS - enhance)

---

## 11. Rollout

1. Deploy schema migration
2. Deploy gateway with new endpoints
3. Update event mapper with worker events
4. Test with manual worker simulation (curl)
5. Connect actual Claude Code worker agent

---

## 12. Notes

- This spec focuses on the **server-side connector**
- The **worker agent itself** (Claude Code session that executes tasks) is a separate concern
- Worker agent implementation may be a follow-up VTID
