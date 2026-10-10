<!-- VTID-04951 sparring record. plan sha256: 2f0895dc9af798199e1bbca601e866760ec0dcbebd59b3ceace4f1c43e95289f. Partner: plan-sparring-partner, 2 rounds, converged. Owner approval: chat, 2026-10-07. -->
# Plan: ended calendar entries say so, and "Vitana fragen" becomes a context-aware FAQ guide

**Change class:** standard (touches ORB widget, session start contract, greeting ladder)
**Repos:** `exafyltd/vitana-v1` (frontend) and `exafyltd/vitana-platform` (gateway + orb-widget.js)

<!-- plan:begin -->

## Problem (observed on device, 2026-10-07)
A calendar entry "Test 10" (live room session, Tue 6 Oct 19:08-19:23) is opened on Wed 7 Oct.
1. The entry screen still offers "Als erledigt markieren", "Zum Live-Raum" and "Vitana fragen" as if the
   event were live. "Zum Live-Raum" lands on a dead page ("Raum nicht gefunden") or on a host
   "Stream starten" page. Nothing tells the member the event is over.
2. "Vitana fragen" calls `activateOrb()` with no context, so Vitana opens as the normal community
   conversation (daily greeting ladder) and knows nothing about the entry the member is looking at.

## Owner intent
- Any action on a past event must say plainly that the event is in the past and no longer active.
- "Vitana fragen" must act as an FAQ / how-to guide for what the member is looking at ("This event has
  ended, you can't enter the room any more. Shall we find a new event for you?"), and the mechanism
  must be generic so the other ~500 features can reuse it, not a calendar one-off.

## Part A - frontend, vitana-v1 (no gateway dependency)
A1. `src/components/calendar/vcal/entry-actions.ts`: add pure `entryTimeState(item, now)` (an unparsable start time is never `ended`) returning
    `upcoming | live | ended` (end = `end_time`, else start + 60 min, same fallback as `sourceActionOf`),
    and `isEndedSourceEntry(item, now)` = ended AND has a source (community event / live room).
    `sourceActionOf` gains `ended: boolean`; `joinable` stays false once ended.
A2. `EntryScreen.tsx`: for an ended source-linked entry
    - header chip "Vorbei / Ended" instead of the countdown,
    - a banner in the footer: "Dieses Event ist vorbei und nicht mehr aktiv.",
    - "Als erledigt markieren", "Zum Live-Raum" / "Zum Event", "Verschieben" stay visible but dimmed
      (`aria-disabled`); tapping any of them calls `notify` with "Event liegt in der Vergangenheit und
      ist nicht aktiv" and does nothing else (no navigation, no completion call).
    Entries without a source (own manual entries, tasks) keep today's behaviour: marking a past
    personal task done is legitimate.
A3. "Vitana fragen" calls a new `activateOrbGuide(ctx)` (src/lib/orbActivate.ts) instead of
    `activateOrb()`. ctx = `{ feature: 'calendar_entry', state: 'ended'|'live'|'upcoming', kind:
    'live_room'|'community_event'|'other', title, startsAt, endsAt }`. Falls back to `activateOrb()` when
    the loaded widget has no `startGuide` (older build), so nothing regresses.
A4. i18n: DE first then EN/ES/AR/SR(+existing shards) under `vcal.entry.*` (`ended`, `endedChip`,
    `endedNotice`). du-form. RTL-safe (no left/right classes added).
A5. Tests: entry-actions unit tests (boundaries: 15 min before, exactly at end, no end_time),
    EntryScreen tests (banner, each dimmed button -> notify and no callback, Vitana button passes ctx,
    own manual past entry unchanged), orbActivate test (fallback). Staging spec
    `docs/validation/<VTID>/staging-tests.json` + a read-only Playwright spec that opens an ended entry.
    What's-New card: Part A is a fix, none. Part B has exactly one adopter at launch, so its card is deferred until a second screen adopts the guide (tracked as a note in the docs page from B5).

## Part B - platform, generic FAQ-guide session ("guide mode")
B1. `orb-widget.js`: new one-shot `VitanaOrb.startGuide(ctx)` modelled on `startSupportReport` /
    `startCommerceSetup` (stop any session, stash `_s.guide`, `_show()`); `_sessionStart` adds
    flat one-shot fields `guide_feature`, `guide_state`, `guide_kind`, `guide_title` (same clear-on-consume as `support_report`; `startPayload` is a local rebuilt on every `_sessionStart`, orb-widget.js:2473, so a reconnect never re-sends them).
B2. Session start (`live-session-controller.ts`, session type in `routes/orb-live.ts`): accept the four flat
    fields, each validated by its own rule: `guide_feature` (`^[a-z0-9_]{1,40}$`, else the whole guide is
    dropped and the ORB opens normally), `guide_state` (enum `upcoming|live|ended|empty|error`, else dropped),
    `guide_kind` (enum, optional), `guide_title` (max 80 chars, control characters and newlines stripped,
    quoted as data). Times are not sent: the state encodes them. A well-formed unknown feature is accepted and
    gets the generic guide opener. Kept on the session; it is DATA for the model, never instructions.
B3. Greeting ladder (`compute-greeting-decision.ts`): new rung `guide_open` (wake opener), member surface only, only while `turn_count === 0`. Precedence, in BOTH the safe-fast and the normal ladder: `support_report` > `guide_open` > `guided_topic` > `resume_thread` (an explicit support intake wins; an explicit tap on "ask Vitana" beats a queued teaching topic). Downstream, all updated in the same PR: the `WakeOpener` union, `WAKE_OPENER_ORDER` (Record, compile-time exhaustive), `WAKE_OPENERS` consumed by the Command Hub Opening tab (checked it renders the new rung), the golden snapshot of compute-greeting-decision, and the ladder expectations in `vtid-04560-role-separation-regression.test.ts` (updated, not optional). Its directive is an
    English INTENT, never a spoken sentence (Part 1 rule 41): "the member opened you from <feature>
    which is in state <state>; in one or two sentences say what they are looking at and what it means
    for them, answer the likely question, then offer ONE concrete next step you can deliver."
    State-specific intent hints live in a small table (`ended`: the event is over, they cannot enter any
    more, offer to find a new one with the event search tool). Wording is composed at runtime.
B4. System instruction: while a guide is set add a GUIDE MODE block (member surface only): the guide facts (feature, state, title) are the PRIMARY source for the first answer; `search_knowledge` is the secondary source for follow-up how-to questions, and when it returns nothing relevant Vitana says so plainly and offers the closest thing she can do instead of inventing steps; stay on the feature,
    do not run the daily briefing, do not call report_to_specialist unless the member reports a defect.
    No new tools; reuse `search_knowledge` and the existing event search.
B5. Reuse contract: adding a guide for another feature = one new `feature` value + one entry in the
    intent-hint table + a call to `activateOrbGuide` from that screen. Unknown features still get the
    generic guide opener. Document in `docs/` and the orb-widget header.
B6. Tests: greeting-decision unit test for the new rung (precedence vs support_report and guided_topic,
    anonymous, turn_count > 0, work surface unaffected), sanitiser tests (injection strings, oversize,
    wrong types), widget test (one-shot, cleared after start, not re-sent on reconnect), a collision test (guide + guided topic + support report all set) and the
    ladder expectations update in `vtid-04560-role-separation-regression.test.ts`. The command-hub ownership guard (`scripts/ci/command-hub-ownership-guard.js`) is
    checked for `orb-widget.js` edits.

## Out of scope / deferred
- Rewriting "Raum nicht gefunden" and the host "Stream starten" screens (separate VTID; the ended
  banner keeps members from reaching them from the calendar).
- Writing FAQ content for the other features: the mechanism lands here, per-feature hints follow with
  the screens that adopt it.
- Gateway-side check that the room/event really ended (the client uses the entry's own times).

## Order and rollout
Part A ships first on its own (works with the old widget). Part B ships behind the existing staging-first
pipeline; the frontend only passes context when `startGuide` exists. No migrations, no new tables, no
production testing (staging-verify read-only per CLAUDE.md).

## Risks I see
- `orb-widget.js` is a hotspot (2.3 MB, ownership guard).
- A new greeting rung can change precedence for existing sessions if the one-shot flag leaks.
- Prompt injection through the entry title carried into the model prompt.
<!-- plan:end -->

## Planner responses - round 1
- F1 ACCEPTED: precedence fixed (support_report > guide_open > guided_topic > resume_thread, both ladders) plus a collision test. See B3.
- F2 ACCEPTED: WakeOpener union, WAKE_OPENER_ORDER, WAKE_OPENERS/Command Hub Opening tab, golden snapshot and 04560 ladder expectations are now listed in B3/B6.
- F3 ACCEPTED IN PART: the rich object is gone; it is four flat validated fields like the existing one-shots, no times. REJECTED the further cut to feature+state only: the entry title is not on the session (current_route carries the URL, not the entry), and without it Vitana cannot name the event the member is looking at. The title is capped at 80, stripped, and quoted as data.
- F4 ACCEPTED: guide facts are the primary source, search_knowledge secondary with an honest "nothing found" behaviour (B4).
- F5 ACCEPTED: Part A no card (fix); Part B card deferred until a second adopter, stated in A5.
- F6 CONFIRMED, no change: startPayload is a local rebuilt in every _sessionStart (orb-widget.js:2473); reconnects call _sessionStart again so the cleared one-shots stay cleared. A widget test asserts it (B6).
- F7 ACCEPTED: wording changed to "update the ladder expectations".
- Q1: no second adopter is named today. The owner explicitly asked for a generic FAQ-guide mechanism for the other ~500 features ("Make Vitana be an FaQ guide like for other 500 features"); that is an owner decision, so the mechanism stays generic, but it is kept deliberately small (four flat fields, one rung, one hint table) so it costs little if adoption is slow.
- Q2: an unparsable start time is never `ended`; a source-linked entry without end_time uses start + 60 min like sourceActionOf. Test added.
- Q3: malformed feature -> dropped, ORB opens normally. Well-formed unknown feature -> accepted, generic guide opener. Stated in B2.

## Sparring verdict
Round 1: not converged (F1-F3 major). Round 2: CONVERGED, F8/F9 minor text inconsistencies fixed in B2 above (flat fields, title cap 80). Partner: plan-sparring-partner, 2 passes. Awaiting owner approval.
