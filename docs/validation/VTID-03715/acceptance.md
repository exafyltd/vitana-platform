# VTID-03715 — the upstream's real PCM rate must survive the server

VTID-03711 taught `orb-widget.js` to read `chunk.mime` instead of hardcoding
24000. That fixed the two paths that build their mime from real data — the
greeting bridge and guided-topic narration, both `audio/pcm;rate=${sampleRateHz}`.

**It did not fix ordinary cascaded conversation**, because the rate never
reached the client to be read:

| Step | Location | Behaviour |
|---|---|---|
| Cascade synthesizes | `cascaded-live-client.ts:273` | `mimeType = audio/pcm;rate=16000` — correct |
| Handler forwards | `upstream-message-handler.ts` | `onAudioResponse(event.dataB64)` — **mime dropped** |
| Callback contract | `orb-live.ts` | `(audioB64: string) => void` — **no mime parameter existed** |
| SSE / WS forward | `orb-live.ts` | `mime: 'audio/pcm;rate=24000'` — **invented** |
| Client parses | `orb-widget.js` | reads 24000 → 16kHz played at 24kHz → **1.5× fast** |

A client-side parser cannot recover from this: by the time the chunk arrives,
the wrong rate is the only thing there is to read. So the chipmunk voice that
forced `ORB_CASCADED_VOICE_ENABLED` back to `false` would have returned intact
the moment the flag was re-enabled.

Found by a Codex review comment on PR #3169; verified against source before
acting on it, not taken on trust.

---

AC-1 — The cascade's declared rate reaches the client

TEST: `services/gateway/test/orb/routes/upstream-audio-mime-forwarding.test.ts` —
"passes event.mimeType through to onAudioResponse"
TEST: same file — "SSE and WS both send the chunk mime with a named fallback"
Output: `outputs/targeted-tests.txt`

The whole defect, in the two places it was lost.

AC-2 — The old shape cannot silently return

TEST: same file — "no longer calls onAudioResponse with the payload alone"
TEST: same file — "declares the second parameter on both callback contracts"
Output: `outputs/targeted-tests.txt`

Two context interfaces carry this callback. Widening only one leaves the other
dropping the rate again, which is exactly how this survived VTID-03711.

AC-3 — The greeting prebuffer keeps each chunk's own rate

TEST: same file — "stores mime alongside the payload"
TEST: same file — "types the buffer as pairs, not bare strings"
TEST: same file — "destructures both fields when replaying"
Output: `outputs/targeted-tests.txt`

`bufferedGreetingChunks?: string[]` silently assumed every held chunk was
24kHz — true while Nova was the only upstream, false the moment a cascaded
greeting could be held. Replay is a second, independent forwarding path and
had to be fixed with the first.

AC-4 — The activation chime deliberately keeps its literal

TEST: same file — "is synthesized at 24000 locally"
TEST: same file — "every surviving hardcoded rate belongs to a chime send"
Output: `outputs/targeted-tests.txt`

Four call sites still say `audio/pcm;rate=24000` and should. `generateChimePcm()`
synthesizes at 24000 in this same file — that is a fact about local bytes, not a
guess about an upstream. Rewriting them to the fallback constant would blur
"known" and "assumed", which is the distinction this VTID exists to draw. The
second test is a structural sweep, so a *new* hardcoded rate on an upstream path
fails even though these four pass.

AC-5 — The guard fails when the defect is reintroduced

TEST: `outputs/mutation-check.txt` — two independent mutations, each caught:
restoring `onAudioResponse(event.dataB64)` → 2 red; restoring
`mime: 'audio/pcm;rate=24000'` on the forwarding paths → 2 red (including the
structural chime sweep). Both reverted to 12/12.
Output: `outputs/mutation-check.txt`

AC-6 — No regression in the surrounding suites

TEST: `npx jest test/orb/` — 127/127 suites, 1736/1742 (6 pre-existing todo).
TEST: `npx jest` (full gateway) — 690/690 suites, 13,148 passing, 0 failures.
Output: `outputs/orb-suite.txt`, `outputs/full-suite.txt`

Six tests failed on the first run and **all six were mine** — they pinned the
single-argument call shape, four by exact `toHaveBeenCalledWith` args and two by
literal source text. Each was re-recorded to the real new shape rather than
loosened: the arg assertions now also assert the mime (strictly stronger than
before, and each test already supplied one), and the two characterization tests
keep pinning the ordering invariant they exist for while allowing the argument
list to vary.

AC-7 — Type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## Verification summary

| Check | Result |
|---|---|
| Targeted suite | 12/12 |
| Mutation check | 2 mutations, 4 red total, 12/12 restored |
| `test/orb/` | 127/127 suites, 1736 passing |
| Full gateway suite | 690/690 suites, 13,148 passing, 0 failures |
| `tsc --noEmit` | clean |
| Live confirmation | **pending — see below** |

## What this unblocks, and the order it has to happen in

`ORB_CASCADED_VOICE_ENABLED=true` was dispatched to production under
VTID-03703, produced the chipmunk voice, and was rolled back to `false`
(run 32743618322). Re-enabling it is what makes `pt`/`pl`/`ru`/`ar`/`zh` stop
being forced onto Nova with a German voice.

1. This PR → staging.
2. **PUBLISH to production** — carries VTID-03711 (client parser), this fix
   (server threading), and VTID-03704 (voice routing, which has still never
   shipped: prod's `supported_languages` is `["en","de","fr","es"]`).
3. **Then** re-dispatch `orb_cascaded_voice_enabled=true`.

Re-enabling the cascade before step 2 reproduces the exact regression that
forced the rollback. VTID-03711 alone is not sufficient for that step, which is
the finding this VTID records.

## Not verified

No live listen — this session cannot play audio, and generating sessions as the
test account would be a production write, which CLAUDE.md forbids absolutely.
`aws` is not installed here, so no task-def or IAM check either. The real
confirmation is a human hearing a Polish or Russian cascaded session at normal
speed after step 3.
