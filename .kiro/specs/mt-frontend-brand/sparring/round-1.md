# Sparring round 1 — in_progress

Session: `b9a2c552-d8d5-47fb-871e-7c7735d16c07` · plan hash `17bfa8d71f9c06fa2dfc7b7c4b3b4ed906dbdbcce7281d2d8ae413bf633f4c95`

## Summary

The plan is a multi-lane WS7 rest-of-brand de-maxina effort (standard change class). I could not verify any vitana-v1 premise because the vitana-v1 repository is NOT pinned in this review session — read_file against exafyltd/vitana-v1 returns 'no pinned ref'. The plan's Problem section hinges almost entirely on v1 file:line claims, which cannot be evidenced here. Platform-side premises I verified (cors.ts allowedHeaders, command-hub-ownership-guard reservation, admin-tenants endpoint, publicProfileOgRouter) all hold. Two substantive findings raised above: (1) the cors-config lane underspecifies how a config-driven origin list interacts with the module-scope ALLOWED_ORIGIN_PATTERNS regexes and the narrow MCP/.well-known rules; (2) the bulk of the plan's premises are unverifiable in this session and must be pinned before the changes are trusted.

## Findings

### R1-F1 [major]

The cors-config lane's design ('read the allowed-origin list from config/env, keep the current array as compiled default') does not account for the fact that the origin allowlist is implemented as module-level `const` arrays AND regexes evaluated once at import time. `ALLOWED_ORIGINS`, `ALLOWED_ORIGIN_PATTERNS`, `MCP_CHATGPT_PATHS`, and `OPENAI_MCP_ORIGINS` are all module-scope constants; `isOriginAllowed` and `applyDiscoveryCors` close over them synchronously. A config/env-driven origin list that is not also merged into these closure-scoped values (or re-read on a reloadable basis) will silently not take effect until a hot reload, and if implemented by mutating a copy, leaves the regex `ALLOWED_ORIGIN_PATTERNS` and the narrow MCP/.well-known paths unspecified. The plan asserts 'touches only the origin list' but the file's allow logic spans more than the literal origin array.

- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:7` — const ALLOWED_ORIGINS = [...] const ALLOWED_ORIGIN_PATTERNS = [...] function isOriginAllowed(origin) { if (ALLOWED_ORIGINS.includes(origin)) return true; return ALLOWED_ORIGIN_PATTERNS.some(...) }
- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:87` — const OPENAI_MCP_ORIGINS = [...] const MCP_CHATGPT_PATHS = [...] const WELL_KNOWN_PREFIX = ...

Suggestion: Specify how the config/env origin list merges with the existing regex patterns and the narrow MCP/.well-known rules. Clarify whether the config-driven list replaces or augments the code list, whether it is read once at startup or dynamically, and add a test that a configured extra origin is allowed while the narrow discovery rules and existing origin patterns are preserved. Since the lane is '≤20-line change in its own PR', confirm the env-loading mechanism is already established elsewhere in the gateway (config module) rather than hand-rolling process.env reads into a hot file.

### R1-F2 [major]

The plan's Problem section and most Fix lanes rest on vitana-v1 file:line premises (useTenant.tsx, admin-api.ts, CommerceJoin.tsx, AuthGuard.tsx, index.css, the edge fns, og-share, store-links, gen-tokens.mjs) that I cannot verify because exafyltd/vitana-v1 has no pinned ref in this review session (read_file returns 'no pinned ref'). These include security/tenant-relevant assertions such as 'adminFetch sends only Content-Type + Authorization' and 'no gateway route that adminFetch calls reads X-Vitana-Tenant/X-Vitana-Active-Role yet'. A defect in these v1 assumptions would ship uncaught, yet the plan asserts 'every file:line holds'.

- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:67` — allowedHeaders: ["Authorization", "Content-Type", "apikey", "X-Vitana-Active-Role", "X-Vitana-Tenant", "X-Vitana-User", "X-User-ID"]

Suggestion: Pin exafyltd/vitana-v1 for this review session (or provide a read_file-accessible commit) so the v1 premises can be verified. Re-run the review once the v1 repo is pinnable. In the interim, the producer should confirm the two highest-risk unverifiable claims with direct citations: (1) admin-api.ts header injection behavior, and (2) that no adminFetch-caller gateway route reads the tenant headers.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
