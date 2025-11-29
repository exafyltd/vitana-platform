# VTID-0521: Automatic VTID Ledger Writer (OASIS -> Ledger Sync)

**VTID:** VTID-0521
**Status:** Implemented
**Layer:** OASIS
**Scope:** Automatic synchronization of OASIS events to vtid_ledger table
**Environment:** All (dev, staging, prod)
**Created:** 2025-11-29
**Parent VTID:** VTID-0516 (Autonomous Safe-Merge Layer)

---

## 1. Overview

VTID-0521 implements an automatic ledger writer that keeps the `vtid_ledger` table in sync with OASIS events. This ensures that:

- `/api/v1/tasks` always reflects reality without manual SQL
- `/api/v1/oasis/tasks` returns accurate task status
- `/api/v1/vtid/:vtid` contains up-to-date information

The ledger writer processes OASIS events that contain VTIDs and UPSERTs corresponding rows in `vtid_ledger`.

---

## 2. Architecture

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  OASIS Events   │────▶│  Ledger Writer  │────▶│  vtid_ledger    │
│  (oasis_events) │     │  (oasis-        │     │  table          │
│                 │     │   projector)    │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  ledger_sync    │
                        │  events         │
                        └─────────────────┘
```

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Ledger Writer | `services/oasis-projector/src/ledger-writer.ts` | Core sync logic |
| Migration | `database/migrations/20251129_vtid_ledger_event_tracking.sql` | Schema changes |
| Sync Endpoint | `POST /internal/oasis/ledger/sync` | Manual sync trigger |
| Status Endpoint | `GET /internal/oasis/ledger/status` | Writer status |

---

## 3. Database Schema Changes

### New Columns in vtid_ledger

| Column | Type | Description |
|--------|------|-------------|
| `last_event_id` | TEXT | ID of the last OASIS event that updated this VTID |
| `last_event_at` | TIMESTAMPTZ | Timestamp of the last event |
| `service` | TEXT | Service that triggered the update |
| `environment` | TEXT | Environment (dev, staging, prod) |

### Projection Offset

The ledger writer uses `projection_offsets` table with `projector_name = 'vtid_ledger_writer'` to track progress.

---

## 4. Status Mapping

OASIS event types are mapped to vtid_ledger statuses:

### Deployment Events

| Event Type | Ledger Status |
|------------|---------------|
| `deployment_started` | `active` |
| `deployment_succeeded` | `complete` |
| `deployment_failed` | `blocked` |
| `deployment_validated` | `complete` |

### Task Events

| Event Type | Ledger Status |
|------------|---------------|
| `task_created` | `pending` |
| `task_started` | `active` |
| `task_completed` | `complete` |
| `task_failed` | `blocked` |
| `task_cancelled` | `cancelled` |

### PR Events

| Event Type | Ledger Status |
|------------|---------------|
| `pr_created` | `active` |
| `pr_merged` | `complete` |
| `pr_closed` | `cancelled` |

### Build Events

| Event Type | Ledger Status |
|------------|---------------|
| `build_started` | `active` |
| `build_succeeded` | `complete` |
| `build_failed` | `blocked` |

### Workflow Events

| Event Type | Ledger Status |
|------------|---------------|
| `workflow_started` | `active` |
| `workflow_completed` | `complete` |
| `workflow_failed` | `blocked` |

### Status-Based Fallback

When event type is not mapped, falls back to event status:

| Event Status | Ledger Status |
|--------------|---------------|
| `success`, `complete` | `complete` |
| `fail`, `failure`, `error` | `blocked` |
| `cancelled` | `cancelled` |
| `start`, `in_progress` | `active` |
| `queued`, `pending` | `pending` |

---

## 5. Behavior Specification

### UPSERT Logic

For each OASIS event with a VTID:

1. **Extract VTID** from (in order):
   - `event.vtid`
   - `event.metadata.vtid`
   - `event.ref` (if valid VTID format)
   - Pattern match in `event.message` (`VTID-XXXX`)

2. **Validate VTID format**:
   - `VTID-XXXX` (e.g., VTID-0521)
   - `VTID-YYYY-NNNN` (e.g., VTID-2025-0001)
   - `DEV-LAYER-NNNN` (e.g., DEV-OASIS-0010)

3. **Map status** using rules above

4. **UPSERT vtid_ledger**:
   - If VTID exists: update status, service, environment, last_event_id, last_event_at
   - If VTID doesn't exist: create new entry

5. **Emit ledger_sync event** after batch processing

### Idempotency

- Multiple events for same VTID update the same row
- Newer events (by `created_at`) override older ones
- Status priority prevents downgrades unless event is newer

### Status Priority

```
pending (1) < active (2) < blocked (3) < cancelled (4) < complete (5)
```

A lower-priority status won't override a higher-priority status unless the event is newer.

---

## 6. API Endpoints

### Manual Sync Trigger

**Request:**
```http
POST /internal/oasis/ledger/sync
```

**Response:**
```json
{
  "ok": true,
  "vtid": "VTID-0521",
  "result": {
    "processed": 10,
    "updated": 5,
    "created": 3,
    "errors": 0,
    "last_event_id": "event-uuid",
    "last_event_time": "2025-11-29T10:00:00.000Z"
  },
  "timestamp": "2025-11-29T10:00:00.000Z"
}
```

### Ledger Status

**Request:**
```http
GET /internal/oasis/ledger/status
```

**Response:**
```json
{
  "ok": true,
  "vtid": "VTID-0521",
  "status": {
    "running": true,
    "events_processed": 1234,
    "last_processed_at": "2025-11-29T10:00:00.000Z",
    "last_event_id": "event-uuid",
    "last_event_time": "2025-11-29T09:59:55.000Z"
  },
  "recent_syncs": [
    {
      "id": "sync-event-id",
      "status": "success",
      "notes": "Processed 10 events: 5 updated, 3 created, 0 errors",
      "metadata": { "processed": 10, "updated": 5, "created": 3, "errors": 0 },
      "created_at": "2025-11-29T10:00:00.000Z"
    }
  ],
  "timestamp": "2025-11-29T10:00:05.000Z"
}
```

### Metrics Endpoint

**Request:**
```http
GET /metrics
```

**Response:**
```json
{
  "projectors": {
    "vtid_ledger_sync": {
      "events_processed": 100,
      "last_processed_at": "2025-11-29T10:00:00.000Z",
      "last_event_time": "2025-11-29T09:59:00.000Z"
    },
    "vtid_ledger_writer": {
      "events_processed": 1234,
      "last_processed_at": "2025-11-29T10:00:00.000Z",
      "last_event_time": "2025-11-29T09:59:55.000Z"
    }
  },
  "timestamp": "2025-11-29T10:00:05.000Z"
}
```

---

## 7. OASIS Logging

Every sync batch emits a `ledger_sync` event:

```json
{
  "service": "oasis-projector",
  "event": "ledger_sync",
  "tenant": "system",
  "status": "success",
  "notes": "Processed 10 events: 5 updated, 3 created, 0 errors",
  "metadata": {
    "processed": 10,
    "updated": 5,
    "created": 3,
    "errors": 0,
    "lastEventId": "event-uuid",
    "lastEventTime": "2025-11-29T10:00:00.000Z",
    "vtid": null
  }
}
```

Status values:
- `success`: All events processed without errors
- `warning`: Some events had errors
- `fail`: Critical failure (not emitted, logged instead)

---

## 8. Example Event -> Ledger Mapping

### Input OASIS Event

```json
{
  "id": "evt-123",
  "vtid": "VTID-0521",
  "topic": "deployment_succeeded",
  "service": "ci-cd",
  "status": "success",
  "message": "Deployment completed successfully",
  "metadata": {
    "environment": "dev",
    "taskFamily": "deployment",
    "taskType": "backend"
  },
  "created_at": "2025-11-29T10:00:00.000Z"
}
```

### Output vtid_ledger Row

```json
{
  "vtid": "VTID-0521",
  "status": "complete",
  "task_family": "deployment",
  "task_type": "backend",
  "description": "Deployment completed successfully",
  "service": "ci-cd",
  "environment": "dev",
  "last_event_id": "evt-123",
  "last_event_at": "2025-11-29T10:00:00.000Z",
  "tenant": "system",
  "metadata": {
    "autoCreated": true,
    "sourceEvent": "evt-123",
    "sourceType": "deployment_succeeded",
    "environment": "dev"
  }
}
```

---

## 9. Deployment

### Service Modified

- **Service:** `oasis-projector`
- **Version:** 1.1.0

### Deployment Command

```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/deploy/service
Content-Type: application/json

{
  "vtid": "VTID-0521",
  "service": "oasis-projector",
  "environment": "dev"
}
```

### Migration

Run the migration before deploying:

```bash
psql $DATABASE_URL < database/migrations/20251129_vtid_ledger_event_tracking.sql
```

---

## 10. Testing

### Unit Tests

Tests are located at `services/oasis-projector/test/ledger-writer.test.ts`:

```bash
cd services/oasis-projector
npm test
```

### Test Coverage

- VTID extraction from multiple sources
- Status mapping for all event types
- Create and update operations
- Status priority handling
- Batch processing
- Ledger sync event emission

### Smoke Test

1. Ingest a test event:
```http
POST /api/v1/events/ingest
{
  "vtid": "VTID-TEST-0521",
  "type": "task_created",
  "source": "test",
  "status": "info",
  "message": "Test task created"
}
```

2. Trigger manual sync:
```http
POST /internal/oasis/ledger/sync
```

3. Verify in tasks API:
```http
GET /api/v1/tasks?vtid=VTID-TEST-0521
```

---

## 11. Files Changed

| File | Change |
|------|--------|
| `database/migrations/20251129_vtid_ledger_event_tracking.sql` | New migration for event tracking columns |
| `prisma/schema.prisma` | Added lastEventId, lastEventAt, service, environment to VtidLedger |
| `services/oasis-projector/src/ledger-writer.ts` | New ledger writer module |
| `services/oasis-projector/src/index.ts` | Integrated ledger writer, added sync endpoints |
| `services/oasis-projector/package.json` | Added test dependencies, version bump |
| `services/oasis-projector/test/ledger-writer.test.ts` | New test file |
| `docs/vtids/VTID-0521-AUTO-VTID-LEDGER-WRITER.md` | This documentation |

---

## 12. Related VTIDs

| VTID | Description | Status |
|------|-------------|--------|
| VTID-0516 | Autonomous Safe-Merge Layer | Implemented |
| DEV-OASIS-0010 | OASIS Event Projector | Implemented |
| VTID-0518 | Standard Backend Deployment Pattern | Implemented |
| VTID-0519 | Standard Frontend Deployment Pattern | Implemented |

---

**Maintained by:** Vitana Platform Team
**Last updated:** 2025-11-29
**Related:** [VTID System](../VTID_SYSTEM.md), [OASIS Architecture](../OASIS_ARCHITECTURE.md)
