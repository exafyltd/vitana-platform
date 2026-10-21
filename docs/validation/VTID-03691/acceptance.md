# VTID-03691 — Guided-topic narration audio cache + first live Polly audit

Evidence pack for PR #3144.

**Scope note.** This branch carries four VTIDs (03691 narration cache, 03692
cascade wiring, 03695 locale seeding, 03696 VALIDATOR-CHECK). The gate keys the
evidence directory on one, so this pack documents VTID-03691 and cites the
others where their verification overlaps. That one-VTID-per-PR assumption is a
known limitation recorded under VTID-03696, not something this pack works
around silently.

---

AC-1 — Narration audio is cached, so a My Journey tap stops re-synthesizing the whole lesson

`synthesizeGuidedTopicNarrationAudio()` ran on every guided-topic session start
with no cache, re-synthesizing the full ~1,800-char lesson each time. The audio
is deterministic and there are ~2,000 assets (254 topics x 8 languages), so this
was a per-tap bill and a per-tap latency cost.

TEST: `services/gateway/test/services/tts/narration-audio-cache.test.ts` —
"returns null on a miss and the entry on a hit"
TEST: `services/gateway/test/services/tts/guided-topic-narration-audio.test.ts`
Output: `outputs/narration-cache-tests.txt` (32/32 passing)

AC-2 — The cache key includes the ENGINE, so the pending neural→generative flip invalidates cleanly

Generative costs roughly 1.9x neural per character. Flipping the engine without
the engine in the key would serve stale neural audio under a generative
configuration — plausible-sounding and wrong, and invisible.

TEST: `narration-audio-cache.test.ts` — "CHANGES when the engine changes — this
is what makes the neural→generative flip safe"
TEST: `narration-audio-cache.test.ts` — "changes when the lesson text changes,
so a curriculum edit self-invalidates"
Note: mutation-verified by removing `engine` from the hashed field list and
confirming the test fails.

AC-3 — An unrecognised NARRATION_AUDIO_CACHE value resolves to `memory`, never `off`

A typo in a task-def env var must not silently restore per-tap billing. The
resolver treats anything unrecognised as `memory`.

TEST: `narration-audio-cache.test.ts` — "treats an UNRECOGNISED value as memory,
not off — a typo must not silently restore per-tap billing"
TEST: `narration-audio-cache.test.ts` — "defaults to memory when unset"

AC-4 — A partial render is never written to the cache

A transient Polly failure part-way through a chunked lesson must not be frozen
into a permanently truncated asset. Every chunk-failure path bails before the
write.

TEST: `guided-topic-narration-audio.test.ts` — whole-narration-fails-on-any-
chunk-failure
Note: this required a test-isolation fix during development — the memoized store
served one test's render to the next and masked the assertion. Fixed with
`resetNarrationAudioStoreForTests()` in `beforeEach`.

AC-5 — The Polly voice table is verified against the live API, not against documentation

§2c had carried "not verified against the live Polly API" since VTID-03495. It
has now been checked with real `DescribeVoices` + `SynthesizeSpeech` calls in
`eu-central-1`.

CURL: `scripts/tts/verify-polly-voices.ts` (live AWS SDK calls, re-runnable)
Findings recorded in CLAUDE.md §2c: 106 voices / 42 language codes; Serbian
genuinely absent under any spelling (`sr`/`hr`/`bs`/`sh`); Russian is
standard-only in BOTH `Tatyana` and `Maxim`, so it is a product limitation, not
a config gap; six of nine languages support `generative` on the same voice id.

AC-6 — The S3 leg is explicitly NOT accepted

The dependency is new, the bucket does not exist, and the task role has no s3
grant. It is documented as unproven in CLAUDE.md §2c-cache and must not be read
as verified. Acceptance for this VTID covers the `memory` leg only.

TEST: `narration-audio-cache.test.ts` — "falls back to memory AND logs an error
when s3 is selected with no bucket"
TEST: `narration-audio-cache.test.ts` — "returns the s3 store when a bucket is
named" (construction only; no live bucket was exercised)

---

## Verification summary

| Check | Result |
|---|---|
| `test/services/tts/` narration suites | 32/32 passing |
| `test/scripts/validator-path-guard.test.ts` | 31/31 passing |
| `tsc --noEmit` | clean |
| Live Polly `DescribeVoices` / `SynthesizeSpeech` | executed, `eu-central-1` |
| S3 cache leg against a real bucket | **NOT executed — explicitly unaccepted** |

## Known limitations carried forward

- The S3 store has never run against a real bucket (AC-6).
- Narration cache `memory` leg does not survive a deploy or a scale-out. That is
  understood and accepted; it is a cost/latency cache, not a source of truth.
- Engine flip to `generative` is deliberately NOT part of this VTID — cache
  first, then flip, per CLAUDE.md §2c.
