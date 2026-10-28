# Vitana Orchestrator

> Verification subsystem (VTID-01175) for the Worker Orchestrator that provides stage gates for validating worker-claimed task completions before OASIS records them as terminal.

## Overview

The Vitana Orchestrator -- more precisely, the Verification Engine -- is a subsystem of the Worker Orchestrator (VTID-01163). It does NOT independently claim task completion; OASIS is the sole authority for terminal state. Instead, it provides verification stage gates that the orchestrator invokes after a worker claims a task is done.

## Critical Rules

1. This subsystem does NOT claim completion -- OASIS is the sole authority
2. All verification results are written as OASIS stage events
3. Never bypasses the existing Worker Orchestrator (VTID-01163)
4. Verification passes/fails inform the orchestrator; they do not replace it

## Architecture

The verification engine sits inside the Worker Orchestrator's flow:

```
Receive Task -> Dispatch to Agent -> Worker claims "done"
                                          |
                              Verification Stage Gate (VTID-01175)
                              1. Check files exist
                              2. Check files modified
                              3. Run domain validators
                              4. Execute tests
                              5. Emit OASIS event
                                          |
                              +-------+--------+
                              |                |
                           PASSED           FAILED
                              |                |
                    Write terminal        Retry or Fail
                    to OASIS             (orchestrator decides)
```

## Key Distinction from Worker Orchestrator

| Aspect | Worker Orchestrator (VTID-01163) | Verification Engine (VTID-01175) |
|--------|----------------------------------|----------------------------------|
| Role | Orchestrator-of-record | Verification subsystem |
| Authority | Writes terminal status to OASIS | Emits verification events only |
| Decides completion | YES | NO |
| Controls retry | YES | Recommends only |
| Production path | Gateway/Cloud Run | Called BY orchestrator |

## Usage

```python
from vitana_orchestrator import VerificationStageGate, StageGateConfig, TaskDomain

gate = VerificationStageGate(StageGateConfig(
    oasis_gateway_url="https://gateway.vitana.ai",
    workspace_path=Path("/mnt/project"),
))

result = await gate.verify(
    vtid="VTID-01234",
    domain=TaskDomain.BACKEND,
    claimed_changes=[
        {"file_path": "services/gateway/src/routes/auth.ts", "action": "modified"},
    ],
    claimed_output="Task completed! Added auth endpoint.",
    started_at=task_started_at,
)
```

The `StageGateResult` contains:
- `passed` (bool) -- Whether all checks passed
- `reason` (str) -- Human-readable explanation
- `recommended_action` (str) -- "retry" or "fail" if not passed

## Domain Validators

### Frontend Validator
- No `console.log` in production code
- Accessibility attributes present (alt text)
- No inline styles (prefer Tailwind classes)

### Backend Validator
- No hardcoded secrets in source
- No SQL injection vulnerabilities
- Error handling required for all routes

### Memory Validator
- RLS policies present for new tables
- No `DROP TABLE` without explicit confirmation
- Transaction wrappers for multi-table operations

## OASIS Events

The verification engine emits stage events (not terminal events):

| Event | Meaning |
|-------|---------|
| `vtid.stage.verification.start` | Verification has begun |
| `vtid.stage.verification.passed` | All checks passed |
| `vtid.stage.verification.failed` | One or more checks failed |

The Worker Orchestrator (VTID-01163) then emits terminal events based on these results:
- `vtid.stage.worker_orchestrator.success` (with `is_terminal: true`)
- `vtid.stage.worker_orchestrator.failed` (with `is_terminal: true`)

## Configuration

```python
StageGateConfig(
    oasis_gateway_url="https://gateway.vitana.ai",
    tenant="vitana-prod",
    workspace_path=Path("/mnt/project"),
    verify_files_exist=True,
    verify_files_modified=True,
    run_domain_validators=True,
    run_tests=True,
)
```

All verification steps can be individually toggled.

## Installation

```bash
pip install -e .
```

Tests: `pytest tests/`

## Related Pages

- [[agent-architecture]] -- Overall agent architecture this fits into
- [[memory-indexer]] -- Sibling agent service
- [[self-healing-system]] -- Uses orchestrator pipeline for autonomous fix execution
- [[spec-governance]] -- Validator Hard Gate (VTID-0535) governance rule
- [[summary-agent-services]] -- Source summary of all agent READMEs

## Sources

- `raw/agents/vitana-orchestrator-README.md`

## Last Updated

2026-04-12
