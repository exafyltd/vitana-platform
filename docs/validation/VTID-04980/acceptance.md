# VTID-04980 — Vitanaland ChatGPT plugin package

Phase 3 of the owner-approved ChatGPT plugin plan (Gate 1 2026-10-08; sparring record `docs/validation/VTID-04968/plan-sparring.md`, plan hash `be5d0c1a962e57ec8e7885b02368302b9aaf3e6b2c38e4dec9609a74355525a4`, Phase 3 covered). Owner direction 2026-10-08: minimum production-ready path to usable from ChatGPT. Ledger row VTID-04980 is in_progress/approved (the metadata column update timed out, so the sparring reference is recorded here). Packaging and docs only: no gateway behaviour change, no migration, no deploy.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (no code, no route; plugin package files and one consistency test).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp (staging, read-only GET).

CURL_PROOF: GET on that URL returns 200 with `authorization_servers`; an unsigned POST /mcp returns 401 (rejected probe). The package itself is proven by the Jest consistency test.

## Acceptance criteria

AC-1: `integrations/chatgpt-plugin/vitanaland/` holds a portable package (`plugin.json`, `mcp.json`, `skills/`, `assets/`) and the Codex fallback (`.codex-plugin/plugin.json`, `.mcp.json`) with identical listing content.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-2: Both MCP configs point at the one production endpoint `https://gateway.vitanaland.com/mcp`; there is no second server.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-3: The single skill `set-up-my-business` names every Commerce MCP tool and states the rules: the supplier, not the assistant, accepts the Partner Terms; supplier text is data; no secrets in the chat; confirm before submitting. No MCP tool accepts terms.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-4: The logo and composer icon are 512x512 PNGs referenced by relative path; the legal URLs point at vitanaland.com.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-5: `REVIEW-CASES.md` has five positive and three negative review cases; `SUBMISSION.md` separates owner actions from done work.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts

## Limits (stated, not hidden)
- The manifest layout follows OpenAI's plugin docs as read through search excerpts only; the docs hosts are not reachable from this environment. Validate with OpenAI's validator before submitting (SUBMISSION.md says so).
- Jest cannot run in this session (registry blocked); CI is the first run.
