# Platform Schema Inventory

> **Status**: PREPARATION PHASE
> **Author**: Claude (Preparation & Governance Engineer)
> **Date**: 2026-01-07
> **Purpose**: Inventory current Vitana Platform Supabase schema for Lovable merger

---

## Executive Summary

The Vitana Platform Supabase schema contains **~135+ tables** across **14 domains**. This inventory classifies each table by ownership, extension safety, and RLS policy patterns.

---

## Schema Classification Legend

| Classification | Meaning | Lovable Can Extend? |
|----------------|---------|---------------------|
| **PLATFORM_CORE** | Critical platform infrastructure | NO |
| **GOVERNANCE** | Governance & compliance tables | NO |
| **OASIS** | Orchestration & observability | NO |
| **DOMAIN_OWNED** | Domain-specific platform data | ADDITIVE ONLY |
| **USER_DATA** | User-scoped personal data | NO (create parallel) |
| **LOOKUP** | Reference/lookup tables | ADDITIVE ONLY |
| **SAFE_EXTEND** | Safe for additive columns/indexes | YES |

---

## 1. PLATFORM CORE (DO NOT MODIFY)

These tables are critical infrastructure. Lovable MUST NOT modify.

### 1.1 Identity & Tenancy

| Table | Purpose | RLS | Owner |
|-------|---------|-----|-------|
| `user_active_roles` | Current active role per user | User-scoped | VTID-01051 |
| `tenants` | Tenant registry | Tenant-scoped | Platform Core |
| `user_tenants` | User-tenant membership | User-scoped | Platform Core |
| `app_users` | Application user profiles | User-scoped | Platform Core |

### 1.2 VTID Ledger

| Table | Purpose | RLS | Owner |
|-------|---------|-----|-------|
| `vtid_ledger` | Master VTID allocation | All authenticated | Platform Core |
| `global_vtid_seq` | VTID sequence (starts 1000) | Service role | Platform Core |

**RLS Policy Pattern**:
```sql
-- Authenticated can read/insert/update own tenant
USING (tenant = current_setting('request.jwt.claims')::json->>'tenant')
```

---

## 2. GOVERNANCE DOMAIN (DO NOT MODIFY)

Governance tables are immutable except by service_role.

| Table | Purpose | RLS | Owner |
|-------|---------|-----|-------|
| `governance_categories` | Rule categories (MIGRATION, FRONTEND, etc.) | Read: authenticated, Write: service_role | VTID-0400 |
| `governance_rules` | Core governance rules | Read: authenticated, Write: service_role | VTID-0400 |
| `governance_evaluations` | Rule evaluation results | Read: authenticated, Write: service_role | VTID-0400 |
| `governance_violations` | Tracked violations | Read: authenticated, Write: service_role | VTID-0400 |
| `governance_enforcements` | Enforcement actions | Read: authenticated, Write: service_role | VTID-0400 |
| `governance_proposals` | Change proposals | Read: authenticated, Write: service_role | VTID-0400 |
| `governance_catalog` | Versioned catalog metadata | Read: authenticated, Write: service_role | VTID-0400 |

---

## 3. OASIS DOMAIN (DO NOT MODIFY)

Orchestration and observability infrastructure.

| Table | Purpose | RLS | Owner |
|-------|---------|-----|-------|
| `oasis_events_v1` | Task execution events | Tenant-aware | OASIS-0102 |
| `software_versions` | Deployment history | Read: all, Insert: service_role | VTID-0510 |

**RLS Policy Pattern**:
```sql
-- Tenant isolation with current_tenant()
USING (tenant = COALESCE((auth.jwt() ->> 'tenant'), 'NO_TENANT'))
```

---

## 4. HEALTH DOMAIN (USER_DATA - Create Parallel)

Health data is strictly user-scoped. Lovable should create parallel tables if needed.

| Table | Purpose | RLS | VTID |
|-------|---------|-----|------|
| `wearable_samples` | Raw wearable device data | `user_id = auth.uid()` | VTID-01103 |
| `biomarker_results` | Lab results, clinical markers | `user_id = auth.uid()` | VTID-01103 |
| `health_features_daily` | Aggregated daily features | `user_id = auth.uid()` | VTID-01103 |
| `vitana_index_scores` | Daily Vitana Index (0-999) | `user_id = auth.uid()` | VTID-01103 |
| `recommendations` | AI-generated health recs | `user_id = auth.uid()` | VTID-01103 |
| `lab_reports` | Lab report documents | `user_id = auth.uid()` | VTID-01103 |

---

## 5. LONGEVITY SIGNALS (DOMAIN_OWNED)

Deterministic longevity signal computation.

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `longevity_signals_daily` | Daily longevity signals | User-scoped | VTID-01083 | ADDITIVE |
| `longevity_signal_rules` | Computation rules | All authenticated read | VTID-01083 | ADDITIVE |

---

## 6. MEMORY DOMAIN (USER_DATA - Create Parallel)

Memory is core platform. Lovable should NOT modify but may read via granted access.

### 6.1 Memory Core

| Table | Purpose | RLS | VTID |
|-------|---------|-----|------|
| `memory_categories` | Lookup table | All authenticated read | VTID-01104 |
| `memory_items` | Long-term memory storage | User + Tenant scoped | VTID-01104 |

### 6.2 Memory Garden & Diary

| Table | Purpose | RLS | VTID |
|-------|---------|-----|------|
| `memory_diary_entries` | Personal diary | User-scoped | VTID-01082 |
| `memory_garden_nodes` | Summary nodes | User-scoped | VTID-01082/85 |
| `memory_garden_config` | Garden layout | User-scoped | VTID-01082 |

### 6.3 Memory Access & Governance

| Table | Purpose | RLS | VTID |
|-------|---------|-----|------|
| `memory_access_grants` | Role-based access grants | Grantor/Grantee scoped | VTID-01085 |
| `memory_retrieve_audit` | Retrieval audit trail | Service role write | VTID-01085 |
| `memory_governance_rules` | Memory usage rules | All authenticated read | VTID-01099 |

### 6.4 Memory Quality & Trust

| Table | Purpose | RLS | VTID |
|-------|---------|-----|------|
| `memory_quality_metrics` | Quality scores | User-scoped | VTID-01100 |
| `memory_confidence_history` | Confidence tracking | User-scoped | VTID-01116 |
| `memory_source_trust` | Source trust scores | User-scoped | VTID-01100 |
| `memory_deletions` | Deletion compliance | User-scoped | VTID-01100 |

---

## 7. COMMUNITY & MATCHMAKING (SAFE_EXTEND)

Community features may be extended additively.

### 7.1 Relationship Graph

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `relationship_nodes` | Entities in graph | Tenant-scoped | VTID-01087 | ADDITIVE |
| `relationship_edges` | Connections | User + Tenant | VTID-01087 | ADDITIVE |
| `relationship_signals` | Behavioral signals | User-scoped | VTID-01087 | ADDITIVE |

### 7.2 Matchmaking Engine

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `match_targets` | Matchable items pool | Tenant read, service write | VTID-01088 | ADDITIVE |
| `matches_daily` | Computed matches | User-scoped | VTID-01088 | ADDITIVE |
| `match_feedback` | User feedback | User-scoped | VTID-01088 | ADDITIVE |

### 7.3 Groups & Meetups

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `community_groups` | Groups with topic keys | Tenant-scoped | VTID-01084 | ADDITIVE |
| `community_meetups` | Events/meetups | Tenant-scoped | VTID-01084 | ADDITIVE |
| `community_memberships` | Membership tracking | User-scoped | VTID-01084 | ADDITIVE |
| `community_recommendations` | Computed suggestions | User-scoped | VTID-01084 | ADDITIVE |

### 7.4 Live Rooms & Events

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `live_rooms` | Live discussion rooms | Tenant-scoped | VTID-01090 | ADDITIVE |
| `live_room_attendance` | Attendance tracking | User-scoped | VTID-01090 | ADDITIVE |
| `event_attendance` | RSVP/attendance | User-scoped | VTID-01090 | ADDITIVE |
| `live_highlights` | Notable moments | User-scoped | VTID-01090 | ADDITIVE |

### 7.5 Locations

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `locations` | Physical locations | Tenant-scoped | VTID-01091 | ADDITIVE |
| `location_visits` | Visit tracking | User-scoped | VTID-01091 | ADDITIVE |
| `location_preferences` | Location preferences | User-scoped | VTID-01091 | ADDITIVE |

### 7.6 Topics Layer

| Table | Purpose | RLS | VTID | Extend? |
|-------|---------|-----|------|---------|
| `topic_registry` | All matchable topics | All authenticated read | VTID-01093 | ADDITIVE |
| `user_topic_profile` | User interests | User-scoped | VTID-01093 | ADDITIVE |

---

## 8. PERSONALIZATION DOMAIN (USER_DATA)

User personalization - create parallel if needed.

### 8.1 User Preferences (VTID-01119)

| Table | Purpose | RLS |
|-------|---------|-----|
| `user_preferences` | Preference settings | User-scoped |
| `user_preference_audit` | Change audit | User-scoped read |
| `preference_categories` | Categories lookup | All authenticated |
| `user_preference_bundles` | Preconfigured bundles | All authenticated |
| `user_preference_inferences` | Inferred preferences | User-scoped |

### 8.2 Health Capacity (VTID-01122)

| Table | Purpose | RLS |
|-------|---------|-----|
| `capacity_state` | Current capacity | User-scoped |
| `capacity_rules` | Computation rules | All authenticated |
| `capacity_overrides` | User overrides | User-scoped |

### 8.3 Life Stage (VTID-01124)

| Table | Purpose | RLS |
|-------|---------|-----|
| `life_stage_assessments` | Life stage | User-scoped |
| `life_stage_goals` | Stage-aligned goals | User-scoped |
| `life_stage_rules` | Computation rules | All authenticated |

### 8.4 Availability (VTID-01127)

| Table | Purpose | RLS |
|-------|---------|-----|
| `availability_assessments` | Current availability | User-scoped |
| `availability_config` | Preferences/calendar | User-scoped |
| `availability_overrides` | Temporary overrides | User-scoped |

---

## 9. SIGNAL DETECTION (DOMAIN_OWNED)

Signal detection infrastructure.

### 9.1 Emotional/Cognitive (VTID-01120)

| Table | Purpose | RLS |
|-------|---------|-----|
| `emotional_cognitive_signals` | State signals | User-scoped |
| `emotional_cognitive_rules` | Detection rules | All authenticated |

### 9.2 Feedback & Trust (VTID-01121)

| Table | Purpose | RLS |
|-------|---------|-----|
| `feedback_propagation_log` | Feedback audit | User-scoped |
| `trust_scores` | Trust dimensions | User-scoped |

---

## 10. CONTENT & CATALOG (LOOKUP)

Content catalog - safe for additive extension.

| Table | Purpose | RLS | Extend? |
|-------|---------|-----|---------|
| `products_catalog` | Product catalog | Tenant-scoped read | ADDITIVE |
| `services_catalog` | Service catalog | Tenant-scoped read | ADDITIVE |
| `knowledge_docs` | Knowledge base | All authenticated read | ADDITIVE |

---

## 11. RLS POLICY PATTERNS

### Pattern 1: User-Scoped (Most Common)

```sql
CREATE POLICY {table}_user_isolation ON {table}
FOR ALL TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND user_id = auth.uid()
);
```

**Used by**: All personal data tables (memory, health, preferences)

### Pattern 2: Tenant-Scoped

```sql
CREATE POLICY {table}_tenant_isolation ON {table}
FOR ALL TO authenticated
USING (tenant_id = public.current_tenant_id());
```

**Used by**: Community, groups, locations, products

### Pattern 3: Service-Role Write, Authenticated Read

```sql
CREATE POLICY {table}_read ON {table}
FOR SELECT TO authenticated USING (true);

CREATE POLICY {table}_write ON {table}
FOR INSERT TO service_role WITH CHECK (true);
```

**Used by**: Governance, OASIS, audit logs

### Pattern 4: Immutable Audit (No UPDATE/DELETE)

```sql
-- Only INSERT and SELECT allowed
-- No UPDATE or DELETE policies
```

**Used by**: `software_versions`, `memory_retrieve_audit`, `governance_*`

---

## 12. KEY RPC FUNCTIONS

### Identity & Context

| Function | Purpose | Security |
|----------|---------|----------|
| `me_context()` | Return canonical identity | SECURITY DEFINER |
| `me_set_active_role(p_role)` | Set active role | SECURITY DEFINER |
| `current_tenant_id()` | Resolve tenant from context | STABLE |
| `current_active_role()` | Resolve role from context | STABLE |
| `dev_bootstrap_request_context(...)` | Dev context setup | Service role only |

### VTID Management

| Function | Purpose | Security |
|----------|---------|----------|
| `allocate_global_vtid(...)` | Allocate next VTID | SECURITY DEFINER |
| `create_vtid_atomic(p_payload)` | Atomic VTID creation | SECURITY DEFINER |

### Health Compute

| Function | Purpose | Security |
|----------|---------|----------|
| `health_compute_features_daily(date)` | Aggregate daily features | SECURITY DEFINER |
| `health_compute_vitana_index(date, model)` | Compute Vitana Index | SECURITY DEFINER |
| `health_generate_recommendations(...)` | Generate recommendations | SECURITY DEFINER |

### Memory Operations

| Function | Purpose | Security |
|----------|---------|----------|
| `memory_write_item(p_payload)` | Write memory item | SECURITY DEFINER |
| `memory_retrieve(p_payload)` | Unified retrieval | SECURITY DEFINER |
| `memory_get_context(...)` | Get memory context | SECURITY DEFINER |

### Longevity

| Function | Purpose | Security |
|----------|---------|----------|
| `longevity_compute_daily(from, to)` | Compute signals | SECURITY DEFINER |
| `longevity_get_daily(date)` | Get day's signals | SECURITY DEFINER |

---

## 13. MIGRATION FILE ORGANIZATION

```
supabase/
├── migrations/          # 86 files (primary)
│   ├── 20251229000000_vtid_01051_*.sql
│   ├── 20251231000000_vtid_01104_*.sql
│   └── ...
database/
├── migrations/          # 15 files (legacy/secondary)
│   └── ...
├── policies/            # 2 files (RLS policies)
│   ├── 002_oasis_events.sql
│   └── 003_vtid_ledger.sql
prisma/
├── migrations/          # 3 files (historical)
    └── ...
```

---

## 14. SAFE EXTENSION ZONES

### Tables Safe for ADDITIVE Columns

Lovable may add columns to these tables (never remove/rename):

- `community_groups` - Add metadata columns
- `community_meetups` - Add scheduling columns
- `match_targets` - Add matching criteria columns
- `topic_registry` - Add topic attributes
- `products_catalog` - Add product attributes
- `services_catalog` - Add service attributes
- `locations` - Add location attributes

### Tables for Parallel Creation

If Lovable needs new user data:

- Create new tables with `lovable_` prefix
- Must include `tenant_id` and `user_id` columns
- Must include standard RLS policies
- Must follow VTID allocation for schema changes

### Tables Forbidden for Modification

- All `governance_*` tables
- All `memory_*` tables
- All `health_*` tables
- `vtid_ledger`
- `user_active_roles`
- `oasis_events_v1`
- `software_versions`

---

## 15. SCHEMA GOVERNANCE RULES

1. **Idempotent Migrations** - All use `IF NOT EXISTS`, `ON CONFLICT`
2. **Tenant Isolation** - All tables include `tenant_id` with RLS
3. **User Isolation** - Personal data includes `user_id` with RLS
4. **Immutable Audit** - Audit tables have no UPDATE/DELETE
5. **JSONB Flexibility** - Use `metadata JSONB` for extensibility
6. **Confidence Scores** - All inferences include `confidence (0-100)`
7. **Explainability** - Include `evidence`, `reasons`, `rules_applied`

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-07 | Initial schema inventory | Claude (Preparation Phase) |

---

*This document is part of the Auth & Supabase Merger Preparation Phase.*
