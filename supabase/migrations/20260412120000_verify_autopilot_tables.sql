-- Diagnostic: check if tenant_autopilot_* tables exist
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'tenant_autopilot%'
ORDER BY table_name;
