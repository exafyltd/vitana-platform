# vitana-platform

> The backend repository: Express API gateway, OASIS services, Command Hub, CI/CD pipelines, and the canonical deployment infrastructure.

## Content

### Identity

| Property | Value |
|----------|-------|
| Repository | `exafyltd/vitana-platform` |
| Role | Backend gateway + Command Hub + CI/CD + OASIS |
| Primary Cloud Run Service | `gateway` |
| GCP Project | `lovable-vitana-vers1` |
| Region | `us-central1` |

### What It Contains

1. **Gateway API** (`services/gateway/`) -- the central Express API serving all `/api/v1/` routes.
2. **Command Hub frontend** (`services/gateway/src/frontend/command-hub/`) -- vanilla JS operator/developer UI served by the gateway.
3. **OASIS services** (`services/oasis-operator/`, `services/oasis-projector/`) -- telemetry and event system.
4. **Agent services** (`services/agents/`) -- CrewAI agents, memory indexer, conductor, validator.
5. **CI/CD workflows** (`.github/workflows/`) -- AUTO-DEPLOY, EXEC-DEPLOY, CI checks.
6. **Database migrations** (`database/migrations/`, `database/policies/`) -- SQL migrations and RLS policies.
7. **Scripts** (`scripts/`) -- CI, deploy, and dev tools.
8. **Packages** (`packages/`) -- shared libraries (llm-router, agent-heartbeat, OpenAPI specs).

### Canonical Directory Structure (ADR-001)

```
vitana-platform/
  services/           # All deployable services
    gateway/          # API Gateway (primary)
    oasis-operator/   # OASIS operator
    oasis-projector/  # OASIS projector
    agents/           # Agent implementations
    deploy-watcher/   # Deploy monitor
  packages/           # Shared libraries
  skills/             # Claude skills
  tasks/              # VTID task definitions
  docs/               # Documentation (ADRs, reports, runbooks)
  .github/workflows/  # CI/CD (UPPERCASE names)
  scripts/            # Operational scripts
  database/           # Migrations and policies
  prisma/             # Prisma ORM
```

### Deployable Services

| Service | Source Path | Cloud Run Name |
|---------|-------------|----------------|
| Gateway | `services/gateway/` | `gateway` |
| OASIS Operator | `services/oasis-operator/` | `oasis-operator` |
| OASIS Projector | `services/oasis-projector/` | `oasis-projector` |
| Verification Engine | `services/agents/vitana-orchestrator/` | `vitana-verification-engine` |
| Worker Runner | `services/worker-runner/` | `worker-runner` |

### Environment Variables (Gateway)

Key variables set during deploy:

| Variable | Source |
|----------|--------|
| `SUPABASE_URL` | GCP Secret Manager |
| `SUPABASE_SERVICE_ROLE` | GCP Secret Manager |
| `SUPABASE_JWT_SECRET` | GCP Secret Manager |
| `GOOGLE_GEMINI_API_KEY` | GCP Secret Manager |
| `LOVABLE_SUPABASE_URL` | Env var |
| `LOVABLE_SUPABASE_SERVICE_ROLE` | Env var |
| `GCP_PROJECT_ID` | `lovable-vitana-vers1` |
| `ENVIRONMENT` | `dev-sandbox` |

### Git Workflow

- Feature branches: `claude/{feature}-{id}`
- PRs merge to `main` via squash.
- AUTO-DEPLOY triggers on `main` push when `services/gateway/**` or `apps/web/**` changes.
- EXEC-DEPLOY is the canonical governed deploy pipeline.
- Push retry: up to 4 times with exponential backoff (2s, 4s, 8s, 16s).

### E2E Testing

- Config: `e2e/playwright.config.ts` -- 16 projects (desktop/mobile per role + shared + hub).
- Auth: API-based via Supabase REST (`POST /auth/v1/token`).
- Test user: `e2e-test@vitana.dev` with `exafy_admin: true`.
- Run: `cd e2e && npx playwright test --project=desktop-community`.
- CI: `.github/workflows/E2E-TEST-RUN.yml`.

## Related Pages

- [[vitana-v1]]
- [[multi-repo-architecture]]
- [[api-gateway-pattern]]
- [[cloud-run]]
- [[github-actions]]
- [[supabase]]
- [[vtid-governance]]
- [[summary-vitana-platform-claude]]
- [[adr-repo-canonical-structure]]

## Sources

- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`
- `raw/governance/ADR-001-REPO-CANON-V1.md`

## Last Updated

2026-04-12
