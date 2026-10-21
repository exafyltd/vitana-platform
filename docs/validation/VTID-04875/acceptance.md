# VTID-04875 — Overview Phase 1a: in-process builders for pipeline summary, voice overview and health summary

Plan A (Command Hub Overview), Phase 1a — sparring finding N1 / REVISION 2 F3
(see `plan-sparring.md`). The Phase 1 `/ops/attention` adapters must call
service functions in-process, never HTTP self-calls. Three of the sources they
need were only reachable as inline route handlers, so this change extracts
them, unchanged, into services and turns the routes into thin wrappers.
Pure refactor: no new routes, no new behaviour, no schema, no OASIS events.

Method: the three `route:` characterization blocks were written first and run
against the untouched handlers (`outputs/01-characterization-old.txt`, 17
snapshots written). After the refactor the same blocks were re-run with
`--ci` (snapshots may not be rewritten): 17/17 matched, and the three `.snap`
files have the same sha256 before and after (`commands.log`). Each snapshot
holds status, content-type, the exact response text, and every outbound read
(Supabase URLs + headers, data-layer arguments, loopback probe URLs + headers).

AC-1: `services/gateway/src/services/pipeline-summary-builder.ts` exports `buildPipelineSummary(deps?)`; it takes no req/res, uses the same 13 PostgREST reads with the service-role key in the same order, and returns `{ status, body }`. `deps` may inject `fetchImpl`, `getEventLoopStatus`, `supabaseUrl`, `serviceRoleKey`; every default is what the handler used.
TEST: services/gateway/test/vtid-04875-pipeline-summary-builder.test.ts (buildPipelineSummary() — in-process, no req/res)

AC-2: `GET /api/v1/autopilot/pipeline/summary` is a thin wrapper and returns byte-identical status, content-type and JSON for realistic data, all-non-ok, all-rejected, event-loop failure and missing Supabase env.
TEST: services/gateway/test/vtid-04875-pipeline-summary-builder.test.ts (route: … — snapshots recorded against the old handler, re-run with --ci)
TEST: services/gateway/test/routes/autopilot.test.ts

AC-3: `services/gateway/src/services/voice-supervisor-overview.ts` exports `buildVoiceOverview({ window, scope, filters })`, callable without req. Scope `{ is_platform_admin: true }` with no filters is unscoped (tenant_id null on both reads). A non-platform scope without filters is confined to its tenant. Data-layer errors are rethrown unchanged.
TEST: services/gateway/test/vtid-04875-voice-overview-builder.test.ts (buildVoiceOverview() — in-process, no req)

AC-4: `GET /api/v1/voice/supervisor/overview` is a thin wrapper and stays byte-identical, with identical data-layer arguments. Covered cases: platform admin with and without filters, bogus window and tenant_id, a tenant admin forced to their own tenant, SupervisorDataError → 502, Error → 500, and a tenant-name lookup failure → 502.
TEST: services/gateway/test/vtid-04875-voice-overview-builder.test.ts (route: … snapshots)
TEST: services/gateway/test/routes/voice-supervisor.test.ts

AC-5: `parseWindow` and `scopedFilters` are still exported from `routes/voice-supervisor.ts` with the same behaviour. `/meta` still lists the same windows.
TEST: services/gateway/test/vtid-04875-voice-overview-builder.test.ts (equals the route for every scenario that succeeds)
TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts

AC-6: `services/gateway/src/services/health-summary-builder.ts` exports `buildHealthSummary({ authHeader?, now? })`. It keeps the loopback self-probe (`http://127.0.0.1:$PORT`, default 8080), documented as health "as seen from the serving task", and forwards `authHeader` verbatim as `Authorization`.
TEST: services/gateway/test/vtid-04875-health-summary-builder.test.ts (buildHealthSummary() — in-process, no req/res)

AC-7: The cache semantics are unchanged. There is one module-level cache shared by the route and in-process callers. It is fresh for 30 s from the end of the run: 29 999 ms gives a cache hit, 30 000 ms a re-probe. Concurrent callers share one in-flight run. A failed run is not cached, the route answers 500 `summary_failed`, and the next call retries. `resetHealthSummaryCacheForTests` is still exported from the route module.
TEST: services/gateway/test/vtid-04875-health-summary-builder.test.ts (route: concurrent callers …; route: a probe run that rejects …)
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts

AC-8: `GET /api/v1/admin/health/summary` is a thin wrapper and stays byte-identical, including probe URLs and headers. The unauthenticated 401 still probes nothing.
TEST: services/gateway/test/vtid-04875-health-summary-builder.test.ts (route: … snapshots)

AC-9: The source-text guard that pins `source_type` in the pipeline-summary recommendations select follows the query into the builder. The assertion itself is unchanged.
TEST: services/gateway/test/vtid-04667-executable-source-types-drift.test.ts

AC-10: The operator pipeline (rule 42e) and role separation (rule 42h, including the atlas drift guard) are green. No route file was added or renamed.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts (npm run test:operator)
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts (npm run test:roles)

AC-11: After deploy, all three routes are still mounted and gated on staging. Each check is a read-only, unauthenticated GET that expects a 401 JSON response, with no sign-in and no writes.
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/pipeline/summary -> 401 {"ok":false,"error":"missing bearer token"}
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/voice/supervisor/overview -> 401 JSON
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/admin/health/summary -> 401 JSON
TEST: docs/validation/VTID-04875/staging-tests.json

OASIS_PROOF: none (pure refactor, no state transitions added or changed).
ROUTE_MOUNT: not applicable (no new routes; the three existing routes keep their paths and mounts).
