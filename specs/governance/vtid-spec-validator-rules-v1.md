# VTID Spec Validator Rules v1

**VTID:** VTID-01191
**Status:** FROZEN
**Version:** 1.0
**Effective Date:** 2026-01-19

---

## Overview

This document defines the validator rules that MUST be enforced for all VTID specifications.
Validators (CI, runtime, pre-commit) use these rules to block non-compliant specs.

---

## Rule Catalog

### SPEC-VAL-001: Identity Block Required

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-001` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime, Pre-commit |
| Failure Action | BLOCK |

**Logic:**
```
IF identity IS MISSING OR identity IS NULL
THEN FAIL("Identity block is required")
```

**Required Fields:**
- `identity.vtid` - Must match pattern `^VTID-\d{4,5}$`
- `identity.title` - Non-empty, max 80 characters
- `identity.owner_role` - Must be one of: `dev_admin`, `admin`, `system`
- `identity.tenant_scope` - Must be one of: `vitana`, `maxina`, `alkalma`, `multi`

---

### SPEC-VAL-002: Classification Block Required

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-002` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime, Pre-commit |
| Failure Action | BLOCK |

**Logic:**
```
IF classification IS MISSING OR classification IS NULL
THEN FAIL("Classification block is required - routing cannot proceed")
```

**Required Fields:**
- `classification.primary_domain` - Exactly one of: `frontend`, `backend`, `ai`, `memory`, `workflow`, `integration`
- `classification.system_surface` - Array with at least one element
- `classification.execution_mode` - Must be one of: `autonomous`, `semi_autonomous`, `manual`

**Validation Rules:**
1. `primary_domain` must not appear in `secondary_domains`
2. `system_surface` values must be unique
3. Missing `primary_domain` is a hard failure

---

### SPEC-VAL-003: Primary Domain Exactly One

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-003` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime |
| Failure Action | BLOCK |

**Logic:**
```
IF classification.primary_domain NOT IN ['frontend', 'backend', 'ai', 'memory', 'workflow', 'integration']
THEN FAIL("Invalid primary_domain: must be exactly one of the allowed values")

IF classification.primary_domain IN classification.secondary_domains
THEN FAIL("primary_domain cannot also appear in secondary_domains")
```

---

### SPEC-VAL-004: System Surface Non-Empty

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-004` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime |
| Failure Action | BLOCK |

**Logic:**
```
IF classification.system_surface IS EMPTY OR LENGTH(system_surface) < 1
THEN FAIL("system_surface must contain at least one valid surface")

FOR EACH surface IN classification.system_surface:
  IF surface NOT IN ['vitana_dev', 'vitana_admin', 'vitana_community', 'vitana_professional']
  THEN FAIL("Invalid system_surface value: " + surface)
```

---

### SPEC-VAL-005: Intent Block Complete

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-005` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime, Pre-commit |
| Failure Action | BLOCK |

**Logic:**
```
IF intent IS MISSING
THEN FAIL("Intent block is required")

IF intent.problem_statement IS EMPTY
THEN FAIL("problem_statement cannot be empty")

IF intent.desired_outcome IS EMPTY
THEN FAIL("desired_outcome cannot be empty")

IF intent.non_goals IS NOT ARRAY
THEN FAIL("non_goals must be an array (empty allowed)")
```

---

### SPEC-VAL-006: Surfaces Block Structure

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-006` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime |
| Failure Action | BLOCK |

**Logic:**
```
REQUIRED_BLOCKS = ['frontend', 'backend', 'ai', 'integrations']

FOR EACH block IN REQUIRED_BLOCKS:
  IF surfaces[block] IS MISSING
  THEN FAIL("surfaces." + block + " block is required (empty arrays allowed)")

IF surfaces.frontend.screens IS NOT ARRAY
THEN FAIL("surfaces.frontend.screens must be an array")

IF surfaces.frontend.components IS NOT ARRAY
THEN FAIL("surfaces.frontend.components must be an array")

IF surfaces.backend.services IS NOT ARRAY
THEN FAIL("surfaces.backend.services must be an array")

IF surfaces.backend.endpoints IS NOT ARRAY
THEN FAIL("surfaces.backend.endpoints must be an array")

IF surfaces.ai.agents IS NOT ARRAY
THEN FAIL("surfaces.ai.agents must be an array")
```

---

### SPEC-VAL-007: Memory Block Mandatory

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-007` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime, Pre-commit |
| Failure Action | BLOCK |

**Logic:**
```
IF memory IS MISSING OR memory IS NULL
THEN FAIL("Memory block is MANDATORY - even if no data impact, declare empty arrays")

REQUIRED_FIELDS = ['reads', 'writes', 'categories', 'retention']

FOR EACH field IN REQUIRED_FIELDS:
  IF memory[field] IS MISSING
  THEN FAIL("memory." + field + " is required")

IF LENGTH(memory.categories) < 1
THEN FAIL("memory.categories must have at least one category")

FOR EACH category IN memory.categories:
  IF category NOT IN ['system', 'governance', 'user', 'health', 'workflow']
  THEN FAIL("Invalid memory category: " + category)

IF memory.retention NOT IN ['permanent', 'bounded']
THEN FAIL("memory.retention must be 'permanent' or 'bounded'")
```

---

### SPEC-VAL-008: Workflow Block Structure

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-008` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime |
| Failure Action | BLOCK |

**Logic:**
```
IF workflow IS MISSING
THEN FAIL("Workflow block is required")

IF workflow.triggers IS NOT ARRAY
THEN FAIL("workflow.triggers must be an array")

IF workflow.autopilot IS MISSING
THEN FAIL("workflow.autopilot is required")

IF workflow.autopilot.enabled IS NOT BOOLEAN
THEN FAIL("workflow.autopilot.enabled must be boolean")

IF workflow.autopilot.requires_spec_snapshot IS NOT BOOLEAN
THEN FAIL("workflow.autopilot.requires_spec_snapshot must be boolean")

IF workflow.verification.acceptance_assertions IS NOT BOOLEAN
THEN FAIL("workflow.verification.acceptance_assertions must be boolean")
```

---

### SPEC-VAL-009: Constraints Block Complete

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-009` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime |
| Failure Action | BLOCK |

**Logic:**
```
IF constraints IS MISSING
THEN FAIL("Constraints block is required")

IF constraints.csp NOT IN ['strict', 'relaxed', 'none']
THEN FAIL("constraints.csp must be 'strict', 'relaxed', or 'none'")

IF constraints.additive_only IS NOT BOOLEAN
THEN FAIL("constraints.additive_only must be boolean")

IF constraints.breaking_change IS NOT BOOLEAN
THEN FAIL("constraints.breaking_change must be boolean")

IF constraints.governance_rules IS NOT ARRAY
THEN FAIL("constraints.governance_rules must be an array (empty allowed)")

FOR EACH rule IN constraints.governance_rules:
  IF rule NOT MATCHES '^(GOV-|SYS-RULE-)'
  THEN WARN("governance_rule may be invalid: " + rule)
```

---

### SPEC-VAL-010: Acceptance Criteria Non-Empty

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-010` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime, Pre-commit |
| Failure Action | BLOCK |

**Logic:**
```
IF acceptance IS MISSING OR acceptance IS NOT ARRAY
THEN FAIL("Acceptance block must be an array")

IF LENGTH(acceptance) < 1
THEN FAIL("At least one acceptance criterion is required")

FOR EACH criterion IN acceptance:
  IF criterion.type NOT IN ['condition', 'test', 'manual_verification']
  THEN FAIL("Invalid acceptance type: " + criterion.type)

  IF criterion.description IS EMPTY
  THEN FAIL("Acceptance criterion description cannot be empty")
```

---

### SPEC-VAL-011: VTID Format Compliance

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-011` |
| Level | L1 (Mandatory) |
| Enforcement | CI, Runtime, Pre-commit |
| Failure Action | BLOCK |

**Logic:**
```
VTID_PATTERN = /^VTID-\d{4,5}$/

IF identity.vtid NOT MATCHES VTID_PATTERN
THEN FAIL("VTID must match pattern VTID-XXXXX (4-5 digits)")

LEGACY_PATTERNS = [/^DEV-/, /^ADM-/, /^AICOR-/, /^OASIS-TASK-/]

FOR EACH pattern IN LEGACY_PATTERNS:
  IF identity.vtid MATCHES pattern
  THEN FAIL("Legacy VTID format detected - must use VTID-XXXXX format")
```

---

### SPEC-VAL-012: Breaking Change Guard

| Attribute | Value |
|-----------|-------|
| Rule ID | `SPEC-VAL-012` |
| Level | L2 (Advisory) |
| Enforcement | CI |
| Failure Action | WARN (unless breaking_change=true) |

**Logic:**
```
IF constraints.additive_only = false AND constraints.breaking_change = false
THEN WARN("Conflicting flags: additive_only=false requires explicit breaking_change=true")

IF constraints.breaking_change = true
THEN REQUIRE_APPROVAL("Breaking change declared - requires explicit approval")
```

---

## Rule Summary Table

| Rule ID | Name | Level | Failure Action |
|---------|------|-------|----------------|
| SPEC-VAL-001 | Identity Block Required | L1 | BLOCK |
| SPEC-VAL-002 | Classification Block Required | L1 | BLOCK |
| SPEC-VAL-003 | Primary Domain Exactly One | L1 | BLOCK |
| SPEC-VAL-004 | System Surface Non-Empty | L1 | BLOCK |
| SPEC-VAL-005 | Intent Block Complete | L1 | BLOCK |
| SPEC-VAL-006 | Surfaces Block Structure | L1 | BLOCK |
| SPEC-VAL-007 | Memory Block Mandatory | L1 | BLOCK |
| SPEC-VAL-008 | Workflow Block Structure | L1 | BLOCK |
| SPEC-VAL-009 | Constraints Block Complete | L1 | BLOCK |
| SPEC-VAL-010 | Acceptance Criteria Non-Empty | L1 | BLOCK |
| SPEC-VAL-011 | VTID Format Compliance | L1 | BLOCK |
| SPEC-VAL-012 | Breaking Change Guard | L2 | WARN |

---

## Enforcement Points

### 1. CI Pipeline
- Triggered on: PR open, PR update
- Uses: `vtid-spec-schema-v1.json`
- Blocks merge if any L1 rule fails

### 2. Runtime (Validator Agent)
- Triggered on: Task allocation, Autopilot execution
- Uses: In-memory validation against schema
- Blocks execution if any L1 rule fails

### 3. Pre-commit Hook
- Triggered on: Local commit
- Uses: Local schema validation
- Blocks commit if any L1 rule fails

---

## Integration with Existing Rules

This validator ruleset integrates with existing governance rules:

| Existing Rule | Integration |
|--------------|-------------|
| GOV-AGENT-002 | VTID Required → enforced by SPEC-VAL-011 |
| GOV-API-001 | VTID in requests → validated VTID format |
| GOV-MIGRATION-001 | Idempotent SQL → referenced in constraints.governance_rules |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-19 | Initial frozen release (VTID-01191) |
