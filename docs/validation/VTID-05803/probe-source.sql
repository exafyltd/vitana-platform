-- VTID-05803 read-only source (Supabase) inventory. Run with SOURCE_DATABASE_URL; read-only transaction; no data rows read.
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;
SELECT current_database() AS db, version() AS pg_version;
SELECT 'public_tables=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';
SELECT 'public_functions=' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
SELECT 'public_indexes=' || count(*) FROM pg_indexes WHERE schemaname='public';
SELECT 'public_fk=' || count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace;
SELECT 'public_policies=' || count(*) FROM pg_policies WHERE schemaname='public';
