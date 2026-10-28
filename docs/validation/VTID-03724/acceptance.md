# VTID-03724 — a tapped guided topic must outrank passive greeting rungs

Live report (staging mobile preview): "when I click a session, it starts my
new day greeting overview... it does not start the session."

## Root cause

Confirmed via `oasis_events` (read-only query against the live staging
session), then confirmed in code:

- The wake-brief ranker correctly selected the guided-topic candidate:
  `orb.livekit.next_action.candidate` — `winner:true`,
  `dedupe_key:"guided_topic:T001"`, priority 96.
- The SAME session's own `greeting_sent` event, ~1.6s later, still reported
  `wake_opener:"newday_overview"` — the daily briefing was spoken instead of
  the tapped lesson.

`services/gateway/src/services/conversation/compute-greeting-decision.ts`'s
normal ladder places rung 7b (`newday_overview`, `tryNewDayOverviewRung`)
ABOVE rung 8 (`override_v2`) — the ONLY rung that ever consulted
`ctx.guidedTopicNarrationContent`. `newday_overview`'s guard
(`shouldAttemptNewdayOverview`) was fixed by VTID-03646 to no longer require
a first name, so it now reliably fires on essentially every user's first
session of the day — silently pre-empting any guided-topic tap that happens
to land on that first session, because nothing upstream of rung 8 ever
checked for one. The safe-fast ladder had ZERO guided-topic awareness at
all — not even the (broken) priority order the normal ladder had.

## Fix

New shared `tryGuidedTopicRung()`, reusing rung 8's exact directive
composition, called at the top of BOTH ladders (right after
`silent_reconnect` on the normal ladder — a genuine transport reconnect
still stays silent) — before `day_close`/`newday_overview` get a chance to
fire. When no guided topic is pending, this returns `null` immediately and
every existing rung fires exactly as before (verified — see AC-4).

---

AC-1 — the normal ladder: a guided-topic tap outranks a due,
content-rich `newday_overview`

TEST: `services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts`
— "normal ladder: a guided-topic tap wins over a due, content-rich
newday_overview" (asserts the SAME context fires `newday_overview` without
the guided tap, and `override_v2` with it — proving the collision is real,
not a fixture artifact).
Output: `outputs/targeted-tests.txt`

AC-2 — the safe-fast ladder gets the SAME fix (it had no guided-topic
handling before this VTID at all)

TEST: same file — "safe-fast ladder: same collision, same fix — this
ladder had NO guided-topic handling before"
Output: `outputs/targeted-tests.txt`

AC-3 — `day_close` (the evening rung) yields to a guided-topic tap too,
same defect class

TEST: same file — "day_close also yields to a guided-topic tap (same
defect class, night window)"
Output: `outputs/targeted-tests.txt`

AC-4 — every rung's existing behaviour is untouched when no guided topic
is pending — mutation-verified, not asserted on faith

TEST: same file — "no guided topic, no collision → both ladders are
byte-identical to before this fix", plus the pre-existing 50 golden-snapshot
tests in the same file (all still pass unchanged, 1 snapshot deliberately
updated for a new non-behavioural diag field — see commands.log).
MUTATION: manually disabled both `tryGuidedTopicRung()` call sites and
re-ran the 7 new VTID-03724 tests — exactly the 3 that exercise the fix
failed (normal ladder, safe-fast ladder, day_close), the other 4
(no-line-yet, anonymous, silent-reconnect, no-collision) correctly still
passed. Restored the fix and re-confirmed all 57/57 green. See
commands.log for the exact commands.
Output: `outputs/targeted-tests.txt`

AC-5 — a genuine transport reconnect still stays silent even with a
guided topic pending (the lesson was already spoken in a prior turn)

TEST: same file — "a genuine silent reconnect still wins over a guided
tap — transport signal, not a new opening"
Output: `outputs/targeted-tests.txt`

AC-6 — anonymous sessions are unaffected (override_v2/guided rung never
fired for them before, still doesn't)

TEST: same file — "anonymous sessions are unaffected"
Output: `outputs/targeted-tests.txt`

AC-7 — no regression to the full orb + conversation suites

TEST: `npx jest test/orb test/services/conversation` — 194/194 suites,
3599/3605 tests passing (6 pre-existing todo), 0 failures.
Output: `outputs/full-regression.txt`

AC-8 — type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## What this does NOT fix

The user also reported the ORB overlay's X (close) button being
unresponsive in the same test session. Traced `_hide()` / `_sessionStop()`
/ `_attemptReconnect()` / `_sessionStart()` in
`services/gateway/src/frontend/command-hub/orb-widget.js` — this close
path has been hardened by multiple prior VTIDs specifically targeting
"un-closeable overlay" failure modes (VTID-03098, VTID-03292, VTID-03293,
VTID-03295, VTID-03469, DEV-COMHU-0504), and static reading found no new
code-level regression in it. Live `oasis_events` for this exact session
DID show a `nova_validation` content-filter rejection on the (wrongly
routed) newday_overview content, an automatic retry, then a long
continuous Nova speech stream (`model_start_speaking` followed by dozens
of streaming usage ticks over several seconds) — consistent with the user
attempting to close mid-stream on an unusually long response. This VTID's
fix removes that specific scenario going forward (a guided-topic tap now
gets the SHORT teaching-opener line, not the long multi-fact briefing), but
this is a plausible correlation, not a confirmed second root cause — flagged
explicitly rather than silently declared fixed. If the close button is
still unresponsive after this ships, it needs its own fresh reproduction
with more detail (does the overlay visually stay, does audio keep playing
after it visually closes, any console errors).
