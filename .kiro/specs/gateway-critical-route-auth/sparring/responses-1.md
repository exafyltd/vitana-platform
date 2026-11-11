# Responses — round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Option (c) with evidence. mcp/vitana-work/src/lib/gateway-client.ts:73 reads VITANA_API_KEY and :89 sends it as Bearer; the MCP is run by developers locally, not deployed. After the lane it works only when VITANA_API_KEY is the service token or an exafy_admin JWT. Plan §4 now names this as a known developer-facing change, recorded in acceptance.md and the PR body; changing the MCP is outside this lane.", "deferred_to": "acceptance.md known changes; MCP owner"},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "Plan §4 now requires the event loop and the reconciler to log one error per process on their first dispatch when GATEWAY_SERVICE_TOKEN is unset, with a test. The variable is set on the staging gateway task (AWS-STAGE-DEPLOY-GATEWAY.yml:1320); the staging rejected probes prove the gate itself.", "deferred_to": ""},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "Verified at the pin: worker-orchestrator-tools.ts exists, imports gatewayApiCall at :18 and posts to /api/v1/worker/orchestrator/tasks/:vtid/release at :86; its other calls (:33, :47, :62, :101) are GETs. The plan now cites :18,86 only.", "deferred_to": ""}
]
```
