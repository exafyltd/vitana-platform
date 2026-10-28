# VTID-03763 — stale-poll clobber loses guided_topic_id on a fresh tap +
# auto-complete practice on guided-topic teaching end

User report (verbatim, most recent and most authoritative): "do whatever it
takes to implement that clicking the session starts a guided-topic content,
and after it finishes the user sees Well done drawer, not the Orb (Vitana)
switches to a new day greeting! And of course, don't forget marking
listened step/session as done!"

## Investigation

Two prior fixes in this chain (VTID-03746, VTID-03762) each addressed a
real, confirmed defect, but a live staging retest — with the reporting
user's own device-preview environment confirmed set to Staging (AWS), not
production — still showed the guided-topic content never starting on a
tap, Vitana opening a generic new-day greeting instead. Traced live via
`oasis_events` for the reporting user's session: the wake-brief candidate
list showed `all_sources_skipped` — `guided_topic_narration` was never even
attempted, meaning `guided_topic_id` never reached the server on the raw
request body. Independently confirmed server-side: `live-session-controller.ts`'s
`isGuidedTopicSession` fast-bootstrap-path check was false for that session
(it took the slow, memory/history-laden bootstrap path instead), which
requires `typeof body.guided_topic_id === 'string' && !!body.guided_topic_id`
to be true — so this is two independent signals agreeing the field was
absent on the wire, not a downstream ranking bug.

Root cause, found by static code reading of `orb-widget.js` (rapid-re-tap
race and `updateContext`'s dead `guided_topic_id` clobber path were both
considered and ruled out — see commands.log): several `setTimeout`-chained
polling loops in this file use `if (!_s.active) return;` as their ONLY
staleness guard. `_s.active` is a single module-level flag shared by every
session, not scoped to the poll's own session. A poll spawned by session
N's `turn_complete` handler (`_waitForAudioEnd`) can survive past session
N's own teardown; by the time its next 300ms tick fires, session N+1 — a
genuinely fresh, deliberate tap — has already flipped `_s.active` back to
`true`. The stale poll then misreads "a session is active" as "my session
is still active," and one of its own branches
(`if (_s.guidedAutoClose && !_s.greetingComplete) { _s.guidedTopic = null; ... }`)
clobbers the NEW session's freshly-armed `_s.guidedTopic` before
`_sessionStart()` ever gets a chance to read it into the WS/SSE start
payload. Three sibling polling loops in the same file
(`_waitForGoodbyeEnd`, `_waitForNavReady`, and VTID-03762's own
`_endGuidedTopicTeaching` helper) share the identical vulnerability shape —
none of them are proven causes of this specific report, but all four can
misfire against a later session's state (`_hide()`, redirect, or navigate
on behalf of a session that isn't theirs), so all four are fixed
identically rather than only the one implicated here.

Separately, the user's ask includes a NEW requirement not covered by
VTID-03746/03762: automatically marking the listened step/session as Done
once teaching ends. Investigation confirmed this genuinely does not happen
anywhere today — `recordSessionListened` (the "+2 Vitana Index" reward)
fires at TAP time, not after listening, and is a different, lesser signal
than the actual checkmark (`completedSet`, driven by `completePractice()`)
which — before this VTID — only fired from the drawer's explicit
"Open feature" / "Mark as Done" buttons. VTID-03762's own
`onGuidedTopicTeachingEnd` widget callback existed in `orb-widget.js` but
was confirmed completely unwired on the `vitana-v1` side (zero references
in `useOrbVoiceWidget.ts`/`orbActivate.ts`).

## Fix

**Part 1 — session-generation guard (`services/gateway/src/frontend/command-hub/orb-widget.js`):**

A new monotonic `_s._sessionGeneration` counter, starting at 0, is bumped
at both `_s.active = true` sites (the SSE and WS session-start success
handlers — covers a fresh start AND a reconnect's fresh start identically,
since both paths funnel through the same success handlers). Each of the
four polling loops now captures `_s._sessionGeneration` into a `myGen`
variable at the moment it is created (IIFE argument for the three
self-invoking loops; a local `var` at function entry for
`_endGuidedTopicTeaching`, which is a plain function, not an IIFE), and
checks `if (_s._sessionGeneration !== myGen) return;` as the FIRST
statement on every tick — before the pre-existing `!_s.active` check and
before touching any other `_s.*` state — so a poll from a superseded
session bails out completely instead of acting on behalf of whichever
session happens to be active when its next tick fires.

**Part 2 — auto-complete on teaching end (`useOrbVoiceWidget.ts` +
`GuidedJourneyCatalog.tsx`, `exafyltd/vitana-v1`):**

`onGuidedTopicTeachingEnd(topicId, reason)` is now wired in BOTH places
`navOpts` is constructed in `useOrbVoiceWidget.ts` (the main init effect
and the auth-change reinit effect — a user can log in/out mid-session, and
both paths must carry identical wiring or the reinit path silently drops
it). The callback dispatches a `window` `CustomEvent`
(`vitana:guided-topic-teaching-complete`, `{detail:{topicId, reason}}`)
rather than importing journey-completion logic directly into the hook,
since the ORB overlay lives outside `GuidedJourneyCatalog`'s component
tree. `GuidedJourneyCatalog.tsx` adds a `useEffect` that listens for this
event and calls `completePractice(topicId)` on receipt — mirroring the
existing `markPracticeDone` button handler's own pattern
(`queryClient.invalidateQueries({queryKey: JOURNEY_STATE_QUERY_KEY})` +
`notify('screens.guidedCatalog.doneToast')` — only on success; a failed
`completePractice()` neither invalidates nor toasts, matching
`markPracticeDone`'s existing behavior). Both completion reasons (the
model calling `end_guided_topic_teaching`, and VTID-03762's 5-minute
client-side backstop) are treated identically — either way, teaching for
that topic has genuinely ended.

**Deliberately NOT done:** no change to the completion mechanism itself
(`completePractice()` / `completed_topic_ids`) — this reuses the exact,
already-proven write path the drawer's own buttons use, per this repo's
"prefer existing systems over rebuilding" rule. No attempt to distinguish
UX behavior by `reason` (model tool call vs. backstop) — both are
legitimate "teaching ended" signals and are handled identically, as
scoped in the pending-tasks note carried into this VTID.

---

AC-1 — a monotonic `_s._sessionGeneration` counter exists on the widget's
shared state, starting at 0

TEST: `services/gateway/test/frontend/orb-widget-stale-poll-generation-guard.test.ts`
— "is declared on the initial _s state, starting at 0".
Output: `outputs/jest-vtid-03763-suite.txt`

AC-2 — the counter is incremented at the SSE session-start success site,
immediately after `_s.active = true`

TEST: same file — "is incremented at the SSE session-start success site".
Mutation-verified (see `outputs/mutation-testing-log.txt`, Mutation 1):
removing both increments fails exactly this test and its WS-site sibling.
Output: `outputs/jest-vtid-03763-suite.txt`

AC-3 — the counter is incremented at the WS session-start success site,
immediately after `_s.active = true`

TEST: same file — "is incremented at the WS session-start success site".
Output: `outputs/jest-vtid-03763-suite.txt`

AC-4 — `_waitForAudioEnd` (the `turn_complete` handler's poll) captures the
generation at creation and bails on a stale generation BEFORE the
pre-existing `!_s.active` check

TEST: same file — "captures myGen from _s._sessionGeneration at IIFE
invocation" + "checks the generation guard as the FIRST statement in the
poll tick, before the pre-existing !_s.active check". Mutation-verified
(Mutation 2): removing this guard alone fails exactly these 2 tests.
Output: `outputs/jest-vtid-03763-suite.txt`

AC-5 — the generation guard in `_waitForAudioEnd` precedes the exact
`_s.guidedTopic = null` clobber this bug's root cause traced to

TEST: same file — "the generation guard precedes the guidedAutoClose/
guidedTopic clobber this bug actually caused".
Output: `outputs/jest-vtid-03763-suite.txt`

AC-6 — `_waitForGoodbyeEnd` (signup/login close) captures the generation
and bails before either its re-poll decision or its final `_hide()`/redirect

TEST: same file — "captures myGen and checks it before either scheduled
_hide()/redirect". Mutation-verified (Mutation 3): removing this guard
alone fails exactly this test.
Output: `outputs/jest-vtid-03763-suite.txt`

AC-7 — `_waitForNavReady` (`orb_directive navigate`) captures the
generation and bails before tearing down audio / navigating / hiding

TEST: same file — "captures myGen and checks it before tearing down
audio/navigating/hiding". Mutation-verified (Mutation 4): removing this
guard alone fails exactly this test.
Output: `outputs/jest-vtid-03763-suite.txt`

AC-8 — `_endGuidedTopicTeaching` (the VTID-03762 shared teardown helper)
pins the generation at function entry, before its poll IIFE is even
created, and bails before `_hide()` / the `onGuidedTopicTeachingEnd`
callback

TEST: same file — "pins myGen at function entry, before the poll IIFE is
even created" + "checks the generation guard before _hide() / the
onGuidedTopicTeachingEnd callback". Mutation-verified (Mutation 5):
removing this guard alone fails exactly the second of these 2 tests.
Output: `outputs/jest-vtid-03763-suite.txt`

AC-9 — the pre-existing VTID-03762 backstop/directive-handler behavior is
unaffected by the generation-guard fix

TEST: `services/gateway/test/orb/live/guided-topic-teaching-complete-signal.test.ts`
— all 22 pre-existing tests re-run unmodified and pass.
Output: `outputs/jest-vtid-03763-suite.txt`

AC-10 — the widget file remains valid JavaScript after every edit

TEST: `node --check services/gateway/src/frontend/command-hub/orb-widget.js`.
Output: `outputs/node-check.txt` — exit=0.

AC-11 — full gateway regression suite is clean

TEST: `npx jest` (full suite, all 713 test suites, gateway repo).
Output: `outputs/jest-full-suite.txt` — 712/713 suites passed (1
pre-existing skip), 13,421/13,456 tests passing, 0 failures.

AC-12 — the gateway package typechecks cleanly

TEST: `npx tsc --noEmit` (from `services/gateway/`).
Output: `outputs/tsc-noemit.txt` — exit=0, no output.

AC-13 — `onGuidedTopicTeachingEnd` is wired into BOTH `navOpts` object
literals in `useOrbVoiceWidget.ts` (main init + auth-change reinit)

TEST: `src/hooks/useOrbVoiceWidget.teaching-complete.test.ts` (vitana-v1) —
"declares exactly two navOpts object literals" + "both navOpts objects
declare onGuidedTopicTeachingEnd".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-14 — the callback dispatches `vitana:guided-topic-teaching-complete` on
`window`, with `{topicId, reason}`, identically at both call sites

TEST: same file — "dispatches the vitana:guided-topic-teaching-complete
CustomEvent with {topicId, reason} in both call sites" + "dispatches on
window, not some other target".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-15 — `GuidedJourneyCatalog.tsx` calls `completePractice(topicId)` when
the model signals teaching end via the tool call

TEST: `src/components/journey/GuidedJourneyCatalog.teaching-complete.test.tsx`
— "calls completePractice(topicId) when the model signals teaching end".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-16 — the same happens identically when the backstop timeout fires
instead, per the "treat both reasons identically" design decision

TEST: same file — "calls completePractice(topicId) identically when the
backstop timeout fires instead".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-17 — a null `topicId` (the widget's own defensive fallback path) is
ignored — nothing is marked done

TEST: same file — "ignores the event when topicId is null".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-18 — a failed `completePractice()` does not invalidate the journey-state
query or show the success toast, matching `markPracticeDone`'s existing
behavior

TEST: same file — "does not invalidate/toast when completePractice reports
failure".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-19 — the event listener is removed on unmount (no leak across catalog
remounts)

TEST: same file — "removes its event listener on unmount".
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-20 — the pre-existing per-topic-completion regression test
(VTID-03679) is unaffected by this change

TEST: `src/components/journey/GuidedJourneyCatalog.test.tsx` — both
pre-existing tests re-run unmodified and pass.
Output: `outputs/vitest-vtid-03763-suite.txt`

AC-21 — full vitana-v1 regression suite is clean

TEST: `npx vitest run` (full suite, vitana-v1 repo).
Output: `outputs/vitest-full-suite.txt` — 26/26 test files passed, 174/174
tests passing, 0 failures.

AC-22 — the vitana-v1 package typechecks cleanly

TEST: `npx tsc --noEmit` (vitana-v1 repo root).
Output: `outputs/vitana-v1-tsc-noemit.txt` — exit=0, no output.

## Explicitly NOT independently confirmed against live traffic

Same honest caveat as every prior row in this chain (VTID-03746,
VTID-03762, and the VTID-03644→03686 chain before them): this session has
no working live-browser verification path (Playwright's headless Chromium
cannot complete a TLS handshake through this sandbox's proxy layer to ANY
external HTTPS destination, confirmed with `https://example.com` — an
environment-level blocker, not staging-specific, and already hit and
unresolved earlier in this same session). Everything above is code-level
and log-level verification: unit tests, mutation testing isolating each
guard to its own failure set, static extraction proving the guard exists
and runs before any state mutation, full regression suites, and
typechecks. It is NOT the same as confirming, on a real device, that a
fresh My Journey tap now reliably starts guided-topic content and that the
Well done drawer appears with the correct step checked. That confirmation
needs the platform owner's own retest on staging once this deploys — per
this session's standing commitment (established earlier in this same
conversation, after two prior "fixed" reports both turned out not to be)
not to claim live success without exactly that kind of evidence.
