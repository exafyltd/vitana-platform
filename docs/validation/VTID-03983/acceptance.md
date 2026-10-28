# VTID-03983 — Fish Audio: switch to free-tier model, live-verify voice + PCM sample rate

## Report

VTID-03970 shipped Fish Audio as a Serbian TTS fallback but could never get
a real synthesis call through — every attempt against the API returned
HTTP 402 "Insufficient API credit". The platform owner supplied Fish's own
FAQ: S2.1 Pro has a free tier (`s2.1-pro-free`, no character cap, no
SLA/latency guarantee). `getFishModel()` was defaulting to the paid
`s2.1-pro` the whole time — never a credit problem, a wrong model string.
Switching it and re-testing with the SAME unfunded key produced a real,
audible Serbian synthesis on the first try.

## Acceptance Criteria

AC-1 — `getFishModel()` defaults to `s2.1-pro-free`, not the paid `s2.1-pro`,
closing the root cause of every 402 during VTID-03970's build.

TEST: `outputs/jest-fish-tests.txt` — `test/tts/fish-provider.test.ts`
"sends the reviewed reference_id, bearer key, and explicit model header"
now asserts `s2.1-pro-free`.

AC-2 — A real Fish Audio synthesis call succeeded, for the first time in
this integration's history — HTTP 200, real audio bytes, not an error body.

CURL: `commands.log` — `POST /v1/tts` with `model: s2.1-pro-free`,
`HTTP_STATUS:200`, `outputs/live-synthesis-sr-free-tier.mp3` (29,256 bytes,
confirmed via `file` as valid MPEG layer III 128kbps/44.1kHz audio — sent
directly to the platform owner as evidence, not just described).

AC-3 — The `FISH_PCM_SAMPLE_RATE_HZ=16_000` assumption (documented as
"requested but never confirmed" since VTID-03970) is now confirmed: a
parallel `pcm` request for the identical text produced a byte count whose
implied duration at 16kHz matches the mp3's own duration almost exactly.

CURL: `commands.log` — the `format:'pcm', sample_rate:16000` request.
TEST: `outputs/live-synthesis-pcm-duration-check.txt` — 1.81s (16kHz) vs
1.83s (mp3) vs 0.66s (44.1kHz, ruled out).

AC-4 — The curated Serbian voice is re-verified clean against the live
API, not just trusted from VTID-03970's original check: no adult-content
tags, not DMCA'd. One new, non-blocking finding recorded honestly: the
voice's own `languages` metadata field says `["hr"]` (Croatian), not `sr`,
despite title/tags/description all being explicitly Serbian — a real
synthesis with Serbian text still produced correct output regardless.

CURL: `commands.log` — `GET /model/2ad62aaf885e4a14add09fe4a38ffd23`,
`outputs/milica-voice-metadata-recheck.json`.

AC-5 — `scripts/tts/verify-fish-voice.ts` had a genuine pre-existing
TypeScript strictness bug (`meta` from `.json()` was untyped `unknown`,
three TS18046 errors) that could never have been caught before this
VTID — the script could never get past the 402 to reach that code. Fixed
with an explicit response type; script's own model default also updated
to `s2.1-pro-free`.

TEST: `outputs/tsc-noemit.txt` — clean after the fix (was failing before,
reproduced and confirmed via a real `npx ts-node` compile error first).

AC-6 — Zero regressions: the full affected test suite and a full gateway
suite re-run both pass.

TEST: `outputs/jest-fish-tests.txt` (19/19, 2 suites) and
`outputs/jest-full-suite.txt` (full gateway suite). `outputs/npm-build.txt`
clean.

## Not yet done (flagged, not silently skipped)

`FISH_API_KEY` still does not exist in AWS Secrets Manager and is not
wired into any ECS task definition — this VTID proves a correctly
configured deployment would actually work, it does not provision one.
Once the secret is provisioned and `TTS_FISH_FALLBACK_ENABLED=true` is
set, the Command Hub's Providers & Voice Preview button (VTID-03970) and
the live ORB cascade path both become real with no further code change.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change fixes a model-string default and updates documentation; it emits
no new OASIS events and does not alter any existing `oasis_events`
emission path.
