# VTID-04665 — Service Health Phase 4: "ok" means the dependency answers

VTID: VTID-04665
VALIDATION_PROFILE: gateway_backend

## Problem
23 registered checks answered `{ ok: true }` without touching anything, so they were green as long
as the route existed. Checked against the live database on 2026-09-26, five of those green routes
had no data layer at all:

| Route (shown green) | Missing in the live database |
|---|---|
| Autopilot Prompts | table `autopilot_prompts` |
| Risk Mitigation | table `risk_mitigations` (already noted in CLAUDE.md §3) |
| Overload Detection | functions `overload_detect`, `overload_get_detections` |
| Taste Alignment | functions `taste_profile_get`, `taste_reaction_record` |
| User Preferences | functions `preference_set`, `preference_get_audit` |

## Change
New `services/dependency-probe.ts`: `probeDependencies()` / `withDependencyHealth()`.
- table: head-only select, no rows read, 3 s timeout
- rpc: presence in PostgREST's own OpenAPI listing, never called (several write)
- file: exists and is non-empty (the Command Hub's app.js and index.html)
- cached 60 s per dependency, schema listing 10 min; never throws

18 per-router `/health` handlers now declare their dependency and keep their existing fields; `status`
and `ok` follow the probe, and `dependencies` lists what was checked. After this ships, the five
routes above will show **down** on the panel. That is the point of the change: those features do not
work today, and fixing them is a product decision per feature, not something to hide.

Deliberately unchanged: `/health` and `/alive` stay dependency-free, because they are liveness
endpoints and tying them to the database would let a slow Supabase take healthy containers out.
`/api/v1/autopilot/health` already reports governance state, `/availability` is a pure computation
engine with no data layer, and `/visual` already probes the MCP gateway.

## Acceptance criteria
AC-1: A missing table or function makes the route `down` and the panel classifies it as down; a
reachable dependency keeps the route's own status; RPCs are never called; results are cached.
TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts

AC-2: Each of the 18 routes declares its dependency.
TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts

OASIS_PROOF: none. Read-only probes.

## Route mount evidence
No route is added. The 18 existing `/health` handlers are rewritten in place (now `async`, wrapping
their body in `withDependencyHealth`), which the route gate reads as a registration line.
ROUTE_MOUNT: unchanged — each handler stays on its router's existing mount in services/gateway/src/index.ts (e.g. riskMitigationRouter at /api/v1/mitigation, overloadDetectionRouter at /api/v1/overload, autopilotPromptsRouter at /api/v1/autopilot/prompts)
FINAL_URL: the 18 existing URLs listed in staging-tests.json, e.g. GET /api/v1/mitigation/health
CURL_PROOF: pre-merge on staging each answers 200 application/json, e.g. `curl -s https://preview-aws-gateway.vitanaland.com/api/v1/mitigation/health` → `{"ok":true,...,"status":"healthy"}` (outputs/jest-vtid-04665.txt). After merge STAGING-VERIFY expects the same URLs to carry `"dependencies":[` and /mitigation/health to read `{"ok":false,"status":"down"}`.
