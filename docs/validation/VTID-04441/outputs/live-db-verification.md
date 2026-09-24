# VTID-04441 — live DB verification (2026-09-23, read-only checks after apply)

Migration `vtid_04441_memory_fact_forgotten` applied via Supabase MCP `apply_migration` before merge.

| check | result |
|---|---|
| `has_table_privilege('anon', …, 'select')` | false |
| `has_table_privilege('authenticated', …, 'select')` | false |
| `has_table_privilege('service_role', …, 'insert')` | true |
| RLS enabled | true |
| rows | 0 |
