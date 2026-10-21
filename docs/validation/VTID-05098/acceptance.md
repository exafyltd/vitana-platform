# VTID-05098 — Loop Engineering Phase 2: Simplify (retire duplicate and dead checks)

Owner approval 2026-10-12 ("Yes" at Gate 1). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED). Parent: VTID-05084. Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §5.

Problem: Phase 1 listed ten overlaps between Testing & QA, Routines, Health Checks and Autonomy Pulse. Research showed six real duplicates, two partial, two not duplicates at all; that no routine produced a signal (every routine had a dead April-generation trigger and a failing September-generation trigger); and that two Pulse actions never worked.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no route added. Two routes removed from `routes/routine-audits.ts` (`GET /api/v1/routines/audits/push-pipeline`, `GET /api/v1/routines/audits/migration-backlog`); the router stays mounted at `/` in services/gateway/src/index.ts.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/command-hub/diagnostics/health-checks/ (and /command-hub/infrastructure/health/ redirecting there)

OASIS_PROOF: none — no event topic added or changed.

CURL_PROOF: `GET /api/v1/routines/audits/migration-backlog` → 404; `GET /api/v1/routines/audits/oasis-summary` → 503 JSON `ROUTINE_INGEST_TOKEN env var not configured` on staging, which has no routine token (staging-tests.json).

## Acceptance criteria

AC-1: The five retired routines (`orb-audio-smoke`, `push-pipeline-probe`, `migration-backlog`, `cloud-run-frontend-health`, `self-healing-triage`) are gone from `routines/` and from every loop's owned sensors; the coverage rule still holds.
  TEST: services/gateway/test/loop-catalog.test.ts
AC-2: A data-only, idempotent migration marks their `routines` rows disabled and annotated; it never deletes (run history kept).
  TEST: services/gateway/test/loop-catalog.test.ts
AC-3: `/routines/audits/push-pipeline` and `/routines/audits/migration-backlog` answer 404; every remaining audit endpoint still answers 401 without the routine token and 503 when the gateway has no token configured.
  TEST: services/gateway/test/routine-audits.test.ts
  CURL: GET /api/v1/routines/audits/migration-backlog → 404 on staging; GET /api/v1/routines/audits/oasis-summary → 503 token-gate JSON on staging
AC-4: Infrastructure → Health is removed and redirects to Diagnostics → Health Checks, which still probes its same 5 endpoints; its render function is removed; Infrastructure → Services is untouched; the legacy voice id DEVHUB.INFRA.HEALTH still opens (alias on Diagnostics → Health Checks).
  TEST: services/gateway/test/command-hub/vtid-05098-simplify.test.ts
  TEST: services/gateway/test/navigation/vtid-04814-command-hub-navigation.test.ts
  UI: https://preview-aws-gateway.vitanaland.com/command-hub/infrastructure/health/
AC-5: Autonomy Pulse offers only `investigate` (labelled Open) for self-healing and test-contract items; no Pulse code path posts to the self-healing approve/reject routes; the self-healing tab still acts with `{id, operator}`.
  TEST: services/gateway/test/autonomy-pulse.test.ts
  TEST: services/gateway/test/command-hub/vtid-05098-simplify.test.ts
AC-6: Every overlap in the loop catalog has a valid status and a resolution; the catalog validator rejects an unknown status or a closed overlap without a resolution; the Loops screen shows the status badge and resolution.
  TEST: services/gateway/test/loop-catalog.test.ts
  TEST: services/gateway/test/command-hub/vtid-05098-simplify.test.ts
AC-7: The September-generation triggers of the five retired routines are disabled (verified enabled=false in the update_trigger response).
  TEST: docs/validation/VTID-05098/acceptance.md (trigger table below)

## Triggers

Disabled by this session (claude.ai routines, `update_trigger enabled=false`, each response read back `enabled: false`, 2026-10-12 18:08–18:11 UTC):

| Trigger | Routine | Generation |
|---|---|---|
| trig_01RKEeqh83Ek9xfZ35zTdhWa | orb-audio-smoke | September (gateway.vitanaland.com) |
| trig_01VfrW1YpdcrDbCXM6KUA4fG | cloud-run-frontend-health | September |
| trig_01LEeMZXGvihR9XgNLt6NSBL | push-pipeline-probe | September |
| trig_01DnkSC1TcZBtH39e12WyCMg | migration-backlog | September |
| trig_01QoGMxgMNSYYvduYMybYyps | self-healing-triage | September |

**Owner action needed — could not be disabled by an agent.** The April-generation triggers post to the deleted Cloud Run gateway (`gateway-q74ibpv6ia-uc.a.run.app`) and were created through the HTTP API; the platform lets an agent change only triggers an agent created ("Agents can only update routines they created … The user can edit it themselves at https://claude.ai/code/routines/<id>"). They do no harm (they post into nothing), but they report false "succeeded" runs. Disable at https://claude.ai/code/routines/<id>:

| Trigger | Routine |
|---|---|
| trig_01TS53Lb7QjjMBePGYfNdRSa | self-healing-triage |
| trig_01UX6rVFSVAzaaZK8JZyPBeL | voice-lab-triage |
| trig_01WuiDqjcb6BvmgYBXPSQmAg | draft-pr-babysitter |
| trig_014ojanxxkScK5HdKv4hDQoi | agents-heartbeat |
| trig_01EXTCEfa1L1nYCxcxu5JcyZ | supabase-io-audit |
| trig_018KrNqmSksaEhCCk9GvmfWU | "⚡ dev-autopilot" (runs autopilot-rec-quality) |
| trig_01Gq5qJBLkMnQqFxJTt5isVY | oasis-event-anomaly |
| trig_017v1feuKcBUZoVxr69gkfp6 | vitana-index-health |
| trig_01PVaLdg5rnNmm3wDHR7RjWi | orb-audio-smoke |
| trig_01AyPwuunSSpZ2MW5zXa35NM | cloud-run-frontend-health |
| trig_01AKm8h5Df9apVQUwoMQH6rt | knowledge-docs-freshness |
| trig_01GtodBPFZpr568K95ZQYLM8 | push-pipeline-probe |
| trig_01FcCyEVLKF3CCKW4oY7aURp | migration-backlog |
| trig_01EuiDskHMkm7CgoiNb8Ra57 | dyk-tour-progress |
| trig_01JsJJH6sxNKri3h1rACMUhi | spec-memory-quarantine |

**Security (owner action):** both trigger generations carry the routine ingest token in plain text in the prompt (two different values). Rotate it and keep it out of prompts. The token value is deliberately not reproduced here.

## Decisions taken
- **One Health tab, literal de-duplication** (sparring F1): Diagnostics → Health Checks unchanged; the 117-check registry stays in the header pill.
- **Pulse links instead of fixing the broken buttons** (sparring F4, rejected on purpose): one place to act; the two surfaces filter the self-healing queue differently.
- **Legacy voice id kept as an alias.** `DEVHUB.INFRA.HEALTH` is one of the 67 frozen ids that must keep opening (vtid-04814 test); it is now an alias on the Diagnostics → Health Checks entry instead of a separate entry.
- **Dead CSS left in place.** `.infra-health-container` is part of a shared selector in `styles.css`; `styles.css` content is not changed (only its `?v=` follows app.js).
- **No new nav vectors needed.** The embeddings rebuild dropped the six texts of the removed entry and embedded nothing new (no Bedrock call).
- **The 404 staging probe does not check content type** — the gateway has no JSON 404 handler, so an unknown path answers Express's HTML 404; the status alone proves the route is gone.
- **April-generation triggers left for the owner** (see above) — the platform refuses agent updates to them.
- **Staging probe of a remaining audit route expects 503, not 401** (fix-forward after STAGING-VERIFY run 38297710254). Staging has no `ROUTINE_INGEST_TOKEN`, so the token gate fails closed with 503 and its JSON error. The probe pins that exact body, so it still fails if the route is removed (404) or opened (200). The 401 path is covered in CI by `routine-audits.test.ts`.
