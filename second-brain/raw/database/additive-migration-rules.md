# Additive Migration Rules

> **Status**: PREPARATION PHASE
> **Author**: Claude (Preparation & Governance Engineer)
> **Date**: 2026-01-07
> **Purpose**: Define rules for additive schema changes during Lovable merger

---

## Overview

This document defines the rules for **additive-only** schema migrations during the Lovable Auth/Supabase merger. The goal is to ensure safe, reversible, non-breaking changes that can be incrementally deployed.

---

## 1. Core Principles

### 1.1 Additive Only

All migrations during the merger phase MUST be:

- **Additive** - Add new tables, columns, indexes, functions
- **Non-destructive** - Never remove or rename existing structures
- **Backward-compatible** - Existing queries must continue to work
- **Reversible** - Must be rollback-able via inverse migration

### 1.2 What is Allowed

| Operation | Allowed? | Conditions |
|-----------|----------|------------|
| CREATE TABLE | YES | With required columns (tenant_id, user_id if user-scoped) |
| ALTER TABLE ADD COLUMN | YES | With DEFAULT or NULL |
| CREATE INDEX | YES | CONCURRENTLY only |
| CREATE FUNCTION | YES | Must be idempotent (CREATE OR REPLACE) |
| CREATE POLICY | YES | Must not weaken existing security |
| ADD RLS POLICY | YES | Must strengthen or maintain security |
| INSERT (lookup data) | YES | With ON CONFLICT DO NOTHING |

### 1.3 What is Forbidden

| Operation | Forbidden? | Reason |
|-----------|------------|--------|
| DROP TABLE | YES | Data loss, breaking changes |
| DROP COLUMN | YES | Breaking existing queries |
| RENAME COLUMN | YES | Breaking existing queries |
| RENAME TABLE | YES | Breaking existing queries |
| ALTER COLUMN TYPE | YES | Potential data loss |
| DROP INDEX | YES | Performance degradation risk |
| DROP FUNCTION | YES | Breaking existing callers |
| DROP POLICY | YES | Security weakening |
| TRUNCATE | YES | Data loss |
| DELETE (bulk) | YES | Data loss |

---

## 2. Table Creation Rules

### 2.1 Required Columns for New Tables

Every new table MUST include:

```sql
CREATE TABLE IF NOT EXISTS public.lovable_{table_name} (
    -- Required: Primary key
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Required: Tenant isolation
    tenant_id UUID NOT NULL,

    -- Required for user-scoped data
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Required: Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Recommended: Extensibility
    metadata JSONB DEFAULT '{}'::JSONB
);
```

### 2.2 Naming Convention

New tables from Lovable merger MUST use prefix:

```
lovable_{domain}_{entity}

Examples:
- lovable_auth_sessions
- lovable_ui_preferences
- lovable_onboarding_progress
```

### 2.3 Required RLS Policies

Every new table MUST have RLS enabled with at least:

```sql
-- Enable RLS
ALTER TABLE public.lovable_{table} ENABLE ROW LEVEL SECURITY;

-- User-scoped data pattern
CREATE POLICY lovable_{table}_user_isolation ON public.lovable_{table}
FOR ALL TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND user_id = auth.uid()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND user_id = auth.uid()
);
```

---

## 3. Column Addition Rules

### 3.1 Adding Columns to Existing Tables

When adding columns to SAFE_EXTEND tables:

```sql
-- Pattern: Nullable with no default (safe, fast)
ALTER TABLE public.{table}
ADD COLUMN IF NOT EXISTS lovable_{column_name} {type};

-- Pattern: With default (safe, but may lock table briefly)
ALTER TABLE public.{table}
ADD COLUMN IF NOT EXISTS lovable_{column_name} {type} DEFAULT {default_value};
```

### 3.2 Column Naming Convention

New columns from Lovable merger:

```
lovable_{purpose}

Examples:
- lovable_source_app
- lovable_onboarding_step
- lovable_ui_theme
```

### 3.3 Forbidden Column Operations

```sql
-- FORBIDDEN: Renaming columns
ALTER TABLE {table} RENAME COLUMN {old} TO {new};

-- FORBIDDEN: Dropping columns
ALTER TABLE {table} DROP COLUMN {column};

-- FORBIDDEN: Changing column type
ALTER TABLE {table} ALTER COLUMN {column} TYPE {new_type};

-- FORBIDDEN: Adding NOT NULL without default
ALTER TABLE {table} ADD COLUMN {column} {type} NOT NULL;
```

---

## 4. Index Creation Rules

### 4.1 Safe Index Creation

All new indexes MUST be created CONCURRENTLY:

```sql
-- CORRECT: Non-blocking index creation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lovable_{table}_{columns}
ON public.{table} ({columns});

-- FORBIDDEN: Blocking index creation
CREATE INDEX idx_lovable_{table}_{columns}
ON public.{table} ({columns});
```

### 4.2 Index Naming Convention

```
idx_lovable_{table}_{column(s)}

Examples:
- idx_lovable_sessions_user_id
- idx_lovable_progress_tenant_user
```

---

## 5. Function Creation Rules

### 5.1 Idempotent Functions

All functions MUST be CREATE OR REPLACE:

```sql
CREATE OR REPLACE FUNCTION public.lovable_{function_name}(...)
RETURNS {type}
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Implementation
END;
$$;
```

### 5.2 Function Naming Convention

```
lovable_{domain}_{action}

Examples:
- lovable_auth_validate_session
- lovable_onboarding_get_progress
- lovable_ui_get_preferences
```

### 5.3 Required Function Patterns

```sql
-- Pattern 1: User context validation
v_user_id := auth.uid();
IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
END IF;

-- Pattern 2: Tenant context validation
v_tenant_id := public.current_tenant_id();
IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
END IF;

-- Pattern 3: Return structured response
RETURN jsonb_build_object(
    'ok', true,
    'data', v_result
);
```

---

## 6. RLS Policy Rules

### 6.1 Policy Requirements

All new policies MUST:

1. Use `IF NOT EXISTS` or `DROP POLICY IF EXISTS` + `CREATE POLICY`
2. Include tenant isolation
3. Include user isolation for user-scoped data
4. Never weaken existing security

### 6.2 Policy Naming Convention

```
lovable_{table}_{operation}_{scope}

Examples:
- lovable_sessions_select_own
- lovable_progress_all_user_tenant
```

### 6.3 Forbidden Policy Operations

```sql
-- FORBIDDEN: Dropping existing platform policies
DROP POLICY {platform_policy} ON {table};

-- FORBIDDEN: Policies that bypass RLS
CREATE POLICY {name} ON {table}
FOR ALL TO authenticated
USING (true);  -- NO! Must have tenant/user check
```

---

## 7. Migration File Format

### 7.1 File Naming

```
{timestamp}_{vtid}_{description}.sql

Examples:
- 20260107120000_lovable_auth_sessions_table.sql
- 20260107120001_lovable_onboarding_progress_table.sql
```

### 7.2 Required Header

```sql
-- Migration: {description}
-- VTID: {vtid}
-- Author: Lovable Merger
-- Date: {date}
-- Phase: ADDITIVE_ONLY
-- Reversible: YES
--
-- This migration is part of the Lovable Auth/Supabase merger.
-- It follows additive-only rules and is safe to deploy incrementally.
```

### 7.3 Required Structure

```sql
-- 1. Existence checks
-- 2. Table creation (if applicable)
-- 3. Column additions (if applicable)
-- 4. Index creation (CONCURRENTLY)
-- 5. RLS policies
-- 6. Function creation
-- 7. Grants

-- Example:
BEGIN;

-- Table creation with IF NOT EXISTS
CREATE TABLE IF NOT EXISTS public.lovable_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- RLS
ALTER TABLE public.lovable_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lovable_sessions_user_isolation ON public.lovable_sessions;
CREATE POLICY lovable_sessions_user_isolation ON public.lovable_sessions
FOR ALL TO authenticated
USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

COMMIT;
```

---

## 8. Rollback Requirements

### 8.1 Rollback Script Naming

Every migration must have a corresponding rollback:

```
{timestamp}_{vtid}_{description}_rollback.sql
```

### 8.2 Rollback Operations Allowed

| Original Operation | Rollback Operation |
|--------------------|--------------------|
| CREATE TABLE | DROP TABLE IF EXISTS |
| ADD COLUMN | DROP COLUMN (only Lovable columns) |
| CREATE INDEX | DROP INDEX IF EXISTS |
| CREATE FUNCTION | DROP FUNCTION IF EXISTS |
| CREATE POLICY | DROP POLICY IF EXISTS |

### 8.3 Rollback Script Format

```sql
-- Rollback: {description}
-- VTID: {vtid}
-- Author: Lovable Merger
-- Date: {date}
--
-- WARNING: This rollback will remove Lovable-specific structures.
-- It will NOT affect Platform structures.

BEGIN;

-- Drop Lovable policies
DROP POLICY IF EXISTS lovable_sessions_user_isolation ON public.lovable_sessions;

-- Drop Lovable tables
DROP TABLE IF EXISTS public.lovable_sessions;

COMMIT;
```

---

## 9. Migration Checklist

Before submitting any migration:

### Pre-Flight Checks

- [ ] Migration is additive only (no DROP, RENAME, ALTER TYPE)
- [ ] All new tables have tenant_id column
- [ ] All user-scoped tables have user_id column
- [ ] All new tables have RLS enabled
- [ ] All RLS policies include tenant isolation
- [ ] All indexes use CONCURRENTLY
- [ ] All functions use CREATE OR REPLACE
- [ ] Rollback script exists
- [ ] Migration tested on dev-sandbox
- [ ] VTID allocated for this migration

### Post-Deploy Checks

- [ ] All existing queries still work
- [ ] RLS policies enforced correctly
- [ ] No performance degradation
- [ ] Rollback tested successfully

---

## 10. Weekly Delta Ingestion

### 10.1 Expectation

During the 1-month parallel development phase:

- Lovable schema may evolve weekly
- Platform must be ready to ingest weekly deltas
- All deltas must follow additive rules

### 10.2 Delta Ingestion Process

1. Lovable provides schema delta (additive changes only)
2. Delta reviewed against these rules
3. VTID allocated for delta migration
4. Migration tested on dev-sandbox
5. Migration deployed to staging
6. Migration deployed to production (if approved)

### 10.3 Delta Format

Lovable deltas should be provided as:

```yaml
# weekly_delta_2026_01_14.yaml
vtid: LOVABLE-DELTA-001
date: 2026-01-14
author: Lovable Team

tables:
  - name: lovable_new_feature
    operation: CREATE
    columns:
      - name: id
        type: UUID
        primary_key: true
      - name: tenant_id
        type: UUID
        required: true
      # ...

columns:
  - table: lovable_sessions
    name: lovable_new_column
    operation: ADD
    type: TEXT
    nullable: true

indexes:
  - table: lovable_sessions
    columns: [lovable_new_column]
    concurrent: true

functions:
  - name: lovable_new_function
    operation: CREATE_OR_REPLACE
    # ...
```

---

## 11. Forbidden Patterns (Examples)

### Example 1: Breaking Change (FORBIDDEN)

```sql
-- FORBIDDEN: Renaming existing column
ALTER TABLE public.user_active_roles
RENAME COLUMN active_role TO current_role;

-- FORBIDDEN: Dropping existing table
DROP TABLE public.memory_items;

-- FORBIDDEN: Modifying existing RLS policy
DROP POLICY memory_items_user_isolation ON public.memory_items;
CREATE POLICY memory_items_user_isolation ON public.memory_items
FOR ALL TO authenticated
USING (true);  -- Weakened security!
```

### Example 2: Correct Additive Change

```sql
-- CORRECT: Adding new column with prefix
ALTER TABLE public.community_groups
ADD COLUMN IF NOT EXISTS lovable_display_order INTEGER DEFAULT 0;

-- CORRECT: Creating new table with all requirements
CREATE TABLE IF NOT EXISTS public.lovable_onboarding_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    completed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.lovable_onboarding_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY lovable_onboarding_progress_user_isolation
ON public.lovable_onboarding_progress
FOR ALL TO authenticated
USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());
```

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-07 | Initial additive migration rules | Claude (Preparation Phase) |

---

*This document is part of the Auth & Supabase Merger Preparation Phase. All migrations must be reviewed against these rules before deployment.*
