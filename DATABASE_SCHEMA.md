# Vitana Database Schema - CANONICAL REFERENCE

## NAMING CONVENTION
- PostgreSQL tables: `snake_case` (vtid_ledger, oasis_events)
- TypeScript code MUST use exact table names from this list

## TABLES

### vtid_ledger
- Purpose: All VTID task tracking
- Used by: services/gateway/src/routes/vtid.ts, tasks.ts
- Schema: vtid, layer, module, status, title, summary, created_at, updated_at

### oasis_events  
- Purpose: System event log
- Used by: services/gateway/src/routes/events.ts
- Schema: id, type, source, created_at, payload

**RULE:** Before creating ANY new table reference, check this file first!
