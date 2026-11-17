-- VTID-05803 staging-only compatibility for the auth.users foreign keys.
-- Creates the schema and an empty users table so the FKs can be recreated. No rows, no Supabase auth implementation.
-- Must run BEFORE the foreign-key recreate script.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
