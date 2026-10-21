# Database Schema

> Overview of the full Vitana Platform database schema: key tables, domain organization, relationships, the tenant model, and RLS enforcement patterns.

## Content

### Schema at a Glance

The Vitana Platform Supabase database contains approximately **135+ tables** across **14 domains**. The Lovable Supabase project has **271 tables** with overlapping patterns. All tables follow `snake_case` naming. The `DATABASE_SCHEMA.md` file is the canonical single source of truth for table names.

### Critical Rules

1. PostgreSQL tables must use `snake_case`.
2. TypeScript code must reference exact table names from the schema document.
3. Before creating any new table or query, check the schema document first.
4. When adding a new table, update the schema document in the same commit.

### Core Platform Tables

| Table | Domain | Purpose |
|-------|--------|---------|
| `vtid_ledger` | Platform Core | Central VTID task tracking (primary key: `vtid TEXT`) |
| `oasis_events` | OASIS | System-wide event log and audit trail |
| `user_active_roles` | Identity | Current active role per user |
| `tenants` | Identity | Tenant registry |
| `user_tenants` | Identity | User-tenant membership |
| `app_users` | Identity | Application user profiles |
| `personalization_audit` | Personalization | Audit log for cross-domain personalization decisions |

### Health Domain Tables

| Table | Purpose |
|-------|---------|
| `wearable_samples` | Raw wearable device data |
| `biomarker_results` | Lab results, clinical markers |
| `health_features_daily` | Aggregated daily health features |
| `vitana_index_scores` | Daily Vitana Index (0-999) |
| `recommendations` | AI-generated health recommendations |
| `lab_reports` | Lab report documents |

### Memory Domain Tables

| Table | Purpose |
|-------|---------|
| `memory_items` | Long-term memory storage |
| `memory_diary_entries` | Personal diary |
| `memory_garden_nodes` | Summary nodes |
| `memory_access_grants` | Role-based access grants |
| `memory_quality_metrics` | Quality scores |
| `memory_confidence_history` | Confidence tracking |

### Community & Matchmaking Tables

| Table | Purpose |
|-------|---------|
| `community_groups` | Groups with topic keys |
| `community_meetups` | Events/meetups |
| `community_memberships` | Membership tracking |
| `relationship_nodes` / `relationship_edges` | Relationship graph |
| `match_targets` / `matches_daily` | Matchmaking engine |
| `live_rooms` / `live_room_attendance` | Live discussion rooms |
| `locations` / `location_visits` | Physical locations |

### Catalog & Offers Tables

| Table | Purpose |
|-------|---------|
| `services_catalog` | Services catalog (coach, doctor, lab, etc.) |
| `products_catalog` | Products catalog (supplement, device, app, etc.) |
| `user_offers_memory` | User relationship to services/products |
| `usage_outcomes` | User-stated outcomes from using services/products |

### Predictive & Risk Tables

| Table | Purpose |
|-------|---------|
| `d44_predictive_signals` | Proactive early intervention signals |
| `d44_signal_evidence` | Evidence references for signals |
| `d44_intervention_history` | User actions on signals |
| `contextual_opportunities` | D48 opportunity surfacing |
| `risk_mitigations` | D49 health/lifestyle risk mitigation |

### Governance Tables

Seven `governance_*` tables: `governance_categories`, `governance_rules`, `governance_evaluations`, `governance_violations`, `governance_enforcements`, `governance_proposals`, `governance_catalog`. All are read-only for authenticated users; writes require `service_role`.

### Tenant Model

Every user-data table includes a `tenant_id UUID NOT NULL` column. Four tenants are registered: `vitana`, `maxina`, `alkalma`, `earthlings`. Tenant isolation is enforced at the database level via RLS policies that check `tenant_id = public.current_tenant_id()`.

### RLS Patterns

| Pattern | Policy Shape | Used By |
|---------|-------------|---------|
| User-scoped | `tenant_id = current_tenant_id() AND user_id = auth.uid()` | Personal data (memory, health, preferences) |
| Tenant-scoped | `tenant_id = current_tenant_id()` | Community, groups, locations, products |
| Service-role write | `SELECT: authenticated USING (true)`, `INSERT: service_role` | Governance, OASIS, audit |
| Immutable audit | INSERT + SELECT only, no UPDATE/DELETE | `software_versions`, audit logs |

### Schema Classification for Lovable Merger

| Classification | Meaning | Lovable Can Extend? |
|----------------|---------|---------------------|
| PLATFORM_CORE | Critical infrastructure | No |
| GOVERNANCE | Compliance tables | No |
| OASIS | Orchestration | No |
| DOMAIN_OWNED | Domain-specific | Additive only |
| USER_DATA | User-scoped personal data | No (create parallel with `lovable_` prefix) |
| LOOKUP | Reference tables | Additive only |
| SAFE_EXTEND | Safe for additive columns | Yes |

### Deprecated

The `VtidLedger` table (PascalCase) is deprecated and empty. Use `vtid_ledger` (snake_case) instead.

## Related Pages

- [[canonical-identity]]
- [[supabase-platform]]
- [[additive-migration-pattern]]
- [[summary-database-schema]]
- [[summary-platform-schema-inventory]]

## Sources

- `raw/database/DATABASE_SCHEMA.md`
- `raw/database/platform-schema-inventory.md`
- `raw/database/additive-migration-rules.md`

## Last Updated

2026-04-12
