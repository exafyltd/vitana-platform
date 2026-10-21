# VTID-03987 — Formalize the cascade's TTS-backend boundary (Polly vs Fish)

## Report

After VTID-03986 (cascade voice latency fix) merged, the platform owner
raised a scope concern: "you should not touch the solution for AWS
Nova2Sonic and Polly we have in place — everything you edit is only
allowed for FISH Audio," and separately clarified "Nova2Sonic is voice to
voice, but Polly is TTS and they behave differently. FISH audio is also
TTS and belongs to setup for TTS. There must be a separation to avoid
misbehaving," specifically flagging the risk of damaging mid-sentence
interrupt/barge-in. Asked for research and a plan before any further code
change.

## Research findings

1. **Nova Sonic and the cascade are structurally isolated, not just by
   convention.** `upstream-client-factory.ts`'s `createUpstreamClient()` is
   a `switch` on provider name: `'nova_sonic'` constructs
   `NovaSonicLiveClient`, `'cascaded'` constructs `CascadedLiveClient`. A
   session gets exactly one. Nothing under
   `orb/live/upstream/cascaded/` or in `cascaded-live-client.ts` is
   reachable from a Nova Sonic session.
2. **Barge-in lives entirely outside the cascade.** Nova's interrupt fires
   from `nova-sonic-live-client.ts` (`this.interruptedHandler?.({})` off
   Nova's own `contentEnd.stopReason:"INTERRUPTED"`) and is backed by
   `full-duplex-gate.ts` (VTID-03706). Grepping `cascaded-live-client.ts`
   confirms `interruptedHandler` is declared and assigned but never
   invoked — the cascade's own file header has said "no barge-in
   mid-generation" since VTID-03683, well before any Fish work. VTID-03986
   could not have damaged Nova's barge-in because it is unreachable from
   the file that fix touched.
3. **What WAS a legitimate concern:** Polly and Fish are two
   interchangeable TTS backends plugged into the SAME `CascadedLiveClient`,
   which also owns Transcribe (STT) and the turn/silence-gating state
   machine. `ru`/`pl`/`tr`/`zh`/`ar` are cascade-eligible via Polly today
   (live in production, staging confirmed `ORB_CASCADED_VOICE_ENABLED=
   true`); `sr` is cascade-eligible only via Fish (opt-in). VTID-03986's
   latency fix touched `sendAudioChunk()`/`emitAudio()` — the STT/turn-
   gating layer, which runs identically for every cascade language. Its own
   regression tests already used `lang: 'ru'` (Polly-backed), not Fish, so
   the fix was in fact validated against the Polly path — but the PR body
   read as Fish-scoped without saying so plainly.

## Fix

Extracted TTS backend SELECTION (previously inline in `runTurn()`) into a
new module, `orb/live/upstream/cascaded/tts-backend.ts`:

- `pollyBackend`/`fishBackend` — each a `{ name, synthesize(text, lang) }`
  object, independently swappable.
- `synthesizeCascadeReply(text, lang)` — the Polly-first, Fish-fallback-
  only-when-Polly-has-no-voice-at-all selection order, a byte-for-byte
  extraction of what `CascadedLiveClient.runTurn()` ran inline before this
  change (VTID-03970's original gate). Zero behavior change.

`cascaded-live-client.ts` now calls `synthesizeCascadeReply()` instead of
inlining the two `synthesizePolly`/`synthesizeFish` calls; the
`synthesizePolly`/`resolvePollyVoice`/`synthesizeFish` imports move to the
new module.

**Rule documented (CLAUDE.md §2c-fish-scope):** a change inside
`pollyBackend`/`fishBackend` is backend-local — Fish-only work never needs
to touch Polly's backend. A change to `synthesizeCascadeReply()`'s
selection order, or to anything in `cascaded-live-client.ts` outside this
file (Transcribe, turn-gating), affects every cascade language and needs a
regression test against a Polly-backed language, not just Fish/`sr`.

## Acceptance Criteria

AC-1 — the extraction is zero-behavior-change: all 5 pre-existing
cascaded-* test suites (39 tests, unmodified) still pass after the
refactor, including the ones that exercise `runTurn()`'s Polly/Fish
selection end-to-end.

TEST: `outputs/jest-tts-backend-and-cascaded.txt` — 6/6 suites, 47/47
tests passing (39 pre-existing + 8 new).

AC-2 — `pollyBackend.synthesize`/`fishBackend.synthesize` each return
`{audioB64}` on success and `null` on failure, independently testable.

TEST: `test/orb/live/upstream/cascaded/tts-backend.test.ts` — "pollyBackend/
fishBackend — individually" (4 tests).

AC-3 — `synthesizeCascadeReply()` tries Polly first for a Polly-backed
language (`ru`) and never calls Fish when Polly succeeds; when Polly fails
but the language HAS a Polly voice, it does NOT fall back to Fish (a
runtime failure, not a coverage gap).

TEST: same file — "synthesizeCascadeReply — selection logic (Polly-backed
language, e.g. ru)" (2 tests).

AC-4 — for a Fish-only language (`sr`), Polly is still tried first
(unconditionally), and Fish is used only when Polly fails AND has no voice
for the language at all; returns null when both fail.

TEST: same file — "synthesizeCascadeReply — selection logic (Fish-only
language, e.g. sr)" (2 tests).

## Verification

TEST: `outputs/tsc-noemit.txt` — `tsc --noEmit`, clean (exit 0).

TEST: `outputs/jest-tts-backend-and-cascaded.txt` — new + pre-existing
cascaded suites, 47/47 passing, 0 regressions.

TEST: `outputs/npm-build.txt` — `npm run build`, clean (exit 0).

TEST: `outputs/jest-full-suite.txt` — full gateway suite: 934/935 suites (1
pre-existing skip), 15,289/15,324 tests passing, 0 failures.

## Not yet independently confirmed

This is a structural refactor with no runtime behavior change (confirmed
by the unmodified pre-existing suites staying green) — there is no new
live signal to watch for beyond VTID-03986's own "next cascade session
shows flat latency" check, which this VTID does not affect.
