# VTID-03740 — Pre-login Intro ORB stuck showing "speaking" while silent

Reported live: tapping the ORB on the pre-login MAXINA Intro screen shows
the "speaking" caption ("Vitana priča..." — Serbian) and the amber glow,
but no audio actually plays, and the session never recovers.

## Root cause

`.vtorb-status`/the orb glow are set to "speaking" the moment the FIRST
audio chunk arrives from the server (`case 'audio': case 'audio_out':`),
before playback or turn completion. The only code path that resets the
visible state back to "listening" is `_waitForAudioEnd()`, which only runs
inside the `case 'turn_complete':` handler — i.e. only after the SERVER
sends `turn_complete`.

If the upstream Nova stream delivers at least one audio chunk and then
dies before completing the turn, the server never sends `turn_complete`,
so `_waitForAudioEnd()` never runs, and the UI is stuck showing "speaking"
forever. The existing `_speakingStateWatchdog()` (DEV-COMHU-0501) already
correctly *detects* this exact condition (quiet for >=2s, nothing
scheduled, queue empty) but only ever cleared the internal `audioPlaying`
flag — it never touched `.vtorb-status`, the orb glow, `voiceState`, or
the mic, so detecting the stall didn't actually fix anything visible.

This is a general, language-agnostic client bug — not Serbian-specific —
but Serbian is disproportionately likely to trigger the underlying
Nova-stream-dies-mid-turn precondition here: Serbian has no native Nova
language support (forced through anyway, since Polly has no Serbian voice
in any engine — see CLAUDE.md §2c), and the anonymous MAXINA Intro turn is
an unusually long (~45s) forced-live-translation speech, the same shape
that has tripped Nova's `nova_validation` content-filter/stream-stability
issues in prior incidents (VTID-03650/03665/03674).

## Fix

`_speakingStateWatchdog()` — when it fires while `voiceState === 'SPEAKING'`
(the exact stuck-caption case) and the session is still genuinely active
(not closing for nav, not user-closed, overlay visible) — now also:
- Resets `voiceState` to `LISTENING` and repaints the caption/orb glow to
  match (skipped only when the VTID-03469 audio-blocked tap-to-hear prompt
  is showing, same guard that prompt already uses elsewhere).
- Re-arms the mic exactly once, gated on `!greetingComplete` — mirroring
  the existing invariant that `_startAudioCapture()` is called exactly
  once per session (on first-turn completion; stays open afterward under
  full duplex).
- Deliberately does NOT invoke the host's turn-completion callback — this
  turn never genuinely completed, and reporting it as complete would
  reproduce the VTID-03685 bug where a guided-topic "completed" drawer
  appeared for a lesson that was never actually delivered.

Scope: this fixes the client-side dead-end (stuck UI, dead mic) regardless
of *why* Nova's stream died. It does not address the underlying Nova
stream-stability question for the anonymous+Serbian long-translation case
— that needs live `oasis_events` confirmation this session has no
Supabase access to pull, and is a separate, harder investigation (flagged,
not silently dropped).

---

AC-1 — the watchdog resets the VISIBLE state (voiceState, orb glow,
caption) back to listening when it fires while stuck showing "speaking",
not just the internal audioPlaying flag

TEST: `services/gateway/test/frontend/orb-widget-stuck-speaking-recovery.test.ts`
— "resets the visible voiceState/orb/caption back to listening when the
watchdog fires while stuck in SPEAKING"
Output: outputs/targeted-tests.txt

AC-2 — the recovery is guarded the same way the normal turn-complete path
is (session active, not mid-navigation-close, not user-closed, overlay
still visible) so it can't fire during teardown or after the user already
closed the overlay

TEST: `orb-widget-stuck-speaking-recovery.test.ts` — "guards the recovery
on session-active / not-closing-for-nav / not-user-closed /
overlay-visible, matching the normal turn-complete path"
Output: outputs/targeted-tests.txt

AC-3 — the mic is re-armed exactly once (gated on !greetingComplete),
matching the existing single-start invariant, and the VTID-03469
tap-to-hear prompt is never overwritten when audio is blocked

TEST: `orb-widget-stuck-speaking-recovery.test.ts` — "re-arms the mic
exactly once..." and "does not overwrite the tap-to-hear prompt..."
Output: outputs/targeted-tests.txt

AC-4 — the recovery never reports this turn as genuinely completed to the
host app (would reproduce the VTID-03685 "completed drawer for
undelivered content" bug)

TEST: `orb-widget-stuck-speaking-recovery.test.ts` — "never fires
_cfg.onTurnComplete..."
Output: outputs/targeted-tests.txt

AC-5 — no regression to the pre-existing DEV-COMHU-0501 watchdog behavior
(internal flag clearing, mic-button UI refresh) or to the full gateway
suite / type-checking

TEST: `orb-widget-speaking-watchdog.test.ts` (existing suite, re-run
unmodified — still 5/5 passing)
TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
