# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified on platform origin/main: ALLOWED_ORIGINS (services/gateway/src/middleware/cors.ts:7-39), ALLOWED_ORIGIN_PATTERNS (:45-50), isOriginAllowed (:52-55), OPENAI_MCP_ORIGINS/MCP_CHATGPT_PATHS/WELL_KNOWN_PREFIX (:87-90) and applyDiscoveryCors (:97-121) are all module-scope and read synchronously. The lane now specifies the mechanism: a new CORS_EXTRA_ORIGINS env var, comma-split with the existing gateway pattern for env origin lists (services/gateway/src/services/outbound-http-worker.ts:151, OUTBOUND_HTTP_ALLOWED_ORIGINS) so no new config module and no ad-hoc reader; parsed ONCE at module load (applies on task restart/deploy, no hot reload); only exact https:// origins kept (no path, no wildcard); APPENDED to ALLOWED_ORIGINS (augment, never replace; unset = today's list exactly). ALLOWED_ORIGIN_PATTERNS, isOriginAllowed, allowedHeaders (:67) and the narrow applyDiscoveryCors rules are unchanged, so an extra origin never widens /mcp/chatgpt or /.well-known. Jest (jest.isolateModules per env value) now also pins: unset env keeps every current origin and pattern; malformed/wildcard entries ignored; /.well-known/* and /mcp/chatgpt behaviour unchanged. Updated plan.md (cors-config Fix + Tests), tasks.md CC1/CC2 and the cors-config lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Pinning vitana-v1 into the partner session is outside this plan's control, so the plan now carries direct citations for the two highest-risk claims, pinned to vitana-v1 origin/main @ 32a82e6b. (1) src/lib/admin-api.ts:7 JSDoc says it 'Injects X-Vitana-Tenant and X-Vitana-Active-Role context headers'; the fetch at admin-api.ts:35-42 sets only \"Content-Type\", Authorization: Bearer and ...init.headers. (2) The only gateway readers of those headers on platform origin/main are routes/autopilot-recommendations.ts:406,430,1799,2336 (mounted /api/v1/autopilot/recommendations, services/gateway/src/index.ts:905), routes/calendar.ts:186,1054 and routes/memory-garden.ts:48 (memory-garden was missing from the old list; added). adminFetch call prefixes in v1 are /admin/* and /api/v1/{admin,community,conversation,partner-health,patient,vcaop,voice-lab}/*; its autopilot calls (src/hooks/useAdminAutopilot.ts:143-322) hit /api/v1/admin/autopilot, which is routes/admin-autopilot.ts (index.ts:555,1489) and reads neither header; no adminFetch call targets calendar or memory-garden. The plan's blanket 'every file:line holds' line is replaced by the pinned commit plus an executor build-time re-check of both premises (adminfetch-header AF1; a mismatch stops the lane with next_actor: claude).",
    "deferred_to": null
  }
]
```
