# Spec Governance

> The governance framework for Vitana engineering: 35 rules across 6 categories (L1-L4), a canonical VTID spec template, and a validator that blocks non-compliant specs from execution.

## Overview

Vitana's spec governance system ensures consistency, traceability, and security across all engineering artifacts. It comprises a catalog of 35 active rules, a mandatory spec template for all VTIDs, and automated enforcement through CI/CD, database policies, and agent protocols.

## Governance Rule Catalog

**Total Rules:** 35 (as of 2025-12-03)

### Rule Categories

| Code | Name | Count | Level(s) |
|------|------|-------|----------|
| MIGRATION | Migration Governance | 7 | L3 |
| FRONTEND | Frontend Governance | 3 | L2-L3 |
| CICD | CI/CD Governance | 9 | L2 |
| DB | Database Governance | 6 | L1 |
| AGENT | Agent Governance | 7 | L4 |
| API | API Governance | 3 | L2 |

### Governance Levels

- **L1 (Database Security):** 6 rules -- RLS enforcement, service role write access, tenant isolation on OASIS events and VTID ledger
- **L2 (Standards & Conventions):** 14 rules -- Workflow naming (UPPERCASE), file naming (kebab-case), OpenAPI validation, health endpoints, VTID in API requests
- **L3 (Migration & Source Control):** 8 rules -- Idempotent SQL, CI-only migration execution, no manual SQL, canonical frontend source path
- **L4 (Agent Governance):** 7 rules -- Claude Operational Protocol (COP), VTID required for all tasks, no direct push to main, command hierarchy, exact-match edit protocol, telemetry emission, safety/validation framework

### Key Rules

**GOV-AGENT-001 (Claude Operational Protocol):** Claude operates as Chief Autonomous Execution Officer under CEO/CTO governance. OASIS is the Single Source of Truth. Command hierarchy: CEO > CTO/OASIS > Claude > Gemini/Workers > Validators.

**GOV-MIGRATION-001 (Idempotent SQL):** All migrations must use idempotent patterns (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`, etc.) for safe CI re-runs.

**GOV-AGENT-003 (No Direct Push to Main):** All changes go through PRs with structured body: Summary, Context, Implementation, Validation evidence, OASIS event reference.

**GOV-FRONTEND-001 (Frontend Canonical Source):** Only one valid source tree: `services/gateway/src/frontend/command-hub`. All other paths are forbidden and blocked by CI.

**GOV-API-002 (Health Endpoint):** All deployed services must expose `/alive`, `/healthz`, or `/health` returning 200. CI deployment workflows verify health after deploy.

## Canonical VTID Spec Template (v1)

**VTID:** VTID-01191 | **Status:** FROZEN | **Governance Level:** L1 (Mandatory)

Every VTID must have a spec compliant with this template. Non-compliant specs block execution.

### Required Sections

| Section | Key Fields |
|---------|-----------|
| 2.1 Identity | `vtid`, `title` (max 80 chars, imperative), `owner_role`, `tenant_scope` |
| 2.2 Classification | `primary_domain` (exactly one of: frontend/backend/ai/memory/workflow/integration), `system_surface`, `execution_mode` |
| 2.3 Intent | `problem_statement`, `desired_outcome`, `non_goals` |
| 2.4 Affected Surfaces | `frontend.screens`, `frontend.components`, `backend.services`, `backend.endpoints`, `ai.agents`, `integrations` |
| 2.5 Memory & Data Impact | `reads`, `writes`, `categories` (at least one), `retention` |
| 2.6 Workflow & Automation | `triggers`, `autopilot.enabled`, `autopilot.requires_spec_snapshot`, `verification.acceptance_assertions` |
| 2.7 Constraints & Guardrails | `csp`, `additive_only`, `breaking_change`, `governance_rules` |
| 2.8 Acceptance Criteria | Array of `{type, description}` -- machine-checkable conditions |

### Validation

All specs are validated against `vtid-spec-schema-v1.json` before:
- PR submission (CI pipeline)
- Autopilot execution (Validator agent)
- Manual execution (pre-commit hooks)

### Template Governance Rules

1. Every VTID MUST have a compliant spec
2. Missing or invalid spec blocks execution
3. Classification is mandatory and authoritative for routing
4. Memory impact must always be declared (empty arrays allowed)
5. Validator enforces all rules strictly

## Enforcement Mechanisms

| Mechanism | Where | What It Checks |
|-----------|-------|---------------|
| CI Workflows | GitHub Actions | Naming conventions, OpenAPI specs, service manifests, migration patterns |
| Database Policies | Supabase RLS | Row-level security, service role access, tenant isolation |
| Agent Protocols | Claude/Gemini | COP compliance, VTID tracking, exact-match edits, telemetry emission |
| Pre-commit Hooks | Local | Spec schema validation |
| Validator Agent | Runtime | Spec completeness, schema compliance |

## Related Pages

- [[self-healing-system]] -- Must comply with governance rules for spec approval and deploy
- [[stripe-connect]] -- Example of governed VTID specs (VTID-01230, VTID-01231)
- [[agent-architecture]] -- Agent governance rules (L4) define how AI agents operate
- [[vitana-orchestrator]] -- Orchestrator enforces verification stage gates
- [[phase-2-evolution]] -- Phase 2B established many of these governance rules

## Sources

- `raw/specs/governance/rules.md`
- `raw/specs/governance/canonical-spec-template-v1.md`

## Last Updated

2026-04-12
