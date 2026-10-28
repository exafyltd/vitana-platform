# Additive Migration Pattern

> Database migration rules for the Lovable/Platform merger: only additive, non-destructive, backward-compatible, and reversible changes are permitted.

## Content

### Core Principles

All migrations during the Lovable Auth/Supabase merger phase must be:

- **Additive** -- Only add new tables, columns, indexes, and functions.
- **Non-destructive** -- Never remove or rename existing structures.
- **Backward-compatible** -- Existing queries must continue to work unchanged.
- **Reversible** -- Every migration must have a tested rollback script.

### Allowed Operations

| Operation | Conditions |
|-----------|-----------|
| `CREATE TABLE` | Must include `tenant_id`, `user_id` (if user-scoped), `created_at`, `updated_at`. Use `IF NOT EXISTS`. |
| `ALTER TABLE ADD COLUMN` | Must be nullable or have a DEFAULT. Use `IF NOT EXISTS`. |
| `CREATE INDEX` | Must use `CONCURRENTLY` to avoid table locks. |
| `CREATE FUNCTION` | Must be idempotent (`CREATE OR REPLACE`). |
| `CREATE POLICY` | Must not weaken existing security. |
| `INSERT` (lookup data) | Must use `ON CONFLICT DO NOTHING`. |

### Forbidden Operations

| Operation | Reason |
|-----------|--------|
| `DROP TABLE` | Data loss, breaking changes |
| `DROP COLUMN` | Breaks existing queries |
| `RENAME TABLE` / `RENAME COLUMN` | Breaks existing queries |
| `ALTER COLUMN TYPE` | Potential data loss |
| `DROP INDEX` | Performance degradation risk |
| `DROP FUNCTION` | Breaks existing callers |
| `DROP POLICY` | Security weakening |
| `TRUNCATE` / bulk `DELETE` | Data loss |

### Naming Conventions

New structures from the Lovable merger must be clearly namespaced:

- **Tables**: `lovable_{domain}_{entity}` (e.g., `lovable_auth_sessions`, `lovable_ui_preferences`)
- **Columns** (on existing tables): `lovable_{purpose}` (e.g., `lovable_source_app`, `lovable_display_order`)
- **Indexes**: `idx_lovable_{table}_{columns}`
- **Functions**: `lovable_{domain}_{action}`
- **RLS Policies**: `lovable_{table}_{operation}_{scope}`

### Required Table Structure

Every new table must include:

```sql
CREATE TABLE IF NOT EXISTS public.lovable_{table_name} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- if user-scoped
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::JSONB  -- recommended for extensibility
);
```

RLS must be enabled on every new table with at minimum tenant + user isolation:

```sql
ALTER TABLE public.lovable_{table} ENABLE ROW LEVEL SECURITY;
CREATE POLICY lovable_{table}_user_isolation ON public.lovable_{table}
FOR ALL TO authenticated
USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());
```

### Required Function Patterns

All new functions must validate user and tenant context:

1. Check `auth.uid()` is not null (return `UNAUTHENTICATED` error if null).
2. Check `current_tenant_id()` is not null (return `TENANT_NOT_FOUND` error if null).
3. Return structured JSONB responses with `ok` boolean and `data` or `error` fields.

### Migration File Format

Files follow the naming pattern `{timestamp}_{vtid}_{description}.sql` and must include a standard header declaring the VTID, author, date, phase (`ADDITIVE_ONLY`), and reversibility.

The required structure within a migration file:

1. Existence checks
2. Table creation
3. Column additions
4. Index creation (CONCURRENTLY)
5. RLS policies
6. Function creation
7. Grants

### Rollback Requirements

Every migration must have a corresponding rollback file named `{timestamp}_{vtid}_{description}_rollback.sql`. Rollback operations are the inverse of additive operations (e.g., `CREATE TABLE` rolls back with `DROP TABLE IF EXISTS`), but rollbacks may only drop Lovable-prefixed structures -- never Platform structures.

### Weekly Delta Ingestion

During the 1-month parallel development phase, Lovable schema changes arrive as weekly deltas in YAML format. Each delta is reviewed against additive rules, assigned a VTID, tested on dev-sandbox, deployed to staging, and then optionally promoted to production.

### Migration Checklist

Before submitting any migration:

- Migration is additive only (no DROP, RENAME, ALTER TYPE)
- All new tables have `tenant_id`
- All user-scoped tables have `user_id`
- All new tables have RLS enabled with tenant isolation
- All indexes use CONCURRENTLY
- All functions use CREATE OR REPLACE
- Rollback script exists and has been tested
- Migration tested on dev-sandbox
- VTID allocated

## Related Pages

- [[canonical-identity]]
- [[database-schema]]
- [[dual-jwt-auth]]
- [[summary-migration-rules]]
- [[summary-platform-schema-inventory]]

## Sources

- `raw/database/additive-migration-rules.md`
- `raw/database/platform-schema-inventory.md`
- `raw/auth/auth-merge-guardrails.md`

## Last Updated

2026-04-12
