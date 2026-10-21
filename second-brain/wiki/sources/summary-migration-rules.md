# Summary: Additive Migration Rules

> Summary of the additive migration rules document -- the safety framework governing all database schema changes during the Lovable/Platform merger.

## Content

### Document: `raw/database/additive-migration-rules.md`

**Status**: Preparation Phase (2026-01-07)

This document defines the rules for safe, additive-only schema migrations during the Lovable Auth/Supabase merger. It is enforced in conjunction with the auth merge guardrails.

### Core Principle

All migrations must be additive, non-destructive, backward-compatible, and reversible. The guiding idea is that existing Platform queries and services must never break due to a Lovable merger migration.

### Allowed vs. Forbidden

**Allowed**: `CREATE TABLE` (with required columns), `ADD COLUMN` (nullable or with default), `CREATE INDEX CONCURRENTLY`, `CREATE OR REPLACE FUNCTION`, `CREATE POLICY` (must not weaken security), `INSERT` with `ON CONFLICT DO NOTHING`.

**Forbidden**: `DROP TABLE`, `DROP COLUMN`, `RENAME TABLE`, `RENAME COLUMN`, `ALTER COLUMN TYPE`, `DROP INDEX`, `DROP FUNCTION`, `DROP POLICY`, `TRUNCATE`, bulk `DELETE`.

### Naming Conventions

All new structures from the Lovable merger are namespaced:
- Tables: `lovable_{domain}_{entity}`
- Columns on existing tables: `lovable_{purpose}`
- Indexes: `idx_lovable_{table}_{columns}`
- Functions: `lovable_{domain}_{action}`
- Policies: `lovable_{table}_{operation}_{scope}`

### Required Table Structure

Every new table must have: `id UUID PK`, `tenant_id UUID NOT NULL`, `user_id UUID` (if user-scoped, with FK to `auth.users`), `created_at`, `updated_at`, and recommended `metadata JSONB`. RLS must be enabled with tenant + user isolation.

### Migration File Format

Files named `{timestamp}_{vtid}_{description}.sql` with a required header declaring VTID, author, date, phase (ADDITIVE_ONLY), and reversibility. Internal structure follows: existence checks, table creation, column additions, index creation, RLS policies, function creation, grants.

### Rollback Requirement

Every migration has a corresponding `_rollback.sql` file. Rollbacks may only drop Lovable-prefixed structures.

### Weekly Delta Ingestion

During the 1-month parallel development phase, Lovable provides weekly schema deltas in YAML format. Each delta is reviewed against additive rules, assigned a VTID, and promoted through dev-sandbox, staging, and production.

### Pre-Flight Checklist (10 items)

Migration is additive only, all new tables have `tenant_id`, user-scoped tables have `user_id`, RLS enabled, indexes use CONCURRENTLY, functions use CREATE OR REPLACE, rollback script exists and tested, migration tested on dev-sandbox, VTID allocated.

## Related Pages

- [[additive-migration-pattern]]
- [[database-schema]]
- [[summary-platform-schema-inventory]]
- [[summary-database-schema]]

## Sources

- `raw/database/additive-migration-rules.md`

## Last Updated

2026-04-12
