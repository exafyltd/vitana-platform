# VTID-03799 — the guided lesson replayed forever and was never credited

## What was reported

> at the end of the lesson, it says: Great, the lesson on My Journey lesson is
> finished. Do you have any questions about it? ....and then reconnecting, then
> it repeats the entire lesson, you cannot stop it at any point, close button
> doesn't work, and then it starts with the new day greeting. No well done
> drawer, no option to finish the selected step/session.

Four symptoms, one session. They are not four bugs — they are one loop seen
from four angles.

## What actually happens (live, staging, topic T005, 2026-08-31)

1. The lesson plays and finishes. `_endGuidedTopicTeaching` is not reached
   (the model wraps up conversationally instead of calling the tool).
2. The server closes the now-idle session — `ws_session_cleanup`, a normal,
   healthy close.
3. The widget reconnects, re-arms T005, and sends `guided_topic_id` again.
4. The server sees a fresh open, re-synthesizes, and the **full Polly
   narration replays** — three times, ~2s after each close.
5. Pressing X closes the overlay, but the next reconnect reopens it carrying
   the topic again, so the close reads as "the button does nothing".
6. Eventually `_guidedTopicInFlight` is cleared by a close that lands, the
   next open has no topic, and the new-day greeting opens instead.
7. Nothing ever credits the lesson, so the Well Done drawer never appears.

## Two defects, both of omission

### 1. Three re-arm guards that never asked whether the lesson was over

`_attemptReconnect` (VTID-03746), `_resetAndReconnect` (VTID-03770) and the
`_sessionStart` send site (VTID-03774) each re-armed the topic on:

```js
_s._guidedTopicInFlight && !_s.guidedTopic   // and the same thing reversed
```

Correct, and incomplete. `_guidedTopicInFlight` means *this overlay-open was
opened on a topic* — it lives until `_hide()`. It does **not** mean the topic
still needs teaching. `_guidedTopicTeachingEnded` has existed since
VTID-03781 and answers exactly that question; **none of the three consulted
it.**

Each guard was added in a different VTID, by copying the previous one. That is
why the missing check is missing three times: the condition was duplicated
rather than shared, so the fix for the last one never reached the first two.
Same shape as VTID-03644's five diverging language maps and VTID-03696's
desynced `paths:` list.

**Fix:** one predicate, `_shouldResumeGuidedTopic()`, consulted by all three:

```js
if (!_s._guidedTopicInFlight) return false;      // nothing to resume
if (_s.guidedTopic) return false;                 // already armed
if (_s._guidedTopicTeachingEnded) return false;   // lesson is over — never replay
```

A fourth reconnect path cannot reintroduce the loop by forgetting to ask.

### 2. The delivered-audio flag was nested inside a one-shot

`_guidedTopicAudioDelivered` is what tells the server "this is a RESUME, do
not re-narrate". It was set inside:

```js
if (_s.guidedAutoClose && !_s.greetingComplete) { … }
```

`guidedAutoClose` is a **one-shot**: cleared on the first turn-complete,
re-armed only by a fresh tap. So every turn-complete after the first left the
flag unset, and the reconnect told the server "fresh open" — which is the
instruction that replayed the whole narration.

The condition that actually governs the flag is "a guided topic is in flight
and turn-1 audio just finished". It now has its own gate, immediately before
the auto-close block, coupled to nothing.

## Why no Well Done drawer

Nothing was broken in the drawer. `GuidedJourneyCatalog.tsx`'s congrats
drawer, `completePractice`, and the 5-minute backstop all already exist and
are tested. They were simply unreachable: crediting was wired only to
`onGuidedTopicTeachingEnd`, which fires from the model's tool call or the
backstop — and in this failure the session never reached a clean end at all.

**Fix:** closing an overlay whose lesson was *delivered but never credited*
now credits it. `_hide()` captures the pending completion **before** clearing
the flags, marks teaching ended (so the tool call and this path cannot
double-fire), and fires `onGuidedTopicTeachingEnd(topicId,
'overlay_closed_after_delivery')` after teardown, guarded so a throwing host
handler cannot break close.

Gated on `_guidedTopicAudioDelivered` deliberately: only true once turn-1
audio actually played. Without that gate this reintroduces VTID-03784's false
completion — a lesson marked done that was never heard.

## Tests re-recorded, not worked around

Seven pre-existing assertions pinned the superseded literal conditions. They
were re-recorded to assert the same invariants through the predicate, each
with an inline note saying what changed and why, plus:

- a new assertion that the predicate still carries **both** original conjuncts
  (so the re-records cannot stand on a weakened predicate), and
- `not.toMatch` guards that the teaching-blind literal is gone from every
  site, so a second ungated re-arm cannot creep back.

## Mutation verification

| mutation | result |
|---|---|
| A — restore the teaching-blind literal at one re-arm site | **3 tests fail** |
| B — re-nest the delivered flag inside `guidedAutoClose` | **3 tests fail** |
| C — neuter the completion crediting (`if (false && …)`) | **1 test fails** |

Mutation C initially passed — the assertion matched a substring of the
condition, so a neutered gate slipped through. That was a real hole in this
VTID's own tests, found by running the mutation rather than assuming it. The
assertion now pins the whole condition anchored on `if (` and `) {`, which
catches both neutering and narrowing.

## Not fixed here

- The model ending a lesson conversationally instead of calling
  `end_guided_topic_teaching` is unchanged. This makes that harmless (the
  close credits the lesson) rather than fixing the tool-call compliance
  itself.
- `orb-live.ts:15059` reports `env: isDevSandbox() ? 'dev-sandbox' :
  'production'` — a hardcoded literal, not the real stack. It is why a staging
  session's telemetry reads `production`. Flagged, not fixed; it is a
  diagnostics defect of its own and does not belong in this diff.
