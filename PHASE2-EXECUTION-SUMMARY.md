# VTID: DEV-CICDL-0031 Phase 2 - Execution Summary

## 🎯 MISSION STATUS: A) LIVE EVENTS - 80% COMPLETE

### ✅ COMPLETED COMPONENTS

#### A1: GitHub → Gateway → OASIS ✅
**File**: `services/gateway/src/routes/webhooks.ts`
- ✅ HMAC SHA-256 signature verification
- ✅ VTID extraction (PR title → branch → commit → fallback UNSET)
- ✅ Handles: workflow_run, check_run, pull_request, push
- ✅ Status normalization (queued/in_progress/success/failure/cancelled)
- ✅ Auto-persist to oasis_events
- ✅ SSE auto-stream via existing feed

**Endpoint**: `POST /webhooks/github`

#### A3: Agent Heartbeat System ✅
**File**: `packages/agent-heartbeat.ts`
- ✅ Reusable utility for any agent service
- ✅ 60-second interval heartbeats
- ✅ VTID tracking (IDLE when not processing)
- ✅ Auto-coalescing (no spam when idle)
- ✅ Start/stop/update VTID functions

**Usage**: Import and call `startHeartbeat()` in agent services

#### A4: OASIS Events Query API ✅
**File**: `services/gateway/src/routes/events.ts`
- ✅ Endpoint: `GET /api/v1/oasis/events`
- ✅ Query params: vtid, limit, offset, source, kind, status, layer
- ✅ X-VTID header echo
- ✅ Descending timestamp order

**Example**: `GET /api/v1/oasis/events?vtid=DEV-CICDL-0031&limit=200`

#### A2: GCP Deploy Watcher ✅ (Structure Created)
**File**: `services/deploy-watcher/src/index.ts`
- ✅ Cloud Run service structure
- ✅ `/poll` endpoint for Cloud Scheduler
- ✅ VTID extraction from labels
- ✅ Auto-publish to OASIS
- ⚠️ Needs: Cloud Logging client implementation

### ⏳ PENDING DEPLOYMENT TASKS

#### 1. Apply Database Migration
```bash
cd ~/vitana-platform
git pull origin vt/DEV-CICDL-0031-phase2

psql "$(gcloud secrets versions access latest --secret=SUPABASE_DB_URL)" \
  -f prisma/migrations/20251029_oasis_events_phase2.sql
```

#### 2. Create GitHub Webhook Secret
```bash
# Generate secret
WEBHOOK_SECRET=$(openssl rand -hex 32)

# Store in GCP (create or update)
echo -n "$WEBHOOK_SECRET" | \
  gcloud secrets create GITHUB_WEBHOOK_SECRET --data-file=- --replication-policy=automatic \
  || echo -n "$WEBHOOK_SECRET" | gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=-

# SAVE THIS - you'll need it for GitHub:
echo "Webhook Secret: $WEBHOOK_SECRET"
```

#### 3. Deploy Gateway with Webhook Support
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

#### 4. Configure GitHub Webhook
**URL**: `https://vitana-gateway-86804897789.us-central1.run.app/webhooks/github`

**Steps**:
1. Go to: https://github.com/exafyltd/vitana-platform/settings/hooks
2. Click "Add webhook"
3. Payload URL: `https://vitana-gateway-86804897789.us-central1.run.app/webhooks/github`
4. Content type: `application/json`
5. Secret: (paste webhook secret from step 2)
6. Events: ✅ Workflow runs, ✅ Check runs, ✅ Pull requests, ✅ Pushes
7. Active: ✅
8. Add webhook

#### 5. Test Live Events
```bash
# Test webhook health
curl https://vitana-gateway-86804897789.us-central1.run.app/webhooks/health

# Create a test PR or push to trigger event
# Then watch SSE feed:
curl -N https://vitana-gateway-86804897789.us-central1.run.app/api/v1/devhub/feed

# Query OASIS for GitHub events:
curl "https://vitana-gateway-86804897789.us-central1.run.app/api/v1/oasis/events?source=github.actions&limit=10"
```

---

## 🎯 MISSION STATUS: B) REPO STANDARDIZATION - NOT STARTED

### ⏳ TO DO

#### B1: Catalog Structure
- Reorganize into services/, packages/, skills/
- Move agent services
- Create OpenAPI specs folder

#### B2: Naming & VTID Enforcement CI
- Create lint workflows (UPPERCASE names)
- Add run-name with VTID
- Auto-rename non-compliant files

#### B3: Cloud Run Labels
- Add vtid, vt_layer, vt_module labels to all deploys
- Create ensure-vtid.sh guard script

#### B4: OpenAPI Specs
- Create gateway-v1.yml
- Create oasis-v1.yml
- Add spectral validation

---

## 📦 FILES CHANGED (Phase 2A)

### New Files
1. `services/gateway/src/routes/webhooks.ts` - GitHub webhook endpoint
2. `packages/agent-heartbeat.ts` - Agent heartbeat utility
3. `services/deploy-watcher/src/index.ts` - GCP deploy watcher
4. `prisma/migrations/20251029_oasis_events_phase2.sql` - Schema updates
5. `PHASE2-PROGRESS.md` - Progress tracking

### Modified Files
1. `services/gateway/src/index.ts` - Added webhooks router
2. `services/gateway/src/routes/events.ts` - Added OASIS query API

---

## 🔄 EVENT FLOW DIAGRAM

```
┌─────────────────┐
│  GitHub Action  │
└────────┬────────┘
         │ webhook
         ▼
┌─────────────────┐
│  POST /webhooks │
│  /github        │
└────────┬────────┘
         │ verify HMAC
         │ extract VTID
         ▼
┌─────────────────┐
│  oasis_events   │ ◄─── POST /events/ingest (agents)
│  (Supabase)     │ ◄─── POST /events/ingest (GCP watcher)
└────────┬────────┘
         │
         │ auto-stream
         ▼
┌─────────────────┐
│  SSE Feed       │
│  /devhub/feed   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Live Console   │
│  (Lovable UI)   │
└─────────────────┘
```

---

## ✅ ACCEPTANCE CRITERIA

### A) Live Events (In Progress)

- [ ] Database migration applied successfully
- [ ] GitHub webhook configured and receiving events
- [ ] Test workflow run appears in Live Console within 5s
- [ ] GCP deploy event appears after any Cloud Run deployment
- [ ] Agent heartbeats visible every 60s
- [ ] `/api/v1/oasis/events?vtid=DEV-CICDL-0031` returns normalized rows
- [ ] Live Console switches from OFFLINE (mock) to LIVE

### B) Repo Standardization (Not Started)

- [ ] All GitHub Actions show UPPERCASE names only
- [ ] No workflow files violate naming canon
- [ ] Cloud Run services have vtid labels
- [ ] OpenAPI specs pass spectral validation
- [ ] Single PR with all changes merged

---

## 📋 DELIVERABLES

### Ready Now
1. ✅ GitHub webhook endpoint code
2. ✅ Agent heartbeat utility
3. ✅ OASIS query API
4. ✅ GCP deploy watcher structure
5. ✅ Schema migration SQL
6. ✅ Branch: `vt/DEV-CICDL-0031-phase2`

### After Deployment
1. Live webhook URL + example payload
2. Screenshot/JSON of GitHub event in Live Console
3. Screenshot/JSON of GCP deploy event
4. Confirmation that Live Console shows "LIVE" status

---

## 🚀 NEXT STEPS

### Immediate (Deploy Phase 2A)
1. Pull latest code: `git pull origin vt/DEV-CICDL-0031-phase2`
2. Apply migration (step 1 above)
3. Create webhook secret (step 2 above)
4. Deploy gateway (step 3 above)
5. Configure GitHub webhook (step 4 above)
6. Test and verify (step 5 above)

### Future (Phase 2B - Repo Standardization)
- Only proceed after Phase 2A is confirmed working
- Await CEO approval before starting B tasks

---

**Branch**: `vt/DEV-CICDL-0031-phase2`  
**Status**: Core Implementation Complete ✅ | Deployment Pending ⏳  
**Blocked On**: Manual deployment steps 1-5

---

**Prepared by**: Claude (Autonomous Agent)  
**Completion**: Phase 2A Code Complete  
**Ready for**: CEO Deployment → Verification → Phase 2B
