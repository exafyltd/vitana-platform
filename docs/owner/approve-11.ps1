# approve-11.ps1 — OWNER-ONLY approval of the 11 escalated multi-tenant sparring sessions.
#
# WHY OWNER-ONLY:
#   POST /api/v1/plans/spar/:id/approve requires an exafy_admin JWT
#   (services/gateway/src/routes/plans-spar.ts L74 requireAdminAuth; it rejects the
#   gateway service token with 403 exafy_admin_required) and records the caller as
#   the approver (plan-sparring-service.ts approveSparringSession L464). An agent
#   must never call this route or impersonate the owner. This script is written
#   FOR THE OWNER to run with their own JWT.
#
# USAGE:
#   $env:VITANA_ADMIN_JWT = '<your exafy_admin JWT>'   # never commit / never echo it
#   pwsh docs/owner/approve-11.ps1                      # approves all 11
#   pwsh docs/owner/approve-11.ps1 mt-guardrails mt-packs
#
# SAFETY:
#   - Reads the JWT only from $env:VITANA_ADMIN_JWT; it is NEVER printed.
#   - Each session is approved with its exact stored final_plan_hash (a mismatch is
#     rejected 409), acknowledge_escalation:$true (required for an escalated verdict),
#     and a note. One POST per session, after a read-only GET pre-check.
#   - $env:GATEWAY_URL overrides the default preview gateway base URL.
#
# AFTER APPROVAL:
#   One empty resume push per plan triggers PLAN-SPAR VTID allocation (confirm against
#   scripts/collab/plan-spar.mjs / .github/workflows/PLAN-SPAR.yml). Plan PRs are
#   CLOSED (escalated at the round cap, 2026-10-28); reopen each or push a fresh
#   re-plan so the spec reaches main.

param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Slugs)

$ErrorActionPreference = 'Stop'
$GatewayUrl = if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { 'https://preview-aws-gateway.vitanaland.com' }

if (-not $env:VITANA_ADMIN_JWT) {
  Write-Error "VITANA_ADMIN_JWT is not set. Set it first: `$env:VITANA_ADMIN_JWT = '<jwt>'  (never printed by this script)"
  exit 1
}

# slug -> @{ id = session_id; hash = final_plan_hash }  (verified read-only 2026-11-01).
$Sessions = [ordered]@{
  'mt-guardrails'             = @{ id = '496d49e4-e3b5-4421-86d0-edaa18ddb659'; hash = '5991f78d7f450fd100e986ac68b2c38c3bd86836b3a17b8795660e187aee2e95' }
  'mt-track-s'                = @{ id = 'd0c274cd-a9f0-48dd-a0a1-ea6061a344b6'; hash = 'a67a6db20b8f4197c40793d8ec06e23e9c304cf6f934093db9291d1f518d2960' }
  'mt-identity'               = @{ id = 'ee011de1-a1ce-4dd8-aaf3-d7e19e0cee14'; hash = '01733293d15809ee167fbb31d7c27eb6bf12e4b5b0acf25928c2c894c5726865' }
  'sparring-token-efficiency' = @{ id = 'b2df0328-27f7-43fe-bee5-2d6ba8866cb2'; hash = '71acdb7cfbf0016db67a6af91b7a5d524864a9708520e80e0b4cc2c2b44c4a0f' }
  'mt-frontend-brand-r2'      = @{ id = 'c351f749-3076-4fba-87b0-25aba2df8c15'; hash = '253a715b903a2e4c945dd544eaa187122e50e75a26b9e687554bf75fec8fad75' }
  'mt-packs'                  = @{ id = 'eb308b4e-c1f4-442f-8624-0b92becdecee'; hash = '00c82ef50a5c2cd09f3d5076fc80f18c1f11ca3828f55982d5f6e0598396a85d' }
  'mt-tenant-admin'           = @{ id = '03698d49-e8fc-4804-8332-b127637d9adc'; hash = '6e4964ee546339af4bb07b3ef2a9993493206eac4d7bd5ebd61790b2b2960da5' }
  'mt-data-cleanup'           = @{ id = '2efa877e-46e8-4355-a2e0-d9b3c30be794'; hash = 'a360a11357cc551e5df193a6fcc517080d9fdb8a6802258d35a087b8082f5746' }
  'mt-native-health'          = @{ id = 'fca982e6-f8a0-4fc9-8e6e-78d23ba39b48'; hash = '2ebd4325364eb56ad1cda12df77257435e295843eb38ec0421c4944bc67db0ab' }
  'mt-community-isolation'    = @{ id = 'ed136e24-677b-483e-92ea-78045c7b4748'; hash = 'e64d3489da4793a3d3bf3879673900eff5b4b05e6dcff6d540d17e1f4e83f94c' }
  'mt-m3'                     = @{ id = '8a83bc72-709d-4234-8481-0e260cd2771f'; hash = 'ecfb4a6ff91fe8573e1210b9d0d749584589d7c02813ac8fb8b7892ce0c92c73' }
}

$Targets = if ($Slugs) { $Slugs } else { @($Sessions.Keys) }
$Note = 'Owner approval of escalated multi-tenant plan; escalation acknowledged. Approved via docs/owner/approve-11.ps1.'
$AuthHeader = @{ Authorization = "Bearer $($env:VITANA_ADMIN_JWT)" }

foreach ($slug in $Targets) {
  if (-not $Sessions.Contains($slug)) { Write-Warning "SKIP ${slug}: unknown slug"; continue }
  $sid  = $Sessions[$slug].id
  $hash = $Sessions[$slug].hash
  Write-Host "=== $slug  session=$sid ==="

  try {
    $pre = Invoke-RestMethod -Method Get -Uri "$GatewayUrl/api/v1/plans/spar/$sid" -Headers $AuthHeader
    Write-Host ("  pre-check: verdict={0} final_plan_hash={1} approved_at={2}" -f $pre.session.verdict, $pre.session.final_plan_hash, $pre.session.approved_at)
  } catch { Write-Warning "  GET failed for ${slug}: $($_.Exception.Message)"; continue }

  $body = @{ final_plan_hash = $hash; acknowledge_escalation = $true; note = $Note } | ConvertTo-Json -Compress
  try {
    $res = Invoke-RestMethod -Method Post -Uri "$GatewayUrl/api/v1/plans/spar/$sid/approve" -Headers $AuthHeader -ContentType 'application/json' -Body $body
    Write-Host ("  OK verdict={0} approved_at={1} approver={2}" -f $res.session.verdict, $res.session.approved_at, $res.session.approved_by) -ForegroundColor Green
  } catch {
    Write-Warning "  NOT approved for ${slug}: $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { Write-Host "  body: $($_.ErrorDetails.Message)" }
  }
  Write-Host ''
}

Write-Host 'Done. Re-run queue.mjs and push one empty resume per approved plan to trigger PLAN-SPAR VTID allocation.'
