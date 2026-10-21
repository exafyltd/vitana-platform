# Health Hub + native app program — status

Shared status file for every session working on this program. Update it in the same PR as the work.

| Program | VTID | Plan | Sparring record |
|---|---|---|---|
| Health Hub | VTID-05020 | `docs/programs/health-hub/HEALTH-HUB-PLAN.md` | `docs/validation/VTID-05020/plan-sparring.md` |
| Native iOS + Android app | VTID-05021 | `exafyltd/vitana-v1` `docs/programs/native-app/NATIVE-APP-PLAN.md` | `exafyltd/vitana-v1` `docs/validation/VTID-05021/plan-sparring.md` |

Owner approval (Gate 1): 2026-10-10. Plan PRs merged: vitana-platform #3984, vitana-v1 #1305. Each work package below gets its own sparred plan and VTID before code.

## Work packages

| # | Package | Program | Status | VTID | Blocked on |
|---|---|---|---|---|---|
| 1 | Phase 0 / D12: remove wearable-derived condition labels from commerce, CI purpose boundary | Health Hub | merged — PR #3988; staging verification, then Gate 2 | VTID-05025 | — |
| 2 | Phase 0 / D1: token access and encryption, revoke on disconnect (+ OAuth callback error codes) | Health Hub | in review (sparred, 2 rounds, converged); grants migration applied after Gate 2 | VTID-05030 | — |
| 3 | Phase 0 / D2: vendor-correct webhook verification, fail closed | Health Hub | in review (sparred, 2 rounds, converged) | VTID-05031 | webhook secrets not wired in staging/prod task defs (deliveries rejected until provisioned) |
| 4 | Phase 0 / D3–D5, D7, D8: fake cards, privacy switches, erasure gaps, false lab notice, partner-health confirmations | Health Hub | done — vitana-v1 #1317 (VTID-05032), #1322 (VTID-05053), #1324 (VTID-05056); vitana-platform #4006 (VTID-05054), #4008 (VTID-05055); remainder in row 20 | VTID-05032, VTID-05053, VTID-05054, VTID-05055, VTID-05056 | — |
| 5 | G1 / 0T: test environment (Aurora test cluster + proxy, free-tier test Supabase project) | both | queued | — | AWS admin (cluster, ECS Exec/ssmmessages fix) |
| 6 | G2: Firebase push project health or replacement | Native app | queued | — | owner: Firebase/GCP project ownership |
| 7 | G3: store and signing ownership | Native app | waiting | — | owner: App Store Connect / Play Console access |
| 8 | Wave 0: Expo project, CI, parity ledger script, extraction dependency analysis | Native app | queued | — | macOS build minutes (EAS or GitHub) |
| 9 | `tr` fixup migration for `supported_locales` | both | queued | — | — |
| 10 | Fix stale "Active locales" paragraph in vitana-v1 CLAUDE.md (11 GA locales) | Native app | done — vitana-v1 #1305 | VTID-05021 | — |
| 11 | D6a: flag-gated bridge from webhook wearable data into `health_features_daily` + one Vitana Index recompute; `find_perfect_product` no longer reads the Index (unconditional) | Health Hub | in review (sparred); ships dark — `WEARABLE_FEATURE_BRIDGE_ENABLED` unset everywhere, always off on staging | VTID-05089 | flag stays off until D10 WP3 (per-member `wearables` + `ai_health_analysis` consent) is in production, webhook secrets are provisioned and one real connection exists |
| 12 | Phase 0 fix-ups (PLAT-FIX, sparred plan shared with V1-FIX VTID-05155 in vitana-v1): `find_perfect_match` stops reading the Vitana Index (no pillar-derived ask, goal only); `find_perfect_product`/`practitioner` read the real Life Compass goal (`primary_goal`, was the non-existent `current_goal`); `health_ingest_wearable_samples` revoked from members + `POST /health/wearables/ingest` answers 410. Change 6 (commerce-MCP link on a not-yet-published Terms/DPA step) follows in a separate PR after #4057 merges | Health Hub | in review (sparred, 3 rounds, converged); revoke migration applied via `RUN-MIGRATION.yml` after Gate 2 | VTID-05156 | Change 6: PR #4057 (VTID-05090) |
| 13 | Phase 0 fix-up V1-FIX: doubled `/api/v1` prefix on four pages (partner-health staff pages, marketplace Overview/Products, member page `/settings/limitations`) | Health Hub | in review — vitana-v1 | VTID-05155 | — |
| 14 | Phase 1 / A1: health store schema (Aurora only), placement guard + Aurora-only drift guard, SQL tests, Aurora-safe `erase_user_data()`, capacity model + placement record (`P1A-CAPACITY-AND-PLACEMENT.md`) | Health Hub | in review (sparred, 2 rounds, converged; Gate 1 2026-10-13); store migration committed, NOT applied — Aurora only (0T, then production after the cutover); the `erase_user_data()` fix is applied to Supabase only after its own Gate 2 | VTID-05158 | 0T (store apply), Aurora cutover (production) |
| 15 | Phase 1 / A2: gateway ingest service (`writeHealthSamples`), readers, maintenance, infra scripts — ships dark | Health Hub | queued (sparred with A1) | VTID-05159 | A1, B1 (`health_sources`), D10 WP1 |
| 16 | Phase 1 / A3: account deletion reaches the raw-batch bucket (vitana-v1) | Health Hub | queued (sparred with A1) | VTID-05160 | A2 (`erase-raw`) |
| 17 | Phase 1 / B1: `health_sources` (Aurora only) + backfill, S6 (`resolveHealthSource`/`setHealthSourceState`/`listHealthSources`), dark dual-write / read switch / reconciler, `user_integrations` browser-write revoke (Supabase, after Gate 2) | Health Hub | in review (sparred, 2 rounds, converged); stacked on A1 | VTID-05161 | A1 (#4102) merges first |
| 18 | Phase 1 / B2: writer re-routing (dual-write into the store), derived `health_features_daily_v2` | Health Hub | queued (sparred with B1) | VTID-05162 | A2, C1 (`self_logged_health`) |
| 19 | Phase 1 / B3: Vitana Index dual-compute, report, cutover switch + rollback | Health Hub | queued (sparred with B1) | VTID-05163 | B2 |
| 20 | Phase 0 / D4–D5 remainder: V1-D4M mobile Settings › Privacy › Data switches off + disabled, export disabled (vitana-v1); PLAT-D5R internal `POST /api/v1/internal/health-erasure/member-residue` (vendor revoke, webhook log rows, partner inbox references) + webhook log rows carry `user_id` (vitana-platform); V1-D5R `request-account-deletion` calls it before any table is erased (vitana-v1) | Health Hub | in review (sparred, 2 rounds, converged; Gate 1 2026-10-13) | VTID-05173 (V1-D4M), VTID-05174 (PLAT-D5R), VTID-05175 (V1-D5R) | V1-D5R deploys only after PLAT-D5R is in production; `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true` in production is a precondition for V1-D5R (follow-up 7) |

## Deferred follow-ups (recorded so they are not lost)

| Item | From | Note |
|---|---|---|
| `health_ingest_lab_report(jsonb)` is SECURITY DEFINER and EXECUTE for `authenticated` — any signed-in member can call it without a consent check | VTID-05156 plan, F18 / Open question 4 | Live callers (`routes/health.ts`, `routes/patient-health-results.ts`, `orb-tools/health-depth-tools.ts`); left to the Phase 1 package C consent-gated ingest rework. |
| `social_connections` OAuth tokens (Google/Microsoft/YouTube connectors) are stored the same way `user_connections` tokens were | VTID-05030 sparring, Fact 6 | Needs its own sparred plan: grants + sealing + revoke for the dispatcher's table. |
| Dedicated encryption key for health connection tokens + key rotation runbook | VTID-05030 round 1, Q2 | Interim: shared `AI_CREDENTIALS_ENC_KEY`. Zero stored tokens today. |
| Production `AI_CREDENTIALS_ENC_KEY` wiring for the gateway | VTID-05030 | Without it wearable connects fail closed (`storage_unavailable`); confirm in Gate 2. |
| D6b: poll scheduler for the polling connectors (Oura, Fitbit, Strava) — `fetchData` + token refresh | VTID-05089 plan (D6 split) | Deferred to Phase 2. Outline: EventBridge → internal `POST /api/v1/wearables/internal/sync-tick` (`X-Gateway-Internal`, 409 on staging, off unless `WEARABLE_SYNC_ENABLED==='true'`, single invocation not `setInterval`); per-connection claim by conditional update on `last_sync_at`; `openToken` → `refreshToken` when `token_expires_at` < 10 min → re-seal and store the rotated refresh token in the same update; `fetchData` → webhook persist code → the D6a bridge; per-provider concurrency 1, honour 429/`Retry-After`, per-tick cap; failures → `last_error` code + OASIS `connector.wearable.sync.*`. Needs its own sparred plan once a provider is enabled and members are connected (those three are seeded `enabled = FALSE`, frozen by the program, 0 connections). |
| `covers` bucket not erased on account deletion — event covers are shared with other members (event-ownership decision needed) | VTID-05053 / VTID-05174 plan, follow-up 1 | `_shared/erase-user-storage.ts:42-44` points here. |
| `intent-covers` bucket missing from `USER_STORAGE_BUCKETS` (paths are `${userId}/…`) | VTID-05174 plan, follow-up 2 | Not health data; add to the Storage walk in a vitana-v1 follow-up. |
| AP-0608 hardcoded English notice (`health-wellness.ts:125-128`) | VTID-05054 / VTID-05174 plan, follow-up 3 | Unreachable today; fix with the lab-parser work package. |
| Member data export job (GDPR Art. 15/20) | VTID-05032 / VTID-05174 plan, follow-up 4 | Desktop `Privacy.tsx:513` and mobile export buttons stay disabled until it exists. |
| Inert non-health privacy switches and raw English (desktop `Privacy.tsx:288, :343`; mobile `privacy.visibility`, security) | VTID-05174 plan F5, follow-up 5 | None shows health sharing as on; needs its own plan. |
| Non-health fake `connected: true` cards (`integrationData.ts:66-159`, shopping/social) | VTID-05032 / VTID-05174 plan, follow-up 6 | Outside the health program. |
| `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED` production state | VTID-05054 / VTID-05174 plan, follow-up 7 | Confirm read-only in the PLAT-D5R Gate 2; set via `env_overrides` if unset. Precondition for V1-D5R's production deploy (the member-residue payload filters are unindexed), else an expression index in its own VTID first. |
