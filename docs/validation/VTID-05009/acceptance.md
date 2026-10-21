# VTID-05009 - DEV_MEMORY_PACK_TOKEN wiring + morning-pack SessionStart hook

Owner Gate 1 "yes", 2026-10-09. Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Staging wires DEV_MEMORY_PACK_TOKEN only when vitana/gateway/staging/dev-memory-pack-token exists; an absent secret never fails the deploy.
  TEST: services/gateway/test/vtid-05009-dev-memory-pack-token-wiring.test.ts
AC-2: Prod wires it only from the repo variable DEV_MEMORY_PACK_TOKEN_PROD_ARN, strips an old ref when unset, and rejects any other ARN.
  TEST: services/gateway/test/vtid-05009-dev-memory-pack-token-wiring.test.ts
AC-3: The SessionStart hook is registered and cannot block or fail a session (curl -m 8, exit 0).
  TEST: services/gateway/test/vtid-05009-dev-memory-pack-token-wiring.test.ts
AC-4: The route stays closed without a token (401 JSON); with the secret created, the header returns 200.
  CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/dev-memory/morning-pack -> 401 application/json
  TEST: services/gateway/test/routes/dev-memory.test.ts
