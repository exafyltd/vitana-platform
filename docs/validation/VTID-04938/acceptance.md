# VTID-04938 — Commerce MCP directory listing: readiness verification (item 1 of 7)

Owner instruction 2026-10-06/07 (approved plan, "approved go ahead"). Sparring: `plan-sparring.md` (converged, plan hash `4f2e36ed66177ffaf3b1b06633b19e63442d12c3da7e16e58c39fed3ff3c5224`).
Not part of this VTID: any code, migration, deploy, reviewer account or directory submission (items 2-7, each its own VTID).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (documentation only; the existing /mcp route is unchanged).

FINAL_URL: n/a (no runtime surface).

CURL_PROOF: n/a — nothing is deployed and nothing is probed against production.

OASIS_PROOF: n/a (no state change).

## Acceptance criteria

AC-1: The report states what is and is not proven about Claude's OAuth callbacks and dynamic client registration, and what the owner must check once by hand.
  TEST: services/gateway/test/commerce-mcp.test.ts (the existing MCP metadata, 401 challenge and scope tests that the report relies on)
AC-2: The report lists, per partner type, the required checklist steps and which of them the seven MCP tools can complete, with file and line evidence (outputs/readiness-evidence.txt).
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-3: The report records the icon situation and the listing-name decision for the owner.
  TEST: services/gateway/test/commerce-mcp.test.ts
