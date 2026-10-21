# ADR: Repository Canonical Structure

> ADR-001 establishing the canonical directory structure for the vitana-platform repository, with naming conventions and migration strategy.

## Content

### Decision Record

| Field | Value |
|-------|-------|
| ADR Number | ADR-001 |
| Status | Accepted |
| Date | 2025-10-29 |
| VTID | DEV-CICDL-0033 |
| Phase | 2C - Runtime Fabric Enforcement |

### Context

The Vitana Platform repository grew organically with services, packages, and utilities spread across multiple locations. To prepare for monorepo consolidation (Phase 2D) and establish long-term maintainability, a canonical directory structure was needed that:

1. Separates concerns clearly (services vs. packages vs. docs).
2. Supports both monolithic and microservices architectures.
3. Enables efficient CI/CD pipelines.
4. Facilitates developer onboarding.
5. Scales to 100+ services.

### Decision

The following canonical structure was established:

```
vitana-platform/
  services/              # All deployable services
    gateway/             # API Gateway
    oasis-operator/      # OASIS operator
    oasis-projector/     # OASIS projector
    agents/              # Agent services (crew/planner/worker/validator)
    mcp/                 # Model Context Protocol servers
    deploy-watcher/      # Deploy monitor
  packages/              # Shared libraries
    openapi/             # OpenAPI specifications
    llm-router/          # LLM routing utility
    agent-heartbeat.ts   # Agent telemetry
  skills/                # Claude skills (public/private/examples)
  tasks/                 # VTID task definitions
  docs/                  # Documentation
    decisions/           # ADRs
    reports/             # Phase reports
    runbooks/            # Operational procedures
  .github/workflows/     # CI/CD (UPPERCASE names)
  scripts/               # Operational scripts
  database/              # Migrations and RLS policies
  prisma/                # Prisma ORM
```

### Naming Conventions (Phase 2B Compliance)

| Target | Convention | Example |
|--------|-----------|---------|
| Service directories | `kebab-case` | `content-generation` |
| Service manifest name | `UPPERCASE-WITH-HYPHENS` | `AGENT-PLANNER-CORE` |
| Package directories | `kebab-case` | `llm-router` |
| Workflow files | `UPPERCASE-WITH-HYPHENS.yml` | `DEPLOY-GATEWAY.yml` |
| ADRs | `ADR-NNN-kebab-case-title.md` | `ADR-001-REPO-CANON-V1.md` |

Every service must have a `manifest.json` with `name`, `vt_layer`, and `vt_module` fields.

### Migration Strategy

The migration is phased:

1. **Stage 1 (Phase 2C -- done):** scaffold target directory structure, add READMEs, document mapping. No code moves.
2. **Stage 2 (Phase 2D.1):** move OpenAPI specs from `specs/` to `packages/openapi/`.
3. **Stage 3 (Phase 2D.2):** organize scattered docs into `docs/decisions/`, `docs/reports/`, `docs/runbooks/`.
4. **Stage 4 (Phase 2D.3):** update import paths in all services and CI workflows.
5. **Stage 5 (Phase 2D.4):** cleanup empty directories, update READMEs, archive deprecated files.

**Key insight:** most of the structure is already correct. Phase 2D primarily moves specs and organizes documentation.

### Consequences

**Positive:**
- Clear separation of concerns.
- Scalable to 100+ services.
- CI/CD friendly (tools can target `services/**`).
- Fast developer onboarding.
- Monorepo ready.

**Negative:**
- Migration effort in Phase 2D.
- Some import paths will change.
- CI workflows may need path updates.

**Neutral:**
- No immediate code changes (Phase 2C scaffolds only).
- Backward compatible during transition.

### CI Enforcement

- `CICDL-CORE-LINT-SERVICES.yml` validates `/services/**` structure.
- `CICDL-CORE-OPENAPI-ENFORCE.yml` validates OpenAPI specs.
- `PHASE-2B-NAMING-ENFORCEMENT.yml` validates naming conventions.

### Approval

Approved by CEO/CTO upon Phase 2C PR merge. Next ADR: ADR-002 (Monorepo Merge Strategy).

## Related Pages

- [[vitana-platform]]
- [[multi-repo-architecture]]
- [[vtid-governance]]
- [[github-actions]]

## Sources

- `raw/governance/ADR-001-REPO-CANON-V1.md`

## Last Updated

2026-04-12
