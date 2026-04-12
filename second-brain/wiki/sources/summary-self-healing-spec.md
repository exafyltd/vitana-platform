# Summary: Self-Healing System Specification

> Summary of the autonomous self-healing system specification and its comprehensive 31-test validation plan.

## Source Documents

- `raw/specs/SELF-HEALING-SYSTEM-SPEC.md` -- Full system specification (VTID-012XX, DRAFT, dated 2026-04-02)
- `raw/specs/SELF-HEALING-TEST-PLAN.md` -- 31-test validation plan across 7 layers (dated 2026-04-02)

## Specification Summary

### Purpose

Build an autonomous self-healing pipeline that detects unhealthy services from the daily status check (54 endpoints via `collect-status.py`), automatically creates VTID tasks with generated fix specifications, and injects them into the Command Hub autopilot pipeline for autonomous execution.

### Pipeline Architecture

Six stages: Detect -> Allocate VTID -> Deep Diagnose (6 layers) -> Prescribe (AI spec generation) -> Inject (into Autopilot) -> Verify (post-fix health check + blast radius).

### Key Design Decisions

1. **VTID-first approach:** Every diagnosis attempt gets its own VTID immediately, before any analysis begins. This ensures full traceability even if diagnosis fails.
2. **6-layer diagnosis:** Not a simple HTTP status classifier. The engine reads source code, checks git history, traces dependencies, correlates OASIS events, and only then determines root cause.
3. **Failure taxonomy with auto-fix levels:** 7 Level-1 (auto-fixable), 4 Level-2 (requires approval), 3 Level-3 (human required) failure classes.
4. **5 autonomy modes:** From DISABLED (0) to FULL_AUTO (4), with production default at AUTO_FIX_SIMPLE (3).
5. **Circuit breaker:** Max 2 auto-fix attempts per service per 48 hours prevents infinite fix loops.
6. **Spec quality gate:** Generated specs must score >= 0.7 on the same quality check used for human-authored specs.

### New Gateway Endpoints

- `POST /api/v1/self-healing/report` -- Receive health check data
- `GET /api/v1/self-healing/health` -- Self-healing service health
- `GET /api/v1/self-healing/config` -- Current configuration
- `PATCH /api/v1/self-healing/config` -- Update autonomy level
- `POST /api/v1/self-healing/kill-switch` -- Emergency stop
- `GET /api/v1/self-healing/active` -- Active repair tasks
- `GET /api/v1/self-healing/history` -- Repair history
- `POST /api/v1/self-healing/verify/:vtid` -- Trigger verification
- `GET /api/v1/self-healing/snapshots/:vtid` -- Pre/post-fix snapshots
- `POST /api/v1/self-healing/rollback/:vtid` -- Request rollback

### Database Tables

Three new tables: `self_healing_log`, `self_healing_snapshots`, `system_config`.

### Governance Compliance

Touches 5 governance rules: VTID Allocation, Spec Approval Gate, Validator Hard Gate, Deploy Governance, OASIS Authority.

## Test Plan Summary

31 tests organized into 7 layers:

| Layer | Tests | Coverage |
|-------|-------|----------|
| Pre-deploy | T-01, T-02 | TypeScript compilation, import chain verification |
| Database | T-03 to T-05 | Migration execution, table verification, default config |
| Smoke | T-06 to T-12 | Health, config, active tasks, history, input validation |
| Config | T-13 to T-17 | Kill switch activate/deactivate, config reflection, report blocking, autonomy level change |
| Integration | T-18 to T-22 | All-healthy report, down service VTID allocation, dedup, active tasks, OASIS events |
| Pipeline | T-23 to T-26 | Full pipeline (diagnosis + spec + inject), spec generation event, VTID API visibility, history |
| Verification | T-27 to T-29 | Verification with escalation, snapshot storage, manual rollback |
| UI | T-30, T-31 | Dashboard rendering, kill switch via UI |

## Related Pages

- [[self-healing-system]] -- Concept page with full analysis
- [[spec-governance]] -- Governance rules referenced by the spec
- [[agent-architecture]] -- Agent pipeline used for fix execution

## Sources

- `raw/specs/SELF-HEALING-SYSTEM-SPEC.md`
- `raw/specs/SELF-HEALING-TEST-PLAN.md`

## Last Updated

2026-04-12
