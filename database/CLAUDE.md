# database/ — SQL Migrations & Policies

## Overview

Raw SQL migrations and RLS policies for the PostgreSQL database. These supplement the Prisma migrations in `prisma/migrations/`.

## Migration Files

Naming convention: `YYYYMMDD_vtid_XXXXX_description.sql` or `NNN_description.sql`

| File | VTID | Purpose |
|------|------|---------|
| `001_vtid_ledger_cleanup.sql` | — | Initial VTID ledger cleanup |
| `003_vtid_ledger.sql` | — | VTID ledger base schema |
| `2025-11-12_vtid_allocator.sql` | — | VTID allocation |
| `20251110_oasis_projector_setup.sql` | — | OASIS event projection setup |
| `20251129_vtid_ledger_event_tracking.sql` | — | Add event tracking to VTID ledger |
| `20251130_vtid_0522_schema_fixes.sql` | 0522 | Schema refinements |
| `20251216_vtid_0542_global_allocator.sql` | 0542 | Global VTID allocator |
| `20251231_vtid_01096_personalization_audit.sql` | 01096 | Personalization audit trail |
| `20260102_vtid_01135_boundary_consent.sql` | 01135 | Consent tracking tables |
| `20260102_vtid_01137_d43_longitudinal_adaptation.sql` | 01137 | Longitudinal adaptation data |
| `20260103_vtid_01138_d44_signal_detection.sql` | 01138 | Signal detection tables |
| `20260103_vtid_01139_d45_predictive_risk_forecasting.sql` | 01139 | Risk forecasting tables |
| `20260103_vtid_01142_d48_opportunity_surfacing.sql` | 01142 | Opportunity surfacing tables |
| `20260103_vtid_01143_d49_risk_mitigation.sql` | 01143 | Risk mitigation tables |
| `20260103_vtid_01144_positive_trajectory_reinforcement.sql` | 01144 | Trajectory reinforcement tables |

## RLS Policies

`policies/` contains Row Level Security policies for:
- `oasis_events` table — restricts access by tenant and role

## How to Add a Migration

1. Create file: `database/migrations/YYYYMMDD_vtid_XXXXX_description.sql`
2. Write SQL (CREATE TABLE, ALTER TABLE, etc.)
3. Run manually or via `RUN-MIGRATION.yml` workflow
4. For Prisma-managed tables, use `npx prisma migrate dev` instead

## Key Tables (from Prisma schema)

| Table | Model | Purpose |
|-------|-------|---------|
| `oasis_events` | OasisEvent | System-wide event log |
| `vtid_ledger` | VtidLedger | Task/VTID tracking |
| `projection_offsets` | ProjectionOffset | Event projection state |

## Additional Tables (from raw migrations)

The context dimension migrations (d43-d51) create additional tables for:
- Longitudinal adaptation tracking
- Signal detection patterns
- Predictive risk scores
- Opportunity surfaces
- Risk mitigation strategies
- Trajectory reinforcement data
- Consent boundaries
- Personalization audit logs
