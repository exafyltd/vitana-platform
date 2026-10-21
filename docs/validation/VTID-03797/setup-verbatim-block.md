# VTID-03797 (cont.) — the verbatim directive had a THIRD copy, in the setup

## What the first fix established, measured

PR #3237 made the guided turn-1 **trigger** compositional. It deployed to
staging (`81b6516c`, 15/15 build-info samples agreeing) and the probe was
re-run. Result:

| session | verdict | audio | errors |
|---|---|---|---|
| guided T001 de | BLOCKED | 2 | 2 |
| guided T001 en | BLOCKED | 2 | 2 |
| guided T100 de | BLOCKED | 2 | 2 |
| guided T200 de | BLOCKED | 2 | 2 |
| guided T001 fr | BLOCKED | 2 | 2 |
| guided T001 es | BLOCKED | 2 | 2 |
| **ordinary de (control)** | **WORKS** | **95** | 0 |
| guided T001 ru (cascade) | WORKS | 9 | 0 |
| guided T001 pl (cascade) | WORKS | 7 | 0 |

So the first fix did **not** close it. Reported as a disproven step, not a
fix — but the telemetry it produced located the real copy.

## Three facts from the live telemetry

**1. The first fix is genuinely live and in use.** The French session's
`greeting_sent` reports `wake_opener:override_v2, prompt_len:364`, which
matches `buildGuidedTopicOpenTrigger()`'s length. The old trigger measured
~225-227. So the compositional trigger reached Nova and Nova still rejected.

**2. Size is dead, again and harder.** The *working* control's instruction is
**31,186** chars; the *blocked* guided one is **30,178**. The larger one
succeeds. (VTID-03795 had already disproven size; this re-kills it with the
comparison the right way round.)

**3. The rejected payload is the SETUP, not the greeting turn.** The German
session emitted **no `greeting_sent` at all**:

```
10:04:58.559  nova_instruction_debug_dump
10:04:58.771  usage_totals
10:04:58.790  upstream_error  nova_validation
```

It was rejected before any greeting existed. (The French one failed 18 ms
*after* `greeting_sent`; on an HTTP/2 bidirectional stream the error is
asynchronous, so the German case — error with no greeting ever sent — is the
one that pins the payload.)

## The third copy

A SQL line-diff of the blocked guided instruction against the working control
surfaced this, present only in the guided one:

```
## SPOKEN FIRST UTTERANCE — REQUIRED VERBATIM (VTID-03079 / VTID-03097)

The user just opened the orb. Your FIRST spoken turn this session MUST
be EXACTLY this text. Copy these characters letter-for-letter; do not
paraphrase, do not translate, do not shorten, do not split into two
turns, do not append clarifying questions:

  "So, das war Was ist Vitanaland. Hast du Fragen dazu, oder sollen wir
   direkt gemeinsam loslegen?"
```

That is the same forced-reproduction-fenced-by-prohibitions shape VTID-03674
and PR #3237 already removed from the two *trigger* copies — in a stronger
form, and in the **system instruction**, which is exactly the payload fact 3
identifies. `buildVertexWakeBriefBlock()`
(`live-session-controller.ts`) builds it.

This is the same defect family as PR #3237's own second finding (two
byte-identical trigger copies, only one of which production reached), and as
VTID-03644's five diverging language maps: the pattern was removed where it
was *looked for*, not everywhere it *lived*.

## Fix

The guided branch of `buildVertexWakeBriefBlock()` now states the INTENT and
quotes no sentence at all. The turn-1 trigger already tells the model to
compose its own opener and the GUIDE MODE block names the topic, so the
quoted sentence was redundant as well as risky. This also satisfies
NEVER-rule 41 (§13b): write the intent, never the finished spoken sentence.

**Scoped to guided sessions only, deliberately.** Non-guided `override_v2`
sessions carry this identical block and succeed ~50% of the time, so it is
not fatal on its own; softening it for everyone would change a working path
for no measured reason, and would risk the exact regression VTID-03079/03097
exist to prevent — a soft "speak this verbatim" being lost to the SHORT-GAP
GREETING PHRASES pool. The sentinel marker that suppresses that pool is
retained in full on the guided path.

## Acceptance Criteria

AC-1 — A guided-topic session's setup block contains no verbatim-reproduction
command and no quoted sentence.

TEST: `guided-topic-spoken-first-utterance.test.ts` — "does NOT command
verbatim reproduction", "does NOT embed the provider line as a quoted
sentence".

AC-2 — It still tells the model to compose the opener itself.

TEST: same file — "tells the model to compose the opener itself".

AC-3 — The SHORT-GAP GREETING PHRASES suppression (VTID-03079/03097) still
holds on the guided path.

TEST: same file — "still suppresses the SHORT-GAP GREETING PHRASES pool".

AC-4 — Non-guided sessions are byte-for-byte unchanged, including a null
dedupe key and a key that merely contains the prefix rather than starting
with it.

TEST: same file — the three "non-guided sessions are untouched" tests.

AC-5 — The VTID-03167 structured-block bypass still wins over both branches.

TEST: same file — "the structured-block bypass still wins over both
branches".

AC-6 — Mutation-verified: disabling the branch fails the guided tests.

TEST: `outputs/jest-mutation-guided-branch-disabled.txt` — 4 failed, 5
passed; the 5 that pass are correctly branch-independent.

AC-7 — `tsc --noEmit` clean and the full gateway suite green.

TEST: `outputs/jest-full-suite-setup-block.txt` — 729/730 suites (1
pre-existing skip), 13,595 passing, 44/44 snapshots, 0 failures.

## Honest caveat

This is the next single variable, not a proven fix. The prior step in this
same VTID was disproven by exactly this kind of live re-run, and this one gets
the same treatment: if guided Nova sessions still block after deploy, this
copy is eliminated too and the GUIDE-MODUS block is the remaining structural
difference. That will be reported as measured, either way.

Not fixed here and still open: Serbian has no Polly voice, and the production
cascade flag is off (see `language-coverage.md`).
