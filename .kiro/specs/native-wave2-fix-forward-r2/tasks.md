# Tasks — Native Wave 2 fix-forward

Six lanes. `design.md` and `requirements.md` in this folder are authoritative; anything outside them is a plan change
(log it in the lane file). The VTID is assigned by CI after PLAN-SPAR converges; do not start a lane before `vtid:` is
set in its lane file. A lane opens its PR only after the vitana-v1 PRs named in its section have merged (plan decision
2). All commands run from `apps/mobile/` on a branch from vitana-v1 `origin/main`; every command is offline. Each lane
ends with: `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`; `docs/validation/<VTID>/`
`scope.json`, `staging-tests.json` (refs only `npm run X` / `npx jest P`), `red-on-base.txt`, `commands.log`,
`plan-sparring.md`; PR on branch `kiro/native-wave2-fix-forward-r2/<lane>`, title
`VTID-xxxxx (native-wave2-fix-forward-r2/<lane>): …`, trailers `Collab-Session: <kiro id>`,
`Collab-Lane: native-wave2-fix-forward-r2/<lane>`; lane → `in-review`. No merge, deploy or live write.


<!-- lane: utility-bar -->
## Lane `utility-bar` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: none in this plan. vitana-v1 #1573 (VTID-05510), #1575 (VTID-05511) and #1565 (VTID-05461) are merged on
main (checked on `a763b4f01`); #1566 (VTID-05460) closed unmerged, so there is no autopilot bar copy to touch. Start from
latest `origin/main`.

- [ ] 1. Red tests `tests/utility-bar/bar.test.tsx`: slot order children → Life Compass → Gift Voucher → after →
  trailing; Gift Voucher absent with `Platform.OS = 'ios'`; Life Compass and Gift Voucher emit their bus events
  (`returnTo` = current path). Red on base (module missing).
- [ ] 2. Move #1573's `VoucherModal.tsx`, `LifeCompassPopup.tsx`, `data/life-compass.ts` and the bar data functions of
  `data/utility.ts` to `src/shell/utility/` (design §1.1); add `src/ports/utility.tsx`; build `UtilityBar.tsx`,
  `buttons.tsx`, `events.ts`. Task 1 green.
- [ ] 3. Red test `tests/utility-bar/hosts.test.tsx`: signed in, emitting `vitana:open-life-compass` opens the popup
  once; `gift-voucher:open` opens the modal with the detail's `returnTo`, or the current path for a missing / non-`/`
  value; both ignored signed out; no modal on iOS. Then register both in `src/shell/OverlayHost.tsx` (design §1.3).
- [ ] 4. Red test `tests/utility-bar/home-diary.test.tsx`: Home renders Search, pill, Invite, Calendar, Create post, Life
  Compass, Gift Voucher, Index, Autopilot in web order; a query filters article cards with the web predicate; Invite
  calls `Share.share` with the flyer URL and the language; Create post pushes `/home/compose`. Diary renders Search,
  pill, Calendar, Life Compass, Gift Voucher, Index, Autopilot. Then backfill `HomeScreen.tsx` and
  `DailyDiaryScreen.tsx` (design §1.4) and update their deferral comments. Existing `tests/home/**` and
  `tests/diary/diary.test.tsx` stay green; an assertion that encoded the missing bar moves to the new state at equal
  strength.
- [ ] 5. Remove the copies (design §1.5): discover, marketplace-orders and journey bars emit `gift-voucher:open`; delete
  `marketplace-orders/VoucherModal.tsx` and `journey/VoucherModal.tsx`; drop voucher functions left without a caller;
  point `tests/discover-commerce/voucher.test.tsx` and `tests/journey/voucher.test.tsx` at the shared modal with every
  case kept. `git grep -n "VoucherModal" src` shows only `src/shell/utility/` and `OverlayHost.tsx`. A copy that does not exist on
  main (the #1566 autopilot copy) is skipped and logged.
- [ ] 6. Verify and PR (header).

**Acceptance (the reviewer agent checks these):**
- Change types: UI, Integration.
- **Outcome** — on Home and Daily Diary a member sees the same utility bar as mobile web; Life Compass opens the Life
  Compass popup from any screen that emits the event (Home, Diary, Discover, Marketplace, Journey, Health); Gift Voucher
  opens one voucher checkout outside iOS; there is one voucher modal in the native code.
- **States** — signed out (events ignored), iOS (no Gift Voucher), voucher open / purchase return / PDF / email states
  unchanged from #1573, search empty / with query.
- **Surfaces** — `HomeScreen`, `DailyDiaryScreen`, `OverlayHost`, the three lane bars. Desktop: n/a (native only).
- **Locales** — existing web keys only; the 11-locale tests of Home and Diary stay green.
- **Accessibility** — every new button has an accessibility label from its web key and a ≥ 44 pt hit target.
- **Contract** — bus events `vitana:open-life-compass`, `gift-voucher:open` `{ returnTo }`, `vitana:open-index`,
  `autopilot:open`; voucher calls as #1573 (no new endpoint).
- **Staging proof** — not verified on staging: the native app has no staging deploy and device runtime waits for G1;
  covered by `npx jest tests/utility-bar tests/home tests/diary tests/discover-commerce tests/journey`.
- New tests red on base (`red-on-base.txt`); no file outside `paths`; NATIVE-CI, PR-GATE **Collab handoff** and
  **Lane scope** green.

<!-- lane: orb-guided-topic -->
## Lane `orb-guided-topic` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: none.

- [ ] 1. Red tests `tests/orb/guided-topic/payload.test.ts`: `buildStartPayload({ …, guidedTopicId: 't1' })` has
  `guided_topic_id: 't1'`; without it the payload equals today's.
- [ ] 2. `protocol.ts` field + `StartContext` (design §2). Task 1 green.
- [ ] 3. Red tests `tests/orb/guided-topic/teaching-end.test.ts` with fake timers and the existing fake transport:
  `focusGuidedTopic('t1')` ends a running session and starts one with the topic; the directive fires
  `{ topicId: 't1', reason }` once; idle 45 s after audio → `idle_after_lesson`; 5 min → `backstop_timeout`; no idle fire
  before any audio; close after audio → `overlay_closed_after_delivery`; a second trigger after the first is ignored;
  `OrbProvider` emits `vitana:guided-topic-teaching-complete` on the overlay bus.
- [ ] 4. `session.ts`: in the directive handler (`:355-358`) branch on the directive string; only
  `end_guided_topic_teaching` first calls the optional dep `onGuidedTopicTeachingEnd(topic_id, reason)`, then drains and
  ends as today; `end_conversation` / `end_teaching_session` unchanged (test: they emit nothing). `orb-controller.ts`:
  new native logic, not present today: the per-topic record, idle clock, the 5 s check with the 45 s idle-after-audio
  and 5 min ceiling backstops, the close-after-audio trigger, and the single `reportTeachingEnd(reason)` emitter with the
  once-per-topic guard shared by all three triggers. `OrbProvider.tsx` emits the bus event. Task 3 green; `tests/orb/**`
  unchanged and green.
- [ ] 5. Verify and PR (header).

**Acceptance (the reviewer agent checks these):**
- Change types: Integration.
- **Outcome** — a native ORB session opened for a guided topic tells the gateway which topic to teach, and the app
  learns once when the lesson has ended, by the same three triggers as the web widget.
- **States** — no topic (today's behaviour), topic focused, directive end, idle end, ceiling end, close after audio,
  close before audio (no fire).
- **Surfaces** — `src/orb/**` only. Desktop: n/a.
- **Locales** — n/a: no text. **Accessibility** — n/a: no control.
- **Contract** — start payload `guided_topic_id` (orb-widget.js `:2594`); directive `end_guided_topic_teaching`
  `{ topic_id, reason }` (`:3908-3921`); bus event `vitana:guided-topic-teaching-complete` `{ topicId, reason }`.
- **Staging proof** — not verified on staging (no native staging deploy; live ORB sessions only on G1); covered by
  `npx jest tests/orb`.
- New tests red on base; ORB parity check green; no file outside `paths`; NATIVE-CI, **Collab handoff**, **Lane scope**
  green.

<!-- lane: public-entry -->
## Lane `public-entry` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: none in this plan. vitana-v1 #1553 (VTID-05451) is merged on main (checked on `a763b4f01`).

- [ ] 1. Red test `tests/public-entry/invite-cold-start.test.ts`: a router created with `isSignedIn: () => false`
  receives `/i/ABC123` before `attachNavigator`; on attach the navigator gets `/i/ABC123` while still signed out (this
  is the sign-in-hold bypass); a warm link navigates at once; the auth-port handler still receives
  `{ kind: 'invite', code: 'ABC123' }`; a non-invite link still waits for sign-in (`held` / `flush()` unchanged). Red
  on base (no navigation).
- [ ] 2. `src/linking/link-router.ts` invite navigation (design §3): separate `heldPublic` slot and `flushPublic()`
  without the `isSignedIn()` check, called by `case 'invite'` and by `attachNavigator`; `held`/`flush()` untouched. Task 1 green; `tests/g1-smoke/deep-link.test.ts`
  and `tests/resolve-link.test.ts` unchanged and green.
- [ ] 3. Red test `tests/public-entry/landing.test.tsx`: `/` signed out renders the storefront; signed in redirects to
  `/home`; loading shows the loader. Then `app/index.tsx` (design §3); move the signed-out case of
  `tests/index.test.tsx` to the storefront.
- [ ] 4. Ledger: `PUBLIC.LANDING` → `native`, delete the whole `{ "path": "/", … }` entry from `native_only` (`ledger.json:5-8`; not reworded, because its reason text becomes false), so no `native_only` `/` entry and a `native` `PUBLIC.LANDING` row never coexist; the ledger test green. If #1553 closed
  unmerged, skip tasks 3-4, keep task 2 (the link router still opens `/i/<code>`, which then renders Unported) and log
  the fallback.
- [ ] 5. Verify and PR (header).

**Acceptance (the reviewer agent checks these):**
- Change types: UI, Integration.
- **Outcome** — a signed-out user who opens the app sees the storefront web shows at `/`; a member still lands on News;
  a friend who taps an invite link with the app closed lands on the Maxina sign-up with the code kept.
- **States** — signed out, signed in, session loading; invite cold start, invite warm, invalid code (screen's rule).
- **Surfaces** — `app/index.tsx`, the link router, the ledger. Desktop: n/a.
- **Locales** — n/a: no new text (the storefront is #1553's). **Accessibility** — n/a: no new control.
- **Contract** — route `/i/<code>` as web `src/App.tsx:877`; `/` as web `:818`; ledger row `PUBLIC.LANDING`.
- **Staging proof** — not verified on staging (no native staging deploy; universal links need G1 hosts); covered by
  `npx jest tests/public-entry tests/index.test.tsx tests/g1-smoke`.
- New tests red on base; no file outside `paths`; NATIVE-CI, ledger CI, **Collab handoff**, **Lane scope** green.

<!-- lane: test-timeouts -->
## Lane `test-timeouts` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: none.

- [ ] 1. Before editing, grep `tests/{memory,diary,community,ui}` for `configure(` and `jest.setTimeout(` and record the
  (expected empty) result in `commands.log`; any hit is reconciled in that file's helper, not overridden. Red test
  `tests/test-timeouts/harness.test.ts` (design §4). Red on base for all four helpers.
- [ ] 2. Add `configure({ asyncUtilTimeout: 5000 })` and `jest.setTimeout(30000)` to `tests/memory/helpers.tsx`,
  `tests/diary/helpers.tsx`, `tests/community/helpers.tsx`, `tests/ui/helpers.tsx`. Task 1 green.
- [ ] 3. Run `npx jest tests/memory tests/diary tests/community tests/ui` three times with default workers and record
  the results in `commands.log`.
- [ ] 4. Verify and PR (header).

**Acceptance (the reviewer agent checks these):**
- Change types: Test infrastructure.
- **Outcome** — the memory, diary, community and ui suites get the same wait budget as settings, so they do not time
  out under default-worker load.
- **States / Surfaces / Locales / Accessibility / Contract** — n/a: test harness only.
- **Staging proof** — n/a: no product change; covered by `npx jest tests/test-timeouts` and the full `npm test`.
- No test, assertion, `jest.config.js` or `jest.setup.ts` changed; no file outside `paths`; NATIVE-CI, **Collab
  handoff**, **Lane scope** green.

<!-- lane: analytics -->
## Lane `analytics` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: none.

- [ ] 1. Red tests `tests/analytics/client.test.ts` (fake `fetch`, fake timers, AsyncStorage mock): event fields equal
  the web list; `source` is `ios` / `android`; events wait for a tenant; `denied` drops and clears; forbidden keys
  stripped; flush at 10, every 10 s, on background; ≤ 100 per POST; outbox ≤ 300; failed POST keeps the batch; URL
  `<origin>/api/v1/analytics/events/batch`, no Authorization header. Red on base (module missing).
- [ ] 2. `src/analytics/{client,session,types}.ts` (design §5). Task 1 green.
- [ ] 3. Red test `tests/analytics/tracker.test.tsx`: signed out → `anonymous`, signed in → `granted` with the SHA-256
  hex of the id; one `screen_viewed` per path change with `previous_route`, `search_present`. Then
  `AnalyticsTracker.tsx` and its mount in `src/shell/ShellRoot.tsx`. `tests/shell.test.tsx` unchanged and green.
- [ ] 4. Verify and PR (header).

**Acceptance (the reviewer agent checks these):**
- Change types: Integration.
- **Outcome** — the native app reports screen views to the same product analytics endpoint and in the same shape as
  mobile web, tagged `ios` / `android`, honouring the same consent states.
- **States** — signed out, signed in, consent denied, no tenant yet, offline / failed POST, app backgrounded.
- **Surfaces** — `ShellRoot` (one tracker, no UI). Desktop: n/a.
- **Locales** — n/a: no text. **Accessibility** — n/a: no control.
- **Contract** — `POST /api/v1/analytics/events/batch` `{ events: AnalyticsEvent[] }` (vitana-platform
  `routes/product-analytics.ts:48-79`); no raw user id ever leaves the device.
- **Staging proof** — not verified on staging (no native staging deploy); covered by `npx jest tests/analytics`.
- New tests red on base; no file outside `paths`; NATIVE-CI, **Collab handoff**, **Lane scope** green.

<!-- lane: screen-backfill -->
## Lane `screen-backfill` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: [orb-guided-topic]. vitana-v1 #1565 (journey), #1584 (VTID-05521, AI key sheet) and #1573 (discover) are
merged on main (checked on `a763b4f01`); #1566 closed unmerged and is not needed (`seams.ts` is on main from #1565).

- [ ] 1. Red test `tests/screen-backfill/journey-bridge.test.tsx`: with no provider, `useActivateOrb()('t1')` calls
  `controller.focusGuidedTopic('t1')`; emitting `vitana:guided-topic-teaching-complete` reaches the catalog's handler;
  a provided bridge still wins. Then `screens/journey/seams.ts` (design §6).
- [ ] 2. Red test `tests/screen-backfill/connectors-ai-key.test.tsx`: ChatGPT and Claude open `AIAssistantConnectSheet`
  with their provider; closing clears it; another AI app keeps the placeholder toast. Then `ConnectorsScreen.tsx`.
- [ ] 3. Red test `tests/screen-backfill/ai-picks.test.tsx`: loading, error, empty, list; filter tabs; card opens the
  product drawer; add-to-cart; back → `/discover`; 11 locales without missing keys. Then
  `app/(app)/discover/ai-picks.tsx`, `src/screens/ai-picks/**`, `resolve.ts`, and move
  `tests/discover-commerce/ai-picks-cold-start.test.tsx` to the new route (design §6).
- [ ] 4. Dependencies are merged (see header); if a file the task edits has changed on main, re-read it first. Log any
  skipped task.
- [ ] 5. Verify and PR (header).

**Acceptance (the reviewer agent checks these):**
- Change types: UI, Integration.
- **Outcome** — tapping a guided topic in My Journey makes Vitana teach that topic and marks it done when the lesson
  ends; ChatGPT and Claude in Connectors open the paste-key sheet as on web; `/discover/ai-picks` opens its own AI picks
  screen.
- **States** — bridge with / without provider; sheet open / closed per provider; AI picks loading / error / empty /
  list / filtered.
- **Surfaces** — My Journey guided catalog, Connectors, `/discover/ai-picks`. Desktop: n/a.
- **Locales** — existing web keys (`discover.aiPicks.*`, `connectedApps.*`); 11-locale test for AI picks.
- **Accessibility** — the AI picks back button, tabs and cards have labels and ≥ 44 pt targets.
- **Contract** — ORB controller `focusGuidedTopic` and bus event from lane `orb-guided-topic`; AI key calls as #1584;
  marketplace feed as #1573.
- **Staging proof** — not verified on staging (no native staging deploy; G1 pending); covered by
  `npx jest tests/screen-backfill tests/discover-commerce/ai-picks-cold-start.test.tsx`.
- New tests red on base (or on the merged dependency head); no file outside `paths`; NATIVE-CI, **Collab handoff**,
  **Lane scope** green.
