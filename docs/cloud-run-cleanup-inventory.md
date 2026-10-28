# Cloud Run Cleanup Inventory

**VTID:** VTID-01176
**Date:** 2026-01-15
**Project:** lovable-vitana-vers1
**Region:** us-central1

## Executive Summary

This document provides the authoritative inventory of Cloud Run services for the Vitana platform cleanup task. Services are classified as KEEP, DEPRECATE, or DELETE based on code analysis, workflow references, and active usage patterns.

---

## 1. Service Classification

### KEEP (Golden Services)

These services are actively referenced, deployed via canonical workflows, and required for runtime.

| Service | URL Pattern | Last Deployed By | References | Status |
|---------|-------------|------------------|------------|--------|
| **gateway** | `gateway-*.run.app` | EXEC-DEPLOY.yml | Main API gateway, Command Hub, OASIS proxy | **KEEP** |
| **oasis-operator** | `oasis-operator-86804897789.us-central1.run.app` | Manual/Cloud Build | Referenced in `natural-language-service.ts`, `gateway-events-api.ts` | **KEEP** |
| **oasis-projector** | `oasis-projector-86804897789.us-central1.run.app` | Manual/Cloud Build | Referenced in docs, has service path mapping | **KEEP** |

### KEEP (Active Satellite Services)

These services have deployment configs and are referenced by gateway but need traffic verification.

| Service | URL Pattern | Deployment Config | References | Status |
|---------|-------------|-------------------|------------|--------|
| **vitana-memory-indexer** | `vitana-memory-indexer-*.run.app` | `services/agents/memory-indexer/cloudbuild.yaml` | `memory-indexer-client.ts` (VTID-01153) | **KEEP** (verify traffic) |
| **auto-logger** | `auto-logger-*.run.app` | `services/gateway/cloudbuild.auto-logger.yaml` | `auto-logger-*.ts` files in gateway | **KEEP** (verify traffic) |
| **vitana-dev-gateway** | `vitana-dev-gateway-86804897789.us-central1.run.app` | Code in `gateway/src/index.ts` | Redirector for legacy URLs | **DEPRECATE** (see below) |

### DEPRECATE (Legacy Services - Remove References First)

These services use old URL formats and are only referenced in legacy scripts.

| Service | Old URL | Only Referenced In | Action Required |
|---------|---------|-------------------|-----------------|
| vitana-oasis | `vitana-oasis-7h42a5ucbq-uc.a.run.app` | `scripts/ci/collect-status.py` | Remove reference, then delete |
| vitana-planner | `vitana-planner-7h42a5ucbq-uc.a.run.app` | `scripts/ci/collect-status.py` | Remove reference, then delete |
| vitana-worker | `vitana-worker-7h42a5ucbq-uc.a.run.app` | `scripts/ci/collect-status.py` | Remove reference, then delete |
| vitana-validator | `vitana-validator-7h42a5ucbq-uc.a.run.app` | `scripts/ci/collect-status.py` | Remove reference, then delete |
| vitana-memory | `vitana-memory-7h42a5ucbq-uc.a.run.app` | `scripts/ci/collect-status.py` | Remove reference, then delete |

### DELETE (After Verification)

Services that should be deleted from Cloud Run after confirming no traffic:

| Service | Reason | Checklist Status |
|---------|--------|------------------|
| vitana-oasis | Old URL format, superseded by oasis-operator | Pending verification |
| vitana-planner | Old URL format, not referenced in current code | Pending verification |
| vitana-worker | Old URL format, not referenced in current code | Pending verification |
| vitana-validator | Old URL format, not referenced in current code | Pending verification |
| vitana-memory | Old URL format, superseded by vitana-memory-indexer | Pending verification |
| vitana-dev-gateway | Redirector only, can be consolidated | Pending verification |

---

## 2. Canonical Service URLs

### Production Gateway (Canonical)
```
https://gateway-{hash}.us-central1.run.app
```
Resolved dynamically via: `gcloud run services describe gateway --region=us-central1 --format="value(status.url)"`

### Known Production URLs (86804897789 project hash)
- Gateway: `https://vitana-gateway-86804897789.us-central1.run.app`
- OASIS Operator: `https://oasis-operator-86804897789.us-central1.run.app`
- OASIS Projector: `https://oasis-projector-86804897789.us-central1.run.app`

---

## 3. Service Path Mapping (from config/service-path-map.json)

| Service Key | Source Path | Cloud Run Service | Deployable |
|-------------|-------------|-------------------|------------|
| gateway | `services/gateway/` | `gateway` | true |
| oasis-operator | `services/oasis-operator/` | `oasis-operator` | true |
| oasis-projector | `services/oasis-projector/` | `oasis-projector` | true |
| agents | `services/agents/` | `agents` | false |
| mcp | `services/mcp/` | `mcp` | false |
| mcp-gateway | `services/mcp-gateway/` | `mcp-gateway` | false |
| deploy-watcher | `services/deploy-watcher/` | `deploy-watcher` | false |
| oasis | `services/oasis/` | null | false |
| validators | `services/validators/` | null | false |

---

## 4. Proof-of-Unused Checklist

For each service in the DELETE list, verify ALL conditions:

### 4.1 Legacy Services (7h42a5ucbq format)

| Condition | vitana-oasis | vitana-planner | vitana-worker | vitana-validator | vitana-memory |
|-----------|--------------|----------------|---------------|------------------|---------------|
| Not in repo config | [x] Removed | [x] Removed | [x] Removed | [x] Removed | [x] Removed |
| Not in gateway env vars | [ ] Verify | [ ] Verify | [ ] Verify | [ ] Verify | [ ] Verify |
| Not targeted by workflows | [x] True | [x] True | [x] True | [x] True | [x] True |
| No recent traffic | [ ] Check logs | [ ] Check logs | [ ] Check logs | [ ] Check logs | [ ] Check logs |
| Not used by scheduled jobs | [ ] Verify | [ ] Verify | [ ] Verify | [ ] Verify | [ ] Verify |

### 4.2 vitana-dev-gateway Redirector

| Condition | Status |
|-----------|--------|
| Not in repo config | [x] True (only in index.ts as K_SERVICE check) |
| Not in gateway env vars | [ ] Verify |
| Not targeted by workflows | [x] True (not in EXEC-DEPLOY.yml) |
| No recent traffic | [ ] Check logs |
| Not used by scheduled jobs | [x] True |

---

## 5. Cleanup Actions Required

### Phase 1: Remove Code References (SAFE)

1. **Update `scripts/ci/collect-status.py`**
   - Remove old 7h42a5ucbq URLs
   - Replace with canonical service URLs

2. **Audit scripts referencing vitana-dev-gateway**
   - `scripts/verify-phase1.5.sh` - update to use canonical gateway

### Phase 2: Verify No Traffic (MANUAL)

Run these commands to check traffic before deletion:

```bash
# List all Cloud Run services
gcloud run services list --project=lovable-vitana-vers1 --region=us-central1

# Check logs for each legacy service (last 7 days)
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="vitana-oasis"' \
  --project=lovable-vitana-vers1 --limit=100 --freshness=7d

# Repeat for each legacy service:
# vitana-planner, vitana-worker, vitana-validator, vitana-memory, vitana-dev-gateway
```

### Phase 3: Controlled Deletion (AFTER VERIFICATION)

```bash
# Only after confirming no traffic
gcloud run services delete <service-name> \
  --project=lovable-vitana-vers1 \
  --region=us-central1 \
  --quiet
```

---

## 6. Verification Commands (Post-Cleanup)

```bash
# Resolve gateway URL
GATEWAY_URL=$(gcloud run services describe gateway \
  --project=lovable-vitana-vers1 \
  --region=us-central1 \
  --format="value(status.url)")

# Health checks
curl -s "$GATEWAY_URL/api/v1/worker/orchestrator/health" | jq
curl -s "$GATEWAY_URL/api/v1/worker/skills" | jq
curl -s "$GATEWAY_URL/api/v1/oasis/vtid-ledger?limit=1" | jq
```

---

## 7. Definition of Done

- [x] Golden services list documented
- [x] Legacy service references removed from code (VTID-01176)
- [ ] Legacy services verified unused (no traffic) - **MANUAL STEP REQUIRED**
- [ ] Legacy services deleted from Cloud Run - **AFTER TRAFFIC VERIFICATION**
- [x] Tombstone record created (see Appendix B)
- [ ] Verification health checks pass

---

## Appendix A: Files Updated (VTID-01176)

| File | Issue | Action Taken |
|------|-------|--------------|
| `scripts/ci/collect-status.py` | Old 7h42a5ucbq URLs | [x] Replaced with canonical gateway URLs |
| `scripts/verify-phase1.5.sh` | Used vitana-dev-gateway URL | [x] Updated to use canonical gateway |
| `scripts/ai/oasis_cop_register.py` | Used oasis-operator direct URL | [x] Updated to use gateway proxy |
| `scripts/ai/upload_to_oasis.py` | Used oasis-operator direct URL | [x] Updated to use gateway proxy |
| `services/gateway/src/services/gchat-notifier.ts` | Used vitana-dev-gateway URL | [x] Updated to canonical gateway |
| `services/gateway/src/middleware/cors.ts` | Missing canonical gateway URL | [x] Added canonical URL, documented deprecation |

---

## Appendix B: Tombstone Records

### Legacy Services Deprecated (VTID-01176)

The following service URLs were removed from codebase references on 2026-01-15:

| Service Name | Old URL | Reason for Deprecation | Status |
|--------------|---------|------------------------|--------|
| vitana-oasis | `https://vitana-oasis-7h42a5ucbq-uc.a.run.app` | Superseded by oasis-operator | References removed |
| vitana-planner | `https://vitana-planner-7h42a5ucbq-uc.a.run.app` | Legacy service, not in use | References removed |
| vitana-worker | `https://vitana-worker-7h42a5ucbq-uc.a.run.app` | Legacy service, not in use | References removed |
| vitana-validator | `https://vitana-validator-7h42a5ucbq-uc.a.run.app` | Legacy service, not in use | References removed |
| vitana-memory | `https://vitana-memory-7h42a5ucbq-uc.a.run.app` | Superseded by vitana-memory-indexer | References removed |

### Services Marked for Deprecation (Future Deletion)

| Service Name | URL | Reason | Scheduled Deletion |
|--------------|-----|--------|-------------------|
| vitana-dev-gateway | `https://vitana-dev-gateway-86804897789.us-central1.run.app` | Redirector only, all traffic should use canonical gateway | After traffic verification |

### Next Steps for Operator

1. **Verify no traffic** to legacy services using Cloud Logging
2. **Delete services** from Cloud Run after verification
3. **Update this document** with deletion timestamps

---

**Last Updated:** 2026-01-15
**Author:** Claude (VTID-01176)
