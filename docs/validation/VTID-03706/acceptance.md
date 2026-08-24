# VTID-03706 — ORB full-duplex voice: keep the mic open so Nova's barge-in can fire

Evidence pack for the reported requirement: *"the user must be able to
interrupt Vitana... voice to voice must be enabled to allow the user to talk
at any time, no matter what Vitana is talking about. So the microphone must be
open at any time."*

Barge-in already shipped (`BOOTSTRAP-ORB-BARGEIN`) — but built inside-out, and
Nova Sonic's own barge-in had never once fired in production.

The mic was gated **shut** while the model spoke, in two independent places,
and only a loudness heuristic could reopen it:

- **Client** (`orb-widget.js` `_startAudioCapture`): frames captured during
  playback went into an 8-frame ring buffer and `return`ed — never sent. Only
  RMS > 0.06 sustained for **6 consecutive frames (~384 ms)** flushed the
  buffer and fired an `interrupt`.
- **Server** (`orb-live.ts` `handleWsAudioMessage`, and its SSE mirror in
  `live-session-controller.ts`): `if (session.isModelSpeaking) return;` —
  hard-dropped every mic chunk.

The server gate is the one that mattered. Nova handles barge-in natively: it
stops generating and emits `contentEnd.stopReason: "INTERRUPTED"`, which
`nova-sonic-protocol.ts:479` already normalizes and
`upstream-message-handler.ts:1653` already forwards. That path was
structurally unreachable, because Nova received literal silence during its own
turn. `sendEndOfTurn()` being a documented no-op for Nova means that event is
the **only** thing that actually stops generation — so the feature was dead,
not merely slow.

Two user-visible consequences:

1. Anything quieter than 0.06 RMS — "nein", "warte", "stopp", a
   normal-volume question — could never interrupt **at any point, ever**.
2. Confirmed interruptions took ~384 ms plus an interrupt/ack round trip,
   against an industry target of under 200 ms.

**Why not simply forward the raw mic.** `orb-widget.js` carries measured
evidence against it: echo survives browser AEC at 0.01-0.04 RMS, and a
previous 0.015 threshold *"triggered on echo, causing constant
interruptions"* — Nova interrupting itself in a loop. So the mic is now open
but **noise-gated**: every capture callback emits a frame, verbatim above the
echo floor and **digital silence** below it.

---

AC-1 — Real speech reaches Nova immediately, at any volume above the echo
floor

TEST: `services/gateway/test/orb/full-duplex-session-gate.test.ts` —
"passes real speech on the VERY FIRST frame (no confirmation delay)"
TEST: same file — "passes quiet speech that the legacy 0.06 threshold discarded forever"
TEST: same file — "keeps the gate open through a mid-word amplitude dip (hysteresis)"
TEST: same file — "holds the gate open across a short silent gap, then closes after the hangover"
Output: `outputs/duplex-gate-tests.txt`

Hysteresis (open 0.05 / close 0.025 / 400 ms hangover) is a Schmitt trigger,
not decoration: a single threshold chatters across the natural amplitude dips
inside a word and shreds the utterance Nova is trying to transcribe.

AC-2 — AEC residue never opens the gate, so Nova cannot interrupt itself

TEST: `full-duplex-session-gate.test.ts` — "blocks sustained AEC residue across the whole band (0.01-0.04)"
TEST: same file — "never fires barge-in on echo alone, however long playback runs"
TEST: same file — "holds shut during the AEC warm-up even if residue spikes above openRms"
TEST: same file — "does not let warm-up frames accumulate toward barge confirmation"
Output: `outputs/duplex-gate-tests.txt`

The warm-up accumulation test is a regression guard: suppressing the OUTPUT
while still counting frames would make the first post-warm-up frame barge
instantly on what was echo.

AC-3 — Barge-in confirms inside the sub-200 ms budget, and a transient does
not trigger it

TEST: `full-duplex-session-gate.test.ts` — "confirms barge-in within the sub-200ms budget"
TEST: same file — "rejects a single-frame transient (cough, door slam)"
TEST: same file — "forwards audio from frame 1 even though barge confirms later"
TEST: same file — "does not re-fire barge-in once already sent for this burst"
Output: `outputs/duplex-gate-tests.txt`

A real bug these caught before shipping: confirmation initially counted
gate-OPEN frames, so the 400 ms hangover would tick a single cough up to the
threshold **in silence** and fire a spurious barge. It now counts *voiced*
frames only; hangover frames neither add nor reset.

The third test pins the property that made the old design fail: the
confirmation delay bounds only the LOCAL playback stop. If it gated
transmission too, the opening syllable would be lost upstream.

AC-4 — Both server gates forward under full duplex, and are unchanged when
the flag is off

TEST: `full-duplex-session-gate.test.ts` — "FULL DUPLEX: forwards even while the model speaks — this is the fix"
TEST: same file — "FULL DUPLEX: never drops — the per-frame gate replaces the time window"
TEST: same file — "LEGACY: drops mic audio while the model speaks (unchanged)"
TEST: same file — "LEGACY: forwards once the window has elapsed (unchanged)"
Output: `outputs/duplex-gate-tests.txt`

`FEATURE_ORB_FULL_DUPLEX_ENV` unset resolves to `'off'`, which is the prior
behaviour byte-for-byte. The legacy pre-roll path is deliberately kept rather
than deleted, so rollback is a flag flip, not a revert.

AC-5 — The tuning constants cannot drift between their three copies

TEST: `full-duplex-session-gate.widget-parity.test.ts` — "%s matches the TypeScript source of truth" (5 constants x 2 files)
TEST: same file — "emits a silent frame instead of returning early when the gate is shut"
TEST: same file — "sends the interrupt AFTER forwarding audio, not instead of it"
TEST: same file — "uses the same getUserMedia constraints as the widget"
Output: `outputs/duplex-gate-tests.txt`

`orb-widget.js` and `orb-duplex-test.js` are plain assets that cannot import
`DUPLEX_GATE`, so they repeat the literals. The parity test reads both sources
and fails the build on any drift — the remedy VTID-03696 needed after a
workflow's `paths:` list desynced unnoticed for 30+ runs, and VTID-03644 after
five copies of a language map diverged.

AC-6 — The CSP gate stops rejecting PRs for violations they did not introduce

TEST: `services/gateway/test/scripts/validator-path-guard.test.ts` — "flags a NEWLY ADDED inline style assignment"
TEST: same file — "does NOT flag a pre-existing violation carried as a context line"
TEST: same file — "does NOT flag the +++ file header"
TEST: same file — "no pattern matches the CSP_PATTERNS declaration block"
Output: `outputs/csp-preexisting-on-main.txt`, `outputs/csp-added-lines.txt`

**This was found by this PR failing on it, and it is not this PR's bug.** The
CSP gate scanned WHOLE FILES, so it was unpassable for any PR touching
`orb-widget.js` or `index.html`. Measured against `origin/main`'s own copies
(`outputs/csp-preexisting-on-main.txt`): `orb-widget.js` hits four patterns and
`index.html` one, before any change on this branch. The gate never said "this
PR introduces a violation" — it said "this file has ever contained one", and
the only way to pass was to not touch the file.

That is the same defect family this workflow was already fixed for twice under
VTID-03696 (the gate flagging its own PATTERNS list; the lockfile deny making
any dependency-adding PR unsatisfiable). The remedy applied here is
VTID-03696's own: judge ADDED lines. A newly added violation still fails.

The patterns moved into `validator-path-guard.cjs` and are assembled from
fragments so no flagged literal appears in a scannable line — which
permanently ends the self-flagging trap rather than relocating it. A test pins
that property.

This PR's own added lines are clean (`outputs/csp-added-lines.txt`): the
device harness drives its level meter through a native `<progress>` element's
`value` property rather than an inline width, and the widget's new mic-live
affordance is a CSS class rather than an inline rule.

AC-7 — The whole gateway still builds and passes

TEST: full jest run — 686/687 suites (1 pre-existing skip), 13,134 tests, 0 failures
Output: `outputs/full-suite.txt`, `outputs/tsc.txt`

`tsc --noEmit` exits clean.

---

## Not verified — and it gates any production discussion

**No real-device echo run has happened.** There is no acoustic path in a unit
test and Playwright renders pixels, not sound; this session has no microphone.

`/command-hub/orb-duplex-test.html` exists precisely for this. It runs the
identical gate against a real mic and speaker, reports gate openings, peak RMS
and barge events with a pass/fail verdict, measures the room noise floor first
and warns when ambient noise already exceeds `closeRms`. It is self-contained:
no gateway call, no ORB session, no writes.

It was exercised end-to-end with Chromium's fake audio device (baseline →
playback → gate transitions → barge → verdict, zero page errors), which
confirms the harness works and nothing more — its own noise-floor guard
correctly flagged the synthetic 440 Hz input as unusable for a real verdict.

Before full duplex goes near production: run the echo test on a real phone,
speakerphone, headphones off, at realistic volume. It must report **zero** gate
openings. If it reports any, full duplex is unsafe on that device class — and
the fix is not to lower the thresholds. `AWS-PROD-DEPLOY-GATEWAY.yml` is
deliberately untouched for this reason.

## Deliberately not done

The `ScriptProcessorNode` → `AudioWorklet` migration. It is the right thing
(deprecated API, main-thread jitter under React load) but it is a
latency/robustness improvement, not a correctness fix for barge-in — bundling
it here would have put the risky part and the safe part behind one flag.
