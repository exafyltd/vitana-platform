# VTID-03797 — Guided-topic turn-1 trigger stops commanding verbatim reproduction

## Report

Guided-topic ("My Journey") sessions have never worked on Nova. Measured over
30 days: **93 guided sessions, 93 blocked, ZERO ever reached
`model_start_speaking` or `turn_complete`** (guided sessions identified by
`guided_topic_audio_bridge_sent`). That determinism is the key signal — every
other rung sees only the ~34% ambient block rate.

### Isolation (live, this VTID)

A live probe against staging, one variable at a time:

| session | verdict | audio chunks |
|---|---|---|
| guided T001 **de** | BLOCKED | 2 |
| guided T001 **en** | BLOCKED | 2 |
| guided T100 de | BLOCKED | 2 |
| guided T200 de | BLOCKED | 2 |
| **ordinary de (control)** | **WORKS** | **493** |

Three different topics and two languages all blocked, while an ordinary
control in the same run produced 493 audio chunks and completed its turn. So
the trigger is **structural** — not topic text, not language, and (per
VTID-03795) not instruction size.

### Root cause

The rejected payload is the turn-1 greeting directive, and the guided-only
difference is the template's **kind**:

- `wakeTrigger` (non-guided override_v2, passes at the ambient rate) quotes its
  lead but then says *"Compose the wording yourself … **do not recite the lead
  word for word**"*.
- `guidedTrigger` (0/93) said *"Open by saying this prepared line … Keep it to
  ONE short utterance. Do not add a greeting before it, do not add a question
  after it, and **do not turn it into something else**."* — a directive to
  reproduce supplied text **verbatim**, wrapped in a stack of prohibitions.

Forcing verbatim reproduction of supplied text, fenced by prohibitions, is the
shape Bedrock's guardrail treats as injection-like. That is exactly why the
platform worked on **Vertex** (no such guardrail) and broke on **Nova** — the
user's own report. **VTID-03674 already identified this pattern** and removed
the older, harsher wrapper ("translate it faithfully and completely…") — but
replaced it with a *milder verbatim wrapper*, so the class survived and the
block never moved.

`nova_validation` is also not necessarily a content verdict:
`nova-sonic-live-client.ts:80` maps **any** `ValidationException` or HTTP 400 to
it. The full diagnostic here does say "blocked by our content filters", so in
this case it is a guardrail — but the label alone should not be read as one.

### A second, load-bearing defect found while fixing this

The template existed in **two byte-identical copies** — `tryGuidedTopicRung`
(line ~705) and rung 8 (line ~1082) — under a comment claiming the two ladders
"can never drift apart on this again". Duplication cannot guarantee that, and
they drifted the instant one copy was edited. **Production uses
`tryGuidedTopicRung`**: every blocked session's `greeting_sent` carries
`guided_topic_outranks_passive_rungs: true`, which only that rung sets. Editing
the rung-8 copy alone would have changed nothing in production while looking
correct locally and passing its own test. Same defect family as VTID-03644's
five diverging language-map copies and VTID-03696's desynced `paths:` list.

## Fix

One shared `buildGuidedTopicOpenTrigger()` backs **both** ladders. It
**describes** the opening instead of dictating it:

```
The person has just listened to a short pre-recorded audio lesson on the topic
named in the GUIDE MODE section, so they have already heard it.
Open with ONE short, warm sentence in the user's own language: acknowledge that
the lesson just finished and invite any questions they have about it.
Compose that sentence yourself in your own words. Then stop and listen.
```

**Why this covers all 254 topics and every language by construction:** the
topic title and practice target are deliberately **not** interpolated — the
GUIDE MODE block already names both in the system instruction. So the template
carries no per-topic and no per-language text at all. There is no table to keep
in sync and no locale that can be missed — the exact failure mode VTID-03644
hit. It also satisfies NEVER-rule 41 / §13b (write the INTENT in English; never
hand the model a finished spoken sentence), which the old template violated.

The teaching itself is untouched: it still happens on turns 2+ from the
GUIDE-MODE block, and VTID-03686's "explain before you skip ahead" rule is
unchanged. Turn 1 only opens.

## Acceptance Criteria

AC-1 — Neither ladder emits a verbatim-reproduction directive; the guided
directive is compositional.

TEST: `compute-greeting-decision.golden.test.ts` — rung-8 guided-teach test now
asserts `/Compose that sentence yourself/` and explicitly `not.toMatch(/say(ing)?
this prepared line/i)` and `not.toMatch(/do not turn it into something else/i)`.

AC-2 — **Both ladders emit the IDENTICAL guided directive** (the drift that made
the first edit a no-op in production cannot recur).

TEST: same file — "safe-fast ladder…" now asserts
`expect(withGuided.directive).toBe(normalLadder.directive)`.

AC-3 — The provider's spoken line is no longer embedded verbatim in the
directive, on either ladder.

TEST: same file (both ladder tests) + `conversation-flow-regression.test.ts` —
all now assert `not.toContain(<the line>)`.

AC-4 — Every pre-existing invariant these tests exist for still holds: the
guided tap still WINS the collision against `newday_overview`/`day_close`, still
does NOT get the three-beat proposal contract, still never reintroduces the
"fluent/translate" phrasing, and the briefing is still not stamped as delivered.

TEST: same files — those assertions are unchanged and passing.

AC-5 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-6 — Full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 728/729 suites (1 pre-existing skip),
13,584/13,619 passing, 44/44 snapshots, 0 failures.

## Deliberately re-recorded, not worked around

Four assertions across two files pinned the OLD verbatim behaviour as correct
(three `toContain(<line verbatim>)` and two `/ONE short utterance/`). Each was
re-recorded with the reasoning inline, and each flipped to assert the NEW
invariant (the line must NOT be embedded) so the defect cannot silently return.
Only one snapshot was regenerated, and only after confirming the sole diff was
the guided directive itself.

## Honest caveats

- **This is one variable.** Instruction size was already disproven (VTID-03795),
  and this changes only the greeting directive, so the live re-run is a clean
  isolation: if guided sessions now speak, this was the cause; if they still
  block, the greeting is eliminated and the GUIDE-MODE block is next. That will
  be reported as such, not declared fixed.
- **Nova Sonic supports only `en`/`de`/`fr`/`es`** (`NOVA_SONIC_SUPPORTED_LANGUAGES`,
  `nova-sonic-config.ts:71`). This fix is language-independent by construction,
  but it cannot by itself deliver the other 7 of 11 languages — there is a
  separate cascaded path (`cascaded-config.ts`, whose own comment says Nova
  "cannot speak Russian, Polish, …") that has not been verified in this VTID.
  Flagged rather than silently implied covered.

## Governance

`command-hub-ownership-guard.js` not touched — changes are under
`services/gateway/src/services/conversation/` and its tests.

OASIS_IMPACT: no — greeting-directive text only; no new event type, no schema
change, no route change.
