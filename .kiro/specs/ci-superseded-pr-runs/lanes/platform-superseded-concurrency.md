---
lane: platform-superseded-concurrency
state: ready
next_actor: kiro
branch: kiro/ci-superseded-pr-runs/platform-superseded-concurrency
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/AURORA-I18N-INTEGRATION.yml
  - .github/workflows/AURORA-PRIVILEGE-PARITY-UNIT.yml
  - .github/workflows/CICDL-CORE-LINT-SERVICES.yml
  - .github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml
  - .github/workflows/CICDL-GATEWAY-CI.yml
  - .github/workflows/COMMAND-HUB-GUARDRAILS.yml
  - .github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml
  - .github/workflows/MIGRATION-DRIFT-CHECK.yml
  - .github/workflows/OASIS-PERSISTENCE.yml
  - .github/workflows/ORB-TOOLS-LIFT-SCANNER.yml
  - .github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml
  - .github/workflows/SQL-ACTIVITY-TIERS.yml
  - .github/workflows/SQL-AUTH-BRIDGE.yml
  - .github/workflows/SQL-COMMUNITY-EVENT-CALENDAR.yml
  - .github/workflows/SQL-COMPANION-WIRING.yml
  - .github/workflows/SQL-ERASE-USER-DATA.yml
  - .github/workflows/SQL-HEALTH-SOURCES.yml
  - .github/workflows/SQL-HEALTH-STORE.yml
  - .github/workflows/SQL-INDEX-MOVEMENTS.yml
  - .github/workflows/SQL-LIVE-ROOM-CALENDAR.yml
  - .github/workflows/SQL-LIVE-ROOM-HOST-CALENDAR.yml
  - .github/workflows/SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml
  - .github/workflows/SQL-MEMORY-SENSITIVITY.yml
  - .github/workflows/SQL-PARTNER-REVIEW.yml
  - .github/workflows/SQL-PARTNER-TERMS.yml
  - .github/workflows/SQL-RECORD-MIGRATION-ROW.yml
  - .github/workflows/SQL-REMINDERS-IN-CALENDAR.yml
  - .github/workflows/SQL-SUBSCRIPTION-DATES-IN-CALENDAR.yml
  - .github/workflows/SQL-SUPPLIER-LISTING-GATE.yml
  - .github/workflows/SQL-TENANT-FOUNDATION.yml
  - .github/workflows/SQL-TEST-RESULTS-IN-CALENDAR.yml
  - .github/workflows/SQL-WEARABLE-SAMPLES-RPC-REVOKE.yml
  - .github/workflows/STAGING-TESTS-REQUIRED.yml
  - .github/workflows/VALIDATOR-CHECK.yml
  - .github/workflows/VCAOP-CICD.yml
  - .github/workflows/VCAOP-GUARDRAILS-CI.yml
  - .github/workflows/VOICE-PIPELINE-PARITY-SCANNER.yml
  - .github/workflows/VOICE-TOOLS-MANIFEST-RECONCILE.yml
updated: 2026-11-02T16:31Z
vtid: VTID-05513
---

# Lane: platform-superseded-concurrency (repo exafyltd/vitana-platform)

Adds the superseded-run concurrency block to 38 PR-triggered workflows in vitana-platform. Tasks T1-T5 in tasks.md. PR-GATE.yml, PLAN-SPAR.yml and AWS-PROD-*.yml are not in the list.

## Log
### 2026-11-02T15:20Z · kiro-exafyltd-202611021510-092e · ready
Lane created with the plan. Paths are the exact files changed by the prepared commit.

### 2026-11-02T16:31Z · ci-plan-spar · ready (VTID allocated)
VTID-05513 allocated after policy approval (converged-auto-v1).
