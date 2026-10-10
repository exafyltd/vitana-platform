# Audiobook voices: Google for Russian and Serbian, Polly for the rest (VTID-05026)

Phase 1 of the sparred plan (`docs/validation/VTID-04893/plan-sparring.md`).

AC-1: Audiobook narration reads from its own voice table: en Tiffany, de Vicki, fr Ambre, es Lucia, pt Camila, pl Ola on Polly `generative`; ar Hala, zh Zhiyu, tr Burcu on Polly `neural`; ru and sr on Google Chirp 3 HD Aoede. The receptionist `POLLY_VOICES` is unchanged.
TEST: services/gateway/test/vtid-05026-audiobook-voices.test.ts ("the owner's Polly picks", "both Google voices are pinned")

AC-2: Google is chosen only for ru and only for sr, each behind its own exact-`true` switch (`AUDIOBOOK_GOOGLE_RU_ENABLED`, `AUDIOBOOK_GOOGLE_SR_ENABLED`) and only while the daily cap is set; never for any other language.
TEST: services/gateway/test/vtid-05026-audiobook-voices.test.ts ("provider selection")

AC-3: Google requests carry an explicit voice, MP3, `model_name` only for families that take one; the client always runs on the task-role auth client; text is split into ≤ 4,500 UTF-8 bytes on sentence boundaries and rendered two at a time in order.
TEST: services/gateway/test/vtid-05026-audiobook-voices.test.ts ("byte splitter", "Google request and auth")

AC-4: A Google failure, or the per-task daily cap, answers 422 `narration_unavailable` — never Polly, never another voice. Concurrent plays share one render; provider is part of the cache key.
TEST: services/gateway/test/vtid-05026-audiobook-voices.test.ts ("daily cap", "the renderer")

AC-5: `synthesizePolly` takes an optional `voiceOverride`; every existing caller's request is byte-identical.
TEST: services/gateway/test/vtid-05026-audiobook-voices.test.ts ("Polly voiceOverride")

AC-6: The route reports `X-Audiobook-Voice-Provider`.
TEST: services/gateway/test/vtid-04761-audiobook-audio-route.test.ts

AC-7: `POST /voice/preview` with `google_tts` serves ru/sr only, through the task-role client; Polly `voice` + `engine` overrides; new admin-only `GET /voice/preview/google-voices?lang=ru|sr` lists the female voices.
TEST: services/gateway/test/routes/voice-config.test.ts

AC-8: Tiffany, Ambre and both Google voices are registered as female; the gender test walks the Audiobook table.
TEST: services/gateway/test/vtid-04445-persona-voice-gender.test.ts ("Audiobook narration (VTID-05026)")

AC-9: Staging sets both switches and the cap; production does not (env_overrides at PUBLISH).
TEST: services/gateway/test/vtid-05026-audiobook-voices.test.ts ("staging wiring"), test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Live evidence (2026-10-10, from this Claude Code session)

- Google `voices.list` through the token module: `ru-RU` 10 female voices (4 Chirp 3 HD), `sr-RS` 15 female (14 Chirp 3 HD); both Aoede present.
- Cold render through `synthesizeGoogleNarrationMp3`: ru 2,001 chars (3,651 bytes) in 26.5 s, one chunk, 573 KB MP3; sr 1,539 chars in 10.8 s, 435 KB MP3. The staging spec allows 120 s per request.
- Polly `DescribeVoices` (eu-central-1): Tiffany, Vicki, Ambre, Lucia, Camila, Ola all Female with `generative`.
- Google IAM: task-role binding added on the service account (see plan-sparring.md, decision 4).
- CloudWatch: alarm `vitana-audiobook-google-tts-chars-daily-high` created (2,000,000 chars/day, `vitana-alarms-prod`). The two log metric filters were refused for `claude-code-aws-agent` (no `logs:PutMetricFilter`); run `scripts/aws/setup-audiobook-google-metric.sh --apply` with an identity that has it. Until then the alarm sees no data (`notBreaching`).

## Routes

- Changed: `GET /api/v1/journey/audiobook/topics/:topicId/audio` (adds `X-Audiobook-Voice-Provider`; ru/sr per the switches).
- Changed: `POST /api/v1/voice/preview` (`google_tts` limited to ru/sr; Polly `voice`/`engine`).
- New: `GET /api/v1/voice/preview/google-voices?lang=ru|sr` (exafy_admin, read-only).

ROUTE_MOUNT: services/gateway/src/routes/voice-config.ts, mounted by `mountRouterSync(app, '/api/v1', voiceConfigRouter, { owner: 'voice-config' })` in services/gateway/src/index.ts (unchanged); the new handler is `router.get('/voice/preview/google-voices', requireAuthWithTenant, …)` with an exafy_admin check. services/gateway/src/routes/guided-journey.ts stays mounted at /api/v1/journey (unchanged).

FINAL_URL: /api/v1/voice/preview/google-voices?lang={ru|sr} ; /api/v1/journey/audiobook/topics/{topicId}/audio?lang={locale}

CURL_PROOF: in-process HTTP against the mounted routers (supertest), outputs/tests.txt — "GET /api/v1/voice/preview/google-voices" 401 unauthenticated / 403 non-admin / 400 for any language but ru/sr / 200 female voices with the pinned one; "X-Audiobook-Voice-Provider names who read the episode (google for sr)". STAGING-VERIFY probes the deployed routes: google-voices anonymous → 401, episode anonymous → 401, signed-in per language → provider + narration locale (staging-tests.json).

## OASIS

No new OASIS event (NEVER-rule 10). Cost is tracked from the per-render log line by the CloudWatch metric filter (`scripts/aws/setup-audiobook-google-metric.sh`).
