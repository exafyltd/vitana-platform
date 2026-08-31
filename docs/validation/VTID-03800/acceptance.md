# VTID-03800 — acceptance

TEST: `services/gateway/test/frontend/guided-topic-ws-heartbeat-and-one-shot.test.ts` (14 new)
TEST: `services/gateway/test/frontend/orb-widget-guided-teaching-no-premature-close.test.ts` (re-recorded)
TEST: `services/gateway/test/frontend/orb-widget-unread-messages-keep-open.test.ts` (re-recorded)

| # | Criterion | Evidence |
|---|---|---|
| AC-1 | The WS keepalive sends a heartbeat that reaches `onmessage` | new suite — "sends a data heartbeat, not only a protocol ping" |
| AC-2 | The protocol ping is kept as well (ALB idle timeout, VTID-03794) | new suite — "keeps the protocol ping as well" (asserts ordering, both present) |
| AC-3 | Heartbeat shape matches SSE's, which the widget already handles | new suite — asserts `{type:'heartbeat', ts}` + widget `case 'heartbeat':` |
| AC-4 | Heartbeat rides the same 10s cadence | new suite — `}, 10_000);` closes the same block |
| AC-5 | A heartbeat send failure cannot kill the session | new suite — try/catch around the send |
| AC-6 | A narrated lesson is recorded as narrated | new suite — `msg.source === 'guided_topic_narration'` sets the flag |
| AC-7 | The terminal close fires ONLY when actually narrated | new suite — all three conjuncts pinned; **MUT B/E** |
| AC-8 | The close routes through the one shared teardown | new suite — `_endGuidedTopicTeaching(..., 'narration_complete')` |
| AC-9 | That teardown still hides the overlay and credits completion | new suite — `_hide()` + `onGuidedTopicTeachingEnd` in its body |
| AC-10 | It cannot replay: ended is set synchronously and the resume predicate reads it | new suite — guard-before-set ordering + `_shouldResumeGuidedTopic` |
| AC-11 | The non-narrated (Polly-failure) path still falls through to the mic | re-recorded VTID-03685 suite — **MUT E** |
| AC-12 | The narration flag resets on a fresh tap and on close | new suite — lifecycle block; **MUT D** |

## Mutation verification

Each guard disabled independently; the suite must go red.

| Mutation | Result |
|---|---|
| A — drop the data heartbeat, keep only `ws.ping()` | **4 failed**, 10 passed |
| B — drop the `_guidedTopicNarrated` conjunct from the terminal close | **1 failed**, 13 passed |
| C — never set the narration flag from the `source` tag | **1 failed**, 13 passed |
| D — drop the fresh-tap reset of the narration flag | **1 failed**, 13 passed |
| E — ungate the terminal close (the VTID-03685/03680 regression) | **1 failed** in the re-recorded suite |
| baseline / restored | 14 passed, 14 total |

## Full run

- Gateway suite: **734/735 suites** (1 pre-existing skip), **13,652 passing, 0 failures** — `outputs/jest-full-suite.txt`
- `tsc --noEmit`: clean — `outputs/tsc.txt`
- `node --check orb-widget.js`: parses

## Re-recorded, not weakened

- **`orb-widget-guided-teaching-no-premature-close.test.ts`** pinned "exactly one early return in this stretch". The narrated one-shot close adds a second, deliberately. Re-recorded to assert the count is two **and that the second carries the `_guidedTopicNarrated` gate** — so the invariant it exists for (the conversational path must still fall through) is still enforced, and MUT E proves it.
- **`orb-widget-unread-messages-keep-open.test.ts`** sliced a fixed 700 characters after `case 'audio':`, which made the assertion a function of how much *comment* sat above the guard — adding an explanatory comment failed a test about code that had not changed. Now bounded by the handler's own extent.

## Not covered

Whether the Well Done drawer actually appears end-to-end. `completePractice`
writes journey progress for the account; `vitana-v1`'s absolute rule forbids
that on every host including staging. Needs a human on a real device.
