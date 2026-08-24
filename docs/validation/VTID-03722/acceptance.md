# VTID-03722 — the cascade must end a user turn on its own

Found by review on PR #3177, **confirmed against source before acting**, and
fixed before the flag reached anyone.

## The defect

| Link | Verified |
|---|---|
| `orb-widget.js` sends only `{type:'audio'}` frames | **zero** `end_turn` occurrences in the file |
| `CascadedLiveClient.runTurn()` callers | ONLY `sendTextTurn()` (L167) and `sendEndOfTurn()` (L173) |
| the transcript handler | appends finals to `pendingUserText`, then stops |
| `vadSilenceMs` | accepted by `connect()` and **discarded** — not even a field |

Nova never needed a boundary because it runs VAD **inside** its own
bidirectional stream. That is precisely why nobody noticed the widget has never
sent one. The cascade has no VAD.

**Net effect with the cascade on:** the greeting speaks (it is a text turn →
`sendTextTurn` → `runTurn`), the user then talks, Transcribe transcribes
correctly — and Bedrock is never invoked. Silence, forever.

That is **strictly worse than the English it replaced**, and VTID-03720 had
already put the flag on staging. This had to land before anyone tested it.

---

AC-1 — A microphone turn produces a reply with no `end_turn` frame

TEST: `services/gateway/test/orb/live/upstream/cascade-turn-boundary.test.ts` —
"invokes the model after the silence budget, with NO end_turn ever sent"
Output: `outputs/targeted-tests.txt`

The whole defect, inverted into an assertion.

AC-2 — The user is not cut off mid-sentence

TEST: same file — "does not cut the user off mid-sentence — each fragment pushes the boundary out"
TEST: same file — "treats a partial as \"still speaking\" and re-arms"
Output: `outputs/targeted-tests.txt`

Transcribe emits finals at clause boundaries, so debouncing on finals alone
would end the turn mid-thought. Partials re-arm but are still **not**
accumulated — Transcribe revises partials, and appending them would feed the
model the same clause twice.

AC-3 — Silence alone never invents a turn

TEST: same file — "never fires a turn on silence alone"
Output: `outputs/targeted-tests.txt`

An empty buffer must not call the model. A greeting followed by a quiet user
should cost nothing.

AC-4 — `vadSilenceMs` is honoured and range-guarded

TEST: same file — "honours a per-session vadSilenceMs"
TEST: same file — 6 cases: `0, -1, 50, 60000, NaN, undefined` → default
Output: `outputs/targeted-tests.txt`

`0` would end the turn on the first final fragment; `60000` would hang it.
Both are worse than the default, so the value is guarded rather than trusted.

AC-5 — Teardown and re-entrancy

TEST: same file — "stops the countdown on close, so a torn-down session cannot fire a turn"
TEST: same file — "does not start a second turn while one is in flight"
Output: `outputs/targeted-tests.txt`

A slow model call must not be raced by the next countdown, and a closed
session must not wake up and call Bedrock.

AC-6 — The guard reproduces the defect when removed

TEST: `outputs/mutation-check.txt` — removing `armSilenceTimer()` turns
**11 of 13** red; reverting restores 13/13.
Output: `outputs/mutation-check.txt`

The 2 survivors are the negative cases, which hold vacuously when nothing ever
fires. That asymmetry *is* the defect's signature.

AC-7 — No regression

TEST: `npx jest test/orb/ test/routes/orb-livekit.test.ts test/scripts/` — 1919 passing, 6 pre-existing todo.
TEST: `npx tsc --noEmit` — clean.

---

## Verification summary

| Check | Result |
|---|---|
| Targeted suite | 13/13 |
| Mutation check | 11 red, 13/13 restored |
| Affected suites | 1919 passing |
| `tsc --noEmit` | clean |
| Live confirmation | **pending — a real Polish session is the proof** |

## Honest limits

900ms is a **judgement**, not a measurement. It is long enough to survive a
mid-sentence pause and short enough not to feel hung, but the right value can
only come from listening to real turns. It is per-session overridable and
range-guarded, so tuning it needs no code change.

This makes the cascade *able* to hold a conversation. It does not prove the
conversation is good — latency across three hops (Transcribe → Bedrock → Polly)
is inherently worse than speech-to-speech, which is why the cascade is scoped
to languages that today get nothing usable at all.
