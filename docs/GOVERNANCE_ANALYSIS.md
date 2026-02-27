# Vitana Governance Deep Analysis

**Date:** 2026-02-26
**Scope:** Full codebase governance audit across database, API, validators, specs, and documentation
**Branch:** claude/analyze-vitana-governance-OecxN

---

## 1. Executive Summary

Vitana uses a **multi-layered, rule-based governance system** (L1-L4 severity) rather than blockchain-style DAO/voting. The governance architecture spans:

- **35 active rules** across 6 categories (DB, Migration, Frontend, CI/CD, Agent, API) + 1 hard task-discovery rule
- **12 VTID spec validator rules** for spec compliance
- **9 database migrations** building the governance schema
- **4 API route groups** exposing governance operations
- **3 subsystems**: core governance, memory governance, system controls

**Overall Maturity Assessment: Phase 0.1 (Foundation Laid, Not Yet Enforced)**

The governance framework is **well-documented and well-structured** but has significant gaps between what is specified and what is actually enforced at runtime. Below is a detailed breakdown of findings and recommended changes.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     GOVERNANCE LAYERS                           │
├─────────────────────────────────────────────────────────────────┤
│  L4 - Agent Governance (7 rules)                               │
│  Claude Operational Protocol, Command Hierarchy, VTID Req.     │
├─────────────────────────────────────────────────────────────────┤
│  L3 - Migration & Source Control (8 rules)                     │
│  Idempotent SQL, CI-Only Execution, Canonical Source           │
├─────────────────────────────────────────────────────────────────┤
│  L2 - Standards & Conventions (14 rules)                       │
│  CI/CD Naming, OpenAPI, CSP, API Traceability                  │
├─────────────────────────────────────────────────────────────────┤
│  L1 - Database Security (6 rules)                              │
│  RLS, Tenant Isolation, Service Role Write Access              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    SUBSYSTEMS                                   │
├────────────────┬───────────────────┬────────────────────────────┤
│  Core Gov.     │  Memory Gov.      │  System Controls           │
│  (VTID-0400)   │  (VTID-01099)     │  (VTID-01181)              │
│  35 rules      │  4 tables         │  Arm/disarm panel          │
│  Proposals     │  10 RPC functions │  Audit trail               │
│  Evaluations   │  Visibility/Lock/ │  Time-limited arming       │
│  Violations    │  Delete/Export    │  Role-gated access         │
│  Enforcements  │                   │                            │
└────────────────┴───────────────────┴────────────────────────────┘
```

---

## 3. Component-by-Component Findings

### 3.1 Database Schema (Governance Core)

**Location:** `supabase/migrations/20251120000000_init_governance.sql`

**Tables:**
| Table | Purpose | RLS | Issues |
|-------|---------|-----|--------|
| `governance_categories` | Rule categories | Yes | `USING (true)` for SELECT - no tenant isolation on reads |
| `governance_rules` | Rule definitions | Yes | Same - no tenant-scoped reads |
| `governance_evaluations` | Rule evaluation results | Yes | Same |
| `governance_violations` | Violation tracking | Yes | Same |
| `governance_enforcements` | Enforcement actions | Yes | Same |
| `governance_proposals` | Proposal lifecycle | Yes | Same |
| `governance_catalog` | Versioned catalog metadata | Yes | Same |

**FINDING GOV-F01: RLS policies use `USING (true)` for all SELECT**
- **Severity:** Medium
- **Detail:** All governance tables allow any authenticated user to read any tenant's governance data. While the rules doc (GOV-DB-003) states "Authenticated Read Access" is intentional for transparency, this contradicts the tenant isolation invariant documented in `auth-merge-guardrails.md`.
- **Recommendation:** Decide explicitly whether governance rules are cross-tenant-visible (acceptable for system-level `SYSTEM` tenant rules) or should be tenant-scoped. If cross-tenant, document this exception. If not, add tenant-aware RLS.

**FINDING GOV-F02: `tenant_id` is TEXT in governance tables but UUID in memory governance tables**
- **Severity:** Medium
- **Detail:** `governance_categories.tenant_id` is `TEXT NOT NULL` while `memory_visibility_prefs.tenant_id` is `UUID NOT NULL`. This type inconsistency means join queries between governance and memory tables won't work without casting.
- **Recommendation:** Standardize tenant_id type across all governance tables. The platform uses UUID elsewhere (memory, system controls reference patterns), so TEXT for governance is an outlier.

**FINDING GOV-F03: No `updated_at` column on core governance tables**
- **Severity:** Low
- **Detail:** `governance_rules`, `governance_categories`, `governance_violations` lack `updated_at` timestamps, making it hard to track when rules were last modified. Only `governance_proposals` has it (with auto-trigger).
- **Recommendation:** Add `updated_at` to `governance_rules` and `governance_categories` with auto-update triggers, matching the proposal table pattern.

---

### 3.2 Governance Rules Catalog

**Location:** `specs/governance/rules.json` + `specs/governance/rules.md`

**FINDING GOV-F04: Catalog is frozen at commit `654c542` / version 0.1 from 2025-12-03**
- **Severity:** High
- **Detail:** The catalog was extracted once and never updated. Multiple governance events have occurred since (memory governance VTID-01099, system controls VTID-01181, task discovery GOV-INTEL-R.1) but the catalog still says "35 rules, 6 categories." The actual rule count is now higher.
- **Recommendation:** Implement a catalog sync mechanism. Either: (a) auto-generate rules.json/rules.md from database on each governance migration, or (b) add a CI check that verifies the catalog matches the database state.

**FINDING GOV-F05: Dual-source rule definitions**
- **Severity:** High
- **Detail:** Rules exist in three places: (1) `specs/governance/rules.json` (static), (2) `governance_rules` database table (seeded by migration), (3) documentation in `specs/governance/rules.md`. If any of these gets out of sync, there's no single source of truth for governance rules.
- **Recommendation:** Designate ONE canonical source (recommend: database) and auto-generate the others. The `rules.json` should be derived from the database, not the other way around.

**FINDING GOV-F06: Missing categories in catalog**
- **Severity:** Medium
- **Detail:** The catalog defines 6 categories but at least 7 exist: the `TASK_DISCOVERY` category (GOV-INTEL-R.1 from VTID-01160) is not reflected in the catalog. The system_controls subsystem (VTID-01181) also has no governance category.
- **Recommendation:** Add `TASK_DISCOVERY` and `SYSTEM_CONTROLS` categories to the catalog. Update category count.

---

### 3.3 Governance API Layer

**Location:** `services/gateway/src/controllers/governance-controller.ts`, `services/gateway/src/routes/governance.ts`

**Endpoints:**
| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/v1/governance/evaluate` | POST | Deploy evaluation | Implemented |
| `/api/v1/governance/categories` | GET | List categories | Implemented |
| `/api/v1/governance/rules` | GET | List rules | Implemented |
| `/api/v1/governance/rules/:ruleCode` | GET | Get rule by code | Implemented |
| `/api/v1/governance/proposals` | GET/POST | List/Create proposals | Implemented |
| `/api/v1/governance/proposals/:id/status` | PATCH | Update proposal status | Implemented |
| `/api/v1/governance/evaluations` | GET | Evaluation history | Implemented |
| `/api/v1/governance/violations` | GET | Violations | Implemented |
| `/api/v1/governance/enforcements` | GET | Enforcement actions | Implemented |
| `/api/v1/governance/feed` | GET | Governance feed | Implemented |
| `/api/v1/governance/history` | GET | History (VTID-0408) | Implemented |
| `/api/v1/governance/controls/*` | GET/POST | System controls | Implemented |

**FINDING GOV-F07: No authentication middleware on governance routes**
- **Severity:** High
- **Detail:** The governance routes (`governance.ts`) don't appear to use auth middleware. The controller falls back to `'SYSTEM'` tenant_id from headers. Compare with `memory-governance.ts` which properly checks for Bearer token on every route. The `governance-controls.ts` checks headers for role but doesn't validate JWT.
- **Recommendation:** Add proper authentication middleware to governance routes. At minimum, require a valid JWT. For write operations (proposals, evaluations), enforce role-based access like `governance-controls.ts` does.

**FINDING GOV-F08: Governance controller tenant_id defaults to 'SYSTEM'**
- **Severity:** Medium
- **Detail:** `governance-controller.ts:31` - `getTenantId()` defaults to 'SYSTEM' if no header is provided. This means unauthenticated or misconfigured requests will silently access SYSTEM-scoped rules.
- **Recommendation:** Either require explicit tenant_id or fail with 400 if not provided (except for truly public endpoints like listing SYSTEM rules).

**FINDING GOV-F09: Governance controls role check uses headers, not JWT claims**
- **Severity:** High
- **Detail:** `governance-controls.ts:38-41` extracts `x-user-id` and `x-user-role` from headers directly. This is a security concern - any client can set arbitrary headers. The TODO at line 50 confirms: "In production, restrict to: ['dev_admin', 'governance_admin', 'admin']."
- **Recommendation:** Replace header-based role extraction with JWT claim extraction. Use the same `createUserSupabaseClient(token)` pattern that memory governance uses.

---

### 3.4 Validator Core

**Location:** `services/gateway/src/validator-core/`

**Files:**
| File | Purpose |
|------|---------|
| `rule-matcher.ts` | Matches rules to evaluation contexts |
| `evaluation-engine.ts` | Evaluates rule logic |
| `enforcement-executor.ts` | Executes enforcement actions |
| `violation-generator.ts` | Creates violation records |
| `oasis-pipeline.ts` | Routes violations to OASIS |
| `task-discovery-validator.ts` | GOV-INTEL-R.1 enforcement |

**FINDING GOV-F10: Validator core is instantiated but enforcement is unclear**
- **Severity:** High
- **Detail:** The governance controller creates instances of `RuleMatcher`, `EvaluationEngine`, `EnforcementExecutor`, `ViolationGenerator`, and `OasisPipeline` but these appear to be skeleton implementations. The `evaluateDeploy` endpoint is the only active enforcement point. Most rules (GOV-CICD-*, GOV-FRONTEND-*, GOV-MIGRATION-*) are enforced via CI workflows, not the runtime validator.
- **Recommendation:** Clarify which rules are CI-enforced vs runtime-enforced. Consider building a runtime governance middleware that evaluates applicable rules on every request (at least for L1 rules like tenant isolation).

---

### 3.5 Memory Governance

**Location:** `supabase/migrations/20251231100000_vtid_01099_memory_governance_v1.sql`, `services/gateway/src/routes/memory-governance.ts`

**Tables:**
| Table | Purpose | RPC Functions |
|-------|---------|---------------|
| `memory_visibility_prefs` | Domain-level visibility control | `memory_set_visibility` |
| `memory_locks` | Entity lock from downstream use | `memory_lock_entity`, `memory_unlock_entity`, `memory_get_locked_entities`, `memory_is_entity_locked` |
| `memory_deletions` | Soft-delete ledger | `memory_delete_entity`, `memory_is_entity_deleted` |
| `memory_exports` | Data portability | `memory_request_export`, `memory_get_export_status` |

**FINDING GOV-F11: Memory export processing is not implemented**
- **Severity:** Medium
- **Detail:** The `memory_request_export` function creates an export request with status `'pending'` but there is no background worker or processing pipeline to actually generate the export file. The export will remain in `'pending'` state forever.
- **Recommendation:** Implement an export processing worker (could be a Cloud Run Job or scheduled function) that:
  1. Picks up pending exports
  2. Queries relevant memory data
  3. Generates JSON/CSV files
  4. Uploads to storage and updates `file_url`
  5. Marks status as `'ready'`

**FINDING GOV-F12: Memory deletion cascade is v1 stub**
- **Severity:** Low
- **Detail:** The `memory_delete_entity` function records cascade *intentions* but doesn't actually cascade. Comments note: "Future versions will implement actual cascade logic." This means deleting a diary entry doesn't actually remove linked garden nodes or relationship signals.
- **Recommendation:** Implement actual cascade logic in v2 or document clearly that v1 only records deletion intent.

**FINDING GOV-F13: Memory governance has no governance rules in catalog**
- **Severity:** Medium
- **Detail:** The memory governance tables and functions aren't tracked by any GOV-* rules. There should be rules like:
  - `GOV-MEMORY-001`: RLS on memory governance tables
  - `GOV-MEMORY-002`: User-only access to own memory settings
  - `GOV-MEMORY-003`: Export data portability compliance
- **Recommendation:** Create governance rules for the memory governance subsystem and add them to the catalog.

---

### 3.6 System Controls

**Location:** `supabase/migrations/20260117150000_vtid_01181_governance_controls.sql`, `services/gateway/src/routes/governance-controls.ts`

**FINDING GOV-F14: Only one system control exists**
- **Severity:** Low
- **Detail:** Only `vtid_allocator_enabled` is seeded. The system is designed for multiple controls but only one is in use.
- **Recommendation:** Identify other high-risk capabilities that should be controllable: deployment auto-approve, export processing, AI agent autonomous mode, etc. Add them as disarmed controls.

**FINDING GOV-F15: System controls lack tenant_id**
- **Severity:** Medium
- **Detail:** The `system_controls` table uses `key TEXT PRIMARY KEY` without tenant_id. This means controls are global, not tenant-scoped. For a multi-tenant platform, different tenants might need different control states.
- **Recommendation:** Either add tenant_id to system_controls or explicitly document that these are platform-level (not tenant-level) controls.

---

### 3.7 Governance Proposals

**Location:** `supabase/migrations/20251120000002_init_governance_proposals.sql`

**FINDING GOV-F16: Proposal workflow has no approval/voting mechanism**
- **Severity:** High
- **Detail:** Proposals follow a lifecycle (Draft -> Under Review -> Approved/Rejected -> Implemented) but there's no actual approval mechanism. Any service_role write can move status from any state to any other. There are no:
  - Required approvers
  - Minimum review period
  - Quorum requirements
  - Impact assessment workflow
  - Notification/escalation system
- **Recommendation:** Implement governance approval workflow:
  1. Add `required_approvers` array to proposals
  2. Add `approvals` JSONB array tracking who approved
  3. Add minimum review period before approval
  4. Block direct Approved->Implemented without validation evidence
  5. Emit OASIS events for each status transition

---

### 3.8 VTID Spec Validation

**Location:** `specs/governance/vtid-spec-schema-v1.json`, `specs/governance/vtid-spec-validator-rules-v1.md`

**FINDING GOV-F17: Spec schema exists but validator is not wired into CI**
- **Severity:** High
- **Detail:** The VTID spec schema and 12 validator rules are well-defined (SPEC-VAL-001 through SPEC-VAL-012) but there's no GitHub Actions workflow that actually validates specs against the schema on PR open/update.
- **Recommendation:** Create a `VALIDATE-VTID-SPECS.yml` workflow that runs the spec validator on all changed spec files.

---

### 3.9 PR Validator Rules

**Location:** `gov/validator-rules.yaml`

**FINDING GOV-F18: Validator rules YAML is not connected to any enforcement mechanism**
- **Severity:** High
- **Detail:** The `validator-rules.yaml` defines comprehensive PR validation rules (VTID in title, scope declarations, evidence packs, CSP scanning, build gates, route mount gates) but there's no GitHub Action or bot that reads and enforces these rules. They exist as a spec only.
- **Recommendation:** Either:
  1. Build a GitHub Action that parses `validator-rules.yaml` and enforces rules on PRs, or
  2. Convert these rules into concrete GitHub Actions workflow steps

---

## 4. Cross-Cutting Concerns

### 4.1 Governance Rule Enforcement Gaps

| Rule | Documented? | DB Seeded? | CI Enforced? | Runtime Enforced? | Gap |
|------|-------------|------------|--------------|-------------------|-----|
| GOV-MIGRATION-001-007 | Yes | Yes | Partially | No | CI workflow exists but doesn't validate all 7 sub-rules |
| GOV-FRONTEND-001 | Yes | Yes | Yes | No | Workflow exists |
| GOV-FRONTEND-002-003 | Yes | Yes | No | No | No CI or runtime validation |
| GOV-CICD-001-009 | Yes | Yes | Partially | No | Some naming enforcement exists |
| GOV-DB-001-006 | Yes | Yes | No | Partial | RLS exists in migrations but no runtime check |
| GOV-AGENT-001-007 | Yes | Yes | No | No | Protocol doc only, no automated enforcement |
| GOV-API-001-003 | Yes | Yes | Partially | Partially | VTID middleware exists, health check in deploy |
| GOV-INTEL-R.1 | Yes | Yes | No | Yes | Task discovery validator enforces at runtime |

**Bottom line:** Only ~20% of governance rules have any automated enforcement. Most exist as documentation/database records but lack CI or runtime gates.

### 4.2 Type System Consistency

| Field | Core Governance | Memory Governance | System Controls |
|-------|----------------|-------------------|-----------------|
| tenant_id type | TEXT | UUID | N/A (global) |
| Primary key | UUID (uuid_generate_v4) | UUID (gen_random_uuid) | TEXT |
| Timestamps | TIMESTAMPTZ DEFAULT NOW() | TIMESTAMPTZ NOT NULL DEFAULT NOW() | TIMESTAMPTZ NOT NULL DEFAULT NOW() |
| UUID generation | uuid_generate_v4() | gen_random_uuid() | gen_random_uuid() |

**FINDING GOV-F19: Inconsistent UUID generation functions**
- **Severity:** Low
- **Detail:** Core governance uses `uuid_generate_v4()` (requires uuid-ossp extension) while memory governance uses `gen_random_uuid()` (built into PostgreSQL 13+). Both work but should be standardized.
- **Recommendation:** Standardize on `gen_random_uuid()` as it doesn't require an extension.

### 4.3 Missing Governance Areas

The following areas lack governance rules entirely:

1. **Data Retention/Cleanup** - No rules for when to purge old evaluations, violations, or audit logs
2. **Rate Limiting** - No governance for API rate limits or abuse prevention
3. **Logging Governance** - No rules about what must/must not be logged (PII protection)
4. **Backup/Recovery** - No governance around backup verification or disaster recovery
5. **Access Grants** - The `memory_access_grants` table is referenced in invariants but no governance rules exist for it
6. **Inter-Service Communication** - No rules governing how services communicate (mTLS, API keys, etc.)
7. **Secret Rotation** - GOV-MIGRATION-005 says use only existing secrets but no rule governs secret rotation
8. **Deployment Rollback** - GOV-API-003 records deployments but no governance for automated rollback
9. **Consent Management** - Memory governance handles visibility but no GDPR/consent governance rules

---

## 5. Priority Recommendations

### P0 - Critical (Address Immediately)

| # | Finding | Action |
|---|---------|--------|
| 1 | GOV-F07: No auth on governance routes | Add JWT authentication middleware to all `/api/v1/governance/*` routes |
| 2 | GOV-F09: Header-based role check | Replace with JWT claim extraction for `governance-controls.ts` |
| 3 | GOV-F10: Validator core not enforcing | Audit which rules are actually enforced; wire up at least L1 rules |

### P1 - High (Address This Sprint)

| # | Finding | Action |
|---|---------|--------|
| 4 | GOV-F04: Frozen catalog | Implement catalog auto-sync from database |
| 5 | GOV-F05: Dual-source rules | Designate database as single source; auto-generate specs from DB |
| 6 | GOV-F16: No approval mechanism | Implement proposal approval workflow with required approvers |
| 7 | GOV-F17: Spec validator not in CI | Create `VALIDATE-VTID-SPECS.yml` GitHub Actions workflow |
| 8 | GOV-F18: Validator YAML not enforced | Build PR validation enforcement from `validator-rules.yaml` |

### P2 - Medium (Next Sprint)

| # | Finding | Action |
|---|---------|--------|
| 9 | GOV-F01: RLS cross-tenant reads | Document exception or add tenant-scoped governance reads |
| 10 | GOV-F02: tenant_id TEXT vs UUID | Migrate governance tables to UUID tenant_id |
| 11 | GOV-F06: Missing categories | Add TASK_DISCOVERY and SYSTEM_CONTROLS categories |
| 12 | GOV-F08: Default SYSTEM tenant | Require explicit tenant_id on write endpoints |
| 13 | GOV-F11: Export not implemented | Build export processing worker |
| 14 | GOV-F13: Memory gov not in catalog | Create GOV-MEMORY-* rules |
| 15 | GOV-F15: Controls lack tenant_id | Document as platform-level or add tenant scoping |

### P3 - Low (Backlog)

| # | Finding | Action |
|---|---------|--------|
| 16 | GOV-F03: Missing updated_at | Add updated_at to core governance tables |
| 17 | GOV-F12: Cascade stub | Implement actual cascade logic in v2 |
| 18 | GOV-F14: Single control | Add more system controls |
| 19 | GOV-F19: UUID function inconsistency | Standardize on gen_random_uuid() |

---

## 6. Governance Maturity Roadmap

### Current State: Phase 0.1 (Foundation)
- Schema and tables exist
- Rules documented in specs and seeded in DB
- Basic API endpoints functional
- Auth merge guardrails documented
- Memory governance v1 deployed

### Phase 0.2: Enforcement (Recommended Next)
- [ ] Auth middleware on all governance routes
- [ ] L1 rules enforced at runtime
- [ ] Catalog auto-sync mechanism
- [ ] CI validation for VTID specs
- [ ] PR validator enforcement

### Phase 0.3: Operational
- [ ] Proposal approval workflow with required approvers
- [ ] Governance dashboard in Command Hub (real-time rule status)
- [ ] Automated violation alerts (Slack/email)
- [ ] Governance audit reports
- [ ] Export processing pipeline

### Phase 1.0: Mature
- [ ] All 35+ rules enforced (CI + runtime)
- [ ] Governance versioning (rule evolution tracked)
- [ ] Multi-tenant governance scoping
- [ ] Self-healing enforcement (auto-remediation for certain violations)
- [ ] Governance analytics and trend reporting
- [ ] GDPR/consent governance integration

---

## 7. File Reference Index

| File | Purpose | Key Findings |
|------|---------|--------------|
| `gov/validator-rules.yaml` | PR validation rules | GOV-F18: Not enforced |
| `specs/governance/rules.json` | Rule catalog (structured) | GOV-F04, F05: Frozen, dual-source |
| `specs/governance/rules.md` | Rule catalog (readable) | GOV-F04, F05 |
| `specs/governance/vtid-spec-schema-v1.json` | VTID spec JSON schema | GOV-F17: Not in CI |
| `specs/governance/vtid-spec-validator-rules-v1.md` | 12 spec validator rules | GOV-F17 |
| `docs/GOVERNANCE/CLAUDE_START_PROMPT.md` | Claude Operational Protocol | Reference only |
| `docs/governance/auth-merge-guardrails.md` | Auth merger guardrails | Security invariants |
| `docs/governance/CEO-HANDOVER-REVISED.md` | Frontend canonical source | |
| `supabase/migrations/20251120000000_init_governance.sql` | Core governance schema | GOV-F01, F02, F03 |
| `supabase/migrations/20251120000001_add_migration_governance_rules.sql` | Migration rules seed | |
| `supabase/migrations/20251120000002_init_governance_proposals.sql` | Proposals table | GOV-F16 |
| `supabase/migrations/20251203000000_governance_catalog_init.sql` | Catalog + full rule seed | GOV-F04 |
| `supabase/migrations/20251203120000_fix_governance_rule_levels.sql` | Level corrections | |
| `supabase/migrations/20251207000000_fix_governance_rules_rule_id_constraint.sql` | Constraint fix | |
| `supabase/migrations/20251231100000_vtid_01099_memory_governance_v1.sql` | Memory governance | GOV-F11, F12, F13 |
| `supabase/migrations/20260117150000_vtid_01181_governance_controls.sql` | System controls | GOV-F14, F15 |
| `services/gateway/src/types/governance.ts` | TypeScript interfaces | |
| `services/gateway/src/controllers/governance-controller.ts` | API controller | GOV-F07, F08, F10 |
| `services/gateway/src/routes/governance.ts` | Core governance routes | GOV-F07 |
| `services/gateway/src/routes/governance-controls.ts` | System control routes | GOV-F09 |
| `services/gateway/src/routes/memory-governance.ts` | Memory governance routes | Properly authed |
| `services/gateway/src/validator-core/` | Rule evaluation engine | GOV-F10 |

---

*This analysis covers the governance system as of 2026-02-26. Total findings: 19 (3 Critical, 5 High, 7 Medium, 4 Low).*
