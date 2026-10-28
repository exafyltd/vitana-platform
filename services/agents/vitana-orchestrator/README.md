# Vitana Verification Engine

**VTID: VTID-01175**

Verification subsystem for the Worker Orchestrator (VTID-01163). This is **NOT** a standalone orchestrator - it provides verification stage gates that integrate into the existing production orchestration flow.

## Critical Rules

1. **This subsystem does NOT claim completion** - OASIS is the sole authority
2. All verification results must be written as OASIS stage events
3. Never bypass the existing Worker Orchestrator (VTID-01163)
4. Verification passes/fails inform the orchestrator, not replace it

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 WORKER ORCHESTRATOR (VTID-01163)                │
│                    (Orchestrator of Record)                     │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────────┐  │
│  │  Receive │───▶│ Dispatch │───▶│  Worker claims "done"    │  │
│  │   Task   │    │ to Agent │    │                          │  │
│  └──────────┘    └──────────┘    └────────────┬─────────────┘  │
│                                                │                │
│                  ┌─────────────────────────────▼─────────────┐  │
│                  │   VERIFICATION STAGE GATE (VTID-01175)    │  │
│                  │   ════════════════════════════════════    │  │
│                  │                                           │  │
│                  │   1. Check files exist                    │  │
│                  │   2. Check files modified                 │  │
│                  │   3. Run domain validators                │  │
│                  │   4. Execute tests                        │  │
│                  │   5. Emit OASIS event                     │  │
│                  │                                           │  │
│                  │   Returns: StageGateResult                │  │
│                  │   (passed, reason, recommended_action)    │  │
│                  └────────────┬───────────────────────────┬──┘  │
│                               │                           │     │
│                     ┌─────────▼─────┐           ┌────────▼───┐  │
│                     │    PASSED     │           │   FAILED   │  │
│                     └───────┬───────┘           └─────┬──────┘  │
│                             │                         │         │
│                             ▼                         ▼         │
│                    Write terminal to OASIS:   Retry or Fail    │
│                    status=completed           (orchestrator     │
│                    is_terminal=true            decides)         │
└─────────────────────────────────────────────────────────────────┘
```

## The Key Distinction

| Aspect | Worker Orchestrator (VTID-01163) | Verification Engine (VTID-01175) |
|--------|----------------------------------|----------------------------------|
| Role | Orchestrator-of-record | Verification subsystem |
| Authority | Writes terminal status to OASIS | Emits verification events only |
| Decides completion | YES | NO |
| Controls retry | YES | Recommends only |
| Production path | Gateway/Cloud Run | Called BY orchestrator |

## Installation

```bash
pip install -e .
```

## Usage by Worker Orchestrator (VTID-01163)

```python
from vitana_orchestrator import VerificationStageGate, StageGateConfig, TaskDomain

# Create stage gate
gate = VerificationStageGate(StageGateConfig(
    oasis_gateway_url="https://gateway.vitana.ai",
    workspace_path=Path("/mnt/project"),
))

# After worker claims completion, verify
result = await gate.verify(
    vtid="VTID-01234",
    domain=TaskDomain.BACKEND,
    claimed_changes=[
        {"file_path": "services/gateway/src/routes/auth.ts", "action": "modified"},
    ],
    claimed_output="Task completed! Added auth endpoint.",
    started_at=task_started_at,
)

# Use result to make orchestrator decision
if result.passed:
    # Emit terminal success to OASIS (orchestrator's job)
    await emit_oasis("vtid.stage.worker_orchestrator.success", {
        "vtid": vtid,
        "is_terminal": True,
        "terminal_outcome": "success",
    })
elif result.recommended_action == "retry":
    # Re-dispatch to worker with failure context
    await retry_worker(task, result.reason)
else:
    # Emit terminal failure to OASIS
    await emit_oasis("vtid.stage.worker_orchestrator.failed", {
        "vtid": vtid,
        "is_terminal": True,
        "terminal_outcome": "failure",
        "reason": result.reason,
    })
```

## Domain Validators

### Frontend Validator
- No console.log in production code
- Accessibility (alt attributes)
- No inline styles (prefer Tailwind)

### Backend Validator
- No hardcoded secrets
- No SQL injection vulnerabilities
- Error handling required for routes

### Memory Validator
- RLS policies for new tables
- No DROP TABLE without confirmation
- Transaction wrappers for multiple tables

## OASIS Events

This subsystem emits **verification stage events** (not terminal events):

- `vtid.stage.verification.start` - Verification started
- `vtid.stage.verification.passed` - All checks passed
- `vtid.stage.verification.failed` - One or more checks failed

The orchestrator (VTID-01163) emits terminal events based on these results.

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

## Testing

```bash
pytest tests/
```

## License

MIT
