# Cloud Run

> Cloud Run services for the Vitana platform: gateway, community-app, OASIS services, their URLs, and associated deploy workflows.

## Content

### Overview

All Vitana Cloud Run services run in GCP project `lovable-vitana-vers1`, region `us-central1`. Services listen on port `8080` and expose `/alive` as the health endpoint.

### Active Services

#### gateway

| Property | Value |
|----------|-------|
| Service Name | `gateway` |
| Canonical URL | `https://gateway-q74ibpv6ia-uc.a.run.app` |
| Alt URL | `https://gateway-86804897789.us-central1.run.app` |
| Source | `vitana-platform/services/gateway/` |
| Deploy Workflow | `EXEC-DEPLOY.yml` (governed, with VTID tracking) |
| Auto-deploy | `AUTO-DEPLOY.yml` on push to `main` |
| Serves | Backend API routes + Command Hub frontend |

#### community-app

| Property | Value |
|----------|-------|
| Service Name | `community-app` |
| Source | `vitana-v1/` (React SPA) |
| Deploy Workflow | `DEPLOY.yml` (source deploy on push to `main`) |
| Serves | Static Vite build via nginx |
| Note | Parallel deploys to Lovable CDN (legacy fallback) |

#### oasis-operator

| Property | Value |
|----------|-------|
| Service Name | `oasis-operator` |
| URL | `https://oasis-operator-86804897789.us-central1.run.app` |
| Source | `vitana-platform/services/oasis-operator/` |
| Deploy | Manual/Cloud Build |
| Referenced By | `natural-language-service.ts`, `gateway-events-api.ts` |

#### oasis-projector

| Property | Value |
|----------|-------|
| Service Name | `oasis-projector` |
| URL | `https://oasis-projector-86804897789.us-central1.run.app` |
| Source | `vitana-platform/services/oasis-projector/` |
| Deploy | Manual/Cloud Build |

### Satellite Services

| Service | Purpose | Status |
|---------|---------|--------|
| `vitana-memory-indexer` | Memory indexing (VTID-01153) | KEEP (verify traffic) |
| `auto-logger` | Automatic logging | KEEP (verify traffic) |
| `vitana-dev-gateway` | Legacy URL redirector | DEPRECATE |

### Deprecated Services (VTID-01176)

Code references removed 2026-01-15. Pending traffic verification and deletion:

| Service | Old URL | Superseded By |
|---------|---------|---------------|
| `vitana-oasis` | `vitana-oasis-7h42a5ucbq-uc.a.run.app` | oasis-operator |
| `vitana-planner` | `vitana-planner-7h42a5ucbq-uc.a.run.app` | -- |
| `vitana-worker` | `vitana-worker-7h42a5ucbq-uc.a.run.app` | -- |
| `vitana-validator` | `vitana-validator-7h42a5ucbq-uc.a.run.app` | -- |
| `vitana-memory` | `vitana-memory-7h42a5ucbq-uc.a.run.app` | vitana-memory-indexer |

### Service Path Map

From `config/service-path-map.json`:

| Service Key | Source Path | Deployable |
|-------------|-------------|------------|
| gateway | `services/gateway/` | true |
| oasis-operator | `services/oasis-operator/` | true |
| oasis-projector | `services/oasis-projector/` | true |
| agents | `services/agents/` | false |
| mcp | `services/mcp/` | false |
| mcp-gateway | `services/mcp-gateway/` | false |
| deploy-watcher | `services/deploy-watcher/` | false |

### Health Checks

```bash
curl https://gateway-q74ibpv6ia-uc.a.run.app/alive
curl https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/worker/orchestrator/health
curl https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/oasis/vtid-ledger?limit=1
```

## Related Pages

- [[cloud-run-deployment]]
- [[github-actions]]
- [[vitana-platform]]
- [[vitana-v1]]
- [[api-gateway-pattern]]
- [[lovable-cdn-vs-cloud-run]]

## Sources

- `raw/deployment/cloud-run-cleanup-inventory.md`
- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`

## Last Updated

2026-04-12
