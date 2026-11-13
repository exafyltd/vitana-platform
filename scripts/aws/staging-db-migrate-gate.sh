#!/usr/bin/env bash
# VTID-05784 (plan autonomous-to-staging-r2 §3.5, lane staging-migrations-auto): may a migration be applied to the
# isolated staging database? Shared by STAGING-MIGRATE.yml (mode auto) and RUN-MIGRATION.yml target staging (mode
# dispatch). No AWS call. Default OFF and fail closed:
#
#   MIGRATION_FREEZE=true                         -> refused (exit 1), whatever the mode.
#   STAGING_DATA_PLANE unset, empty or "shared"   -> disabled: mode auto prints a notice and exits 0 with enabled=false
#                                                    (nothing is applied); mode dispatch is refused (exit 1).
#   STAGING_DATA_PLANE = "isolated"               -> enabled only when ALL of these hold, else refused (exit 1):
#       AWS_STAGING_DB_ROLE_ARN = arn:aws:iam::472838866351:role/vitana-gha-staging-db  (stack output, design.md §6.2)
#       STAGING_DB_COST_APPROVED = yes                                                  (owner, design.md §6.1)
#       GITHUB_REF = refs/heads/main                                                    (the role trusts main only)
#   any other STAGING_DATA_PLANE value            -> refused (exit 1).
#
# The variables are the owner-set repository variables of the stage-2/3 lanes; this lane adds none. The isolated plane
# is the one the cutover (VTID-05781) switches staging to, so migrations follow the data plane staging serves from.
#
# Usage: staging-db-migrate-gate.sh --mode auto|dispatch
# Writes enabled=true|false to $GITHUB_OUTPUT when set. Exit: 0 decided; 1 refused; 2 usage.
set -euo pipefail
ROLE_RE='^arn:aws:iam::472838866351:role/vitana-gha-staging-db$'
MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    *) echo "::error::unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in auto|dispatch) ;; *) echo "::error::usage: $0 --mode auto|dispatch" >&2; exit 2 ;; esac

out() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "enabled=$1" >> "$GITHUB_OUTPUT"; }
refuse() { echo "::error::Refused: $*" >&2; out false; exit 1; }

[ "${MIGRATION_FREEZE:-}" != "true" ] || refuse "MIGRATION_FREEZE=true (schema freeze); no migration is applied to any database."

PLANE="${STAGING_DATA_PLANE:-}"
case "$PLANE" in
  ''|shared)
    if [ "$MODE" = auto ]; then
      echo "::notice::Staging migrations are off: STAGING_DATA_PLANE is '${PLANE:-unset}' (staging serves the shared data plane). Nothing is applied."
      out false
      exit 0
    fi
    refuse "target staging needs STAGING_DATA_PLANE=isolated (now '${PLANE:-unset}'); staging still serves the shared data plane, which is never a migration target here."
    ;;
  isolated) ;;
  *) refuse "unknown STAGING_DATA_PLANE value '$PLANE' (expected shared or isolated)." ;;
esac

fail=0
if [ -z "${AWS_STAGING_DB_ROLE_ARN:-}" ]; then
  echo "::error::Refused: AWS_STAGING_DB_ROLE_ARN is not set (stack output StagingDbRoleArn, design.md §6.2)." >&2; fail=1
elif ! printf '%s' "$AWS_STAGING_DB_ROLE_ARN" | grep -Eq "$ROLE_RE"; then
  echo "::error::Refused: AWS_STAGING_DB_ROLE_ARN is not arn:aws:iam::472838866351:role/vitana-gha-staging-db." >&2; fail=1
fi
if [ "${STAGING_DB_COST_APPROVED:-}" != "yes" ]; then
  echo "::error::Refused: STAGING_DB_COST_APPROVED is not 'yes' (owner cost approval, design.md §6.1)." >&2; fail=1
fi
if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::Refused: run from main only (the staging database role trusts refs/heads/main), not '${GITHUB_REF:-}'." >&2; fail=1
fi
if [ "$fail" = 1 ]; then out false; exit 1; fi
echo "Staging migrations enabled: plane isolated, role vitana-gha-staging-db, cost approved, main."
out true
