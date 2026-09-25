# VTID-04521 — Navigation rebuild, Phases 3 + 4 (gateway half): speak first, confirm, offer on "where"

Plan and owner decisions: `docs/navigation-rebuild/PLAN.md`. Everything here
is behind `NAV_V2_ENABLED` (pinned `true` on staging only). With the flag off
the tools, prompts and directives are unchanged. The client half (the app
routes by its own registry, the overlay bus, `nav_result`) is
`exafyltd/vitana-v1`, same branch name. VTID-04520 is the acknowledgement
leg that both halves share.

## What changes with the flag on

1. **Speak, then navigate.** Every registry directive carries
   `after_speech: true`. The widget keeps playing the reply ("I'll open your
   diary") and runs the directive when the turn completes and its audio has
   drained (15 s safety timer). A screen closes the orb; a panel keeps the
   conversation going.
2. **No session-wide mic latch.** V2 directives no longer set
   `navigationDispatched`, the one-way flag that dropped the member's
   microphone, the model's audio and its transcripts for the rest of the
   session. The per-turn marker still stops a second navigation in one turn.
3. **The app confirms (VTID-04520).** The widget sends
   `{type:'nav_result', screen_id, route, status}` over WS or
   `/live/stream/send`. `current_route` moves only when the app reports
   `opened` (or `unknown`, an older app build that does not report). A
   refused / not-found result is kept and put in front of the next navigation
   tool result as a `NOTE:` so the model does not claim it opened. Each result
   is an `orb.navigator.acknowledged` OASIS event, so dispatched vs. opened is
   measurable.
4. **"Where" holds an offer.** A `navigate(intent "where")` answer, or the
   best of several candidates, is written as the session's pending offer
   (`navigator_v2_offer`, 5 min) when `NAV_CONTINUATION_BIND` is on, so a bare
   "yes" opens exactly that screen.
5. **The "yes" goes through the gates.** The continuation bind opened the
   stored route directly, with no checks, and set the session latch. It now
   builds the directive through `openScreen()` (known, enabled, allowed,
   right viewport, not already there), speaks first and sets no latch.
6. **Prompts describe the tools as they behave.** A V2 navigator policy
   (open vs. where, offer, yes, speak-first, panels, `NOTE:`); a V2
   `navigate_to_screen` description without the "where is … = hard
   redirect" lexicon; the intent classifier no longer names tools that do
   not exist (`navigate_to`, `get_route`, `get_route_for_path` — fixed for
   every session) and treats "where is" as where-then-offer under V2.
   `explain_feature` now returns `redirect_screen_id`, which the classifier
   tells the model to pass to `navigate_to_screen`.
7. **Every voice path.** The cascade (Transcribe → Bedrock → Polly) declares
   `navigate`, `navigate_to_screen`, `get_current_screen`; admin, backoffice
   and commerce keep `navigate_to_screen` so they can open what `navigate`
   found.
8. Fixed on the way: `navigationDirectiveSentImmediately` was never reset, so
   the turn-complete fallback skipped every later navigation in a session.

## Acceptance criteria

AC-1 A registry directive carries `after_speech: true`; the widget holds it until turn_complete and audio drain, closes for a screen, stays for a panel.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts
TEST: services/gateway/test/frontend/orb-widget-speak-then-navigate.test.ts

AC-2 A V2 navigation sets no session latch; the route moves only on the app's confirmation.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts
TEST: services/gateway/test/navigation/nav-ack.test.ts

AC-3 `nav_result` is validated and bounded, ignores stale results, records failures once, and emits `orb.navigator.acknowledged`.
TEST: services/gateway/test/navigation/nav-ack.test.ts

AC-4 A "where" answer holds an offer, an "open" one does not, and a failed hold never breaks the answer.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-5 An accepted offer opens through the gates without the latch; blocked, anonymous or already-showing screens open nothing; flag off keeps the legacy directive.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-6 Under the flag: V2 policy, V2 navigate_to_screen description, cascade and admin tool lists; no instruction names a nonexistent tool.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-7 Resolution quality does not regress with the refreshed registry (wallet popup re-enabled in vitana-v1).
TEST: services/gateway/test/nav-golden/nav-golden-registry.test.ts
TEST: services/gateway/test/nav-golden/nav-registry-loo.test.ts

AC-8 Nothing else changes: the full gateway suite passes.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

## Results

- Golden set (167 cases, sentences held out of the index): 0 wrong screens,
  0 forbidden, 0 false actions, 1 silent; 159 reach the right screen directly
  or as the first clarifying option.
- Leave-one-out over 6,941 registry phrasings: top-5 93.0%; confident
  wrong page 55 (0.79%, ratchet is a rate).
- Full gateway Jest: 1,244 suites passed, 1 skipped; 19,916 tests passed.

## Not verified here

No live voice session was run: a session writes rows as the test member on
the one production database, which CLAUDE.md forbids on every host. The
staging evidence is the `orb.navigator.acknowledged` / `resolved` events that
real staging sessions produce after this deploys (read-only query).

## OASIS

OASIS_PROOF: new event `orb.navigator.acknowledged` (vtid VTID-04520, source
`nav-ack`, status info on `opened`, warning otherwise; payload session_id,
screen_id, route, status, reason, entry_kind, applied, route_changed,
latency_ms), asserted in services/gateway/test/navigation/nav-ack.test.ts
("records the outcome as orb.navigator.acknowledged"). Registered in
`src/types/cicd.ts`. The existing `conversation.offer.*` events gain source
`navigator_v2_offer`; no new topic.
