# VTID-03796 Acceptance Criteria
## gateway.vitanaland.com as single canonical production URL

AC-1: CORS allowlist retains dr-gateway.vitanaland.com as a legacy entry but its comment is corrected — it is NOT the canonical URL, it is a legacy ALB alias. gateway.vitanaland.com remains listed as the canonical entry.
TEST: grep -n "dr-gateway" services/gateway/src/middleware/cors.ts — confirms legacy alias kept with correct comment; gateway.vitanaland.com at line 11 is the canonical entry

AC-2: verify-aws-production.sh always targets gateway.vitanaland.com and vitanaland.com with no mode branching. The --post-cutover flag is accepted as a no-op for backward compatibility.
CURL: bash scripts/aws/verify-aws-production.sh --post-cutover — GATEWAY_HOST resolves to gateway.vitanaland.com in all execution paths

AC-3: CLAUDE.md §1b gateway table row documents gateway.vitanaland.com as the single canonical production URL; dr-gateway.vitanaland.com is explicitly noted as a legacy ALB alias that must not be used as a target.
TEST: grep "gateway.vitanaland.com" CLAUDE.md — canonical URL present; grep "dr-gateway" CLAUDE.md identifies only the legacy-alias footnote, not a target URL

AC-4: No functional change to any running ECS service, no schema change, no deployment triggered. This is a documentation/script/comment-only change.
TEST: git diff origin/main...HEAD --stat — confirms only cors.ts (comments), verify-aws-production.sh (mode branching removed), CLAUDE.md (§1b text)
