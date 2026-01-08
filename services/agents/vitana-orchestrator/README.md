# Vitana Orchestrator

**VTID: VTID-01175**

Production-grade orchestrator for managing AI sub-agents with **guaranteed task completion**. The key innovation is a verification loop that prevents false confirmations and ensures tasks are truly complete before being marked as done.

## Key Features

### Guaranteed Task Completion

The orchestrator implements a verification loop that:

1. **Never trusts "done" claims** - When a sub-agent claims completion, the orchestrator verifies the work
2. **Catches false completions** - Detects when files don't exist or weren't actually modified
3. **Automatic retry** - Failed verifications trigger automatic retry with exponential backoff
4. **Domain-specific validation** - Runs security, accessibility, and database checks

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    VITANA ORCHESTRATOR                          │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌─────────────────────────┐   │
│  │  Submit  │───▶│ Dispatch │───▶│   VERIFICATION LOOP     │   │
│  │   Task   │    │ to Agent │    │                         │   │
│  └──────────┘    └──────────┘    │  ┌───────────────────┐  │   │
│                                   │  │ 1. Wait for claim │  │   │
│                                   │  │ 2. Verify files   │  │   │
│                                   │  │ 3. Run validators │  │   │
│                                   │  │ 4. Execute tests  │  │   │
│                                   │  │ 5. Check artifacts│  │   │
│                                   │  └───────────────────┘  │   │
│                                   │           │             │   │
│                                   │     ┌─────┴─────┐       │   │
│                                   │     ▼           ▼       │   │
│                                   │  PASSED     FAILED      │   │
│                                   │     │           │       │   │
│                                   │     ▼           ▼       │   │
│                                   │ COMPLETE    RETRY       │   │
│                                   └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
# From the vitana-orchestrator directory
pip install -e .

# With development dependencies
pip install -e ".[dev]"

# With CrewAI support
pip install -e ".[crewai]"
```

## Quick Start

### CLI Usage

```bash
# Run a task
vitana-orchestrator run VTID-01234 "Add user authentication endpoint" \
  --domain backend \
  --target "services/gateway/src/routes/**"

# With verbose output
vitana-orchestrator run VTID-01234 "Fix button styling" -v

# Check status
vitana-orchestrator status

# Initialize config
vitana-orchestrator config --init
```

### Python API

```python
import asyncio
from vitana_orchestrator import VitanaOrchestrator, TaskConfig

async def main():
    # Create orchestrator
    orchestrator = VitanaOrchestrator()

    # Register adapters
    from vitana_orchestrator.adapters import ClaudeAdapter
    adapter = ClaudeAdapter()
    await adapter.initialize()
    orchestrator.register_adapter("backend", adapter)
    orchestrator.register_adapter("default", adapter)

    # Submit task
    task_config = TaskConfig(
        vtid="VTID-01234",
        title="Add user authentication",
        description="Implement JWT-based auth for API endpoints",
        domain="backend",
    )

    task = await orchestrator.submit_task(task_config)

    # Execute with verification
    result = await orchestrator.execute_task(task.task_id)

    print(f"Task {result.status.value}: {result.vtid}")

asyncio.run(main())
```

## Configuration

Configuration can be provided via YAML file or environment variables:

```yaml
# vitana-orchestrator.yml
vtid: VTID-01175
verification:
  required: true
  max_attempts: 3
  auto_retry_on_failure: true

retry:
  max_retries: 3
  delay_ms: 10000
  backoff_multiplier: 2.0

safety:
  max_files_per_task: 20
  forbidden_paths:
    - .env
    - credentials.json
```

## Verification System

The verification system is the core innovation that prevents false completions:

### Verification Stages

1. **File Existence** - Verifies claimed files actually exist
2. **File Modification** - Checks files were modified after task start
3. **Domain Validation** - Runs domain-specific validators:
   - **Frontend**: Accessibility, no console.log, alt attributes
   - **Backend**: No hardcoded secrets, SQL injection protection
   - **Memory**: RLS policies, migration safety
4. **Test Execution** - Runs related tests
5. **Artifact Verification** - Checks expected outputs exist

### False Completion Detection

```
Sub-Agent claims: "Task complete! Modified: services/api/auth.ts"

Orchestrator verification:
  ❌ File does not exist: services/api/auth.ts
  → FALSE COMPLETION DETECTED
  → Incrementing retry counter
  → Re-dispatching task
```

## Adapters

### Claude Adapter

```python
from vitana_orchestrator.adapters import ClaudeAdapter, AdapterConfig

config = AdapterConfig(
    name="claude-backend",
    domain="backend",
    model="claude-3-5-sonnet-20241022",
)
adapter = ClaudeAdapter(config)
```

### CrewAI Adapter

```python
from vitana_orchestrator.adapters import CrewAIAdapter

adapter = CrewAIAdapter()
# Connects to CrewAI service at CREWAI_SERVICE_URL
```

### Mock Adapter (Testing)

```python
from vitana_orchestrator.adapters import MockAdapter

# Configure for testing verification
adapter = MockAdapter(
    success_rate=0.9,
    false_completion_rate=0.1,  # 10% false completions to test detection
)
```

## Safety Features

- **Path Protection** - Blocks access to sensitive files (.env, credentials)
- **Rate Limiting** - Prevents runaway execution
- **Scope Limits** - Maximum files/directories per task
- **Secret Detection** - Catches leaked credentials in output

## Metrics

```python
stats = orchestrator.get_stats()
print(f"Tasks completed: {stats['tasks_completed']}")
print(f"False completions caught: {stats['false_completions_caught']}")
print(f"Verification pass rate: {stats['verification_passes'] / stats['tasks_submitted']}")
```

## Testing

```bash
# Run all tests
pytest

# With coverage
pytest --cov=vitana_orchestrator

# Run specific test file
pytest tests/test_verification.py -v
```

## OASIS Integration

The orchestrator emits events to OASIS for observability:

- `vtid.stage.orchestrator.start`
- `vtid.stage.orchestrator.dispatch`
- `vtid.stage.orchestrator.verify`
- `vtid.stage.orchestrator.complete`
- `vtid.stage.orchestrator.fail`

## License

MIT License - See LICENSE file for details.
