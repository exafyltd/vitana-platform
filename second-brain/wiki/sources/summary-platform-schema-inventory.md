# Summary: Platform Schema Inventory

> Summary of the platform schema inventory document -- a complete classification of all 135+ tables in the Vitana Platform Supabase schema, organized by domain, ownership, and extension safety.

## Content

### Document: `raw/database/platform-schema-inventory.md`

**Status**: Preparation Phase (2026-01-07)

This document inventories the entire Vitana Platform Supabase schema for the purposes of the Lovable merger. It classifies every table by domain, RLS pattern, owning VTID, and whether Lovable may extend it.

### Schema Size

Approximately **135+ tables** across **14 domains**.

### Classification System

| Classification | Meaning | Lovable Extension? |
|----------------|---------|-------------------|
| PLATFORM_CORE | Critical infrastructure | No |
| GOVERNANCE | Compliance tables | No |
| OASIS | Orchestration/observability | No |
| DOMAIN_OWNED | Domain-specific data | Additive only |
| USER_DATA | Personal data | No (create parallel `lovable_` tables) |
| LOOKUP | Reference tables | Additive only |
| SAFE_EXTEND | Safe for additive columns | Yes |

### Domain Breakdown

1. **Platform Core** (Identity and Tenancy): `user_active_roles`, `tenants`, `user_tenants`, `app_users`, `vtid_ledger`, `global_vtid_seq`.
2. **Governance** (7 tables): `governance_categories`, `governance_rules`, `governance_evaluations`, `governance_violations`, `governance_enforcements`, `governance_proposals`, `governance_catalog`. All service_role write only.
3. **OASIS** (2 tables): `oasis_events_v1`, `software_versions`. Tenant-aware RLS.
4. **Health** (6 tables): `wearable_samples`, `biomarker_results`, `health_features_daily`, `vitana_index_scores`, `recommendations`, `lab_reports`. All strictly user-scoped.
5. **Longevity Signals** (2 tables): `longevity_signals_daily`, `longevity_signal_rules`. Additive extension OK.
6. **Memory** (9+ tables): Core (`memory_categories`, `memory_items`), Garden/Diary, Access/Governance, Quality/Trust.
7. **Community and Matchmaking** (16+ tables): Relationship graph, matchmaking engine, groups/meetups, live rooms, locations, topics layer. All marked SAFE_EXTEND / ADDITIVE.
8. **Personalization** (11+ tables): User preferences, health capacity, life stage, availability. All user-scoped.
9. **Signal Detection** (4 tables): Emotional/cognitive signals, feedback propagation, trust scores.
10. **Content and Catalog** (3 tables): `products_catalog`, `services_catalog`, `knowledge_docs`. Additive extension OK.

### Safe Extension Zones

Tables where Lovable may add columns (never remove/rename): `community_groups`, `community_meetups`, `match_targets`, `topic_registry`, `products_catalog`, `services_catalog`, `locations`.

### Forbidden Modification Zones

All `governance_*` tables, all `memory_*` tables, all `health_*` tables, `vtid_ledger`, `user_active_roles`, `oasis_events_v1`, `software_versions`.

### Key RPC Functions

Identity: `me_context()`, `me_set_active_role()`, `current_tenant_id()`, `current_active_role()`. VTID: `allocate_global_vtid()`, `create_vtid_atomic()`. Health: `health_compute_features_daily()`, `health_compute_vitana_index()`, `health_generate_recommendations()`. Memory: `memory_write_item()`, `memory_retrieve()`, `memory_get_context()`. Longevity: `longevity_compute_daily()`, `longevity_get_daily()`.

### Migration File Organization

- `supabase/migrations/` -- 86 files (primary)
- `database/migrations/` -- 15 files (legacy/secondary)
- `database/policies/` -- 2 files (RLS policies)
- `prisma/migrations/` -- 3 files (historical)

### Schema Governance Rules

Idempotent migrations (`IF NOT EXISTS`, `ON CONFLICT`), tenant isolation on all tables, user isolation on personal data, immutable audit tables, JSONB `metadata` for extensibility, confidence scores (0-100) on all inferences, explainability fields (`evidence`, `reasons`, `rules_applied`).

## Related Pages

- [[database-schema]]
- [[supabase-platform]]
- [[additive-migration-pattern]]
- [[summary-database-schema]]
- [[summary-migration-rules]]

## Sources

- `raw/database/platform-schema-inventory.md`

## Last Updated

2026-04-12
