-- VTID-05803: staging-only auth.users, so the 136 public foreign keys into auth.users can be preserved.
-- Schema object only: id is the primary key the foreign keys reference. NO rows, NO member data, NO password
-- or identity column. Production auth.users stays on Supabase. Not applied to production.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
