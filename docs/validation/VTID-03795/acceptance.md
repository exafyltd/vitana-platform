# VTID-03795 — Guided-topic sessions exceed the Nova setup budget; drop the contradictory GUIDED JOURNEY scaffold

## Report

VTID-03790 confirmed-fixed the nested-quote defect (verified live), but a real
guided-topic session against staging **still** hit `nova_validation` twice,
while an ordinary session on the same shared scaffold succeeded cleanly. This
VTID root-caused what was actually left.

### Two hypotheses tested, the first killed with real data

The obvious candidate — `<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>`, an internal
sentinel that leaks verbatim into the model-facing text on every override_v2
path and is absent from ordinary sessions — was **disproven before any code was
written**. Real 14-day telemetry:

| wake_opener | sessions | blocked | clean |
|---|---|---|---|
| `override_v2` | 26 | 13 | **13 (50% succeed)** |
| `(none)` | 268 | 92 | 176 (~34% ambient block rate) |

`override_v2` sessions carry the marker **and** the SPOKEN-FIRST-UTTERANCE block
and succeed half the time, so neither is a sufficient cause. Killing this
hypothesis is what prevented a fourth consecutive content-guess fix in this
chain.

### The real cause: the instruction exceeds the setup budget

Bucketing every `nova_instruction_debug_dump` (VTID-03787's instrumentation) over
7 days by size against outcome:

| bucket | sessions | blocked | clean | range |
|---|---|---|---|---|
| **≥ 32,768 bytes** | 2 | **2 (100%)** | 0 | 33,766–33,778 |
| < 32,768 bytes | 37 | 5 (13.5%) | 32 | 8,054–**32,431** |

A clean gap — no sample exists between 32,431 (clean) and 33,766 (blocked) — and
the 13.5% matches the known ambient rate. The two directly-compared sessions:

| session | UTF-8 bytes | vs 30,720 guard budget | vs ~32,768 hard limit |
|---|---|---|---|
| **GUIDED (blocked)** | 34,206 | +3,486 | **+1,438 OVER** |
| GUIDED retry (blocked) | 34,162 | +3,442 | **+1,394 OVER** |
| ORDINARY (clean) | 31,594 | +874 | −1,174 under |

This converges with an independent line of evidence: the codebase documents this
exact failure mode (`instruction-budget.ts`: *"the SUM of these can still exceed
the ~32 KB Vertex Live setup budget… → no TTS frames → 'Vitana won't talk'"*).

**`enforceInstructionBudget` cannot rescue it.** It may only drop
`bootstrap`/`history`/`specialist` — and *both* dumps already carried
`[bootstrap context omitted...]`, i.e. it had already trimmed everything it is
permitted to. Its own contract then returns the still-over-budget text as-is
(`stillOverBudget: true`, "best-effort send / fail-open"). So the payload ships
and is reliably refused. Note both session types are over the guard's own
30,720 budget — it has been failing open silently for everyone; guided is simply
the one that also crosses the hard limit.

### Why the GUIDED JOURNEY block specifically

Measured block sizes in the blocked prompt: GUIDED JOURNEY **3,847 bytes**,
PROACTIVE LEADERSHIP 6,845, SPOKEN-FIRST-UTTERANCE 998, GUIDE-MODUS 1,099.

The GUIDED JOURNEY block is not merely the right size — in this branch it is
**wrong**. It instructs the model to call `narrate_guided_session` and speak the
returned script *"word for word"* (`PLAYING A SESSION = SPEAKING ITS SCRIPT
ALOUD… your ENTIRE spoken turn must BE that script`), while the guided-topic
block in the same prompt says the lesson was **already narrated as audio and
must NOT be repeated**. A tapped My Journey topic is also deliberately scoped to
that ONE topic (the block ends by calling `end_guided_topic_teaching` rather
than drifting into general conversation), so coaching the model to offer other
sessions fights the intended scope as well.

## Fix

`buildLiveSystemInstruction` now detects a guided-topic teaching block in
`bootstrapContext` (verified: `orb-live.ts:7776-7781` and `orb-livekit.ts:1920`
both concatenate it into that exact 3rd positional argument) and **replaces**
— not deletes — the generic block with a one-line form that:

- scopes the session to the one topic (reinforcing the intended behaviour),
- keeps `narrate_guided_session` reachable if the user explicitly asks for a
  different session,
- scopes "speak it in full" to a script fetched *during this conversation*, so
  it can no longer contradict the already-narrated lesson.

**Measured saving: 3,606 UTF-8 bytes.** The real 34,206-byte blocked session
becomes **~30,600** — under the ~32,768 hard limit by 2,168 bytes, and under the
guard's own conservative 30,720 budget by 120.

Non-guided sessions are untouched: the full block renders exactly as before.

## Acceptance Criteria

AC-1 — On a guided-topic session the generic GUIDED JOURNEY block and its
contradictory `PLAYING A SESSION = SPEAKING ITS SCRIPT ALOUD` directive are
absent.

TEST: `guided-topic-journey-scaffold-suppression.test.ts` — "drops the generic
block (and its contradictory directive) on a guided-topic session".
Mutation-verified.

AC-2 — The capability is scoped, not removed: `narrate_guided_session` remains
reachable on a guided-topic session.

TEST: same file — "keeps narrate_guided_session reachable — capability is
scoped, not removed".

AC-3 — **No collateral damage.** A non-guided session renders the FULL block
exactly as before, and the rest of the prompt (identity lock, proactive
leadership, greeting rules, navigator) is intact in BOTH cases.

TEST: same file — "leaves the FULL block completely intact on a non-guided
session" and "leaves the rest of the prompt untouched in BOTH cases". Also
evidenced by the full suite: all 44 snapshots and every pre-existing golden /
prompt-content test pass unmodified.

AC-4 — The saving exceeds the measured 1,438-byte overage with real margin.

TEST: same file — "sheds enough bytes to clear the measured overage (>= 3,000)";
measured 3,606. Mutation-verified: with the fix disabled this reports **−16**.

AC-5 — The detector cannot silently rot. It matches prose headings, so a rename
in the builder would turn it into a permanent no-op and quietly restore the
over-budget payload.

TEST: same file — "detects EVERY branch buildGuidedTopicNarrationBlock can emit
(heading drift guard)", asserting all four branches (de/en × post-narration/
legacy) are detected AND that every declared heading is actually used.

AC-6 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-7 — Full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 728/729 suites (1 pre-existing skip),
13,584/13,619 passing (13,577 before this VTID's +7), 44/44 snapshots, 0
failures.

Re-verified on the rebased branch: `origin/main` advanced from `93e428e6` to
`ae7b494c` mid-work (VTID-03779 Nova warm-start, VTID-03791 WS-transport pin,
VTID-03793 diary dictation — all touching or adjacent to the ORB voice path),
so the branch was cut from the newer base and the full suite + `tsc` re-run
clean against it rather than against the base the fix was written on.

## Deliberately NOT attempted

- **No new last-resort trim tier in `enforceInstructionBudget`.** It would only
  matter for a NON-guided session above 32,768 bytes, and zero such sessions
  exist in the measured data (largest non-guided sample: 32,431). Adding a
  speculative trim tier to a load-bearing pure module for an unobserved failure
  is exactly the evidence-free pattern this chain has repeatedly been burned by.
  Flagged rather than built.
- **Did not touch `<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>`.** It is a genuine
  hygiene issue (an internal sentinel leaking into model-facing text) but the
  50%-success data proves it is not the blocker. Left alone rather than bundled
  in on a hunch.
- **Did not shrink PROACTIVE LEADERSHIP (6,845 bytes)**, the single largest
  block. It governs every session's behaviour and carries no contradiction;
  trimming it is a behavioural change needing its own evidence.

## Open / honest caveats

- The over-budget bucket is **n=2**. The correlation is perfect and converges
  with the codebase's own documented failure mode, but it is not proof on its
  own. **The decisive test is the live re-run**: the fix keeps every byte of
  guided-topic content and changes only size, so if a guided session now
  succeeds, size was the cause; if it still blocks, size was not, and that will
  be reported as such rather than declared fixed.
- Nova reports this as `nova_validation` / "blocked by our content filters",
  not an explicit size error. The size correlation is behavioural, not a
  message the API returns.

## Governance

`command-hub-ownership-guard.js` not touched — changes are under
`services/gateway/src/orb/live/instruction/` and its test, outside
`PROTECTED_PATH` scope.

OASIS_IMPACT: no — prompt-assembly change only; no new event type, no schema
change, no route change.
