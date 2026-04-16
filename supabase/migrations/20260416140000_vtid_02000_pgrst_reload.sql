-- Migration: 20260416140000_vtid_02000_pgrst_reload.sql
-- Purpose: Force a fresh PostgREST schema reload. The previous migrations
--          created `products` but the REST layer's schema cache is stale.
NOTIFY pgrst, 'reload schema';
-- Also reload the config just in case:
NOTIFY pgrst, 'reload config';
-- Trigger pgrst via pg_notify as well (belt + braces):
SELECT pg_notify('pgrst', 'reload schema');
