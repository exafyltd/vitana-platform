# VTID-05005 - Kiro sessions get the Operator's developer tools (phase A: read tools)

Owner approval 2026-10-09 (Gate 1 yes; "Include SQL and logs. I want full access."). Sparring: `plan-sparring.md` (converged, 3 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /api/v1/operator/kiro/mcp` (new, `routes/operator-kiro-mcp.ts`, mounted before the operator router; own auth: the Kiro session pass).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/mcp (staging).

CURL_PROOF: POST with an invalid bearer answers 401 application/json (route exists, pass check first), not an HTML 404.

OASIS_PROOF: every tools/call emits `operator.kiro.tool_called` (vtid VTID-05005; tool, thread_id, latency_ms, outcome; never arguments or results), declared in the CicdEventType union.

## Acceptance criteria

AC-1: A Kiro session's pass is signed (HKDF from GATEWAY_INTERNAL_TOKEN), bound to user, thread and environment, valid at most 1 h; forged, tampered, expired or other-environment passes are refused; no secret = no pass and the route answers 503.
  TEST: services/gateway/test/vtid-05005-kiro-dev-tools-mcp.test.ts
AC-2: The route is off (404) unless KIRO_MCP_ENABLED=true, refuses no/bad pass (401) and non-admins (403, re-checked per call, 60 s cache), rate-limits per user (429), and serves MCP initialize / tools/list / tools/call.
  TEST: services/gateway/test/vtid-05005-kiro-dev-tools-mcp.test.ts
  CURL: staging POST without a valid pass -> 401 application/json
AC-3: The tool list is exactly the approved read set (incl. read-only SQL, table reads, CloudWatch logs; no write tool); each call runs the Operator's own executeTool as the caller, with auth + identity registered for that call only.
  TEST: services/gateway/test/vtid-05005-kiro-dev-tools-mcp.test.ts
AC-4: The runner, never the gateway, decides a session's MCP servers: exactly the `vitana` stdio relay when the session carries a pass and the runner has its gateway URL, otherwise none; the relay posts each message with the pass.
  TEST: services/kiro-runner/test/runner.test.ts
AC-5: The gateway sends the pass in a header (never the URL); sessions older than 55 min reopen so a pass never expires mid-session; each environment's runner calls only its own gateway; existing Kiro, role and operator suites stay green.
  TEST: services/gateway/test/vtid-05005-kiro-dev-tools-mcp.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
