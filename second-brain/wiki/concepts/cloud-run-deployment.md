# Cloud Run Deployment

> Cloud Run deployment model for the Vitana platform: services, URLs, the dual-deploy pattern, and the cleanup of legacy services.

## Content

### GCP Infrastructure

| Setting | Value |
|---------|-------|
| GCP Project ID | `lovable-vitana-vers1` |
| Region | `us-central1` |
| Artifact Registry | `us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/` |
| Health Endpoint | `/alive` (never `/healthz`) |
| Port | `8080` |

### Golden Services (KEEP)

These are the active, production Cloud Run services:

| Service | URL Pattern | Deployed By | Purpose |
|---------|-------------|-------------|---------|
| `gateway` | `gateway-q74ibpv6ia-uc.a.run.app` | EXEC-DEPLOY.yml | Main API gateway + Command Hub |
| `community-app` | `community-app-*.run.app` | DEPLOY.yml (vitana-v1) | Frontend community app |
| `oasis-operator` | `oasis-operator-86804897789.us-central1.run.app` | Manual/Cloud Build | OASIS operator service |
| `oasis-projector` | `oasis-projector-86804897789.us-central1.run.app` | Manual/Cloud Build | OASIS projector service |

### Satellite Services (Verify Traffic)

| Service | Purpose | Status |
|---------|---------|--------|
| `vitana-memory-indexer` | Memory indexing for agents | KEEP (verify traffic) |
| `auto-logger` | Automatic logging | KEEP (verify traffic) |
| `vitana-dev-gateway` | Legacy URL redirector | DEPRECATE |

### Dual-Deploy Pattern (Community App)

The community app (vitana-v1) currently deploys to two hosts simultaneously on push to `main`:

1. **Cloud Run** (`community-app` service) -- via `.github/workflows/DEPLOY.yml` (new, being verified)
2. **Lovable CDN** (`vitana-lovable-vers1.lovable.app`) -- auto-deploy on push (legacy fallback)

Once Cloud Run is fully verified, the Lovable CDN will be decommissioned.

### Legacy Services (Deprecated -- VTID-01176)

The following services use the old `7h42a5ucbq` URL format and have had their code references removed:

- `vitana-oasis` -- superseded by `oasis-operator`
- `vitana-planner` -- no longer in use
- `vitana-worker` -- no longer in use
- `vitana-validator` -- no longer in use
- `vitana-memory` -- superseded by `vitana-memory-indexer`

These services are pending traffic verification and deletion from Cloud Run.

### Deploy Commands

```bash
# Resolve gateway URL dynamically
gcloud run services describe gateway \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format="value(status.url)"

# Deploy a service
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/<service>:latest \
  --project lovable-vitana-vers1

gcloud run deploy <service> \
  --image us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/<service>:latest \
  --region us-central1 \
  --project lovable-vitana-vers1
```

### Migration Roadmap

1. **Phase 1 (current):** Cloud Run `community-app` deploys alongside Lovable CDN.
2. **Phase 2:** Add preview deploy workflows (`--no-traffic --tag` on feature branches).
3. **Phase 3:** Expand Command Hub Publish modal for multi-service publish.
4. **Phase 4:** Backend API for preview status and operator publish.
5. **Lovable cleanup:** Remove `lovable-tagger`, `.lovable/`, cut over DNS.

## Related Pages

- [[cloud-run]]
- [[github-actions]]
- [[multi-repo-architecture]]
- [[lovable-cdn-vs-cloud-run]]
- [[vitana-v1]]
- [[vitana-platform]]

## Sources

- `raw/deployment/DEPLOY_WITH_ACTIONS.md`
- `raw/deployment/cloud-run-cleanup-inventory.md`
- `raw/deployment/VTID-01231-RECOVERY.md`
- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`

## Last Updated

2026-04-12
