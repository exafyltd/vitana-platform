# VTID-05142 - update_business and update_product are destructive tools

Owner decision 2026-10-13 ("yes, go ahead" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (light class, 2 rounds, CONVERGED).

Problem: OpenAI's plugin portal scan (account connected) lists the nine Commerce tools and reports one finding each on `update_business` and `update_product`: "This tool is marked destructiveHint: false, but its behavior appears to cause material loss or a hard-to-reverse change." The catalogue (`services/gateway/src/services/commerce-mcp.ts`, `hints()`) declared every tool non-destructive; these two overwrite existing values in place.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route or mount; no route file changes.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-authorization-server (staging, read-only GET; the served hints are proven by the Jest suites because `tools/list` needs a signed-in caller).

OASIS_PROOF: not applicable; tool-annotation metadata only, no event is emitted or changed.

CURL_PROOF: after the production deploy the owner presses Rescan in OpenAI's plugin portal and the two findings must be gone; the scan's `tools/list` carries `destructiveHint: true` for exactly `update_business` and `update_product`.

## Acceptance criteria

AC-1: `update_business` and `update_product` carry `destructiveHint: true`; every other Commerce tool keeps `false`; all three hints stay explicit booleans on every tool.
  TEST: services/gateway/test/vtid-04969-commerce-mcp-openai-metadata.test.ts
AC-2: Per tool, the write-tool check expects `destructiveHint` true for the two overwrite tools and false for the others; read-only tools are still exactly the two readers.
  TEST: services/gateway/test/vtid-04940-commerce-mcp-supplier-data.test.ts
AC-3: `check_verification` and `connect_store` annotations are unchanged.
  TEST: services/gateway/test/vtid-04941-commerce-mcp-automation.test.ts

## Accepted risk
A client that honors `destructiveHint` may ask the supplier to confirm each call of the two tools. Metadata only: no tool behavior, schema, description, access check or `confirmed` rule changes. The Community MCP catalogue is not touched.

## Limits
Jest cannot run in the build session (registry blocked); CI is the first run. The three changed files were syntax-checked with the TypeScript transpiler.
