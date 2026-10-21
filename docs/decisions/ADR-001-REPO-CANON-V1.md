# ADR-001: Repository Canon V1

**Status:** Accepted  
**Date:** 2025-10-29  
**VTID:** DEV-CICDL-0033  
**Phase:** 2C - Runtime Fabric Enforcement

---

## Context

The Vitana Platform repository has grown organically with services, packages, and utilities spread across multiple locations. To prepare for the monorepo consolidation (Phase 2D) and establish long-term maintainability, we need a canonical directory structure that:

1. Separates concerns clearly (services vs. packages vs. docs)
2. Supports both monolithic and microservices architectures
3. Enables efficient CI/CD pipelines
4. Facilitates developer onboarding
5. Scales to 100+ services

---

## Decision

We establish the following **canonical directory structure** for the Vitana Platform repository:

```
vitana-platform/
├── services/                    # All deployable services
│   ├── agents/                  # Agent services
│   │   ├── <crew-name>/         # Agent crew (e.g., content-generation)
│   │   │   ├── planner/         # Planner role
│   │   │   ├── worker/          # Worker role
│   │   │   └── validator/       # Validator role
│   │   └── conductor/           # Conductor orchestrator
│   ├── mcp/                     # Model Context Protocol servers
│   │   └── <domain-purpose>/    # e.g., github-integration, slack-bot
│   ├── gateway/                 # API Gateway
│   ├── oasis/                   # OASIS telemetry service
│   └── deploy-watcher/          # Cloud deploy monitor
│
├── packages/                    # Shared libraries & utilities
│   ├── openapi/                 # OpenAPI specifications
│   │   ├── gateway-v1.yml
│   │   ├── oasis-v1.yml
│   │   └── schemas/             # Shared schemas
│   ├── llm-router/              # LLM routing utility
│   ├── agent-heartbeat.ts       # Agent telemetry utility
│   └── py/                      # Python shared packages
│
├── skills/                      # Claude skills
│   ├── public/                  # Public skills (docx, pdf, xlsx, etc.)
│   ├── private/                 # Private/internal skills
│   └── examples/                # Example skills
│
├── tasks/                       # VTID task definitions & tracking
│   ├── DEV-CICDL-0031/          # Phase 2 CI/CD work
│   ├── DEV-CICDL-0033/          # Phase 2C Runtime Fabric
│   └── templates/               # Task templates
│
├── docs/                        # Documentation
│   ├── decisions/               # Architecture Decision Records (ADRs)
│   ├── reports/                 # Phase reports, audit logs
│   ├── runbooks/                # Operational procedures
│   └── api/                     # API documentation (generated)
│
├── .github/                     # GitHub configuration
│   ├── workflows/               # CI/CD workflows (UPPERCASE names)
│   ├── actions/                 # Reusable actions
│   └── pull_request_template.md
│
├── scripts/                     # Operational scripts
│   ├── ci/                      # CI-specific scripts
│   ├── deploy/                  # Deployment scripts
│   └── tools/                   # Dev tools
│
├── database/                    # Database schemas & migrations
│   ├── migrations/              # SQL migrations
│   └── policies/                # RLS policies
│
├── prisma/                      # Prisma ORM (if used)
│   ├── schema.prisma
│   └── migrations/
│
└── specs/                       # Legacy OpenAPI specs (→ packages/openapi)
    └── README.md                # Migration guide
```

---

## Naming Conventions (Phase 2B Compliance)

### Services
- **Directories:** `kebab-case` (e.g., `content-generation`, `github-integration`)
- **Manifest:** Every service MUST have `manifest.json` with:
  - `name`: `UPPERCASE-WITH-HYPHENS` (e.g., `AGENT-PLANNER-CORE`)
  - `vt_layer`: `UPPERCASE` (e.g., `AGTL`, `CICDL`)
  - `vt_module`: `UPPERCASE` (e.g., `PLANNER`, `GATEWAY`)

### Packages
- **Directories:** `kebab-case`
- **Files:** `kebab-case.ts` or `kebab-case.py`

### Workflows
- **Files:** `UPPERCASE-WITH-HYPHENS.yml` (e.g., `DEPLOY-GATEWAY.yml`)
- **`run-name`:** Must include VTID

### Documentation
- **ADRs:** `ADR-NNN-kebab-case-title.md`
- **Reports:** `phase<N>-kebab-case-$(date).md`

---

## Mapping: Current → Target

| Current Location | Target Location | Migration Phase |
|------------------|-----------------|-----------------|
| `/services/gateway/` | `/services/gateway/` | ✅ No change |
| `/services/agents/crewai-gcp/` | `/services/agents/crewai-gcp/` | ✅ No change |
| `/services/agents/validator-core/` | `/services/agents/validator-core/` | ✅ No change |
| `/services/agents/conductor/` | `/services/agents/conductor/` | ✅ No change |
| `/services/agents/memory-indexer/` | `/services/agents/memory-indexer/` | ✅ No change |
| `/services/deploy-watcher/` | `/services/deploy-watcher/` | ✅ No change |
| `/packages/agent-heartbeat.ts` | `/packages/agent-heartbeat.ts` | ✅ No change |
| `/packages/llm-router/` | `/packages/llm-router/` | ✅ No change |
| `/specs/*.yml` | `/packages/openapi/*.yml` | Phase 2D |
| `/phase_2b/*.md` | `/tasks/DEV-CICDL-0031/` | Phase 2D |
| `/docs/*.md` (scattered) | `/docs/reports/` or `/docs/runbooks/` | Phase 2D |

**Key Insight:** Most of the structure is already correct! Phase 2D will primarily:
1. Move `/specs/` → `/packages/openapi/`
2. Organize scattered documentation into `/docs/decisions/`, `/docs/reports/`, `/docs/runbooks/`
3. Create `/tasks/` directory for VTID tracking

---

## Consequences

### Positive

1. **Clear Separation of Concerns:** Services, packages, docs, and tasks are clearly separated
2. **Scalable:** Structure supports 100+ services without confusion
3. **CI/CD Friendly:** Tools can easily target specific directories (e.g., `services/**` for linting)
4. **Onboarding:** New developers can quickly understand the repository layout
5. **Monorepo Ready:** Structure supports consolidation of multiple repos

### Negative

1. **Migration Effort:** Phase 2D will require moving some files
2. **Breaking Changes:** Some import paths will change during migration
3. **Tooling Updates:** CI workflows may need path updates

### Neutral

1. **No Immediate Changes:** Phase 2C scaffolds structure without moving code
2. **Backward Compatible:** Current code continues to work during transition

---

## Migration Strategy (Phase 2D)

### Stage 1: Scaffold & Document (Phase 2C) ✅
- Create target directory structure
- Add README files to new directories
- Document mapping in this ADR
- **No code moves yet**

### Stage 2: Move OpenAPI Specs (Phase 2D.1)
```bash
mv specs/*.yml packages/openapi/
git commit -m "refactor: Move OpenAPI specs to packages/openapi"
```

### Stage 3: Organize Documentation (Phase 2D.2)
```bash
mv PHASE2*.md tasks/DEV-CICDL-0031/
mv ADR*.md docs/decisions/
git commit -m "refactor: Organize documentation into canonical structure"
```

### Stage 4: Update Import Paths (Phase 2D.3)
- Search/replace import paths in all services
- Update CI workflow paths
- Test all services
- Deploy

### Stage 5: Cleanup (Phase 2D.4)
- Remove empty directories
- Update READMEs
- Archive deprecated files

---

## Validation

### CI Enforcement
- `CICDL-CORE-LINT-SERVICES.yml` validates `/services/**` structure
- `CICDL-CORE-OPENAPI-ENFORCE.yml` validates OpenAPI specs
- `PHASE-2B-NAMING-ENFORCEMENT.yml` validates naming conventions

### Manual Checks
```bash
# Verify structure
ls -R services/ packages/ skills/ tasks/ docs/

# Verify manifests
find services -name "manifest.json" -exec cat {} \;

# Verify naming conventions
./scripts/verify-phase2b-compliance.sh
```

---

## References

- **Phase 2B:** Naming Governance & Repo Standardization (DEV-CICDL-0031)
- **Phase 2C:** Runtime Fabric Enforcement (DEV-CICDL-0033)
- **Phase 2D:** Monorepo Consolidation (DEV-CICDL-0034) - Planned
- **OpenAPI Specs:** `/specs/README.md`

---

## Approval

**Approved by:** CEO/CTO (upon Phase 2C PR merge)  
**Implementation:** Phase 2D (post Phase 2C completion)  
**Review Date:** 2026-01-29 (3 months post-implementation)

---

**ADR Status:** Accepted  
**Next ADR:** ADR-002 (Monorepo Merge Strategy)  
**Last Updated:** 2025-10-29
