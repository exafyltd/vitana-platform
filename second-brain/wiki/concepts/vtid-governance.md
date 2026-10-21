# VTID Governance

> The VTID (Vitana Task ID) tracking system: numbering format, lifecycle, branching strategy, and integration with OASIS and deployment governance.

## Content

### What is a VTID?

A VTID is the unique identifier assigned to every task, deployment, migration, and governance action in the Vitana platform. VTIDs enable audit trails, status tracking, task relationships, and multi-tenant isolation.

### VTID Formats

Two formats exist in the codebase:

| Format | Example | Context |
|--------|---------|---------|
| `VTID-YYYY-NNNN` | `VTID-2025-0042` | Original format (resets annually) |
| `VTID-XXXXX` | `VTID-01231` | Extended format (5-digit, zero-padded) |

### Task Lifecycle

```
scheduled --> in_progress --> [claimed] --> [executing] --> completed/failed
                                                          |
                                                    is_terminal=true
                                                    terminal_outcome=success|failed|cancelled
```

A task is eligible for worker execution when:
1. `status === 'in_progress'`
2. `spec_status === 'approved'`
3. `is_terminal === false`
4. `claimed_by === null` OR `claimed_by === this_worker`

### Database Schema (vtid_ledger)

Key columns in the `vtid_ledger` table:

| Column | Type | Purpose |
|--------|------|---------|
| `vtid` | TEXT | Primary key (unique identifier) |
| `task_family` | TEXT | High-level category (governance, deployment, analysis) |
| `task_type` | TEXT | Specific task type (migration, test, review) |
| `status` | TEXT | scheduled, in_progress, completed, pending, blocked, cancelled |
| `spec_status` | TEXT | draft, pending_approval, approved, rejected |
| `is_terminal` | BOOLEAN | Task completion flag |
| `tenant` | TEXT | Tenant identifier (system, maxina, earthlings, alkalma) |
| `parent_vtid` | TEXT | Optional parent for subtask relationships |

### Target Roles

```typescript
const TARGET_ROLES = ['DEV', 'COM', 'ADM', 'PRO', 'ERP', 'PAT', 'INFRA'] as const;
```

`INFRA` must be exclusive (cannot combine with others).

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/vtid/create` | Create a new VTID |
| GET | `/vtid/:vtid` | Retrieve VTID details |
| PATCH | `/vtid/:vtid` | Update status or metadata |
| GET | `/vtid/list` | List VTIDs with filters |
| GET | `/vtid/health` | Health check |

### Branching Strategy

For every new VTID, a fresh branch must be created from `origin/main`. Reusing old branches is forbidden.

| VTID Type | Branch Pattern | Example |
|-----------|----------------|---------|
| Command Hub Frontend | `feature/DEV-COMHU-XXXX-*` | `feature/DEV-COMHU-0203-ticker-fix` |
| Backend/API | `feature/VTID-XXXX-*` | `feature/VTID-0600-visibility` |
| Claude Agent | `claude/VTID-XXXX-*` | `claude/VTID-0302-golden-shield` |

### Command Hub Protection Zone

The path `services/gateway/src/frontend/command-hub/**/*` is a protected zone. Only VTIDs with the `DEV-COMHU-*` prefix can modify files in this path. Two CI guardrails enforce this:
1. **Path Ownership Guard** -- fails builds for unauthorized modifications.
2. **Golden Fingerprint Check** -- ensures the bundle contains required markers (task-board, ORB, etc.).

### Integration with Deployment

- The `EXEC-DEPLOY.yml` pipeline has a hard gate (VTID-0542) that checks VTID existence in the OASIS ledger before allowing deployment.
- `AUTO-DEPLOY.yml` extracts the VTID from the commit message and dispatches `EXEC-DEPLOY.yml`.
- If no VTID is found in the commit, the fallback `BOOTSTRAP-AUTO-{sha}` is used.

### Integration with OASIS

VTIDs emit OASIS events for lifecycle transitions:
- `vtid.lifecycle.started` / `vtid.lifecycle.completed` / `vtid.lifecycle.failed`
- `vtid.stage.*` for stage transitions
- `vtid.decision.*` for claims, releases, retries

OASIS is for state transitions and decisions only -- never polling or heartbeats.

### Hard Governance Rules

1. `EXECUTION_DISARMED` -- global kill switch for autonomous execution.
2. `AUTOPILOT_LOOP_ENABLED` -- controls autopilot polling.
3. `VTID_ALLOCATOR_ENABLED` -- controls VTID allocation.
4. One VTID at a time per worker (no parallel execution).

## Related Pages

- [[summary-vtid-system]]
- [[github-actions]]
- [[vitana-platform]]
- [[cloud-run-deployment]]
- [[adr-repo-canonical-structure]]

## Sources

- `raw/governance/VTID_SYSTEM.md`
- `raw/governance/VTID_BRANCHING.md`
- `raw/architecture/vitana-platform-claude-extended.md`
- `raw/governance/CLAUDE_START_PROMPT.md`

## Last Updated

2026-04-12
