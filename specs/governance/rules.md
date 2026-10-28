# Vitana Governance Catalog v0.1

This file lists all active governance rules (L1–L4) enforced across Vitana.

**Last Updated:** 2025-12-03
**Commit:** 654c542667c45e741bc47cfc85e817ca4f5db9f8
**Total Rules:** 35

---

## Categories

| Code | Name | Description |
|------|------|-------------|
| MIGRATION | Migration Governance | Rules enforcing autonomous, idempotent, CI-only schema migrations |
| FRONTEND | Frontend Governance | Rules enforcing frontend structure, navigation, and security |
| CICD | CI/CD Governance | Rules enforcing CI/CD workflow standards and naming conventions |
| DB | Database Governance | Rules enforcing database security, RLS, and tenant isolation |
| AGENT | Agent Governance | Rules enforcing autonomous agent behavior and operational protocols |
| API | API Governance | Rules enforcing API standards, traceability, and health monitoring |

---

## Rules Summary

| ID | Level | Title | Status | VTIDs | Enforcement | Description |
|----|-------|-------|--------|-------|-------------|-------------|
| GOV-MIGRATION-001 | L3 | Idempotent SQL Requirement | Active | DEV-OASIS-GOV-0103 | backend, CI, DB | All migrations MUST use idempotent SQL patterns |
| GOV-MIGRATION-002 | L3 | CI-Only Migration Execution | Active | DEV-OASIS-GOV-0102, DEV-OASIS-GOV-0103 | CI, DB | All schema migrations MUST run through APPLY-MIGRATIONS.yml |
| GOV-MIGRATION-003 | L3 | No Manual SQL | Active | DEV-OASIS-GOV-0103 | CI, DB, agents | Manual SQL changes are prohibited |
| GOV-MIGRATION-004 | L3 | Mandatory CI Failure on Migration Errors | Active | DEV-OASIS-GOV-0103 | CI | Migration workflow MUST fail on any SQL error |
| GOV-MIGRATION-005 | L3 | Use Only Existing Secrets | Active | DEV-OASIS-GOV-0103 | CI | Only approved secrets allowed in migrations |
| GOV-MIGRATION-006 | L3 | Tenant Isolation Enforcement | Active | DEV-OASIS-GOV-0103 | backend, DB | Schema objects MUST include tenant_id and RLS |
| GOV-MIGRATION-007 | L3 | Timestamp-Ordered Migrations | Active | DEV-OASIS-GOV-0103 | CI, DB | Migrations MUST follow YYYYMMDDHHMMSS naming |
| GOV-FRONTEND-001 | L3 | Frontend Canonical Source | Active | DEV-CICDL-0205, GOV-FRONTEND-CANONICAL-SOURCE-0001 | frontend, CI | Only canonical source path allowed |
| GOV-FRONTEND-002 | L2 | Navigation Canon | Active | DEV-CICDL-0205 | frontend, CI | Fixed 17 modules, 87 screens structure |
| GOV-FRONTEND-003 | L2 | CSP Compliance | Active | DEV-CICDL-0205 | frontend, backend | CSP headers required, no inline scripts |
| GOV-CICD-001 | L2 | Workflow UPPERCASE Naming | Active | DEV-CICDL-0033 | CI | Workflow files MUST use UPPERCASE names |
| GOV-CICD-002 | L2 | Workflow VTID in run-name | Active | DEV-CICDL-0033 | CI | Workflows SHOULD include VTID in run-name |
| GOV-CICD-003 | L2 | File Naming Convention | Active | DEV-CICDL-0033 | CI | Code files MUST use kebab-case |
| GOV-CICD-004 | L2 | Service Manifest Required | Active | DEV-CICDL-0033 | CI | Every service MUST have manifest.json |
| GOV-CICD-005 | L2 | Top-Level Service Directory Naming | Active | DEV-CICDL-0033 | CI | Service directories MUST use kebab-case |
| GOV-CICD-006 | L2 | OpenAPI Spectral Validation | Active | DEV-CICDL-0033 | CI | OpenAPI specs MUST pass Spectral validation |
| GOV-CICD-007 | L2 | OpenAPI Version Requirement | Active | DEV-CICDL-0033 | CI | OpenAPI specs MUST use version 3.0.x or 3.1.x |
| GOV-CICD-008 | L2 | No Duplicate Operation IDs | Active | DEV-CICDL-0033 | CI | Each operationId MUST be unique |
| GOV-CICD-009 | L2 | Prisma Schema Check | Active | DEV-OASIS-GOV-0102 | CI | Prisma schema MUST pass format --check |
| GOV-DB-001 | L1 | RLS Enabled on Governance Tables | Active | DEV-OASIS-GOV-0102 | DB | RLS MUST be enabled on governance tables |
| GOV-DB-002 | L1 | Service Role Write Access | Active | DEV-OASIS-GOV-0102 | DB, backend | Write access restricted to service_role |
| GOV-DB-003 | L1 | Authenticated Read Access | Active | DEV-OASIS-GOV-0102 | DB | Authenticated users have read-only access |
| GOV-DB-004 | L1 | OASIS Events Tenant Isolation | Active | DEV-OASIS-GOV-0102 | DB | OasisEvent table has tenant-aware RLS |
| GOV-DB-005 | L1 | OASIS Events Service Insert Only | Active | DEV-OASIS-GOV-0102 | DB, backend | Only service_role can insert events |
| GOV-DB-006 | L1 | VtidLedger RLS Policies | Active | DEV-VTID-LEDGER | DB | VtidLedger has tenant-aware RLS |
| GOV-AGENT-001 | L4 | Claude Operational Protocol (COP) | Active | COP-V1.0 | agents | Claude operates under CEO/CTO governance |
| GOV-AGENT-002 | L4 | VTID Required for All Tasks | Active | COP-V1.0 | agents, CI | Every task MUST include VTID |
| GOV-AGENT-003 | L4 | No Direct Push to Main | Active | COP-V1.0 | agents, CI | All changes MUST go through PR |
| GOV-AGENT-004 | L4 | Command Hierarchy | Active | COP-V1.0 | agents | CEO > CTO/OASIS > Claude > Gemini/Workers |
| GOV-AGENT-005 | L4 | Exact-Match Edit Protocol | Active | COP-V1.0 | agents | Verify snippet exists before modification |
| GOV-AGENT-006 | L4 | Telemetry Event Emission | Active | COP-V1.0 | agents, backend | Every execution emits telemetry to OASIS |
| GOV-AGENT-007 | L4 | Safety and Validation Framework | Active | COP-V1.0 | agents | Validate schemas, protect secrets |
| GOV-API-001 | L2 | VTID Required in API Requests | Active | DEV-API-GOVERNANCE | backend | X-VTID header required for traceability |
| GOV-API-002 | L2 | Health Endpoint Requirement | Active | DEV-CICDL-DEPLOY | backend, CI | Services MUST expose /alive or /health |
| GOV-API-003 | L2 | Deployment Version Recording | Active | VTID-0510 | CI, backend | Deployments MUST record version in OASIS |

---

## Detailed Rules

### Migration Governance (L3)

#### GOV-MIGRATION-001: Idempotent SQL Requirement
- **Level:** L3
- **Status:** Active
- **Description:** All migrations MUST use idempotent SQL patterns (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE INDEX IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING) to allow safe re-runs via CI.
- **Enforcement:** backend, CI, DB
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
  - .github/workflows/APPLY-MIGRATIONS.yml
- **VTIDs:** DEV-OASIS-GOV-0103

#### GOV-MIGRATION-002: CI-Only Migration Execution
- **Level:** L3
- **Status:** Active
- **Description:** All schema migrations MUST run exclusively through the canonical GitHub Actions workflow (APPLY-MIGRATIONS.yml). No direct SQL execution via Supabase UI, local CLI, or Cloud Shell is allowed.
- **Enforcement:** CI, DB
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
  - .github/workflows/APPLY-MIGRATIONS.yml
- **VTIDs:** DEV-OASIS-GOV-0102, DEV-OASIS-GOV-0103

#### GOV-MIGRATION-003: No Manual SQL
- **Level:** L3
- **Status:** Active
- **Description:** Manual SQL changes (in Supabase Dashboard, local psql, or Cloud Shell) are prohibited. Any schema modification outside CI MUST be rejected by governance and Validator.
- **Enforcement:** CI, DB, agents
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
- **VTIDs:** DEV-OASIS-GOV-0103

#### GOV-MIGRATION-004: Mandatory CI Failure on Migration Errors
- **Level:** L3
- **Status:** Active
- **Description:** The migration workflow MUST fail (non-zero exit) on any SQL error or verification error. Silent failures or partial application of migrations are not allowed.
- **Enforcement:** CI
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
  - .github/workflows/APPLY-MIGRATIONS.yml
- **VTIDs:** DEV-OASIS-GOV-0103

#### GOV-MIGRATION-005: Use Only Existing Secrets
- **Level:** L3
- **Status:** Active
- **Description:** Migration workflows MUST use only existing, approved secrets (e.g., SUPABASE_DB_URL). Introducing new credentials or ad-hoc connection strings is forbidden.
- **Enforcement:** CI
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
  - .github/workflows/APPLY-MIGRATIONS.yml
- **VTIDs:** DEV-OASIS-GOV-0103

#### GOV-MIGRATION-006: Tenant Isolation Enforcement
- **Level:** L3
- **Status:** Active
- **Description:** All governance-related schema objects MUST include tenant-aware design (tenant_id and appropriate RLS) to preserve tenant isolation across the Vitana platform.
- **Enforcement:** backend, DB
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
  - supabase/migrations/20251120000000_init_governance.sql
- **VTIDs:** DEV-OASIS-GOV-0103

#### GOV-MIGRATION-007: Timestamp-Ordered Migrations
- **Level:** L3
- **Status:** Active
- **Description:** All migration files MUST follow the global timestamp naming convention (YYYYMMDDHHMMSS_description.sql), and CI MUST apply them in sorted order to guarantee deterministic schema evolution.
- **Enforcement:** CI, DB
- **Sources:**
  - supabase/migrations/20251120000001_add_migration_governance_rules.sql
  - .github/workflows/APPLY-MIGRATIONS.yml
- **VTIDs:** DEV-OASIS-GOV-0103

---

### Frontend Governance (L2-L3)

#### GOV-FRONTEND-001: Frontend Canonical Source
- **Level:** L3
- **Status:** Active
- **Description:** Only one valid source tree for the Command Hub is allowed: services/gateway/src/frontend/command-hub. Forbidden paths include static/command-hub, public/command-hub, frontend/command-hub, and any variant casing. CI and Validator block violations.
- **Enforcement:** frontend, CI
- **Sources:**
  - services/validators/frontend-canonical-source.js
  - .github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml
  - docs/governance/CEO-HANDOVER-REVISED.md
- **VTIDs:** DEV-CICDL-0205, GOV-FRONTEND-CANONICAL-SOURCE-0001

#### GOV-FRONTEND-002: Navigation Canon
- **Level:** L2
- **Status:** Active
- **Description:** The frontend navigation structure is fixed with exactly 17 modules and 87 screens in a canonical order. This structure MUST match the OASIS spec in specs/dev_screen_inventory_v1.json. Modifications require OASIS spec update first.
- **Enforcement:** frontend, CI
- **Sources:**
  - services/gateway/src/frontend/command-hub/navigation-config.js
- **VTIDs:** DEV-CICDL-0205

#### GOV-FRONTEND-003: CSP Compliance
- **Level:** L2
- **Status:** Active
- **Description:** All frontend routes MUST set Content-Security-Policy headers. No inline scripts or styles allowed. CSP: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'.
- **Enforcement:** frontend, backend
- **Sources:**
  - services/gateway/src/routes/command-hub.ts
- **VTIDs:** DEV-CICDL-0205

---

### CI/CD Governance (L2)

#### GOV-CICD-001: Workflow UPPERCASE Naming
- **Level:** L2
- **Status:** Active
- **Description:** All GitHub Actions workflow files MUST use UPPERCASE names with hyphens (e.g., DEPLOY-GATEWAY.yml, RUN-TESTS.yml). Reusable workflows prefixed with underscore (_) are exempt.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-002: Workflow VTID in run-name
- **Level:** L2
- **Status:** Active
- **Description:** All workflows SHOULD include VTID reference in run-name field for tracking (e.g., run-name: 'Deploy Gateway [VTID: DEV-CICDL-0031] (${{ github.ref_name }})').
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-003: File Naming Convention (kebab-case)
- **Level:** L2
- **Status:** Active
- **Description:** All TypeScript/JavaScript code files MUST use kebab-case naming (e.g., my-service.ts). Exceptions: README, LICENSE, CHANGELOG, Dockerfile, Makefile.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-004: Service Manifest Required
- **Level:** L2
- **Status:** Active
- **Description:** Every service directory (agents, MCP services, gateway, deploy-watcher) MUST contain a manifest.json with required fields: name, and either vtid or vt_layer/vt_module.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/CICDL-CORE-LINT-SERVICES.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-005: Top-Level Service Directory Naming
- **Level:** L2
- **Status:** Active
- **Description:** Top-level service directories MUST use kebab-case. Internal subdirectories may follow language conventions (e.g., Python snake_case).
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/CICDL-CORE-LINT-SERVICES.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-006: OpenAPI Spectral Validation
- **Level:** L2
- **Status:** Active
- **Description:** All OpenAPI specification files in specs/ and packages/openapi/ MUST pass Spectral validation with fail-severity=warn.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-007: OpenAPI Version Requirement
- **Level:** L2
- **Status:** Active
- **Description:** All OpenAPI specs MUST use version 3.0.x or 3.1.x. Older versions are not supported.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-008: No Duplicate Operation IDs
- **Level:** L2
- **Status:** Active
- **Description:** Each OpenAPI operation MUST have a unique operationId within a specification. Duplicate operationIds are not allowed.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml
- **VTIDs:** DEV-CICDL-0033

#### GOV-CICD-009: Prisma Schema Check
- **Level:** L2
- **Status:** Active
- **Description:** Prisma schema MUST pass format --check validation. Schema generation and formatting are verified in CI.
- **Enforcement:** CI
- **Sources:**
  - .github/workflows/OASIS-PERSISTENCE.yml
- **VTIDs:** DEV-OASIS-GOV-0102

---

### Database Governance (L1)

#### GOV-DB-001: RLS Enabled on Governance Tables
- **Level:** L1
- **Status:** Active
- **Description:** Row Level Security MUST be enabled on all governance tables: governance_categories, governance_rules, governance_evaluations, governance_violations, governance_enforcements.
- **Enforcement:** DB
- **Sources:**
  - supabase/migrations/20251120000000_init_governance.sql
- **VTIDs:** DEV-OASIS-GOV-0102

#### GOV-DB-002: Service Role Write Access
- **Level:** L1
- **Status:** Active
- **Description:** Write access to governance tables is restricted to service_role only. Backend services use service_role for all write operations.
- **Enforcement:** DB, backend
- **Sources:**
  - supabase/migrations/20251120000000_init_governance.sql
- **VTIDs:** DEV-OASIS-GOV-0102

#### GOV-DB-003: Authenticated Read Access
- **Level:** L1
- **Status:** Active
- **Description:** Authenticated users have read-only access to governance tables for transparency.
- **Enforcement:** DB
- **Sources:**
  - supabase/migrations/20251120000000_init_governance.sql
- **VTIDs:** DEV-OASIS-GOV-0102

#### GOV-DB-004: OASIS Events Tenant Isolation
- **Level:** L1
- **Status:** Active
- **Description:** OasisEvent table has RLS enabled with tenant-aware reads. Users can only SELECT events matching their JWT tenant claim.
- **Enforcement:** DB
- **Sources:**
  - database/policies/002_oasis_events.sql
- **VTIDs:** DEV-OASIS-GOV-0102

#### GOV-DB-005: OASIS Events Service Insert Only
- **Level:** L1
- **Status:** Active
- **Description:** Only service_role can INSERT into OasisEvent table. Gateway backend uses service_role for event ingestion.
- **Enforcement:** DB, backend
- **Sources:**
  - database/policies/002_oasis_events.sql
- **VTIDs:** DEV-OASIS-GOV-0102

#### GOV-DB-006: VtidLedger RLS Policies
- **Level:** L1
- **Status:** Active
- **Description:** VtidLedger table has RLS enabled. Authenticated users can read all VTIDs, insert new VTIDs, and update only their tenant's VTIDs (or if admin).
- **Enforcement:** DB
- **Sources:**
  - database/policies/003_vtid_ledger.sql
- **VTIDs:** DEV-VTID-LEDGER

---

### Agent Governance (L4)

#### GOV-AGENT-001: Claude Operational Protocol (COP)
- **Level:** L4
- **Status:** Active
- **Description:** Claude operates as Chief Autonomous Execution Officer under CEO/CTO governance. All tasks must honor OASIS as Single Source of Truth and preserve deterministic reproducibility.
- **Enforcement:** agents
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

#### GOV-AGENT-002: VTID Required for All Tasks
- **Level:** L4
- **Status:** Active
- **Description:** Every task executed by Claude or agents MUST include a VTID in its header (e.g., DEV-COMMU-0050). Tasks without VTID are invalid.
- **Enforcement:** agents, CI
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

#### GOV-AGENT-003: No Direct Push to Main
- **Level:** L4
- **Status:** Active
- **Description:** No direct pushes to main branch unless CEO explicitly orders. All changes must go through a PR with structured body including Summary, Context, Implementation details, Validation evidence, and OASIS event reference.
- **Enforcement:** agents, CI
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

#### GOV-AGENT-004: Command Hierarchy
- **Level:** L4
- **Status:** Active
- **Description:** Command hierarchy must be respected: CEO (Ultimate authority) > CTO/OASIS (Governance layer) > Claude (Executor) > Gemini/Worker Agents > Validator Agents. Claude never overrides CEO or OASIS directives.
- **Enforcement:** agents
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

#### GOV-AGENT-005: Exact-Match Edit Protocol
- **Level:** L4
- **Status:** Active
- **Description:** Claude must verify exact target snippet exists before modification. If snippet not found: STOP immediately, report mismatch, do not improvise or guess. Escalate to CEO for correction.
- **Enforcement:** agents
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

#### GOV-AGENT-006: Telemetry Event Emission
- **Level:** L4
- **Status:** Active
- **Description:** Every execution must emit a telemetry event to OASIS including: service name, VTID, start/end timestamps, outcome (success/warning/failure), and files touched.
- **Enforcement:** agents, backend
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

#### GOV-AGENT-007: Safety and Validation Framework
- **Level:** L4
- **Status:** Active
- **Description:** Claude must: validate all JSON/YAML schemas before commit, never expose secrets/API keys, treat OASIS/Gateway/Supabase credentials as secure, default to read-only unless explicitly instructed.
- **Enforcement:** agents
- **Sources:**
  - docs/GOVERNANCE/CLAUDE_START_PROMPT.md
- **VTIDs:** COP-V1.0

---

### API Governance (L2)

#### GOV-API-001: VTID Required in API Requests
- **Level:** L2
- **Status:** Active
- **Description:** API requests requiring traceability MUST include VTID via X-VTID header, body parameter, or query parameter. Middleware enforces this requirement.
- **Enforcement:** backend
- **Sources:**
  - services/gateway/src/middleware/require-vtid.ts
- **VTIDs:** DEV-API-GOVERNANCE

#### GOV-API-002: Health Endpoint Requirement
- **Level:** L2
- **Status:** Active
- **Description:** All deployed services MUST expose health endpoints (/alive, /healthz, or /health) that return 200 status. CI deployment workflows verify health after deploy.
- **Enforcement:** backend, CI
- **Sources:**
  - .github/workflows/EXEC-DEPLOY.yml
  - services/gateway/src/routes/command-hub.ts
- **VTIDs:** DEV-CICDL-DEPLOY

#### GOV-API-003: Deployment Version Recording
- **Level:** L2
- **Status:** Active
- **Description:** All deployments MUST record software version in OASIS via /api/v1/operator/deployments endpoint including: service name, git commit, deploy type, initiator, and environment.
- **Enforcement:** CI, backend
- **Sources:**
  - .github/workflows/EXEC-DEPLOY.yml
- **VTIDs:** VTID-0510

---

## Statistics

- **Total Rules:** 35
- **L1 (Database Security):** 6 rules
- **L2 (Standards & Conventions):** 14 rules
- **L3 (Migration & Source Control):** 8 rules
- **L4 (Agent Governance):** 7 rules

---

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2025-12-03 | 0.1 | Initial catalog extraction from codebase |

---

*This catalog is auto-generated from the Vitana codebase. All rules are enforced through CI/CD, database policies, and agent protocols.*
