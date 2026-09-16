#!/usr/bin/env bash
#
# VTID-03769 — replicate Supabase's anon/authenticated/service_role grant
# set onto Aurora, so the auth.uid()-compatible RLS mechanism VTID-03768
# verified live can actually be reached by those roles.
#
# WHY THIS EXISTS
#
# VTID-03768 found that auth.uid()/auth.jwt()/auth.role()/auth.email(),
# the anon/authenticated/service_role/authenticator role model, and RLS
# (576 tables, 984 policies) already exist on Aurora — evidently scaffolded
# by an earlier, undocumented effort, alongside a pre-provisioned
# `vitana/aurora/prod/postgrest-authenticator-uri` secret. The mechanism
# itself works (live-tested: set_config('request.jwt.claim.sub', ...) then
# auth.uid() resolves correctly). What's missing is mundane: `SET ROLE
# authenticated` then any query against `public.*` fails with "permission
# denied for schema public" — the actual GRANT statements were never
# replicated, because DMS carries table structure and data, not GRANT DDL.
#
# Supabase's live grants (queried directly, 2026-08-27) are exactly the
# standard Supabase default: anon/authenticated/service_role each hold
# ALL table privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
# REFERENCES, TRIGGER) on ~599-600 of ~600 public tables — RLS, not table
# grants, is what actually restricts anon/authenticated in practice. This
# script reproduces that same shape on Aurora: schema USAGE, then
# table/sequence/function grants, then default privileges so future
# tables inherit the same grants without a manual step.
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
# It does not touch RLS policies (984 already present, not this script's
# concern), does not create or alter any table, and does not grant
# anything to `vitana_admin`/`vitana_readonly`/any role this migration
# effort's own credentials use — only to the four PostgREST-facing roles
# already present (anon, authenticated, service_role, authenticator).
#
# THIS IS A CONSEQUENTIAL CHANGE, NOT A ROUTINE ONE — read before --apply
#
# `service_role` has `rolbypassrls=true` (confirmed, matches Supabase).
# Granting it ALL privileges on every public table means anything
# connecting as `service_role` — intentionally or via a credential leak —
# bypasses RLS entirely, the same blast radius Supabase's own
# service-role key already carries in production. This script does not
# widen that risk beyond what Supabase already has; it makes Aurora match
# it. Still: run this deliberately, not as a routine step, and only once
# whoever owns B4 has decided Aurora should actually start serving
# PostgREST-shaped traffic.
#
# USAGE
#
#   scripts/aws/setup-aurora-postgrest-grants.sh            # dry run, prints the plan
#   scripts/aws/setup-aurora-postgrest-grants.sh --apply    # actually execute
#
# Idempotent: GRANT/ALTER DEFAULT PRIVILEGES are safe to re-run.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT_ID="472838866351"
CLUSTER_ARN="arn:aws:rds:${REGION}:${ACCOUNT_ID}:cluster:vitana-aurora-prod"
SECRET_ARN="${AURORA_ADMIN_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-QR8ox2}"
DB_NAME="vitana"
ROLES=(anon authenticated service_role)

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Guard against pointing this at the wrong account — CLAUDE.md IF-THEN 11.
CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "ERROR: caller is account '$CURRENT_ACCOUNT', expected '$ACCOUNT_ID'." >&2
  exit 1
fi

run_sql() {
  local sql="$1"
  if [ "$APPLY" = "1" ]; then
    echo "+ $sql"
    aws rds-data execute-statement --region "$REGION" --resource-arn "$CLUSTER_ARN" \
      --secret-arn "$SECRET_ARN" --database "$DB_NAME" --sql "$sql" --output json \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ok, records:', len(d.get('records', [])))"
  else
    echo "[dry-run] $sql"
  fi
}

echo "=== VTID-03769: Aurora PostgREST-role grants ==="
echo "cluster : $CLUSTER_ARN"
echo "database: $DB_NAME"
echo "roles   : ${ROLES[*]}"
[ "$APPLY" = "1" ] || echo "MODE    : DRY RUN (pass --apply to execute)"
echo

for role in "${ROLES[@]}"; do
  echo "--- $role ---"
  run_sql "GRANT USAGE ON SCHEMA public TO ${role};"
  run_sql "GRANT USAGE ON SCHEMA extensions TO ${role};"
  run_sql "GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role};"
  run_sql "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role};"
  run_sql "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role};"
  run_sql "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role};"
  run_sql "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${role};"
  run_sql "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role};"
  echo
done

echo "Done."
echo
echo "Verify with (expect no 'permission denied for schema public'):"
echo "  aws rds-data execute-statement --region $REGION --resource-arn $CLUSTER_ARN \\"
echo "    --secret-arn $SECRET_ARN --database $DB_NAME \\"
echo "    --sql \"SET ROLE authenticated; SELECT count(*) FROM public.diary_entries;\""
echo "  (RDS Data API rejects multi-statement calls — run SET ROLE and the SELECT as"
echo "   two execute-statement calls sharing one --transaction-id, per VTID-03768's"
echo "   own test method.)"
