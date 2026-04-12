# Canonical VTID Spec Template v1

**VTID:** VTID-01191
**Status:** FROZEN
**Version:** 1.0
**Effective Date:** 2026-01-19
**Governance Level:** L1 (Mandatory)

---

## Purpose

This template defines the canonical structure for all VTID specifications in the Vitana platform.
Every VTID MUST have a spec compliant with this template. Non-compliant specs block execution.

---

## Template Structure

```yaml
# =============================================================================
# VTID SPECIFICATION - CANONICAL TEMPLATE v1
# =============================================================================
# INSTRUCTIONS:
# 1. Copy this template for new VTIDs
# 2. Fill ALL sections (empty arrays allowed, missing sections NOT allowed)
# 3. Validate against vtid-spec-schema-v1.json before submission
# =============================================================================

# -----------------------------------------------------------------------------
# 2.1 IDENTITY (REQUIRED)
# -----------------------------------------------------------------------------
identity:
  vtid: "VTID-XXXXX"                    # Pattern: ^VTID-\d{4,5}$
  title: "Short imperative title"       # Max 80 chars, imperative mood
  owner_role: "dev_admin"               # Enum: dev_admin | admin | system
  tenant_scope: "vitana"                # Enum: vitana | maxina | alkalma | multi

# -----------------------------------------------------------------------------
# 2.2 CLASSIFICATION (REQUIRED - ROUTING ROOT)
# -----------------------------------------------------------------------------
# Classification determines execution routing. This is the most critical section.
classification:
  primary_domain: "backend"             # EXACTLY ONE of: frontend | backend | ai | memory | workflow | integration
  secondary_domains: []                 # Optional additional domains
  system_surface:                       # AT LEAST ONE required
    - "vitana_dev"                      # Enum values:
    # - "vitana_admin"                  #   vitana_dev
    # - "vitana_community"              #   vitana_admin
    # - "vitana_professional"           #   vitana_community
  execution_mode: "autonomous"          # Enum: autonomous | semi_autonomous | manual

# -----------------------------------------------------------------------------
# 2.3 INTENT (REQUIRED - Human + AI Readable)
# -----------------------------------------------------------------------------
intent:
  problem_statement: |
    What is broken or missing. Be specific.
    Reference error codes, user reports, or system logs if applicable.
  desired_outcome: |
    What must be true when done. Measurable and verifiable.
    Use "MUST", "SHALL", "SHOULD" language per RFC 2119.
  non_goals:
    - "Explicit exclusion 1"
    - "Explicit exclusion 2"

# -----------------------------------------------------------------------------
# 2.4 AFFECTED SURFACES (REQUIRED - All blocks must exist)
# -----------------------------------------------------------------------------
surfaces:
  frontend:
    screens: []                         # Screen IDs or paths
    components: []                      # Component names or paths
  backend:
    services: []                        # Service names
    endpoints: []                       # Endpoint paths
  ai:
    agents: []                          # Agent identifiers
  integrations: []                      # External system names

# -----------------------------------------------------------------------------
# 2.5 MEMORY & DATA IMPACT (REQUIRED - Omission = Validator Failure)
# -----------------------------------------------------------------------------
memory:
  reads:                                # Data/state this VTID reads
    - "oasis_events"
  writes:                               # Data/state this VTID writes
    - "vtid_ledger"
  categories:                           # AT LEAST ONE required
    - "system"                          # Enum: system | governance | user | health | workflow
  retention: "permanent"                # Enum: permanent | bounded

# -----------------------------------------------------------------------------
# 2.6 WORKFLOW & AUTOMATION (REQUIRED)
# -----------------------------------------------------------------------------
workflow:
  triggers:                             # What initiates this VTID
    - "manual_request"                  # Examples: manual_request, cron, event, pr_merge
  autopilot:
    enabled: false                      # Whether autopilot can execute this
    requires_spec_snapshot: true        # Autopilot must snapshot spec before execution
  verification:
    acceptance_assertions: true         # Machine-checkable acceptance required

# -----------------------------------------------------------------------------
# 2.7 CONSTRAINTS & GUARDRAILS (REQUIRED)
# -----------------------------------------------------------------------------
constraints:
  csp: "strict"                         # Enum: strict | relaxed | none
  additive_only: true                   # No breaking changes to existing interfaces
  breaking_change: false                # Explicit flag for breaking changes
  governance_rules:                     # Referenced governance rules
    - "GOV-AGENT-002"                   # VTID Required for All Tasks
    - "GOV-MIGRATION-001"               # Idempotent SQL Requirement (if DB)

# -----------------------------------------------------------------------------
# 2.8 ACCEPTANCE CRITERIA (REQUIRED - Machine-Checkable)
# -----------------------------------------------------------------------------
acceptance:
  - type: "condition"
    description: "Spec template file exists at specs/governance/canonical-spec-template-v1.md"
  - type: "condition"
    description: "JSON schema validates all required fields"
  - type: "condition"
    description: "Validator rule list is documented"
```

---

## Field Reference

### 2.1 Identity Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `vtid` | string | YES | Unique identifier matching pattern `^VTID-\d{4,5}$` |
| `title` | string | YES | Imperative title, max 80 characters |
| `owner_role` | enum | YES | One of: `dev_admin`, `admin`, `system` |
| `tenant_scope` | enum | YES | One of: `vitana`, `maxina`, `alkalma`, `multi` |

### 2.2 Classification Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `primary_domain` | enum | YES | Exactly one of: `frontend`, `backend`, `ai`, `memory`, `workflow`, `integration` |
| `secondary_domains` | array | NO | Additional domains (empty array allowed) |
| `system_surface` | array | YES | At least one of: `vitana_dev`, `vitana_admin`, `vitana_community`, `vitana_professional` |
| `execution_mode` | enum | YES | One of: `autonomous`, `semi_autonomous`, `manual` |

### 2.3 Intent Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `problem_statement` | string | YES | What is broken or missing |
| `desired_outcome` | string | YES | What must be true when done |
| `non_goals` | array | YES | Explicit exclusions (empty array allowed) |

### 2.4 Surfaces Fields

| Block | Type | Required | Description |
|-------|------|----------|-------------|
| `frontend.screens` | array | YES | Screen identifiers (empty allowed) |
| `frontend.components` | array | YES | Component identifiers (empty allowed) |
| `backend.services` | array | YES | Service names (empty allowed) |
| `backend.endpoints` | array | YES | Endpoint paths (empty allowed) |
| `ai.agents` | array | YES | Agent identifiers (empty allowed) |
| `integrations` | array | YES | External system names (empty allowed) |

### 2.5 Memory Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reads` | array | YES | Data/state read by this VTID (empty allowed) |
| `writes` | array | YES | Data/state written by this VTID (empty allowed) |
| `categories` | array | YES | At least one of: `system`, `governance`, `user`, `health`, `workflow` |
| `retention` | enum | YES | One of: `permanent`, `bounded` |

### 2.6 Workflow Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `triggers` | array | YES | What initiates execution (empty allowed) |
| `autopilot.enabled` | boolean | YES | Whether autopilot can execute |
| `autopilot.requires_spec_snapshot` | boolean | YES | Must snapshot spec before execution |
| `verification.acceptance_assertions` | boolean | YES | Machine-checkable acceptance required |

### 2.7 Constraints Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `csp` | enum | YES | One of: `strict`, `relaxed`, `none` |
| `additive_only` | boolean | YES | No breaking changes to existing interfaces |
| `breaking_change` | boolean | YES | Explicit flag for breaking changes |
| `governance_rules` | array | YES | Referenced rule IDs (empty allowed) |

### 2.8 Acceptance Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | enum | YES | One of: `condition`, `test`, `manual_verification` |
| `description` | string | YES | What must pass |

---

## Governance Rules

1. **Every VTID MUST have a spec compliant with this template**
2. **Missing or invalid spec blocks execution**
3. **Classification is mandatory and authoritative for routing**
4. **A spec may touch multiple domains, but one primary domain is required**
5. **Memory impact must always be declared, even if empty arrays**
6. **Validator must enforce all rules strictly**

---

## Validation

All specs MUST be validated against `vtid-spec-schema-v1.json` before:
- PR submission
- Autopilot execution
- Manual execution

Validation is performed by:
- CI pipeline (automated)
- Validator agent (runtime)
- Pre-commit hooks (local)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-19 | Initial frozen release (VTID-01191) |
