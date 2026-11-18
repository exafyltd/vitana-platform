-- VTID-05803 local test fixture: an empty "Aurora staging" database (run as a superuser on a scratch DB named vitana).
-- Mirrors what the evidence shows on vitana-aurora-staging: the API roles and authenticator exist, public is empty,
-- and the master user is rds_superuser but not a Postgres superuser.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_superuser') THEN CREATE ROLE rds_superuser NOLOGIN CREATEROLE CREATEDB BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stg_master') THEN CREATE ROLE stg_master LOGIN PASSWORD 'stg-pass' CREATEROLE CREATEDB BYPASSRLS IN ROLE rds_superuser; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator LOGIN PASSWORD 'auth-pass' NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'not_admin') THEN CREATE ROLE not_admin LOGIN PASSWORD 'na-pass'; END IF;
END $$;
GRANT ALL ON DATABASE vitana TO stg_master;
GRANT CONNECT ON DATABASE vitana TO authenticator, not_admin;
ALTER SCHEMA public OWNER TO stg_master;
GRANT anon, authenticated, service_role TO authenticator;
