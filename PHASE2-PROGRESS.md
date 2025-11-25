# VTID: DEV-CICDL-0031 Phase 2 - Progress Report

## ✅ COMPLETED (A1: GitHub Webhook)

### A1.1 - GitHub Webhook Endpoint Created
**File**: `services/gateway/src/routes/webhooks.ts`

**Features**:
- ✅ HMAC SHA-256 signature verification
- ✅ VTID extraction from PR title, branch name, commit messages
- ✅ Handles events: `workflow_run`, `check_run`, `pull_request`, `push`
- ✅ Status mapping (queued → in_progress → success/failure/cancelled)
- ✅ Automatic OASIS persistence
- ✅ Error handling with fallback to UNSET VTID

**Endpoint**: `POST /webhooks/github`

### A1.2 - Route Registration
**File**: `services/gateway/src/index.ts`
- ✅ Webhooks router imported and registered
- ✅ Startup logs updated

### A1.3 - Schema Migration
**File**: `prisma/migrations/20251029_oasis_events_phase2.sql`
- ✅ Idempotent column additions (vtid, layer, module, source, kind, status, title, ref, link, meta)
- ✅ Indexes for performance
- ✅ Check constraints for status values
- ✅ RLS policies updated

### A1.4 - GitHub Push
- ✅ Branch created: `vt/DEV-CICDL-0031-phase2`
- ✅ All files committed and pushed

---

## 🔧 SETUP REQUIRED

### 1. Apply Database Migration

```bash
# In Cloud Shell
cd ~/vitana-platform
psql "$(gcloud secrets versions access latest --secret=SUPABASE_DB_URL)" \
  -f prisma/migrations/20251029_oasis_events_phase2.sql
```

### 2. Create GitHub Webhook Secret

```bash
# Generate a strong secret
WEBHOOK_SECRET=$(openssl rand -hex 32)

# Store in GCP Secret Manager
echo -n "$WEBHOOK_SECRET" | \
  gcloud secrets create GITHUB_WEBHOOK_SECRET --data-file=- --replication-policy=automatic

# Or update existing:
echo -n "$WEBHOOK_SECRET" | \
  gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=-

# Save this secret - you'll need it for GitHub webhook config
echo "Your webhook secret: $WEBHOOK_SECRET"
```

### 3. Deploy Gateway with New Secret

```bash
cd ~/vitana-platform/services/gateway

gcloud run deploy vitana-gateway \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets="SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE=SUPABASE_SERVICE_ROLE:latest,SUPABASE_DB_URL=SUPABASE_DB_URL:latest,GITHUB_WEBHOOK_SECRET=GITHUB_WEBHOOK_SECRET:latest" \
  --memory 512Mi \
  --min-instances 1
```

### 4. Configure GitHub Webhook

**URL**: `https://vitana-gateway-86804897789.us-central1.run.app/webhooks/github`

**Steps**:
1. Go to: https://github.com/exafyltd/vitana-platform/settings/hooks
2. Click "Add webhook"
3. **Payload URL**: `https://vitana-gateway-86804897789.us-central1.run.app/webhooks/github`
4. **Content type**: `application/json`
5. **Secret**: (paste the webhook secret from step 2)
6. **Events**: Select individual events:
   - ✅ Workflow runs
   - ✅ Check runs
   - ✅ Pull requests
   - ✅ Pushes
7. ✅ Active
8. Click "Add webhook"

### 5. Test Webhook

```bash
# Trigger a test event (create a test PR or push to any branch)
# Then check if it appears:

curl "https://vitana-gateway-86804897789.us-central1.run.app/api/v1/devhub/feed" | head -20

# Or query OASIS directly:
curl "https://vitana-gateway-86804897789.us-central1.run.app/events?source=github.actions&limit=10"
```

---

## ⏳ IN PROGRESS

### A2: GCP Deploys → OASIS
- Creating deploy watcher service

### A3: Agent Heartbeats
- Adding heartbeat endpoints to agents

### A4: API Endpoint
- Creating `GET /api/v1/oasis/events?vtid=<VTID>`

### A5: Security/Resilience
- Rate limiting
- CORS configuration

---

## 📊 WEBHOOK EVENT FLOW

```
GitHub Action triggers
  ↓
GitHub sends webhook to /webhooks/github
  ↓
Gateway verifies HMAC signature
  ↓
Extracts VTID from PR title/branch/commit
  ↓
Normalizes event data
  ↓
Persists to oasis_events table
  ↓
SSE feed automatically streams to Live Console
  ↓
User sees event in real-time UI
```

---

## 🎯 EXAMPLE WEBHOOK PAYLOADS

### Workflow Run
```json
{
  "vtid": "DEV-CICDL-0031",
  "layer": "CICDL",
  "module": "WORKFLOW",
  "source": "github.actions",
  "kind": "workflow_run",
  "status": "success",
  "title": "CICDL-WORKFLOW-COMPLETED",
  "ref": "vt/DEV-CICDL-0031-phase2",
  "link": "https://github.com/exafyltd/vitana-platform/actions/runs/123",
  "meta": {
    "workflow_name": "Deploy Gateway",
    "run_number": 42,
    "repository": "exafyltd/vitana-platform"
  }
}
```

### Pull Request
```json
{
  "vtid": "DEV-CICDL-0031",
  "layer": "CICDL",
  "module": "PR",
  "source": "github.actions",
  "kind": "pull_request",
  "status": "success",
  "title": "CICDL-PR-MERGED",
  "ref": "vt/DEV-CICDL-0031-phase2",
  "link": "https://github.com/exafyltd/vitana-platform/pull/22",
  "meta": {
    "pr_number": 22,
    "pr_title": "[VTID DEV-CICDL-0031] Phase 2",
    "action": "closed",
    "merged": true
  }
}
```

---

**Branch**: `vt/DEV-CICDL-0031-phase2`  
**Status**: A1 Complete ✅ | A2-A5 In Progress ⏳  
**Next**: Apply migration → Deploy → Configure GitHub webhook → Test
