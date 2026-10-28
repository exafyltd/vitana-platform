/**
 * VTID-04813 — a SECOND narrow bridge to Vertex Live, for `ru` only.
 *
 * Owner decision 2026-10-01, in response to a live report: "the Russian
 * voice is also like from a desperate old woman with zero energy" —
 * "replace Tatyana voice with a Google voice like for Serbian".
 *
 * Why Polly cannot fix this. `POLLY_VOICES.ru` is `Tatyana` on the
 * `standard` engine, and that is not a configuration choice:
 * `DescribeVoices(ru-RU)` in `eu-central-1` returns exactly two voices,
 * `Tatyana` and `Maxim`, and BOTH are `standard`-only — Polly has no
 * neural and no generative Russian voice at all (re-measured live
 * 2026-09-29; `services/tts/polly.ts`'s own table comment has said since
 * VTID-03578 that `ru` is "a quality step down from `ru-RU-Wavenet-A`,
 * flagged rather than hidden"). Russian is the only language in that table
 * not on `neural`. So the fix cannot live inside Polly.
 *
 * Why this mirrors Serbian rather than inventing something. Gemini Live
 * speaks Russian natively in one hop — confirmed against Google's own
 * Live API supported-language table (99 languages; `ru` and `sr` both
 * listed, checked 2026-10-01) — and the Serbian bridge that already does
 * exactly this is live in PRODUCTION today
 * (`VERTEX_SERBIAN_BRIDGE_ENABLED=true` is pinned in
 * `AWS-PROD-DEPLOY-GATEWAY.yml`), on the same new, dedicated GCP project
 * and the same Workload Identity Federation credential config. Nothing new
 * has to be provisioned for Russian: the project, the WIF config,
 * `VERTEX_AI_LOCATION` and `GCP_SERVICE_ACCOUNT_JSON` are already there.
 *
 * Why a SEPARATE flag instead of widening the Serbian one.
 * `vertex-serbian-bridge.ts` says, in its own words, that its language
 * predicate must be "never widened to a language list — one language, one
 * narrow bridge, easy to delete outright". This file keeps that promise:
 * Russian gets its own switch and its own `ru`-only predicate, so
 *   - Russian can be turned off without touching Serbian, and vice versa;
 *   - neither predicate ever becomes a list that a future language can be
 *     quietly appended to;
 *   - deleting either bridge stays a one-file, one-flag operation.
 *
 * On CLAUDE.md's "do not promote this bridge past a small canary before
 * the watchdog parity gap is closed" (§2e-vertex-serbian-bridge). That
 * precondition offers two ways out — backport the watchdogs into
 * `VertexLiveClient`, OR "confirm gateway-level timeouts elsewhere already
 * bound it". The second holds, verified in code rather than assumed: the
 * gateway's own session reapers (`cleanupExpiredSessions()` in
 * `session/live-session-controller.ts`, and the `wsClientSessions` sweep in
 * `routes/orb-live.ts`) expire any session idle past `SESSION_TIMEOUT_MS`
 * (30 min) every 5 minutes, and neither one looks at the provider — a
 * Vertex session is bounded by them exactly as a Nova session is.
 *
 * And this is not a promotion past a canary by volume either, measured
 * read-only in production `oasis_events` over the 30 days to 2026-10-01
 * (`greeting_sent` per language): `sr` 136 sessions, `ru` 18. Russian is
 * ~7.5x SMALLER than the language already running on this bridge in
 * production, so enabling it widens exposure by about 13%, not 8x.
 *
 * What this does NOT change, stated so it is not mistaken for a full
 * cutover: only the LIVE VOICE SESSION moves. `POLLY_VOICES.ru` stays
 * exactly as it is, because `resolvePollyVoice('ru')` still serves the
 * non-conversational Russian TTS call sites (the `/orb/tts` route, the
 * reminder pre-render, guided-topic narration). Those do not go through
 * Gemini Live and removing Tatyana would break them.
 */

export function isVertexRussianBridgeEnabled(): boolean {
  return (process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED || '').trim() === 'true';
}

/**
 * True ONLY for `ru` (any region/script suffix, e.g. `ru-RU`, `ru_RU`).
 * Never widened to a language list — see this file's header.
 */
export function isVertexRussianBridgeLanguage(lang: string | null | undefined): boolean {
  const normalized = (lang || '').toLowerCase().split(/[-_]/)[0];
  return normalized === 'ru';
}
