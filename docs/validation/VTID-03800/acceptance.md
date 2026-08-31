# VTID-03800 — acceptance

Each `AC-` below is followed by the check that proves it. Suites:

- `services/gateway/test/frontend/guided-topic-ws-heartbeat-and-one-shot.test.ts` (new, 14 tests)
- `services/gateway/test/frontend/orb-widget-guided-teaching-no-premature-close.test.ts` (re-recorded)
- `services/gateway/test/frontend/orb-widget-unread-messages-keep-open.test.ts` (re-recorded)

---

AC-1 — The WS keepalive sends a heartbeat that actually reaches the client's `onmessage`.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "sends a data heartbeat, not only a protocol ping"

AC-2 — The protocol `ws.ping()` is kept as well, so the ALB's 60s idle timeout (VTID-03794) stays covered.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "keeps the protocol ping as well — proxies need it, clients cannot see it"

AC-3 — The heartbeat uses the same `{type:'heartbeat', ts}` shape SSE already sends, which the widget already handles.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "uses the same shape SSE already sends, which the widget already handles"

AC-4 — The heartbeat rides the same 10s cadence as the ping.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "heartbeats on the same 10s cadence as the ping it rides with"

AC-5 — A heartbeat send failure cannot kill the session.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "a send failure cannot kill the session"

AC-6 — A lesson delivered as pre-rendered Polly audio is recorded as narrated.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "records that the authored lesson was delivered as pre-rendered audio"

AC-7 — The terminal close at turn-1 complete fires ONLY when the topic was actually narrated.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "ends teaching at turn-1 complete ONLY when it was actually narrated" (mutations B and E)

AC-8 — The close routes through the one shared teardown, not a second copy of it.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "routes the close through the one shared teardown, not a second copy"

AC-9 — That shared teardown still hides the overlay and credits completion.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "the shared teardown still hides the overlay and credits completion"

AC-10 — The lesson cannot replay: teaching-ended is set synchronously and the resume predicate reads it.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "cannot replay: the shared teardown marks teaching ended synchronously"

AC-11 — The non-narrated (Polly-failure) path still falls through to the listening transition.
TEST: orb-widget-guided-teaching-no-premature-close.test.ts — "a NON-narrated guided open still falls through to the listening transition" (mutation E)

AC-12 — The narration flag resets on a fresh tap and on close, so a previous topic cannot close the next one early.
TEST: guided-topic-ws-heartbeat-and-one-shot.test.ts — "lifecycle" block (mutation D)

---

## Mutation verification

Each guard disabled independently; the suite must go red. Baseline and every
restore: 14 passed, 14 total.

| Mutation | Result |
|---|---|
| A — drop the data heartbeat, keep only `ws.ping()` | **4 failed**, 10 passed |
| B — drop the `_guidedTopicNarrated` conjunct from the terminal close | **1 failed**, 13 passed |
| C — never set the narration flag from the `source` tag | **1 failed**, 13 passed |
| D — drop the fresh-tap reset of the narration flag | **1 failed**, 13 passed |
| E — ungate the terminal close (the VTID-03685/03680 regression) | **1 failed** in the re-recorded suite |

## Full run

- Gateway suite: **734/735 suites** (1 pre-existing skip), **13,652 passing, 0 failures** — `outputs/jest-full-suite.txt`
- `tsc --noEmit`: clean — `outputs/tsc.txt`
- `node --check orb-widget.js`: parses
- Re-run in full after the branch was restarted onto `main` (`c560ba9b`), not just before it.

## Re-recorded, not weakened

`orb-widget-guided-teaching-no-premature-close.test.ts` pinned "exactly one
early return in this stretch". The narrated one-shot close adds a second,
deliberately. It now asserts the count is two **and that the second carries the
`_guidedTopicNarrated` gate** — so the invariant it exists for (the
conversational path must still fall through) is still enforced, and mutation E
proves it.

`orb-widget-unread-messages-keep-open.test.ts` sliced a fixed 700 characters
after `case 'audio':`, which made the assertion a function of how much *comment*
sat above the guard — adding an explanatory comment failed a test about code
that had not changed. It is now bounded by the handler's own extent.

## Not covered

Whether the Well Done drawer actually appears end-to-end. `completePractice`
writes journey progress for the account, and `vitana-v1`'s absolute rule forbids
that on every host including staging. Needs a human on a real device.
