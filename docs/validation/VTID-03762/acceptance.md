# VTID-03762 — guided-topic teaching-complete signal (My Journey)

User report (verbatim): "when we start a session, Vitana starts talking
properly about the subject of that session, or step within the session, but
when it ends, the Well done drawer does not open, but Vitana just continues
to speak in general, general communication, and you cannot interrupt her, X
does not work, or anything, which is completely incorrect. After we listen
to Vitana regarding that session, or step, the Well done drawer opens, and
that step ... is marked/checked as Done. That's how it should work and
that's how it worked before."

## Investigation

A read-only codebase investigation (no live ORB session opened, per this
repo's absolute governance rule) established:

1. The "Well done" drawer in `vitana-v1`'s `GuidedJourneyCatalog.tsx` is
   opened at TAP time (`handleTopicClick` calls `setOpenTopic(topic)`
   synchronously, the same instant it calls `activateOrb(topic.topicId)`),
   mounted underneath the ORB widget's full-screen overlay for the entire
   session. It has no completion gate of its own — it only becomes visible
   once the overlay's `display:none` is applied.
2. `orb-widget.js`'s `focusGuidedTopic()` used to auto-close the overlay
   (`guidedAutoClose`) once turn 1 completed — but that fired after just the
   short opener line, before real teaching happened, and was deliberately
   removed by VTID-03685. Its own comment (`orb-widget.js`, near the
   turn-complete handler) says explicitly: "there is no reliable signal yet
   for 'the model decided teaching is done' ... guessing at one here would
   trade a definite bug for a fragile heuristic" — a disclosed, open gap,
   not a silently-declared fix.
3. Since then, nothing closes the overlay. The GUIDE MODE system-instruction
   block (`guided-topic-narration-prompt.ts`) is re-injected for the WHOLE
   session with no turn-count limit and no other exit condition — once the
   model has covered the material, it necessarily free-wheels into ordinary
   conversation. This matches the reported symptom exactly.
4. A working, proven precedent for exactly this shape already exists:
   Teacher Mode's `end_teaching_session` tool (`live-tool-catalog.ts` /
   `orb-live.ts`) — the model calls it after its farewell line, the server
   relays an `orb_directive`, the widget closes the overlay. Never reused
   for guided topics.

## Fix

New tool `end_guided_topic_teaching`, mirroring `end_teaching_session`
exactly:

- **`live-tool-catalog.ts`**: tool declaration (name, description telling the
  model to call it AFTER teaching + answering follow-ups, optional `reason`
  parameter for telemetry) — declared unconditionally for authenticated
  sessions, same as `end_teaching_session`/`teacher_event` already are.
- **`orb-live.ts`**: dispatcher case emits `{type:'orb_directive',
  directive:'end_guided_topic_teaching', topic_id, reason}` over whichever
  transport (SSE/WS) the session uses, best-effort (wrapped in try/catch,
  always returns `success:true`).
- **`orb-widget.js`**: new `else if (msg.directive ===
  'end_guided_topic_teaching')` branch — stops accepting new audio, waits
  500ms for the queued audio to finish, then calls `_hide()`. Identical
  shape to the existing `end_teaching_session` branch. Fires an optional
  `onGuidedTopicTeachingEnd` host callback.
- **`guided-topic-narration-prompt.ts`**: all four `buildGuidedTopicNarrationBlock`
  variants (de/en × narrationAudio-already-spoken/full-teach) now instruct
  the model to call `end_guided_topic_teaching` once it has answered
  follow-ups / proposed the next step — "do NOT just keep talking in
  general conversation."

**Deliberately NOT done:** no new database write. Topic completion (the
checkmark shown in `GuidedJourneyCatalog.tsx`) still flows entirely through
the EXISTING practice-drawer buttons (`openPracticeFeature` /
`markPracticeDone`, both already calling `completePractice()` →
`completed_topic_ids`) — unchanged. Those buttons were always reachable
once the drawer is visible; the only thing broken was the drawer never
becoming visible. Auto-crediting completion from the tool call would have
bypassed the deliberate, separate "Start Practice" product step
(`GuidedJourneyCatalog.tsx`'s own header comment: "P7 wires Start Practice
→ real feature + completion") and there is no evidence that mechanism ever
worked differently.

---

AC-1 — `end_guided_topic_teaching` is declared in the authenticated tool
catalog, immediately after `end_teaching_session`

TEST: `test/orb/live/guided-topic-teaching-complete-signal.test.ts` —
"is present in the authenticated tool catalog, right after
end_teaching_session". Mutation-verified: reverting `live-tool-catalog.ts`
alone fails this and 6 other tests (4 catalog-declaration tests + 2
now-stale snapshot assertions), nothing else.
Output: `outputs/jest-vtid-03762-suite.txt`

AC-2 — the tool is NOT declared for anonymous sessions, matching every
other authenticated-only tool

TEST: same file — "is NOT present for an anonymous session".
Output: `outputs/jest-vtid-03762-suite.txt`

AC-3 — the tool takes an optional freeform `reason` parameter, same shape
as `end_teaching_session`

TEST: same file — "takes an optional freeform 'reason' parameter".
Output: `outputs/jest-vtid-03762-suite.txt`

AC-4 — the tool description tells the model to call it AFTER teaching, not
before

TEST: same file — "description tells the model to call it AFTER teaching,
not before".
Output: `outputs/jest-vtid-03762-suite.txt`

AC-5 — `orb-live.ts` has a dispatcher case for `end_guided_topic_teaching`
that emits the directive over both SSE and WS

TEST: same file — "has a case body..." + "emits an orb_directive...".
Mutation-verified: reverting `orb-live.ts` alone fails exactly these 5
tests, nothing else.
Output: `outputs/jest-vtid-03762-suite.txt`

AC-6 — the directive includes the session's active `guided_topic_id` (for
the client + telemetry)

TEST: same file — "includes the active guided_topic_id in the directive
payload".
Output: `outputs/jest-vtid-03762-suite.txt`

AC-7 — the directive emit is best-effort: wrapped in try/catch, always
returns `success:true`

TEST: same file — "never throws on a transport write failure" +
"always returns success:true".
Output: `outputs/jest-vtid-03762-suite.txt`

AC-8 — `orb-widget.js` handles the new directive and closes the overlay
the same way `end_teaching_session` already does (500ms delay, stop
accepting new audio, then `_hide()`)

TEST: same file — "handles msg.directive ===
'end_guided_topic_teaching'" + "calls _hide() after a short delay..." +
"stops accepting new audio chunks before hiding...". Mutation-verified:
reverting `orb-widget.js` alone fails exactly these 5 tests, nothing else.
Output: `outputs/jest-vtid-03762-suite.txt`

AC-9 — the existing `end_teaching_session` (Teacher Mode) branch is
untouched and both directives still funnel into the same fallback

TEST: same file — "does not disturb the existing end_teaching_session
branch".
Output: `outputs/jest-vtid-03762-suite.txt`

AC-10 — all four GUIDE MODE prompt variants instruct the model to call
`end_guided_topic_teaching`, positioned AFTER the teaching/practice
guidance (not before)

TEST: `test/orb/live/instruction/guided-topic-narration-prompt.test.ts` —
two new tests, one per branch family (post-narration + full-teach), each
asserting the string is present in both `de` and `en` output and that it
comes after the practice/next-step line. Mutation-verified: reverting
`guided-topic-narration-prompt.ts` alone fails exactly these 2 tests,
nothing else.
Output: `outputs/jest-vtid-03762-suite.txt`

AC-11 — full gateway regression suite is clean (no suite broken by any of
the four changed files)

TEST: `npx jest` (full suite, all 712 test suites).
Output: `outputs/jest-full-suite.txt` — 711/712 suites passed (1
pre-existing skip), 13,403/13,438 tests passing, 0 failures.

AC-12 — the edited files typecheck cleanly and the widget remains valid
JavaScript

TEST: `npx tsc --noEmit` (clean, no output) and `node --check
services/gateway/src/frontend/command-hub/orb-widget.js` (exit 0).
Output: `outputs/tsc-check.txt`, `outputs/node-check.txt`

AC-13 — the diff introduces no new CSP-relevant pattern in the
CSP-governed surface

TEST: ran the same check `VALIDATOR-CHECK.yml`'s "CSP Governance Gate" step
runs — `git diff origin/main...HEAD -- 'services/gateway/src/frontend/'
'services/gateway/dist/frontend/'` piped into `node
scripts/ci/validator-path-guard.cjs --csp-added-lines <diff>` — locally,
before pushing.
Output: `outputs/csp-gate.txt`

AC-14 — the changed files satisfy the `gateway_backend` VALIDATION_PROFILE's
path-ownership allowlist

TEST: ran the same check `VALIDATOR-CHECK.yml`'s "Enforce Path Ownership
Guard" step runs — `node scripts/ci/validator-path-guard.cjs
<changed-files> gateway_backend <pr-body>` — locally, before pushing.
Output: `outputs/path-ownership-guard.txt`

AC-15 — the 2 tool-catalog/system-instruction snapshot fixtures were
regenerated deliberately (not accidentally stale), and the diff contains
ONLY the new tool's insertion

TEST: ran the affected snapshot suites before and after `-u`, read the
diff shown by the failing run, confirmed it inserted exactly one new
`{name: 'end_guided_topic_teaching', ...}` block immediately after
`end_teaching_session` with no other change.
Output: `outputs/jest-vtid-03762-suite.txt` (the updated suites are part
of the full-suite run in `outputs/jest-full-suite.txt`)

---

## What could NOT be verified from this session, and why

**No live/staging exercise of the actual fix.** Per this repo's absolute
governance rule, no ORB voice session may be opened as the test account on
any host/transport, live or staging. All live evidence for the root cause
came from read-only `oasis_events` queries and a codebase investigation;
this fix's actual effect on a real guided-topic session (does the model
reliably call the new tool, does the overlay actually close, does the
drawer actually reveal the already-correct checkmark flow) is **not yet
confirmed against live traffic** — same honest caveat as every prior row in
this codebase's own guided-topic-narration changelog chain (VTID-03650
through VTID-03746), all of which depend on model tool-call compliance
that can only be confirmed by observation.

**The reported "mic/X-close unresponsive" symptom is not directly fixed
here, and may not need to be.** Static analysis of `orb-widget.js` found no
code path that disables the X-close button's click handler — it is wired
unconditionally at overlay-creation time. The most likely explanation is
that it was a SIDE EFFECT of the runaway conversation state this VTID
fixes: in half-duplex mode (production default — full duplex is
staging-only per this repo's CLAUDE.md §2e-duplex), the mic is gated shut
while Vitana speaks, and back-to-back turns with no natural stopping point
left very little window to interrupt. Giving the model a defined exit
should eliminate the runaway state that produced this symptom; whether the
mic/X-close were ever ACTUALLY broken (vs. merely felt unreachable during
an unbroken monologue) needs a real-device retest once this ships to
staging, tapping a guided-topic session and confirming (a) the drawer
opens once Vitana finishes teaching, (b) that step's checkmark is reachable
via the practice flow, and (c) mic/X-close are responsive throughout.
