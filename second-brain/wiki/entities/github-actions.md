# GitHub Actions

> CI/CD workflows for the Vitana platform: the AUTO-DEPLOY / EXEC-DEPLOY deploy chain, CI validation workflows, E2E testing, and utility workflows.

## Content

### Deploy Chain

The canonical deployment path is: `AUTO-DEPLOY.yml` -> `EXEC-DEPLOY.yml`.

```
Push to main (services/gateway/**)
        |
AUTO-DEPLOY.yml (extracts VTID from commit)
        |
EXEC-DEPLOY.yml (governed deploy)
        |
Cloud Run deployment
```

#### AUTO-DEPLOY.yml

- **Triggers on:** push to `main` when `services/gateway/**` or `apps/web/**` changes.
- **Does:** extracts VTID from commit message, dispatches `EXEC-DEPLOY.yml`.
- **Fallback:** if no VTID in commit, uses `BOOTSTRAP-AUTO-{sha}`.
- **Important:** AUTO-DEPLOY success does NOT mean code was deployed -- must check EXEC-DEPLOY.

#### EXEC-DEPLOY.yml

- **Triggers:** `workflow_dispatch` only (called by AUTO-DEPLOY or manual).
- **Steps:**
  1. VTID existence check (task must exist in OASIS ledger -- VTID-0542 hard gate).
  2. Governance evaluation (VTID-0416).
  3. Cloud Run source deploy (`gcloud run deploy gateway`).
  4. Post-deploy smoke tests.
  5. OASIS terminal completion gate.
- **Deploys:** backend API + Command Hub frontend together (same Docker image).

### Community App Deploy (vitana-v1)

#### DEPLOY.yml

- **Repo:** `exafyltd/vitana-v1`
- **Triggers on:** push to `main`.
- **Does:** source deploy to Cloud Run `community-app` service.
- **Also:** Lovable CDN auto-deploys on push to `main` (legacy fallback).

#### E2E-TEST-RUN.yml

- **Triggers:** manual dispatch or `repository_dispatch` from vitana-v1 deploy.
- **Config:** `e2e/playwright.config.ts` -- 16 projects (desktop/mobile per role).
- **Auth:** API-based via Supabase REST.
- **Test user:** `e2e-test@vitana.dev`.

### CI Validation Workflows (PR checks)

| Workflow | Purpose |
|----------|---------|
| `CICDL-GATEWAY-CI.yml` | Gateway build/lint/typecheck |
| `VALIDATOR-CHECK.yml` | PR governance validation |
| `COMMAND-HUB-GUARDRAILS.yml` | Command Hub ownership guards + golden fingerprint |
| `OASIS-PERSISTENCE.yml` | Gateway tests |
| `UNIT.yml` | Basic unit tests |
| `APPLY-MIGRATIONS.yml` | Database migration checks |
| `CICDL-CORE-LINT-SERVICES.yml` | Service linting |
| `CICDL-CORE-OPENAPI-ENFORCE.yml` | OpenAPI spec validation |
| `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` | Frontend source enforcement |
| `MCP-GATEWAY-CI.yml` | MCP Gateway CI |
| `PHASE-2B-DOC-GATE.yml` | Documentation gate |
| `PHASE-2B-NAMING-ENFORCEMENT.yml` | Naming convention enforcement |

### Utility Workflows

| Workflow | Purpose |
|----------|---------|
| `DAILY-STATUS-UPDATE.yml` | Scheduled status updates |
| `REUSABLE-NOTIFY.yml` | Reusable notification helper |

### Deleted Workflows (VTID-01170/01175)

All non-canonical deploy workflows were removed:
- ~~DEPLOY-MCP-GATEWAY.yml~~
- ~~AUTODEPLOY-COMMAND-HUB.yml~~
- ~~VTID-FIX-E2E.yml~~

### Key Environment Variables Set by EXEC-DEPLOY

Secrets from GCP Secret Manager:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY`
- `GOOGLE_GEMINI_API_KEY`

Env vars:
- `LOVABLE_SUPABASE_URL`, `LOVABLE_SUPABASE_SERVICE_ROLE`
- `GCP_PROJECT_ID=lovable-vitana-vers1`
- `ENVIRONMENT=dev-sandbox`

### Merge Process

1. Create feature branch (`claude/{feature}-{id}`).
2. Open PR to `main`.
3. CI workflows validate the PR.
4. Human review and approval required.
5. Merge via GitHub UI (squash).
6. AUTO-DEPLOY triggers on main push.

No auto-merge workflows exist. PR review is always required.

## Related Pages

- [[cloud-run-deployment]]
- [[cloud-run]]
- [[vitana-platform]]
- [[vtid-governance]]
- [[multi-repo-architecture]]

## Sources

- `raw/deployment/DEPLOY_WITH_ACTIONS.md`
- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`

## Last Updated

2026-04-12
