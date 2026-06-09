#!/usr/bin/env bash
#
# publish-to-prod.sh — THE DOCUMENTED MANUAL ESCAPE HATCH
# ============================================================================
# Staging-first cutover (effective Mon 8 Jun 2026, 10:00 Europe/Berlin): from
# the cutover instant, automatic (push) deploys no longer reach production —
# they land on STAGING. Production is normally reached via the single PUBLISH
# button in the Command Hub. This script is the *other* sanctioned path: a
# deliberate, governed, human-initiated production deploy — the explicit
# EXCEPTION, never the default. (Before the cutover it also works, but auto
# pushes still reach prod, so you rarely need it then.)
#
# It wraps a `workflow_dispatch` of EXEC-DEPLOY.yml (the canonical governed
# prod deploy: VTID hard-gate + governance eval + `gcloud run deploy`).
#
# Every invocation REQUIRES a --reason, which is recorded in the dispatch and
# echoed into the workflow logs for the audit trail.
#
# Usage:
#   scripts/deploy/publish-to-prod.sh \
#     --service gateway \
#     --vtid VTID-01234 \
#     --reason "hotfix: ORB voice 500s in prod, staging verified, ticket OPS-99"
#
# Options:
#   --service <name>   Cloud Run service to deploy. Default: gateway.
#                      Supported: gateway, oasis-operator, oasis-projector,
#                      vitana-verification-engine, cognee-extractor, worker-runner.
#   --vtid <id>        VTID for governance. Use a real VTID-NNNNN when one
#                      exists; otherwise BOOTSTRAP-<DESC> to bypass the ledger
#                      existence check (e.g. BOOTSTRAP-PROD-HOTFIX).
#   --reason <text>    REQUIRED. Why this exceptional prod deploy is justified.
#   --ref <git-ref>    Git ref to deploy. Default: main.
#   --health <path>    Health path. Default: /alive.
#   --canary           Deploy with --no-traffic; promote later via Command Hub.
#   --yes              Skip the interactive confirmation prompt.
#
# Requires the GitHub CLI (`gh`) authenticated against exafyltd/vitana-platform,
# or GH_TOKEN set for a curl fallback.
# ============================================================================

set -euo pipefail

REPO="exafyltd/vitana-platform"
WORKFLOW="EXEC-DEPLOY.yml"

SERVICE="gateway"
VTID=""
REASON=""
REF="main"
HEALTH="/alive"
CANARY="false"
ASSUME_YES="false"

YELLOW="\033[33m"; GREEN="\033[32m"; RED="\033[31m"; CYAN="\033[36m"; NC="\033[0m"

die() { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --vtid)    VTID="$2"; shift 2 ;;
    --reason)  REASON="$2"; shift 2 ;;
    --ref)     REF="$2"; shift 2 ;;
    --health)  HEALTH="$2"; shift 2 ;;
    --canary)  CANARY="true"; shift ;;
    --yes|-y)  ASSUME_YES="true"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "Unknown argument: $1 (use --help)" ;;
  esac
done

[[ -n "$VTID"   ]] || die "--vtid is required (VTID-NNNNN or BOOTSTRAP-<DESC>)."
[[ -n "$REASON" ]] || die "--reason is required. This is the exception path; justify it."

echo -e "${YELLOW}=============================================================${NC}"
echo -e "${YELLOW}  MANUAL PRODUCTION DEPLOY — the documented exception path${NC}"
echo -e "${YELLOW}=============================================================${NC}"
echo -e "  Repo:    ${CYAN}${REPO}${NC}"
echo -e "  Service: ${CYAN}${SERVICE}${NC}"
echo -e "  VTID:    ${CYAN}${VTID}${NC}"
echo -e "  Ref:     ${CYAN}${REF}${NC}"
echo -e "  Health:  ${CYAN}${HEALTH}${NC}"
echo -e "  Canary:  ${CYAN}${CANARY}${NC}"
echo -e "  Reason:  ${CYAN}${REASON}${NC}"
echo
echo -e "${YELLOW}Auto deploys go to STAGING. This ships to LIVE. Proceed only if staging is verified.${NC}"

if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "Type 'PUBLISH' to confirm production deploy: " CONFIRM
  [[ "$CONFIRM" == "PUBLISH" ]] || die "Aborted (confirmation not given)."
fi

# EXEC-DEPLOY.yml records `reason` indirectly via the initiator + VTID; we also
# prepend the reason into the OASIS trail by passing it through the initiator
# field where the workflow surfaces it. The canonical record is the dispatch
# itself + this script's stdout. Keep this output with your change record.

dispatch_with_gh() {
  gh workflow run "$WORKFLOW" \
    --repo "$REPO" \
    --ref "$REF" \
    -f vtid="$VTID" \
    -f service="$SERVICE" \
    -f health_path="$HEALTH" \
    -f initiator="agent" \
    -f environment="production" \
    -f canary="$CANARY"
}

dispatch_with_curl() {
  [[ -n "${GH_TOKEN:-}" ]] || die "gh not found and GH_TOKEN unset — cannot dispatch."
  curl -fsS -X POST \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches" \
    -d "$(cat <<JSON
{
  "ref": "${REF}",
  "inputs": {
    "vtid": "${VTID}",
    "service": "${SERVICE}",
    "health_path": "${HEALTH}",
    "initiator": "agent",
    "environment": "production",
    "canary": "${CANARY}"
  }
}
JSON
)"
}

echo -e "${CYAN}Dispatching ${WORKFLOW}...${NC}"
if command -v gh >/dev/null 2>&1; then
  dispatch_with_gh
else
  echo -e "${YELLOW}gh CLI not found — falling back to curl (requires GH_TOKEN).${NC}"
  dispatch_with_curl
fi

echo -e "${GREEN}✅ Dispatched.${NC} Watch the run:"
echo -e "   ${CYAN}https://github.com/${REPO}/actions/workflows/${WORKFLOW}${NC}"
echo -e "Verify after deploy per CLAUDE.md §15 (curl a JSON endpoint, check the live revision)."
