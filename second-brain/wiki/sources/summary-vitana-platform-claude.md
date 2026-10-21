# Summary: vitana-platform CLAUDE.md

> Summary of the CLAUDE.md and extended CLAUDE.md files from the vitana-platform backend repository.

## Content

### What These Files Are

Two related documents define the operating rules for the vitana-platform repository:

1. **`vitana-platform-CLAUDE.md`** -- deployment guide focused on multi-repo setup, architecture overview, deployment process, and gateway URLs.
2. **`vitana-platform-claude-extended.md`** -- comprehensive behavioral rules (Always/Never/If-Then), technical reference for GCP, services, database, VTID system, governance, OASIS events, worker orchestrator, environment variables, and coding conventions.

### Core Behavioral Rules

The extended document defines 40 Always rules, 40 Never rules, and 30+ If-Then rules organized into categories: Source of Truth, Infrastructure, Database, Frontend/UX, and AI/Autonomy.

Key highlights:
- Always use GCP project `lovable-vitana-vers1` in `us-central1`.
- Always expose `/alive` as the health endpoint on port `8080`.
- Always verify VTID existence before execution.
- Never hardcode URLs, paths, or service names.
- Never bypass governance gates.
- Never deploy without OASIS approval.

### Architecture: Three Deployable Components

1. **Backend API + Command Hub** -- `gateway` Cloud Run service from `services/gateway/`.
2. **Community App** -- `community-app` Cloud Run service from `vitana-v1/`.
3. **OASIS services** -- `oasis-operator` and `oasis-projector`.

### Deployment Guide

- Backend: merge to `main` -> AUTO-DEPLOY -> EXEC-DEPLOY -> Cloud Run.
- Frontend: merge to `main` -> DEPLOY.yml -> Cloud Run `community-app` + Lovable CDN.
- Full-stack: deploy backend first, then frontend.
- All deploys are governed (VTID check, governance evaluation, smoke tests).

### Technical Reference

- **Services architecture:** 5 deployable Cloud Run services, 6+ non-deployable library services.
- **Database:** Supabase with strict snake_case tables, RLS enforcement, Prisma ORM.
- **VTID system:** `VTID-XXXXX` format, lifecycle from scheduled to terminal.
- **Governance:** hard gates (EXECUTION_DISARMED, VTID_ALLOCATOR_ENABLED), one VTID per worker.
- **OASIS events:** taxonomy for lifecycle, stage, decision, and error events.
- **Worker orchestrator API:** 12 endpoints for register, claim, heartbeat, route, complete, terminalize.
- **Memory architecture:** 13 Memory Garden categories, ORB voice + operator console inputs.

### Claude Operational Protocol (COP v1.0)

Defines Claude as the Chief Autonomous Execution Officer operating under CEO/CTO governance. Key rules:
- Honor OASIS as single source of truth.
- Every task must include a VTID.
- All changes through PRs with structured body.
- Exact-Match Edit Protocol: always verify snippets exist before modifying.
- Escalate uncertainties before acting.

### CEO Handover: Canonical Frontend Source

Governance rule `GOV-FRONTEND-CANONICAL-SOURCE-0001` enforces:
- Only one valid source tree for Command Hub.
- Build output locked to `dist/frontend/command-hub`.
- Claude must not delete source directories, modify build process, change Express routing, or touch frontend files.
- Governance-only enforcement.

## Related Pages

- [[vitana-platform]]
- [[api-gateway-pattern]]
- [[vtid-governance]]
- [[multi-repo-architecture]]
- [[summary-vitana-v1-claude]]

## Sources

- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`
- `raw/governance/CLAUDE_START_PROMPT.md`
- `raw/governance/CEO-HANDOVER-REVISED.md`

## Last Updated

2026-04-12
