# Self-Healing System

> Autonomous pipeline that detects unhealthy services, diagnoses root causes through a 6-layer analysis engine, generates fix specifications, and injects repair tasks into the Autopilot pipeline -- turning health alerts into automated remediation.

## Overview

The Self-Healing System is an infrastructure-layer capability (INFRA / OASIS+AUTOPILOT) that transforms Vitana's daily health monitoring from a passive notification system into an active, autonomous repair pipeline. Rather than alerting a human when a service is down, the system diagnoses the failure, writes a fix specification, and injects a VTID task into the Autopilot execution pipeline.

## Pipeline Stages

The self-healing pipeline follows a six-stage flow:

1. **Detect** -- The existing `collect-status.py` health monitor (54 endpoints) is enhanced to POST structured failure data to `POST /api/v1/self-healing/report` on the Gateway.
2. **Allocate VTID** -- Every diagnosis attempt immediately receives its own VTID via the global allocator (VTID-0542) before any analysis begins, ensuring full traceability.
3. **Deep Diagnose** -- A 6-layer diagnosis engine investigates the failure (see below).
4. **Prescribe** -- An AI-driven spec generator produces a fix specification using the canonical VTID spec template, with a quality gate requiring a score >= 0.7.
5. **Inject** -- The generated spec is injected into the Autopilot pipeline as a VTID task with `priority: critical` and `source: self-healing`.
6. **Verify** -- Post-fix health re-check confirms the endpoint is restored; blast-radius analysis checks that no other services were broken.

## 6-Layer Diagnosis Engine

The diagnosis engine (`self-healing-diagnosis-service.ts`) performs a multi-layer investigation modeled on how a senior engineer triages an outage:

| Layer | Name | What It Does |
|-------|------|-------------|
| 1 | HTTP Response Analysis | Parses status code, headers, and response body to form an initial failure classification |
| 2 | Codebase Deep Dive | Reads actual source files: resolves endpoint to route file, checks for health handler, inspects imports, env vars, Supabase tables |
| 3 | Git History Analysis | Finds the last known healthy date, identifies breaking commits, checks if a fix already exists in repo but hasn't been deployed |
| 4 | Dependency & Import Chain | Verifies all imports resolve, checks for missing env vars, detects missing DB tables |
| 5 | Workflow & Registration | Confirms route is mounted in `index.ts`, checks middleware chain for auth/CORS blockers |
| 6 | OASIS Event Correlation | Checks prior fix attempts (circuit breaker at 2 attempts/48h), identifies correlated failures across services |

If confidence remains below 0.6 after all layers, an AI-assisted deep analysis (Gemini) synthesizes all evidence for a final diagnosis.

## Failure Classification

Failures are classified into three auto-fixability levels:

- **Level 1 (Auto-fixable, high confidence):** `route_not_registered`, `handler_crash`, `missing_env_var`, `import_error`, `dependency_timeout`, `stale_deployment`, `regression`
- **Level 2 (Auto-fixable, requires approval):** `database_schema_drift`, `integration_failure`, `resource_exhaustion`, `middleware_rejection`
- **Level 3 (Human required):** `unknown`, `external_dependency`, `data_corruption`

## Autonomy Levels

The system supports 5 operational modes controlled via `PATCH /api/v1/self-healing/config`:

| Level | Name | Behavior |
|-------|------|----------|
| 0 | DISABLED | No processing |
| 1 | DIAGNOSE_ONLY | Diagnose and create VTID but take no fix action |
| 2 | SPEC_AND_WAIT | Generate spec but require human approval before execution |
| 3 | AUTO_FIX_SIMPLE | Automatically fix Level 1 failures; wait for approval on Level 2+ |
| 4 | FULL_AUTO | Fix all auto-fixable failures without approval |

Production default is Level 3 (`AUTO_FIX_SIMPLE`).

## Kill Switch

An emergency kill switch is available at `POST /api/v1/self-healing/kill-switch` which immediately disables all self-healing processing. It requires an `operator` and `reason` field for audit purposes. Reports submitted while killed return `action: "disabled"` for all services.

## Verification and Blast Radius

After a fix is deployed, the verification stage:
- Waits 30 seconds for stabilization
- Re-checks the target endpoint
- Takes a full system snapshot (all 54 endpoints) and compares against the pre-fix snapshot
- If the target is still broken or new services are down, escalates to human with full evidence
- Stores both pre-fix and post-fix snapshots linked to the VTID

## Governance Rules Touched

- **VTID Allocation (VTID-0542):** Auto-created VTIDs use the global allocator
- **Spec Approval Gate (VTID-01188):** Level 1 fixes bypass human approval; novel fixes require it
- **Validator Hard Gate (VTID-0535):** All fixes must pass deterministic validation
- **Deploy Governance (VTID-0416):** All deploys go through `EXEC-DEPLOY.yml`
- **OASIS Authority (VTID-01005):** All state transitions recorded as OASIS events

## Test Plan

The test plan (31 tests across 7 layers) validates:
- Pre-deployment checks (TypeScript compilation, import chain)
- Database migration (3 tables: `self_healing_log`, `self_healing_snapshots`, `system_config`)
- Smoke tests (health, config, active tasks, history, input validation)
- Kill switch and config management
- Integration tests in DIAGNOSE_ONLY mode (VTID allocation, dedup, OASIS events)
- Full pipeline tests in SPEC_AND_WAIT mode (spec generation, task injection)
- Verification and blast radius testing
- Dashboard UI rendering and kill switch interaction

## Database Tables

- `self_healing_log` -- Records every self-healing attempt with diagnosis, outcome, and VTID reference
- `self_healing_snapshots` -- Pre-fix and post-fix system health snapshots (all 54 endpoints)
- `system_config` -- Configuration store for `self_healing_enabled` and `self_healing_autonomy_level`

## Related Pages

- [[stripe-connect]] -- Another major system integration spec
- [[spec-governance]] -- Governance rules the self-healing system must follow
- [[agent-architecture]] -- The AI agent infrastructure that executes self-healing fixes
- [[vitana-orchestrator]] -- Orchestrator that dispatches fix tasks to worker agents
- [[summary-self-healing-spec]] -- Source summary of the self-healing specification

## Sources

- `raw/specs/SELF-HEALING-SYSTEM-SPEC.md`
- `raw/specs/SELF-HEALING-TEST-PLAN.md`

## Last Updated

2026-04-12
