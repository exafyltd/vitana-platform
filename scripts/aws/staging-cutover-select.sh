#!/usr/bin/env bash
# VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover): select the data plane of a STAGING task definition.
# stdin = the task-definition JSON a staging workflow is about to register; stdout = the JSON to register.
#
#   STAGING_DATA_PLANE=shared|isolated  bash scripts/aws/staging-cutover-select.sh --service gateway|postgrest \
#        [--candidate-url https://preview-iso-…]
#
# shared (or unset)  Delegates to staging-cutover-taskdef.mjs --plane shared: an unmarked task definition passes through
#                    byte for byte, a marked (isolated) one is restored to the shared plane. No AWS call.
# isolated           Refuses unless STAGING_CUTOVER_APPROVED=yes (owner, design.md §6.3) or --candidate-url is given
#                    (rehearsal on the -iso candidates). Resolves the staging secret ARNs with describe-secret (ARN only,
#                    the value is never read) and delegates to staging-cutover-taskdef.mjs --plane isolated.
# Exit: 0 ok, 2 refused (nothing is printed on stdout then, so the caller registers nothing).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "::error::staging-cutover-select: $*" >&2; exit 2; }

service=""; candidate=""
while [ $# -gt 0 ]; do
  case "$1" in
    --service) service="${2:-}"; shift 2 ;;
    --candidate-url) candidate="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$service" in gateway|postgrest) ;; *) die "--service must be gateway or postgrest, got '$service'" ;; esac
plane="${STAGING_DATA_PLANE:-shared}"
[ -n "$plane" ] || plane=shared
case "$plane" in shared|isolated) ;; *) die "STAGING_DATA_PLANE must be shared or isolated, got '$plane'" ;; esac

input="$(cat)"
if [ "$plane" = shared ]; then
  [ -z "$candidate" ] || die "--candidate-url needs STAGING_DATA_PLANE=isolated"
  printf '%s' "$input" | node "$here/staging-cutover-taskdef.mjs" --plane shared --service "$service"
  exit $?
fi

if [ -z "$candidate" ] && [ "${STAGING_CUTOVER_APPROVED:-}" != yes ]; then
  die "STAGING_DATA_PLANE=isolated, but repository variable STAGING_CUTOVER_APPROVED is not 'yes' (owner approval after a passing rehearsal, design.md §6.3). Nothing was registered."
fi

resolve() { # secret name -> ARN (metadata only)
  local arn
  arn=$(aws secretsmanager describe-secret --secret-id "$1" --query ARN --output text 2>/dev/null || true)
  if [ -z "$arn" ] || [ "$arn" = None ]; then die "secret '$1' cannot be described (missing, or the staging deploy role lacks DescribeSecret on it, design.md §4). Nothing was registered."; fi
  printf '%s' "$arn"
}

args=(--plane isolated --service "$service" --arn "authenticator_uri=$(resolve vitana/aurora/staging-db/postgrest-authenticator-uri)")
if [ "$service" = gateway ]; then
  args+=(--arn "database_url=$(resolve vitana/aurora/staging-db/database-url)")
  [ -z "$candidate" ] || args+=(--arn "supabase_url=$(resolve vitana/supabase/staging/url-aurora-proxy-iso)")
fi
[ -z "$candidate" ] || args+=(--candidate-url "$candidate")
printf '%s' "$input" | node "$here/staging-cutover-taskdef.mjs" "${args[@]}"
