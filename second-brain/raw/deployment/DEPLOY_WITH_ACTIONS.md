# Canonical CI/CD Pipeline

**VTID:** VTID-01175 (cleanup) | SYS-RULE-DEPLOY-L1

## How We Deploy

**Single canonical path:** `AUTO-DEPLOY.yml` → `EXEC-DEPLOY.yml`

```
Push to main (services/gateway/**)
        ↓
AUTO-DEPLOY.yml (extracts VTID from commit)
        ↓
EXEC-DEPLOY.yml (governed deploy)
        ↓
Cloud Run deployment
```

### Deploy Workflow

1. **AUTO-DEPLOY.yml** - Triggers on push to `main` when `services/gateway/**` changes
   - Extracts VTID from commit message
   - Dispatches `EXEC-DEPLOY.yml`

2. **EXEC-DEPLOY.yml** - Canonical governed deployment (workflow_dispatch only)
   - VTID existence check (task must exist in OASIS)
   - Governance evaluation
   - Cloud Run source deploy
   - Post-deploy smoke tests
   - OASIS terminal completion gate

### No Other Deploy Paths

All non-canonical deploy workflows were removed in VTID-01170/VTID-01175:
- ~~DEPLOY-MCP-GATEWAY.yml~~ (deleted)
- ~~AUTODEPLOY-COMMAND-HUB.yml~~ (deleted)
- ~~VTID-FIX-E2E.yml~~ (deleted)

## How We Merge Safely

**PR review required.** No auto-merge workflows exist.

1. Create a feature branch (e.g., `claude/feature-name-xxxxx`)
2. Open a PR to `main`
3. CI workflows validate the PR
4. Human review and approval required
5. Merge via GitHub UI
6. AUTO-DEPLOY triggers on main push

### CI Workflows (PR validation)

| Workflow | Purpose |
|----------|---------|
| CICDL-GATEWAY-CI | Gateway build/lint/typecheck |
| VALIDATOR-CHECK | PR governance validation |
| COMMAND-HUB-GUARDRAILS | Command Hub ownership guards |
| OASIS-PERSISTENCE | Gateway tests |
| UNIT | Basic unit tests |

## Workflow Inventory

### Deploy Chain (2)
- `AUTO-DEPLOY.yml` - Entry point
- `EXEC-DEPLOY.yml` - Canonical deployer

### CI Workflows (12)
- `APPLY-MIGRATIONS.yml`
- `CICDL-CORE-LINT-SERVICES.yml`
- `CICDL-CORE-OPENAPI-ENFORCE.yml`
- `CICDL-GATEWAY-CI.yml`
- `COMMAND-HUB-GUARDRAILS.yml`
- `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`
- `MCP-GATEWAY-CI.yml`
- `OASIS-PERSISTENCE.yml`
- `PHASE-2B-DOC-GATE.yml`
- `PHASE-2B-NAMING-ENFORCEMENT.yml`
- `UNIT.yml`
- `VALIDATOR-CHECK.yml`

### Utility (2)
- `DAILY-STATUS-UPDATE.yml` - Scheduled status updates
- `REUSABLE-NOTIFY.yml` - Reusable notification helper
