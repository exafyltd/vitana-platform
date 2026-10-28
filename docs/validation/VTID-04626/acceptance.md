# VTID-04626 — Voice Self-Healing screen and pipeline rebuild

Owner report (2026-09-26): `/command-hub/voice/self-healing/` "is a mess and none of it works".

## What was actually broken (read from the live project before any change)

| # | Symptom on the screen | Root cause |
|---|---|---|
| 1 | `MODE: ...` forever; no per-class table, no session monitor | `/healing/mode`, `/healing/summary`, `/healing/live-monitor` were fetched **without the Authorization header**; the router is behind `requireAuth`, so all three returned 401 and the panel rendered nothing. |
| 2 | 17 of 41 "open reports" read `? ? confidence` | They are `v1-stub` rows: the investigator failed on every spawn since at least 2026-09-01. It called Bedrock directly with the task def's `BEDROCK_MODEL_ID` (`eu.anthropic.claude-opus-4-7`, **not available for this account**; since 09-22 `Operation not allowed`). The stub reason was a blanket `claude_no_response`. |
| 3 | The 24 real open reports recommend "instrument Gemini Live" | The investigator prompt described the pipeline as "Vertex AI Gemini Live + Cloud TTS" — decommissioned 2026-08-16. 19 of the 24 target code that no longer runs voice. |
| 4 | Every detection counted twice | One conversation stops through two hooks (`ws-…` and `live-…` ids) with identical metrics; pairs on 09-16 and 09-22 each wrote two history rows and spawned two investigators. |
| 5 | Lesson sessions flagged as failures | `low_turn_progression` fired on long, few-turn sessions where Vitana did most of the talking (e.g. 177 in / 503 out / 1 turn / 64 s) — guided lessons working as intended. |
| 6 | Accept & Execute "did nothing" | It allocated one VTID per step at `status='scheduled'`, `metadata.source='voice-investigator-execute'`. Nothing claims such rows (VTID-03516 allowlist): 0 executions since 2026-05-30. |
| 7 | Mode flips shown as failures; placeholder `VTID-VOICE-HEALING` typed into a browser prompt | Mode flips emitted `voice.healing.dispatched`; mutating routes were open to any signed-in user. |

## Change

- **Investigator** runs on the `triage` routing stage via `callViaRouter` (policy model + fallback + `llm.call.*` telemetry), records provider/model on each report (`report._llm`) and the real failure category (`llm_call_failed` / `llm_json_parse_failed` / `llm_threw`). Prompt describes the current pipeline (Nova Sonic, Transcribe→Bedrock→Polly/Fish cascade, Serbian-only Vertex bridge).
- **Adapter**: one conversation → one quality report (metrics fingerprint, 2-minute window); a quality failure on an error-free session is logged as such, not as `classifier_no_error`.
- **Classifier**: `low_turn_progression` only when the model produced less audio than the user was heard.
- **Accept** hands the report to the Dev Autopilot on-ramp as ONE open-ended agent execution (held at `awaiting_approval` where `OPERATOR_PR_APPROVAL_REQUIRED=true`, i.e. staging and prod); the execution ref is stored on the report. Legacy ledger progress still readable.
- **New routes**: `GET /healing/overview`, `POST /healing/reports/:id/retry`, `POST /healing/reports/dismiss`. Execute, retry, dismiss, mode, PATCH report, investigate and quarantine release are `requireExafyAdmin`; the actor is the signed-in identity.
- **New events**: `voice.healing.mode.changed`, `voice.healing.report.accepted`, `voice.healing.report.dismissed`.
- **Screen** rebuilt in `voice-self-healing.js` / `.css` (class-only, CSP-clean): mode control, alerts, four-stage loop health (Detect → Investigate → Quarantine → Execute) with the real last error, reports split into Needs decision / Failed investigations / Decided, old-pipeline flag + bulk dismiss, retry, quarantine release, detections, per-class table, live sessions, report drawer. ~840 lines of the old inline-styled panel removed from `app.js`.

## Acceptance criteria

AC-1 Every screen request carries the login token; the page loads from one authenticated overview read.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "every screen request carries the login token"

AC-2 The investigator calls the `triage` routing stage with fallback allowed, never the pinned Bedrock client, and describes the current pipeline.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "calls callViaRouter(\"triage\") …", "the investigator no longer imports the pinned Bedrock client"

AC-3 A failed investigation stores the real error category and detail.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "a failed call writes a stub with the real category and error …"

AC-4 One conversation produces one quality report.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "the ws-… and live-… stop hooks of the same conversation collapse to one"

AC-5 A lesson-shaped session (model spoke more than the user) is not a low-turn failure.
TEST: services/gateway/test/voice-failure-taxonomy.test.ts — "VTID-04626: long session, few turns, model did most of the talking (a lesson) → null"

AC-6 Accept queues exactly one open-ended Dev Autopilot execution, records it on the report, and never writes the old scheduled ledger rows; failed stubs and decided reports are refused.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "Accept → Dev Autopilot" block

AC-7 Failed investigations and old-pipeline reports are shown as such, not as "? ?" reports; alerts name the failing writer.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "overview helpers" block
UI: outputs/desktop-top.png, outputs/alerts.png, outputs/failed-tab.png, outputs/decided-tab.png, outputs/mobile-top.png, outputs/mobile-drawer.png (local harness fed with the live report rows, 1400×900 and 390×844, 0 px horizontal overflow)

AC-8 Every mutating healing route is exafy_admin only.
TEST: services/gateway/test/vtid-04626-voice-self-healing.test.ts — "mutating route is exafy_admin only"

## Route evidence

ROUTE_MOUNT: `mountRouterSync(app, '/api/v1/voice-lab', voiceLabRouter)` (services/gateway/src/index.ts:919); new handlers `router.get('/healing/overview')`, `router.post('/healing/reports/:id/retry')`, `router.post('/healing/reports/dismiss')` in services/gateway/src/routes/voice-lab.ts, after `router.use(requireAuth)`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/voice-lab/healing/overview
CURL_PROOF: pre-deploy, staging `bf985e64` — `curl https://preview-aws-gateway.vitanaland.com/api/v1/voice-lab/healing/mode` → `401 application/json {"ok":false,"error":"UNAUTHENTICATED",…}` (router mounted, JSON not an HTML 404). The new routes are not live until this merges; the post-deploy check is an authenticated `GET …/healing/overview` returning `{"ok":true,…}`.

## OASIS

OASIS_PROOF: `voice.healing.report.accepted` (on accept, vtid = the execution's VTID) and `voice.healing.report.dismissed` are asserted in the test; `voice.healing.mode.changed` replaces the mode-flip use of `voice.healing.dispatched` (asserted in "mode flips no longer masquerade as detections"). Types added to `src/types/cicd.ts`. After the impact scan: `voice.healing.report.decided` (report PATCH), `voice.healing.quarantine.released` (quarantine release) and a `status:error` `voice.healing.investigation.completed` for a failed investigation, all asserted in the test.

## Not verified

- No live run: staging has not served this code yet. The first real signals after merge are (1) a Retry on a failed investigation producing a `v1` report with `_llm.stage = "triage"`, (2) an Accept producing a Dev Autopilot execution held at `awaiting_approval`.
- The triage stage's live model (policy v17: Bedrock Sonnet 4.6 primary) is what now writes reports; if Bedrock is blocked on the account (the 09-22 `Operation not allowed`), the stage's DeepSeek fallback serves instead — visible in `_llm.fallback_used`.
- Existing data was **not** changed: the 17 failed stubs and the 19 old-pipeline reports are still open. Dismissing them is one button each on the rebuilt screen, and is the owner's call.
