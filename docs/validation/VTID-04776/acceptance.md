# VTID-04776 — Voice Supervisor (with VTID-04777, VTID-04778, VTID-04779, VTID-04780)

Owner request 2026-10-01: reorganise the Command Hub Voice section so a
supervisor can tell whether a voice problem is system-wide or specific to a
tenant, user role / assistant, provider or language, and see whether a
self-healing fix actually improved things. Companion change:
exafyltd/vitana-v1 VTID-04781 (the ORB declares surface + view_role after
login/logout too).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `voice_session_facts` holds one row per voice session (tenant, surface, role, persona, lang, provider + selection reason, transport, ttfa, turns, audio in/out, close reason/code, failure class, outcome); RLS on, service role only; applied to the VITANA project and backfilled 7 days.
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
  UI: docs/validation/VTID-04776/outputs/migration-applied.txt
AC-2: The writer is fire-and-forget (never throws into the voice path, logs every failure, kill switch `VOICE_SESSION_FACTS_ENABLED=false`) and is wired at start, profile/provider resolution, first audio and all six stop paths; stop events carry surface/role/lang/provider/reason/close_code.
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
AC-3: The LiveKit token route resolves the assistant from the declared surface/view_role — the device never decides (CLAUDE.md 42g) — emits `orb.livekit.session.minted` and records the facts row.
  TEST: services/gateway/test/routes/orb-livekit.test.ts
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
AC-4: Healing verdicts record `recurrence_after_fix_ms` and `tenant_scope`.
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
AC-5: voice-lab live-session and healing reads require exafy_admin (previously any signed-in user saw every tenant's sessions).
  TEST: services/gateway/test/vtid-04780-voice-supervisor-auth.test.ts
AC-6: `/api/v1/voice/supervisor/overview` answers healthy / system_wide / segment_specific / insufficient_data from per-segment rates with a minimum sample; a session with no recorded end is a telemetry gap (`no_end`), excluded from quality rates and reported as `end_recorded_rate`.
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
AC-7: `/segments` builds the tenant x assistant matrix (any two dimensions) and the `assistant` filter maps each column to its surface, so a clicked cell opens exactly its sessions.
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
AC-8 (VTID-04778): `/fixes/:id/impact` compares the fix's segment N days before vs after and returns improved / no_change / regressed / insufficient_data.
  TEST: services/gateway/test/vtid-04776-voice-supervisor.test.ts
AC-9 (VTID-04780): a platform admin sees every tenant; a tenant admin is forced to their own tenant whatever the query says; anyone else 403; no token 401.
  TEST: services/gateway/test/vtid-04780-voice-supervisor-auth.test.ts
AC-10 (VTID-04777/04778/04779): the Voice section is Overview, Tenants & Roles, Sessions, Issues & Healing (Action Queue / Self-Healing Pipeline / Fix Impact), Test Bench (LiveKit | Nova Sonic + voice test suite), Providers & Config; Test Contracts lives in Testing & QA; every old path redirects; LiveKit Run Diagnostics is read-only.
  TEST: services/gateway/test/command-hub/vtid-04779-voice-section-rebuild.test.ts
  UI: Playwright screenshots of each tab at 1400x900 and 390x844 (API mocked), reviewed in-session

## Scope

SCOPE_ALLOWLIST:
- supabase/migrations/20261001120000_vtid_04776_voice_session_facts.sql, DATABASE_SCHEMA.md
- services/gateway/src/services/voice-session-facts.ts, voice-supervisor-analysis.ts, voice-supervisor-data.ts
- services/gateway/src/routes/voice-supervisor.ts (new), orb-live.ts, orb-livekit.ts, voice-lab.ts, oasis-emit.ts, index.ts
- services/gateway/src/orb/live/session/live-session-controller.ts, src/orb/developer/domain-atlas.ts, src/types/cicd.ts
- services/gateway/src/services/voice-recurrence-sentinel.ts, voice-self-healing-adapter.ts, self-healing-reconciler.ts
- services/gateway/src/frontend/command-hub/** (app.js, index.html, navigation-config.js, styles.css, voice-supervisor.{js,css})
- scripts/ci/command-hub-ownership-guard.js (allowlist entry), services/gateway/specs/*.json
- services/gateway/test/** (new suites + the intentional VTID-04542 snapshot update)
- docs/validation/VTID-04776..04780/**

## Route mount

ROUTE_MOUNT: services/gateway/src/index.ts — `mountRouterSync(app, '/api/v1/voice/supervisor', voiceSupervisorRouter, { owner: 'voice-supervisor' })`
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/voice/supervisor/overview (also /meta, /segments, /sessions, /fixes, /fixes/:id/impact)
CURL_PROOF: unauthenticated GETs answer `401 application/json` with `{ok:false}` (docs/validation/VTID-04776/staging-tests.json); authenticated reads are proven by the CI suites (staging probes are read-only and anonymous).

## OASIS

OASIS_PROOF: new topic `orb.livekit.session.minted` (tenant, surface, role, lang) registered in `src/types/cicd.ts`; `vtid.live.session.stop` payloads gain surface/role/lang/provider/reason/close_code; `orb.upstream.provider.selected` gains tenant_id/user_id/lang; `vtid.live.session.start` carries the declared profile role. Asserted in test/vtid-04776-voice-supervisor.test.ts and test/routes/orb-livekit.test.ts.
