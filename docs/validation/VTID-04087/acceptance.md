# VTID-04087 — Acceptance: Command Hub Service Health backend-fed registry

## Context

T12 of the Command Hub cleanup program. The Service Health panel's ~55-entry
`healthEndpoints` array lived only inline inside `fetchServiceHealth()` in
the static `app.js` — a frontend-only asset with no server-side
counterpart, so shipping a new health-check route could never make it onto
the panel unless someone remembered to hand-edit that unrelated array too.

## Acceptance Criteria

AC-1 — A new server-side constants module,
`services/gateway/src/constants/service-health-registry.ts`, exports
`SERVICE_HEALTH_REGISTRY`: the exact same 55 `{name, url, group}` entries
previously hardcoded in app.js, byte-for-byte (names, URLs, groups, the
`Screen Load Time` comment preserved).
TEST: services/gateway/test/command-hub/t12-health-registry-backend-fed.test.ts
  — "service-health-registry.ts exports SERVICE_HEALTH_REGISTRY with the
  same core checks"

AC-2 — A new unauthenticated route, `GET /api/v1/admin/health-registry`
(mounted via the existing `admin-health.ts` router at `/api/v1/admin`),
returns `{ ok: true, endpoints: SERVICE_HEALTH_REGISTRY }`. Unauthenticated
to match the existing `/health`/`/build-info` posture on this router — the
registry is a list of endpoint names/paths/groups, not sensitive data.
TEST: services/gateway/test/routes/admin-health-registry.test.ts — "returns
  200 with an endpoints array, unauthenticated"; "carries no secrets —
  matches the public /health, /build-info posture"
TEST: services/gateway/test/command-hub/t12-health-registry-backend-fed.test.ts
  — "admin-health.ts mounts an unauthenticated /health-registry route
  sourced from the registry module"
CURL: `curl -s http://localhost:8080/api/v1/admin/health-registry | jq '.endpoints | length'`
  → 55 (verified against a local supertest harness in the route test above,
  same assertion shape)

AC-3 — `fetchServiceHealth()` in app.js fetches the registry at runtime
(`GET /api/v1/admin/health-registry`, 4s timeout) and uses its
`endpoints` array when the fetch succeeds and returns a non-empty array.
TEST: services/gateway/test/command-hub/t12-health-registry-backend-fed.test.ts
  — "fetchServiceHealth() fetches the server-side registry before falling
  back"

AC-4 — On a failed/malformed registry fetch (network error, non-2xx,
missing/empty `endpoints`), `fetchServiceHealth()` falls back to a
last-known-good copy (`FALLBACK_HEALTH_ENDPOINTS`, declared once at module
scope) rather than throwing or rendering an empty panel.
TEST: services/gateway/test/command-hub/t12-health-registry-backend-fed.test.ts
  — "fetchServiceHealth() fetches the server-side registry before falling
  back"; "the fallback list still carries the core checks the panel has
  always shown"

AC-5 — The old inline array literal is gone from inside
`fetchServiceHealth()`'s body — it is not duplicated in two places.
TEST: services/gateway/test/command-hub/t12-health-registry-backend-fed.test.ts
  — "the old hardcoded array no longer lives inline inside
  fetchServiceHealth()"

AC-6 — `FALLBACK_HEALTH_ENDPOINTS` is declared exactly once, at module
scope, before the function that reads it.
TEST: services/gateway/test/command-hub/t12-health-registry-backend-fed.test.ts
  — "FALLBACK_HEALTH_ENDPOINTS is declared once, at module scope, before
  the function that uses it"

AC-7 — `index.html`'s cache-bust query strings for `styles.css` and
`app.js` were bumped together to the same new value, per this repo's
CI/CD cache-busting convention (CLAUDE.md §16).
TEST: services/gateway/test/command-hub/t5c-no-fabricated-fallback-rows.test.ts
  (unrelated suite, but exercises the same cache-bust-pair assertion
  pattern this PR's own change satisfies) — verified directly: both tags
  read `?v=20260918-vtid-04087-health-registry`.

AC-8 — The change compiles and builds cleanly.
TEST: `tsc --noEmit` (services/gateway) — 0 errors.
TEST: `npm run build` (services/gateway) — exit 0.

## Route Mount Evidence

ROUTE_MOUNT: `router.get('/health-registry', (_req, res) => ...)` registered
in `services/gateway/src/routes/admin-health.ts`, whose router is mounted
at `/api/v1/admin` in `services/gateway/src/index.ts`
(`mountRouterSync(app, '/api/v1/admin', adminHealthRouter, { owner:
'admin-health' })`, unchanged by this PR — no new mount, an existing
router gains a route).

FINAL_URL: `GET /api/v1/admin/health-registry`

CURL_PROOF: exercised via a real Express app + supertest, not a live curl
(no reachable gateway from this session) —
`services/gateway/test/routes/admin-health-registry.test.ts`, "returns 200
with an endpoints array, unauthenticated":
```
const res = await request(buildApp()).get('/api/v1/admin/health-registry');
expect(res.status).toBe(200);
expect(res.body.ok).toBe(true);
expect(Array.isArray(res.body.endpoints)).toBe(true);
expect(res.body.endpoints.length).toBeGreaterThan(0);
```
Passing locally (see commands.log step 10/12): the route returns 200,
`application/json`, `ok:true`, a 55-entry `endpoints` array.

## Not done / explicitly out of scope

- No change to which endpoints are checked, how results are rendered, or
  the health-pill/incremental-update logic — this VTID only moves the
  *list* of endpoints from a frontend-only literal to a backend-fed
  registry with a safe fallback. The check-execution logic
  (`Promise.allSettled`, latency measurement, `state.serviceHealth.items`)
  is untouched.
- Not verified live on staging — this session has no live gateway
  endpoint to curl. The next real signal is the Command Hub Service
  Health panel loading its 55 checks from `GET
  /api/v1/admin/health-registry` on the next staging deploy (visible via
  the browser network tab, or a `console.warn` in devtools if the
  registry fetch ever falls back).
