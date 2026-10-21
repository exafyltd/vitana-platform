# VTID-03986 — Cascade voice: stop full-duplex mic audio from backing up Transcribe

## Report

Reported live by the platform owner: after VTID-03985/VTID-03984 got real
Serbian cascade audio working on staging, the next round of testing showed
"major latency issues." Pulled the full `oasis_events` trace for the
reported session (`live-a99f8633-606e-4504-8c75-32b9f9cc512a`) and
confirmed a clean, escalating per-turn pattern: **8.7s -> 16.6s -> 35s ->
43s**, with both the transcription step and the reply-generation step
individually growing each turn — not a one-off slow call.

## Root cause

Two independent, pre-existing pieces interact badly:

1. **VTID-03706's full-duplex mode** (`ORB_FULL_DUPLEX_ENABLED`, staging
   only) forwards a continuous audio frame for the *entire* session — real
   speech above the echo floor, digital silence below it — for the entire
   time the client mic is open, including while Vitana is speaking. It was
   built for Nova Sonic's own native VAD/turn-detection and barge-in
   (`contentEnd.stopReason:"INTERRUPTED"`), which genuinely needs a
   continuous stream to work.
2. **`TranscribeStreamSession`** (`cascaded/transcribe-stream.ts`) is ONE
   continuous, ordered, never-restarted Amazon Transcribe streaming session
   per ORB session. It is a real-time, ordered pipe: audio submitted earlier
   must be processed before audio submitted later can produce a result.

`CascadedLiveClient.sendAudioChunk()` forwarded every full-duplex frame
into Transcribe unconditionally — with no awareness that (a) the cascade
has no barge-in at all (documented in this file's own header: "no
barge-in mid-generation") and (b) forwarding audio while Vitana's own
reply is being generated or played back adds nothing but backlog. Every
reply's own duration therefore queued *ahead* of the next real user
utterance in Transcribe's single ordered stream, and Transcribe had to work
through all of it, in real time, before it could transcribe anything new —
compounding turn over turn exactly as measured (each reply is itself
longer than the last, since the model now has more context to respond to,
so each turn's backlog tax grows too).

## Fix

`CascadedLiveClient.sendAudioChunk()` (`cascaded-live-client.ts`) now drops
— rather than forwards — incoming mic audio while `turnInFlight` is true
(LLM + TTS generation) or while `Date.now() < busyUntilMs` (the just-emitted
reply's estimated client-side playback window). `busyUntilMs` is set inside
`emitAudio()` from the synthesized PCM buffer's byte length (16-bit mono @
16kHz -> `bytes / 32` ms) plus a fixed `PLAYBACK_MARGIN_MS` (400ms) covering
network delivery + client buffering/decode. The client already silences
non-speech frames below the echo floor (VTID-03706), so nothing meaningful
is lost by dropping them here too; the cascade has no barge-in to preserve.

`sendAudioChunk()` still returns `true` while dropping (the client is
`open` and functioning — this is an intentional no-op, not backpressure,
per `UpstreamLiveClient`'s documented contract that `false` specifically
means "not open").

## Acceptance Criteria

AC-1 — before any turn has ever run, mic audio is forwarded to Transcribe
normally.

TEST: `test/orb/live/upstream/cascaded-live-client-audio-gating.test.ts`
— "forwards audio normally before any turn has ever run".

AC-2 — while a turn is generating (`turnInFlight`), mic audio is dropped
(not forwarded), `sendAudioChunk()` still returns `true`, and once the
reply is emitted, audio stays dropped through its estimated playback
window and only resumes forwarding after that window elapses.

TEST: same file — "drops mic audio while a turn is generating
(turnInFlight), then resumes once the reply finishes playing".

AC-3 — a turn that fails before any audio is ever synthesized does not
extend the busy window — audio resumes immediately once `turnInFlight`
clears.

TEST: same file — "does not extend the busy window when the turn errors
before any audio is emitted".

AC-4 — the busy window scales with the actual reply length, not a fixed
duration — a short reply gates for a correspondingly short time.

TEST: same file — "a short reply gates for a correspondingly short window,
not a fixed long one".

AC-5 — the pre-existing `!open -> false` contract (distinct from the new
busy-but-open `-> true` case) is unchanged.

TEST: same file — "still returns false (not true) when the client is not
open at all".

## Verification

TEST: `outputs/tsc-noemit.txt` — `tsc --noEmit`, clean (exit 0).

TEST: `outputs/jest-cascaded-suites.txt` — all cascaded-* suites (including
the pre-existing ones, unmodified) re-run together: 39/39 passing plus the
5 new tests, 0 regressions.

TEST: `outputs/npm-build.txt` — `npm run build`, clean (exit 0).

TEST: `outputs/jest-full-suite.txt` — full gateway suite re-run: 933/934
suites (1 pre-existing skip), 15,281/15,316 tests passing, 0 failures.

## Not yet independently confirmed

This fix has not yet been observed against a fresh live session. The next
real signal is the reporting user's next cascade-eligible (`sr` or any
Nova-unsupported language) voice session showing flat, non-escalating
per-turn latency instead of the measured 8.7s -> 16.6s -> 35s -> 43s
pattern.

The cascade's other reported issue from the same round — "pre login it
didn't work" (`cascade_tts_failed`, suspected Fish Audio timeout/reliability
on the first-ever call) — is a separate, not-yet-root-caused defect and is
explicitly out of scope for this VTID.

OASIS_PROOF: `oasis_events`, topic `orb.live.diag`, session
`live-a99f8633-606e-4504-8c75-32b9f9cc512a` carries the pre-fix baseline
(8.7s/16.6s/35s/43s per-turn latency). Confirm the next cascade session
shows flat per-turn latency instead of this escalating pattern.
