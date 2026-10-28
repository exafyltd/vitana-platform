# VTID Numbering System

**Version:** 1.0  
**Date:** 2025-10-28  
**Task:** 4A - VTID Ledger Implementation  
**Status:** ✅ Complete

## Overview

The **VTID (Vitana Task ID)** system provides a centralized, sequential numbering scheme for tracking all tasks, deployments, migrations, and governance actions across the Vitana platform. VTIDs enable:

- **Unique identification** of every task with a human-readable format
- **Audit trails** for compliance and governance
- **Task relationships** through parent-child hierarchies
- **Status tracking** throughout task lifecycle
- **Multi-tenant isolation** for organizational boundaries

## VTID Format

```
VTID-YYYY-NNNN
```

- **VTID** - Prefix identifier
- **YYYY** - Current year (e.g., 2025)
- **NNNN** - Sequential number, zero-padded to 4 digits (0001-9999)

**Examples:**
- `VTID-2025-0001` - First task of 2025
- `VTID-2025-0042` - 42nd task of 2025
- `VTID-2026-0001` - First task of 2026 (counter resets annually)

## Database Schema

### VtidLedger Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | UUID primary key |
| `vtid` | TEXT | Unique VTID identifier (UNIQUE) |
| `task_family` | TEXT | High-level category (governance, deployment, analysis) |
| `task_type` | TEXT | Specific task type (migration, test, review) |
| `description` | TEXT | Human-readable task description |
| `status` | TEXT | Current status: pending, active, complete, blocked, cancelled |
| `assigned_to` | TEXT | Optional assignee (user, agent, service) |
| `tenant` | TEXT | Tenant identifier (system, maxina, earthlings, alkalma) |
| `metadata` | JSONB | Additional task-specific data |
| `parent_vtid` | TEXT | Optional parent VTID for subtasks |
| `created_at` | TIMESTAMP | Creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp (auto-updated) |

### Indexes

- `idx_vtid_created_at` - Performance for chronological queries
- `idx_vtid_family_created` - Filter by task family
- `idx_vtid_status_created` - Filter by status
- `idx_vtid_tenant_created` - Tenant isolation
- `idx_vtid_lookup` - Fast VTID lookups

## API Endpoints

### POST /vtid/create

**Create a new VTID and task record**

**Request:**
```json
{
  "taskFamily": "governance",
  "taskType": "migration",
  "description": "Migrate user data to new schema",
  "status": "pending",
  "assignedTo": "claude-caeo",
  "tenant": "system",
  "metadata": {
    "priority": "high",
    "estimatedHours": 4
  },
  "parentVtid": "VTID-2025-0001"
}
```

**Response:**
```json
{
  "ok": true,
  "vtid": "VTID-2025-0042",
  "data": {
    "id": "cm3abc123...",
    "vtid": "VTID-2025-0042",
    "task_family": "governance",
    "task_type": "migration",
    "description": "Migrate user data to new schema",
    "status": "pending",
    "assigned_to": "claude-caeo",
    "tenant": "system",
    "metadata": {...},
    "parent_vtid": "VTID-2025-0001",
    "created_at": "2025-10-28T10:00:00.000Z",
    "updated_at": "2025-10-28T10:00:00.000Z"
  }
}
```

**Fields:**
- `taskFamily` *(required)* - High-level category
- `taskType` *(required)* - Specific task type
- `description` *(required)* - Task description
- `status` - One of: pending (default), active, complete, blocked, cancelled
- `assignedTo` - Who/what is executing the task
- `tenant` *(required)* - Tenant identifier
- `metadata` - Additional JSON data
- `parentVtid` - Parent task for subtask relationships

---

### GET /vtid/:vtid

**Retrieve details of a specific VTID**

**Request:**
```http
GET /vtid/VTID-2025-0042
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "cm3abc123...",
    "vtid": "VTID-2025-0042",
    "task_family": "governance",
    "task_type": "migration",
    "description": "Migrate user data to new schema",
    "status": "active",
    "assigned_to": "claude-caeo",
    "tenant": "system",
    "metadata": {...},
    "created_at": "2025-10-28T10:00:00.000Z",
    "updated_at": "2025-10-28T12:30:00.000Z"
  }
}
```

**Error responses:**
- `400` - Invalid VTID format
- `404` - VTID not found

---

### PATCH /vtid/:vtid

**Update status or metadata of an existing VTID**

**Request:**
```json
{
  "status": "complete",
  "metadata": {
    "actualHours": 3.5,
    "notes": "Migration completed successfully"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "vtid": "VTID-2025-0042",
  "data": [
    {
      "id": "cm3abc123...",
      "vtid": "VTID-2025-0042",
      "status": "complete",
      "metadata": {...},
      "updated_at": "2025-10-28T14:00:00.000Z"
    }
  ]
}
```

**Fields:**
- `status` - Update task status
- `assignedTo` - Update assignee
- `metadata` - Update metadata (merges with existing)

---

### GET /vtid/list

**List VTIDs with optional filters**

**Query parameters:**
- `taskFamily` - Filter by task family
- `status` - Filter by status
- `tenant` - Filter by tenant
- `limit` - Max results (default: 50)

**Example:**
```http
GET /vtid/list?taskFamily=governance&status=pending&limit=20
```

**Response:**
```json
{
  "ok": true,
  "count": 15,
  "data": [
    {
      "id": "cm3abc123...",
      "vtid": "VTID-2025-0042",
      "task_family": "governance",
      "status": "pending",
      ...
    },
    ...
  ]
}
```

---

### GET /vtid/health

**Health check for VTID service**

**Response:**
```json
{
  "ok": true,
  "service": "vtid-ledger",
  "timestamp": "2025-10-28T15:00:00.000Z"
}
```

## Usage Examples

### Creating a Task with Subtasks

```bash
# 1. Create parent task
curl -X POST https://vitana-gateway.run.app/vtid/create \
  -H "Content-Type: application/json" \
  -d '{
    "taskFamily": "deployment",
    "taskType": "rollout",
    "description": "Deploy new authentication system",
    "tenant": "system",
    "metadata": {
      "deploymentStrategy": "blue-green",
      "services": ["auth", "gateway", "api"]
    }
  }'
# Returns: VTID-2025-0100

# 2. Create subtasks
curl -X POST https://vitana-gateway.run.app/vtid/create \
  -H "Content-Type: application/json" \
  -d '{
    "taskFamily": "deployment",
    "taskType": "service-deploy",
    "description": "Deploy auth service",
    "tenant": "system",
    "parentVtid": "VTID-2025-0100",
    "metadata": {"service": "auth"}
  }'
# Returns: VTID-2025-0101
```

### Tracking Task Progress

```bash
# Start task
curl -X PATCH https://vitana-gateway.run.app/vtid/VTID-2025-0100 \
  -H "Content-Type: application/json" \
  -d '{"status": "active", "assignedTo": "deployment-agent"}'

# Update progress
curl -X PATCH https://vitana-gateway.run.app/vtid/VTID-2025-0100 \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "progress": 50,
      "completedServices": ["auth"],
      "remainingServices": ["gateway", "api"]
    }
  }'

# Complete task
curl -X PATCH https://vitana-gateway.run.app/vtid/VTID-2025-0100 \
  -H "Content-Type: application/json" \
  -d '{
    "status": "complete",
    "metadata": {"completionTime": "2025-10-28T16:30:00Z"}
  }'
```

### Querying Tasks

```bash
# Get all pending governance tasks
curl https://vitana-gateway.run.app/vtid/list?taskFamily=governance&status=pending

# Get specific task details
curl https://vitana-gateway.run.app/vtid/VTID-2025-0042

# Get all tasks for a tenant
curl https://vitana-gateway.run.app/vtid/list?tenant=maxina&limit=100
```

## Integration with OASIS

VTIDs complement the OASIS event system:

1. **VTID creation** should emit an OASIS event:
   ```json
   {
     "service": "vtid-ledger",
     "event": "vtid-created",
     "tenant": "system",
     "status": "success",
     "metadata": {"vtid": "VTID-2025-0042"}
   }
   ```

2. **OASIS events** can reference VTIDs:
   ```json
   {
     "service": "deployment",
     "event": "service-deployed",
     "metadata": {"vtid": "VTID-2025-0100"}
   }
   ```

3. **Task completion** should emit OASIS event:
   ```json
   {
     "service": "vtid-ledger",
     "event": "vtid-completed",
     "tenant": "system",
     "status": "success",
     "metadata": {"vtid": "VTID-2025-0042", "duration": 3.5}
   }
   ```

## Security & Access Control

### Row-Level Security (RLS)

VtidLedger table has RLS policies:

1. **service_role** - Full access for backend services
2. **authenticated** users:
   - ✅ Read all VTIDs (transparency)
   - ✅ Create new VTIDs
   - ✅ Update own tenant's VTIDs
   - ❌ Delete VTIDs (immutable audit trail)

### Tenant Isolation

- Each VTID must specify a `tenant`
- Users can only update VTIDs for their tenant (unless admin)
- Cross-tenant visibility for audit and coordination

## Deployment

### Prerequisites

1. Supabase database with credentials:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE`
   - `SUPABASE_DB_URL`

2. Gateway service deployed on Cloud Run

### Migration Steps

```bash
# 1. Run database migration
psql "$SUPABASE_DB_URL" -f database/migrations/003_vtid_ledger.sql

# 2. Apply RLS policies
psql "$SUPABASE_DB_URL" -f database/policies/003_vtid_ledger.sql

# 3. Regenerate Prisma client
cd ~/vitana-platform
pnpm install
pnpm prisma generate

# 4. Deploy Gateway
cd services/gateway
gcloud run deploy vitana-gateway \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE=SUPABASE_SERVICE_ROLE:latest

# 5. Test
curl https://vitana-gateway.run.app/vtid/health
```

## Testing

```bash
# Run unit tests
cd services/gateway
npm test -- vtid.test.ts

# Integration test
curl -X POST https://vitana-gateway.run.app/vtid/create \
  -H "Content-Type: application/json" \
  -d '{
    "taskFamily": "test",
    "taskType": "integration",
    "description": "Integration test VTID",
    "tenant": "system"
  }'
```

## Monitoring

### Key Metrics

- **VTID creation rate** - Tasks per hour
- **Status distribution** - Active vs pending vs complete
- **Task duration** - Time from creation to completion
- **Family breakdown** - Most common task families

### Health Checks

```bash
# VTID service health
curl https://vitana-gateway.run.app/vtid/health

# Database connectivity
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM \"VtidLedger\";"

# Latest VTIDs
curl https://vitana-gateway.run.app/vtid/list?limit=5
```

## Troubleshooting

### Issue: VTID numbering gaps

**Cause:** Database transactions rolled back after VTID generation  
**Solution:** Gaps are acceptable - VTIDs don't need to be perfectly sequential

### Issue: VTID not found

**Check:**
1. VTID format is correct (`VTID-YYYY-NNNN`)
2. VTID exists in database: `SELECT * FROM "VtidLedger" WHERE vtid = 'VTID-2025-0042';`
3. Network connectivity to Gateway

### Issue: Cannot update VTID

**Check:**
1. User has permission for tenant
2. VTID exists and is not locked
3. Status transition is valid

## Future Enhancements

- [ ] VTID locking for concurrent updates
- [ ] Bulk VTID operations
- [ ] VTID search by description
- [ ] Task duration analytics
- [ ] Slack/Google Chat notifications on status changes
- [ ] VTID archival for completed tasks
- [ ] VTID relationships visualization

---

**Maintained by:** Vitana Platform Team  
**Last updated:** 2025-10-28  
**Related:** [OASIS Documentation](../OASIS.md), [Gateway API](../services/gateway/README.md)
