# VTID-0522: Fix VTID Auto-Ledger Writer Mapping & Status

**VTID:** VTID-0522
**Status:** Implemented
**Layer:** OASIS
**Scope:** Fix event-to-ledger mapping and status endpoint responses
**Environment:** All (dev, staging, prod)
**Created:** 2025-11-30
**Parent VTID:** VTID-0521 (Automatic VTID Ledger Writer)

---

## 1. Overview

VTID-0522 fixes issues discovered after VTID-0521 deployment where:

- Events ingested via `/api/v1/events/ingest` were not appearing in `/api/v1/tasks`
- Status and sync endpoints were returning non-JSON responses (jq parse errors)
- Table name mismatches between Prisma schema and actual database tables

### Root Causes Identified

1. **Prisma Schema Mismatch**: `OasisEvent` model didn't map to `oasis_events` table
2. **Missing Columns**: `vtid`, `topic`, `message` columns missing from Prisma schema
3. **Field Name Mismatch**: Ledger writer used `created_at` but Prisma returns `createdAt`
4. **Tasks API Columns**: Missing `layer`, `module`, `title`, `summary` columns expected by tasks API

---

## 2. Changes Made

### 2.1 Prisma Schema Updates

#### OasisEvent Model

Added table mapping and missing columns:

```prisma
model OasisEvent {
  // ... existing fields ...

  // VTID-0522: Fields for event ingest API
  vtid      String?  // VTID reference
  topic     String?  // Event type
  message   String?  // Event message
  role      String?  // Role
  model     String?  // Model name
  link      String?  // Optional link
  source    String?  // Event source

  @@map("oasis_events")  // Map to correct table
}
```

#### VtidLedger Model

Added tasks API columns and table mapping:

```prisma
model VtidLedger {
  // ... existing fields ...

  // VTID-0522: Tasks API columns
  layer       String?  // High-level category
  module      String?  // Module name
  title       String?  // Short display title
  summary     String?  // Summary text

  @@map("vtid_ledger")  // Map to correct table
}
```

### 2.2 Ledger Writer Fixes

**File:** `services/oasis-projector/src/ledger-writer.ts`

1. Updated `OasisEvent` interface to use camelCase field names (matching Prisma output)
2. Changed `event.created_at` to `event.createdAt` throughout
3. Added logic to populate `layer`, `module`, `title`, `summary` columns:
   - `layer`: derived from `metadata.layer` or `taskFamily.toUpperCase()`
   - `module`: derived from `metadata.module` or `taskType` or `topic`
   - `title`: from `metadata.title` or defaults to VTID
   - `summary`: from `metadata.summary` or `description` or `message`

### 2.3 Status Endpoint Improvements

**File:** `services/oasis-projector/src/index.ts`

Updated response format to match VTID-0522 specification:

```json
{
  "ok": true,
  "last_event_id": "...",
  "last_event_at": "...",
  "processed_events": 123,
  "pending": 5,
  "status": {
    "running": true,
    "last_processed_at": "..."
  },
  "recent_syncs": [...],
  "timestamp": "..."
}
```

### 2.4 Sync Endpoint Improvements

Updated response format:

```json
{
  "ok": true,
  "synced": 10,
  "details": {
    "processed": 10,
    "updated": 5,
    "created": 3,
    "errors": 0,
    "last_event_id": "...",
    "last_event_time": "..."
  },
  "timestamp": "..."
}
```

---

## 3. Database Migration

**File:** `database/migrations/20251130_vtid_0522_schema_fixes.sql`

### New Columns in oasis_events

| Column | Type | Description |
|--------|------|-------------|
| `vtid` | TEXT | VTID reference |
| `topic` | TEXT | Event type |
| `message` | TEXT | Event message |
| `role` | TEXT | Role |
| `model` | TEXT | Model name |
| `link` | TEXT | Optional link |
| `source` | TEXT | Event source |

### New Columns in vtid_ledger

| Column | Type | Description |
|--------|------|-------------|
| `layer` | TEXT | High-level category (e.g., OASIS, GOVERNANCE) |
| `module` | TEXT | Module name |
| `title` | TEXT | Short display title |
| `summary` | TEXT | Summary text for display |

### Backfill Logic

The migration backfills existing data:
- `layer` = UPPER(task_family)
- `module` = task_type
- `title` = vtid
- `summary` = description

---

## 4. Testing

### New Test Cases

**File:** `services/oasis-projector/test/ledger-writer.test.ts`

Added VTID-0522 specific tests for:

1. Populating `layer`, `module`, `title`, `summary` on create
2. Deriving `layer` from `taskFamily` if not provided
3. Deriving `module` from `topic` if not provided
4. Using VTID as `title` if not provided
5. Deriving `summary` from `message` if not provided
6. Preserving existing columns on update

### Running Tests

```bash
cd services/oasis-projector
npm test
```

---

## 5. Verification Procedure

### Step 1: Ingest Test Event

```bash
export GATEWAY_URL="https://gateway-q74ibpv6ia-uc.a.run.app"

curl -s -X POST "$GATEWAY_URL/api/v1/events/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "vtid": "VTID-0522-TEST-0001",
    "type": "deployment_succeeded",
    "source": "vtid-0522-test",
    "status": "success",
    "message": "Test event for VTID-0522 auto-ledger-writer",
    "payload": { "service": "gateway", "environment": "dev" }
  }'
```

### Step 2: Verify in Tasks API

```bash
curl -s "$GATEWAY_URL/api/v1/tasks?limit=200" \
  | jq '.data[] | select(.vtid=="VTID-0522-TEST-0001")'
```

### Step 3: Verify VTID Endpoint

```bash
curl -s "$GATEWAY_URL/api/v1/vtid/VTID-0522-TEST-0001" | jq
```

### Step 4: Verify Status Endpoint

```bash
curl -s "https://oasis-projector-86804897789.us-central1.run.app/internal/oasis/ledger/status" | jq
```

Expected: Returns JSON with `ok: true`, `last_event_id`, `processed_events`, `pending`

### Step 5: Verify Sync Endpoint

```bash
curl -s -X POST "https://oasis-projector-86804897789.us-central1.run.app/internal/oasis/ledger/sync" | jq
```

Expected: Returns JSON with `ok: true`, `synced: N`

---

## 6. Acceptance Criteria

- [x] Events ingested with VTID appear in `/api/v1/tasks`
- [x] `/api/v1/vtid/:vtid` returns full VTID object
- [x] `/internal/oasis/ledger/status` returns proper JSON
- [x] `/internal/oasis/ledger/sync` returns proper JSON
- [x] Tests pass for updated ledger writer logic
- [x] All changes merged into `main` in `vitana-platform`

---

## 7. Files Changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Added table mappings and missing columns |
| `database/migrations/20251130_vtid_0522_schema_fixes.sql` | New migration for schema fixes |
| `services/oasis-projector/src/ledger-writer.ts` | Fixed field mappings and added tasks API columns |
| `services/oasis-projector/src/index.ts` | Updated status/sync endpoint responses |
| `services/oasis-projector/test/ledger-writer.test.ts` | Added VTID-0522 specific tests |
| `docs/vtids/VTID-0522-FIX-AUTO-LEDGER-WRITER-STATUS.md` | This documentation |

---

## 8. Deployment

### Pre-deployment: Run Migration

```bash
psql $DATABASE_URL < database/migrations/20251130_vtid_0522_schema_fixes.sql
```

### Deploy oasis-projector

```bash
cd ~/vitana-platform
./scripts/deploy/deploy-service.sh oasis-projector services/oasis-projector
```

---

## 9. Related VTIDs

| VTID | Description | Status |
|------|-------------|--------|
| VTID-0521 | Automatic VTID Ledger Writer | Implemented |
| VTID-0520 | CI/CD Health Indicator | Implemented |
| DEV-OASIS-0010 | OASIS Event Projector | Implemented |

---

**Maintained by:** Vitana Platform Team
**Last updated:** 2025-11-30
**Related:** [VTID-0521](VTID-0521-AUTO-VTID-LEDGER-WRITER.md)
