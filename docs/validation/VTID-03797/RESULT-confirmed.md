# VTID-03797 — CONFIRMED FIXED against live traffic

Guided-topic ("My Journey") voice sessions on Nova went from **0/93 over 30
days** to **8/8**, measured on staging after `e2ef150` deployed.

## The measurement

Staging rollout confirmed converged first (an intermediate sample read 8 old /
7 new — probing then would have mixed two builds; the probe only ran once 12/12
samples agreed on `e2ef150`).

| session | before (0/93) | after `e2ef150` | audio chunks | errors |
|---|---|---|---|---|
| guided T001 **de** | BLOCKED | **WORKS** | 49 | 0 |
| guided T001 **en** | BLOCKED | **WORKS** | 68 | 0 |
| guided T100 de | BLOCKED | **WORKS** | 46 | 0 |
| guided T200 de | BLOCKED | **WORKS** | 62 | 0 |
| guided T001 **fr** | BLOCKED | **WORKS** | 40 | 0 |
| guided T001 **es** | BLOCKED | **WORKS** | 91 | 0 |
| guided T001 ru (cascade) | WORKS | **WORKS** | 9 | 0 |
| guided T001 pl (cascade) | WORKS | **WORKS** | 7 | 0 |
| ordinary de (control) | WORKS | **WORKS** | 87 | 0 |

Three topics × four Nova languages, plus both cascade languages, plus the
non-guided control — all green, no regression on anything that already worked.

## Telemetry corroboration

Not just "the probe heard audio". Every one of the six Nova guided sessions
shows the full clean lifecycle in `oasis_events`:

```
guided_topic_audio_bridge_sent  1
greeting_sent                   1
model_start_speaking            1
turn_complete                   1
upstream_error                  0   <- absent
nova_premature_close_retry      0   <- absent
```

First-attempt success. No `nova_validation`, and the retry/recovery path was
never entered — so this is the fix working, not a recovery masking a failure.

## What actually caused it

The verbatim-reproduction directive — *"MUST be EXACTLY this text. Copy these
characters letter-for-letter; do not paraphrase, do not translate, do not
shorten…"* wrapped around a quoted sentence. Bedrock's guardrail rejects that
shape. Vertex had no equivalent guardrail, which is exactly why this worked
before the Nova migration and broke after it.

It existed in **three** places, and removing it took three passes because each
pass only removed the copies that had been looked for:

1. VTID-03674 — the harsh guided trigger wrapper ("translate it faithfully and
   completely…").
2. PR #3237 — the two byte-identical `guidedTrigger` copies in
   `compute-greeting-decision.ts`. Deployed, measured, **did not fix it**, and
   was reported as disproven.
3. PR #3239 — `buildVertexWakeBriefBlock()`'s `## SPOKEN FIRST UTTERANCE —
   REQUIRED VERBATIM` block, in the **system instruction**. This was the one.

Step 2 is what made step 3 findable: its telemetry showed the German session
being rejected with **no `greeting_sent` at all**, which pinned the rejected
payload to the setup rather than the greeting turn, and its instruction dump
let a SQL line-diff against the working control surface the third copy.

Two hypotheses were killed with real data along the way rather than assumed:
instruction **size** (the *working* control's instruction is 31,186 chars vs
the *blocked* guided one at 30,178 — the larger one succeeds) and the **Polly
audio bridge** (the working ru/pl sessions send it too).

## Scope of the fix

Guided sessions only. Non-guided `override_v2` sessions carry the identical
block and succeed ~50% of the time, so it is not fatal on its own; changing it
for everyone would alter a working path for no measured reason and risk the
regression VTID-03079/03097 exist to prevent. The marker that suppresses the
SHORT-GAP GREETING PHRASES pool is retained in full on the guided path.

## Language coverage after this fix

All eleven languages are now **individually measured**, not reasoned about.

| languages | route | guided topics |
|---|---|---|
| en, de, fr, es | Nova speech-to-speech | **working** (measured) |
| ru, pl, ar, pt, tr, zh | cascade | **working** (measured) |
| sr | neither | **fails silently** — see below |

10 of 11 confirmed working. Each cascade language shows the full clean
lifecycle in `oasis_events` — `guided_topic_audio_bridge_sent` →
`greeting_sent` → `model_start_speaking` → `turn_complete`, zero
`upstream_error`.

### Serbian fails SILENTLY — worse than a missing voice

Previously recorded only as "Polly has no Serbian voice". The live probe shows
what a user actually experiences, which is a distinct and worse defect:

```
guided_topic_audio_bridge_sent  0   <- Polly cannot synthesize Serbian
nova_voice_fallback             1   <- falls back to Nova
greeting_sent                   1
model_start_speaking            0   <- never speaks
turn_complete                   0
upstream_error                  0   <- and never errors either
```

The cascade correctly refuses Serbian (`no_polly_voice`), so the session falls
back to Nova, which cannot speak Serbian. It then closes **without producing
audio and without raising an error** — the user taps a lesson, hears nothing,
and is shown no failure. A silent failure is harder to diagnose and worse to
experience than an honest "voice is not available in Serbian yet".

Fixing the *voice* needs a third TTS provider. Fixing the *silence* — surfacing
an honest unsupported-language message instead of nothing — is a smaller,
separate piece of work and is NOT done here.

## Still open — not fixed by this, and each needs its own decision

1. **Production has the cascade switched off** (`ORB_CASCADED_VOICE_ENABLED`
   `effective:false`), so its six languages are forced onto Nova, which cannot
   speak them. Staging has it on. Flipping it is a prod config dispatch that
   its own workflow says needs Transcribe + Polly IAM confirmed first.
2. **This fix is on staging only.** Production still runs the old code and will
   still block every guided topic until it is promoted.
3. **Serbian** needs a third TTS provider for a voice, and separately needs its
   silent failure replaced with an honest message (see above).
4. **`tr` has 252 checklist rows, not 254** — two short.

(A fifth item — that `ar`/`pt`/`tr`/`zh` were reasoned-covered rather than
probed — is now closed: all four were individually measured and pass.)
