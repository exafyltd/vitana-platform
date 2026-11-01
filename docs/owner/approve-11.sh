#!/usr/bin/env bash
# approve-11.sh — OWNER-ONLY approval of the 11 escalated multi-tenant sparring sessions.
#
# WHY THIS IS OWNER-ONLY:
#   POST /api/v1/plans/spar/:id/approve requires an exafy_admin JWT
#   (services/gateway/src/routes/plans-spar.ts L74 requireAdminAuth; it rejects
#   the gateway service token with 403 exafy_admin_required) and records the
#   caller as the approver (plan-sparring-service.ts approveSparringSession L464).
#   An agent must never call this route or impersonate the owner. This script is
#   written FOR THE OWNER to run with their own JWT.
#
# USAGE:
#   export VITANA_ADMIN_JWT='<your exafy_admin JWT>'     # never commit / never echo it
#   bash docs/owner/approve-11.sh                         # approves all 11
#   bash docs/owner/approve-11.sh mt-guardrails mt-packs  # approve a subset by slug
#
# SAFETY:
#   - Reads the JWT only from $VITANA_ADMIN_JWT; it is NEVER printed or logged.
#   - Each session is approved with its exact stored final_plan_hash (a mismatch
#     is rejected 409 by the gateway), acknowledge_escalation:true (required for
#     an escalated verdict), and a note. One POST per session.
#   - Read-only re-check (GET) of each session is printed before the POST so you
#     see verdict + current approval state first.
#   - The gateway base URL defaults to the staging/preview gateway; override with
#     $GATEWAY_URL if you want the production gateway.
#
# AFTER APPROVAL:
#   Each approved, now policy-eligible plan needs one empty resume push to its
#   plan branch to trigger PLAN-SPAR VTID allocation (confirm against
#   scripts/collab/plan-spar.mjs / .github/workflows/PLAN-SPAR.yml). The driver
#   then carries each plan's lanes. The plan PRs are currently CLOSED (escalated
#   at the round cap, 2026-10-28); reopen each PR or push a fresh re-plan so the
#   spec reaches main.

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"

if [[ -z "${VITANA_ADMIN_JWT:-}" ]]; then
  echo "ERROR: VITANA_ADMIN_JWT is not set. Export your exafy_admin JWT first." >&2
  echo "       export VITANA_ADMIN_JWT='<jwt>'   # it is never printed by this script" >&2
  exit 1
fi

# slug -> "session_id final_plan_hash"  (verified read-only 2026-11-01; hashes from the handover table).
declare -A SESSION=(
  [mt-guardrails]="496d49e4-e3b5-4421-86d0-edaa18ddb659 5991f78d7f450fd100e986ac68b2c38c3bd86836b3a17b8795660e187aee2e95"
  [mt-track-s]="d0c274cd-a9f0-48dd-a0a1-ea6061a344b6 a67a6db20b8f4197c40793d8ec06e23e9c304cf6f934093db9291d1f518d2960"
  [mt-identity]="ee011de1-a1ce-4dd8-aaf3-d7e19e0cee14 01733293d15809ee167fbb31d7c27eb6bf12e4b5b0acf25928c2c894c5726865"
  [sparring-token-efficiency]="b2df0328-27f7-43fe-bee5-2d6ba8866cb2 71acdb7cfbf0016db67a6af91b7a5d524864a9708520e80e0b4cc2c2b44c4a0f"
  [mt-frontend-brand-r2]="c351f749-3076-4fba-87b0-25aba2df8c15 253a715b903a2e4c945dd544eaa187122e50e75a26b9e687554bf75fec8fad75"
  [mt-packs]="eb308b4e-c1f4-442f-8624-0b92becdecee 00c82ef50a5c2cd09f3d5076fc80f18c1f11ca3828f55982d5f6e0598396a85d"
  [mt-tenant-admin]="03698d49-e8fc-4804-8332-b127637d9adc 6e4964ee546339af4bb07b3ef2a9993493206eac4d7bd5ebd61790b2b2960da5"
  [mt-data-cleanup]="2efa877e-46e8-4355-a2e0-d9b3c30be794 a360a11357cc551e5df193a6fcc517080d9fdb8a6802258d35a087b8082f5746"
  [mt-native-health]="fca982e6-f8a0-4fc9-8e6e-78d23ba39b48 2ebd4325364eb56ad1cda12df77257435e295843eb38ec0421c4944bc67db0ab"
  [mt-community-isolation]="ed136e24-677b-483e-92ea-78045c7b4748 e64d3489da4793a3d3bf3879673900eff5b4b05e6dcff6d540d17e1f4e83f94c"
  [mt-m3]="8a83bc72-709d-4234-8481-0e260cd2771f ecfb4a6ff91fe8573e1210b9d0d749584589d7c02813ac8fb8b7892ce0c92c73"
)

# Fixed approval order (deterministic); subset allowed via CLI args.
ORDER=(mt-guardrails mt-track-s mt-identity sparring-token-efficiency mt-frontend-brand-r2 \
       mt-packs mt-tenant-admin mt-data-cleanup mt-native-health mt-community-isolation mt-m3)

TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then TARGETS=("${ORDER[@]}"); fi

NOTE="Owner approval of escalated multi-tenant plan; escalation acknowledged. Approved via docs/owner/approve-11.sh."

for slug in "${TARGETS[@]}"; do
  entry="${SESSION[$slug]:-}"
  if [[ -z "$entry" ]]; then echo "SKIP $slug: unknown slug" >&2; continue; fi
  sid="${entry%% *}"
  hash="${entry##* }"

  echo "=== $slug  session=$sid ==="
  echo "--- read-only pre-check (GET) ---"
  curl -fsS -H "Authorization: Bearer $VITANA_ADMIN_JWT" \
    "$GATEWAY_URL/api/v1/plans/spar/$sid" \
    | python3 -c 'import sys,json; s=json.load(sys.stdin)["session"]; print("  verdict=%s final_plan_hash=%s approved_at=%s"%(s.get("verdict"), s.get("final_plan_hash"), s.get("approved_at")))' \
    || { echo "  GET failed for $slug" >&2; continue; }

  echo "--- approve (POST once) ---"
  http_code=$(curl -sS -o /tmp/approve-"$slug".json -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $VITANA_ADMIN_JWT" \
    -H 'Content-Type: application/json' \
    -d "{\"final_plan_hash\":\"$hash\",\"acknowledge_escalation\":true,\"note\":\"$NOTE\"}" \
    "$GATEWAY_URL/api/v1/plans/spar/$sid/approve")
  echo "  HTTP $http_code"
  if [[ "$http_code" == "200" ]]; then
    python3 -c 'import json;s=json.load(open("/tmp/approve-'"$slug"'.json"))["session"];print("  OK verdict=%s approved_at=%s approver=%s"%(s.get("verdict"),s.get("approved_at"),s.get("approved_by")))' 2>/dev/null \
      || echo "  OK (approved)"
  else
    echo "  NOT approved — response body:"; cat /tmp/approve-"$slug".json; echo
  fi
  echo
done

echo "Done. Re-run queue.mjs and push one empty resume per approved plan to trigger PLAN-SPAR VTID allocation."
