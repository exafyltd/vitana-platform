# Sparring round 1 — in_progress

Session: `1d3959ab-0249-4d15-81ec-1f39154fce6f` · plan hash `045ec6d4201bdde7720631b142fcf49bd783ddba6ff9de4356bf1962b73d1857`

## Summary

The plan is well-structured with appropriate gating (prereq-exit, owner gates) and sensible parallelism. The gateway-side premises I could verify (app-config route, defaults, service structure) are accurate. However, there are three substantive gaps in the `client-identity-gateway` lane: the scope likely omits necessary integration points (middleware or index.ts), the mechanism for distinguishing Appilix from web traffic is unspecified despite being critical for the adoption metric, and the persistence/storage mechanism for the per-client-class counts is absent. Most vitana-v1 premises could not be verified because only vitana-platform is pinned in this session.

## Findings

### R1-F1 [major]

The `client-identity-gateway` lane scope (`services/gateway/src/services/client-identity/**`) is too narrow. The gateway needs to read the `X-Vitana-Client` header and classify every authenticated request, which requires either new middleware or changes to an existing request path, plus a mount point in `src/index.ts`. The index.ts file shows every route and middleware is imported and mounted there. Neither middleware files nor index.ts appear in the lane's scope. Without an integration point, the classification service is dead code.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:64` — const { mountRouterSync, logStartupSummary } = require('./governance/route-guard'); ... All routes are imported and mounted in index.ts; a new service that must intercept requests needs a mount here.
- `exafyltd/vitana-platform:services/gateway/src/index.ts:80` — Continued route imports and mounts — every feature (app-config, supervisor-summary, telemetry, etc.) follows the pattern of being imported in index.ts and mounted via mountRouterSync.

Suggestion: Add `services/gateway/src/middleware/client-identity.ts` (or an equivalent route-level integration file) and `services/gateway/src/index.ts` to the lane's scope. Clarify whether the classification runs as Express middleware on all routes or is called from specific routes.

### R1-F2 [major]

The plan says the gateway classifies each request as `native`, `appilix`, or `web`, but only the native app sends the new `X-Vitana-Client` header. The plan explicitly states 'the user agent alone cannot separate the Appilix web view from native' — implying there IS a UA-based signal to distinguish Appilix from regular web. However, the plan never specifies what that Appilix signal is (a UA substring? A custom header the wrapper injects?). Without documenting this, the classification test and the adoption metric have no grounded definition of `appilix` vs `web`.

- `exafyltd/vitana-platform:services/gateway/src/services/native-push-flags.ts:1` — NATIVE_PUSH_APPILIX_GUARD_ENABLED same-phone duplicate guard; effective only when the first is also on. — The gateway already has a notion of Appilix, but this file gives no classification logic; it is a boolean env flag only.

Suggestion: Document the exact signal(s) the gateway uses to classify a request as `appilix` (e.g., a known UA substring injected by the wrapper, or a specific query parameter). Add this to the classification test's assertions so the metric is auditable before `appilix-retire` opens.

### R1-F3 [major]

The plan says the gateway 'counts distinct active members per class' but does not specify the persistence or aggregation mechanism. Is it a new database table/view? A Redis counter? A log-based offline query? The adoption metric (≥95% of active mobile members on native, 7-day window) requires durable, queryable storage. The lane scope lists only `services/client-identity/**` and test files, with no migration, no new table, and no mention of a storage dependency.

- `exafyltd/vitana-platform:services/gateway/src/services/app-config/app-config-repository.ts:29` — fetchNativeAppKillRows reads from Supabase REST using SUPABASE_URL and SUPABASE_SERVICE_ROLE — the existing pattern for gateway ↔ Supabase reads. A new counting mechanism would need either a new table with similar pattern, or a different store.

Suggestion: Specify the storage backing for the client-identity counts: new Supabase table (requires a migration file in scope), Redis expiring sets, or structured log query. If a new table is needed, add the migration to the lane scope and note whether it needs a VTID-governed schema change.

### R1-F5 [minor]

The `crash-port` lane references `apps/mobile/src/push/provider.ts:53` (`setPushProvider`) as the design pattern for its provider-agnostic port, but vitana-v1 is not pinned in this review session and the search for `setPushProvider` returned no hits. If this pattern does not exist at the cited line or has a different API shape, the crash-port design assumption is unfounded.

- `exafyltd/vitana-platform:services/gateway/src/services/app-config/defaults.ts:1` — VTID-05177 — native app remote config: the checked-in source of truth. (This confirms the gateway-side app-config exists; the vitana-v1 push provider reference could not be checked because vitana-v1 is not pinned.)

Suggestion: In the next review round, pin vitana-v1 so the push provider pattern and all other vitana-v1 premises (ledger counts, app.config.ts guards, http.ts, Appilix file count) can be verified.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
