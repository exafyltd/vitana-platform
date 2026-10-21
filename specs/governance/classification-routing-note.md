# How Routing Uses Classification

**VTID:** VTID-01191
**Document Type:** Technical Note
**Version:** 1.0

---

## Overview

The `classification` block in a VTID spec is the **routing root** - it determines which execution path, agents, validators, and resources are allocated to a task.

---

## Routing Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      VTID Spec Submitted                        │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                 SPEC-VAL-002: Validate Classification           │
│                 (primary_domain, system_surface required)       │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Extract primary_domain                       │
└─────────────────────────────────────────────────────────────────┘
                               │
        ┌──────────┬──────────┼──────────┬──────────┬─────────────┐
        ▼          ▼          ▼          ▼          ▼             ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐
   │frontend│ │backend │ │   ai   │ │ memory │ │workflow│ │integration │
   └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────────┘
        │          │          │          │          │             │
        ▼          ▼          ▼          ▼          ▼             ▼
   ┌────────────────────────────────────────────────────────────────┐
   │                   Domain-Specific Routing                      │
   └────────────────────────────────────────────────────────────────┘
```

---

## Domain Routing Rules

### `frontend`

| Attribute | Routing Decision |
|-----------|------------------|
| Worker Agent | UI-specialized worker |
| Validation Profile | `command_hub_frontend` |
| CSP Gate | ENABLED |
| Build Gate | `npm run build` in services/gateway |
| Path Allowlist | `services/gateway/src/frontend/**` |

### `backend`

| Attribute | Routing Decision |
|-----------|------------------|
| Worker Agent | Backend-specialized worker |
| Validation Profile | `gateway_backend` |
| CSP Gate | ENABLED (for API responses) |
| Build Gate | `npm run build` in services/gateway |
| Path Allowlist | `services/gateway/src/**` |

### `ai`

| Attribute | Routing Decision |
|-----------|------------------|
| Worker Agent | AI/Orchestrator worker |
| Validation Profile | Agent-specific |
| CSP Gate | N/A |
| Build Gate | Agent deployment validation |
| Path Allowlist | `services/agents/**` |

### `memory`

| Attribute | Routing Decision |
|-----------|------------------|
| Worker Agent | Data/Memory specialized worker |
| Validation Profile | Memory governance |
| CSP Gate | N/A |
| Build Gate | Schema validation |
| Path Allowlist | `database/**`, `supabase/**` |

### `workflow`

| Attribute | Routing Decision |
|-----------|------------------|
| Worker Agent | Workflow orchestration worker |
| Validation Profile | Workflow-specific |
| CSP Gate | N/A |
| Build Gate | Workflow definition validation |
| Path Allowlist | Task/workflow definitions |

### `integration`

| Attribute | Routing Decision |
|-----------|------------------|
| Worker Agent | Integration-specialized worker |
| Validation Profile | Integration-specific |
| CSP Gate | Per-integration |
| Build Gate | Integration tests |
| Path Allowlist | Integration-specific paths |

---

## System Surface Routing

The `system_surface` array determines which deployments and environments are affected:

| Surface | Environment | Deployment Target |
|---------|-------------|-------------------|
| `vitana_dev` | Development | Dev cluster |
| `vitana_admin` | Admin Portal | Admin deployment |
| `vitana_community` | Community App | Community deployment |
| `vitana_professional` | Professional App | Professional deployment |

**Multi-surface tasks** (e.g., `["vitana_dev", "vitana_admin"]`) require:
1. Validation in all affected environments
2. Coordinated deployment
3. Cross-surface acceptance testing

---

## Execution Mode Impact

| Mode | Routing Behavior |
|------|-----------------|
| `autonomous` | Full autopilot execution permitted |
| `semi_autonomous` | Autopilot with human checkpoints |
| `manual` | Human-initiated, human-validated only |

---

## Secondary Domain Handling

When `secondary_domains` is populated:

1. Primary domain determines the **lead worker**
2. Secondary domains trigger **auxiliary validation**
3. All affected domains must pass their domain-specific gates

Example:
```yaml
classification:
  primary_domain: backend
  secondary_domains: [frontend, memory]
```

This routes to:
- Lead: Backend worker
- Auxiliary: Frontend CSP gate + Memory schema validation

---

## Practical Example

```yaml
classification:
  primary_domain: frontend
  secondary_domains: []
  system_surface:
    - vitana_dev
    - vitana_admin
  execution_mode: autonomous
```

**Routing Result:**
1. Assigned to UI-specialized worker
2. Validation profile: `command_hub_frontend`
3. CSP gate: ENABLED
4. Build gate: `npm run build` in services/gateway
5. Affected deployments: Dev + Admin
6. Autopilot: Permitted (autonomous mode)

---

## Key Principles

1. **`primary_domain` is authoritative** - determines lead execution path
2. **Missing classification blocks execution** - no routing possible
3. **`system_surface` scopes deployment** - limits blast radius
4. **`execution_mode` gates automation** - controls autopilot eligibility
5. **Classification is validated first** - before any execution begins

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-19 | Initial release (VTID-01191) |
