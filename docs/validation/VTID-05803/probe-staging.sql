-- VTID-05803 read-only staging probe. Runs in a read-only transaction; changes nothing.
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;
SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS server_ip;
SELECT 'public_tables=' || count(*) FROM information_schema.tables WHERE table_schema='public';
