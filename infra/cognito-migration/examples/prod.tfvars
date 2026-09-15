# Example only — DO NOT apply against production until:
#   1. Staging has a real Cognito User Pool, and at least one real
#      Authentication-trigger migration has been observed succeeding
#      end-to-end against staging Supabase data.
#   2. The gateway can verify Cognito-issued tokens (not just
#      Supabase-issued ones) — see ../README.md "Not covered here".
#   3. The Aurora auth.uid()/auth.jwt() RLS compatibility shim has been
#      built and tested against a meaningful slice of the 638 policies
#      that currently key on auth.uid()/auth.jwt() (see
#      docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md, "B4 — Identity").
#   4. The frontend (exafyltd/vitana-v1) has a working Cognito sign-in path.
# Applying this against prod before those are true creates a second,
# empty, disconnected identity system prod traffic never uses.

name_prefix = "vitana-prod"
region      = "eu-central-1"

supabase_url      = "https://inmkhvwdcuyhnxkgfvsb.supabase.co"
supabase_anon_key = "REPLACE_ME"

supabase_service_role_secret_arn = "arn:aws:secretsmanager:eu-central-1:472838866351:secret:REPLACE_ME"

tags = {
  Environment = "production"
  Project     = "vitana-auth-cognito-migration"
  Vtid        = "VTID-03827"
}
