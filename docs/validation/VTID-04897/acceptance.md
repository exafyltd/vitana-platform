# VTID-04897 — Commerce MCP on in production

Owner instruction 2026-10-05: after the first gateway production release (VTID-04896, reward sweep off) is verified, enable and verify Commerce MCP in production before any frontend production deploy.

AC-1 The production deploy pins `COMMERCE_MCP_ENABLED=true` before the task definition is registered, after the reward-sweep pin.
TEST: services/gateway/test/vtid-04897-prod-commerce-mcp-pin.test.ts — "pins COMMERCE_MCP_ENABLED to "true" before registration, after the sweep-off pin"

AC-2 That value is exactly what turns the endpoint on; the endpoint's behaviour is unchanged.
TEST: services/gateway/test/vtid-04897-prod-commerce-mcp-pin.test.ts — "that value is exactly what turns the endpoint on"; services/gateway/test/commerce-mcp.test.ts

AC-3 The flag pins show MCP on for staging and production while the reward sweep stays off in production.
TEST: services/gateway/test/vtid-04897-prod-commerce-mcp-pin.test.ts — "the generated flag pins show it on for staging and production; the sweep stays off"; services/gateway/test/vtid-04896-prod-reward-sweep-pin.test.ts
