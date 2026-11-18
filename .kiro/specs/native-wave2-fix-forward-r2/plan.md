---
change_class: standard
---
# Plan — native-wave2-fix-forward-r2
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only: `apps/mobile/**` and `docs/validation/**`;
no web screen, no backend, no gateway change, no migration, no `packages/core` change, no i18n shard). Spec:
`requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder. Program: `docs/programs/native-app/program.md`
(`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md`, VTID-05021).

<!-- plan:begin -->
Re-plan note (2026-11-08T12:10Z): this is the plan of `native-wave2-fix-forward` (PR #4664) under a new slug, because the old branch carries `_plan` commits from two Kiro sessions (the original author and the session that answered its sparring), which Collab handoff refuses for a `_plan` lane. Content is the version that converged there (session efadbe18-afbe-452c-8138-e3a248f109e7, 2026-11-08), incl. its sparring answers; unchanged except the slug, and the lane-file fixes: the `utility-bar`, `public-entry` and `screen-backfill` lane files no longer say "waits for open PR" (vitana-v1 #1573, #1575, #1565, #1553, #1584 and #1562 have merged) and `tasks.md` drops the note that lanes must fix their own files.
## Goal
Close the follow-ups that native Wave 2 lanes recorded but could not do inside their own `paths`: one shared native
utility bar (with one shared gift-voucher modal and a global Life Compass host) backfilled into Home and Daily Diary;
the ORB guided-topic hooks My Journey needs; the public storefront at `/` and cold-start `/i/:code` invite links;
per-suite test timeouts in four merged test folders; the AI-key sheet in Connectors; a native product analytics
client; and a dedicated `/discover/ai-picks` screen. Owner instruction: "continue, what are you waiting for" (driver
session `kiro-exafyltd-202611011658-9f52`, which holds the `native-wave2-fix-forward-r2/_plan` claim). The follow-ups
come from the driver tracker entries of 2026-11-02 (shell, ORB, public, tests, connectors, platform).

## Today (vitana-v1 origin/main `a763b4f01`)
Every follow-up below was measured on `aac65bfeb` and **re-checked on `a763b4f01` for sparring round 1**: none is fixed
on main, so none is dropped. The line numbers below are from `aac65bfeb`; a lane re-reads a file on main before editing
it. What changed since: **#1573, #1575, #1565, #1553, #1584 and #1562 have merged** (their files below are now on main,
not in open PRs); **#1566 (autopilot-audiobook) closed unmerged** and **#1567 (vitana-index-biology) is still open**.
On main now: `screens/{discover,marketplace-orders,journey}/UtilityBar.tsx` and `VoucherModal.tsx`,
`screens/discover/LifeCompassPopup.tsx`, `screens/health/HealthUtilityBar.tsx` (+ `events.ts`),
`screens/journey/seams.ts` (no-op bridge, `:49-63`), `screens/public/{PublicLandingScreen,InviteLandingScreen}.tsx`
(landing still "Not mounted yet"), `screens/ai-assistants/AIAssistantConnectSheet.tsx`, `app/(public)/i/[code].tsx`,
`tests/discover-commerce/ai-picks-cold-start.test.tsx` and the `/discover/ai-picks` alias comment in
`navigation/resolve.ts:65`. Still absent on main: `src/shell/utility/`, any `vitana:open-life-compass` /
`gift-voucher:open` listener (`OverlayHost.tsx:10-21` is unchanged), `guided_topic_id`, `focusGuidedTopic`, an
analytics client, a `/discover/ai-picks` route, a `/` storefront (`app/index.tsx` and `PUBLIC.LANDING` `not_started` at
`ledger.json:1841-1847` unchanged), and the Connectors AI-key sheet (`ConnectorsScreen.tsx:181-183` unchanged). Home and
Daily Diary still carry the deferral comments (`HomeScreen.tsx:16`, `DailyDiaryScreen.tsx:15`).

1. **Utility bar.** The mobile-web bar is `UtilityActionButton` (`src/components/ui/utility-action-button.tsx`): page
   children → Life Compass → Gift Voucher (hidden when `isIAPRestricted()`, `:43`) → `afterGiftVoucherChildren` →
   `trailingElement` (`:26-27`, `:99-125`); it owns its `MaxinaVoucherModal` (`:131`). Mobile web renders it on Home
   (`src/pages/Home.tsx:713-746`: search, mode pill, invite, calendar, create post; then Index and Autopilot chips) and
   on Daily Diary (`src/pages/MobileDailyDiary.tsx:86-108`: search, mode pill, calendar; then the two chips). Home is
   always the non-spotlight branch on a phone (`src/hooks/useSpotlightEnabled.ts:50`). Native main has no utility bar:
   `HomeScreen.tsx:16-21` and `DailyDiaryScreen.tsx:15-20` document the deferral and render only `MobileModePill`
   (`HomeScreen.tsx:276`, `DailyDiaryScreen.tsx:79`). Four lane PRs built their own bars (#1573, #1575, #1565 and #1562 are merged on main; #1566 and #1567 carry copies but #1566 is closed unmerged and #1567 is open):
   `screens/discover/UtilityBar.tsx` (#1573), `screens/marketplace-orders/UtilityBar.tsx` (#1575),
   `screens/journey/UtilityBar.tsx` (#1565, also in #1566), `screens/health/HealthUtilityBar.tsx` (#1562, also in #1567).
2. **ORB guided topic.** Native `buildStartPayload` has no guided-topic field (`apps/mobile/src/orb/protocol.ts:239`,
   type `:105-117`); `end_guided_topic_teaching` only ends the session (`protocol.ts:190`, `session.ts:355-358`); the
   controller has no `focusGuidedTopic` (`orb/ui/orb-controller.ts:68-84`). Web: `orbActivate.ts:79-83` calls
   `VitanaOrb.focusGuidedTopic`; the widget's teaching-end callback becomes the window event
   `vitana:guided-topic-teaching-complete` (`src/hooks/useOrbVoiceWidget.ts:292-294`), which
   `GuidedJourneyCatalog.tsx:235` listens to. The journey lane (#1565) ships a no-op bridge for this
   (`screens/journey/seams.ts:18-20`, `:49-63`) because `apps/mobile/src/orb/**` is outside screen lanes.
3. **Life Compass and gift-voucher listeners.** Nothing on native main listens for `vitana:open-life-compass` or
   `gift-voucher:open` (grep of `apps/mobile/src`); `OverlayHost.tsx:12-21` hosts only the admin-in-browser sheet. Web
   hosts the popup once, app-wide (`src/context/LifeCompassPopupContext.tsx:14`, `:32`). The open PRs emit these events
   (journey, marketplace, health-hub: `HealthUtilityBar.tsx:21-27`) or open a private popup copy when no host exists
   (#1573 `screens/discover/LifeCompassPopup.tsx:10-14`). `gift-voucher:open` is a native-only event (no web listener).
4. **Public entry.** `apps/mobile/app/index.tsx:12-17` redirects signed out to `/maxina`; the ledger lists `/` as
   `native_only` (`apps/mobile/parity/ledger.json:5-8`) and `PUBLIC.LANDING` (`/`) as `not_started` (`:1841-1847`).
   Web `/` is the storefront (`src/App.tsx:818`, `ShareEntry fallback={<Index />}`). The native storefront screen is in
   #1553 (`screens/public/PublicLandingScreen.tsx:16-19`: "Not mounted yet … A follow-up lane mounts this screen").
   Cold-start invites: `+native-intent.tsx:10-17` hands every link to the link router and returns `null`; the router
   only delivers an invite to the auth port (`src/linking/link-router.ts:63-65`), which keeps it until a handler
   registers (`src/linking/auth-port.ts:25-48`). On main no code calls `onInviteLink`; in #1553 only
   `InviteLandingScreen.tsx:32` does, and that screen mounts only after something navigates to `/i/:code`. A link that
   opens the app therefore lands on `/` and the code is never read.
5. **Test timeouts.** `tests/memory`, `tests/diary`, `tests/community` and `tests/ui` set neither
   `configure({ asyncUtilTimeout })` nor `jest.setTimeout` (grep). Tracker entries name the reds under load:
   `memory/gateway-i18n` and `diary/gateway-i18n` (`describe('community gateway contract')`, `:45` / `:46`),
   `community/find-partner`, `community/members`, `ui/catalogue` (`describe('profile gate')`, `:65`). The settings
   folder already uses the fix (`tests/settings/helpers.tsx:26-28`: `asyncUtilTimeout: 5000`, `jest.setTimeout(30000)`).
   Every test file in the four folders imports its `helpers.tsx` except two synchronous suites
   (`diary/app-config-plugins.test.ts`, `ui/tokens-contract.test.ts`).
6. **Connectors AI key.** Path confirmed: `apps/mobile/src/screens/support/ConnectorsScreen.tsx:181-183` falls through
   to `placeholder(i)` (`:146`) for ChatGPT and Claude (`screens/support/data/connectors.ts:117-118`). Web opens
   `AIAssistantConnectModal` for those two ids (`src/components/settings/MobileConnectedAppsView.tsx:261-264`,
   `:538-543`). The native twin `AIAssistantConnectSheet` is in #1584 (`screens/ai-assistants/AIAssistantConnectSheet.tsx:49`).
7. **VoucherModal copies.** Three near-identical copies of the web `MaxinaVoucherModal`, each on its own lane's ports
   and data module: `screens/discover/VoucherModal.tsx` (485 lines, #1573), `screens/marketplace-orders/VoucherModal.tsx`
   (486, #1575), `screens/journey/VoucherModal.tsx` (484, #1565 and #1566). Each is imported only by its lane's
   `UtilityBar.tsx` and by `tests/discover-commerce/voucher.test.tsx` (#1573 and #1575) or `tests/journey/voucher.test.tsx`.
8. **Analytics.** No native analytics client on main (grep of `apps/mobile/src` and `packages/core/src` for
   `analytics`, `track(`). Web sends product events through `src/lib/product-analytics/client.ts` to
   `POST /api/v1/analytics/events/batch` (`:37`; batches of 10 / every 10 s / max 100, `:41-44`; event shape `:240-256`
   with `source: "web"` at `:251`) and a `screen_viewed` event per route change from `src/components/AnalyticsTracker.tsx:60-70`
   (mounted at `src/App.tsx:782`). The gateway schema accepts `source` `ios` and `android`
   (vitana-platform `services/gateway/src/routes/product-analytics.ts:68`). Web also posts `/api/v1/analytics/celebrate`
   from `celebrate()` (`src/lib/celebrate.ts:130-180`); the only native celebrate post is the journey-local `screens/journey/celebrate.ts` (`POST /api/v1/analytics/celebrate`,
   VTID-05461), so a shared native `celebrate()` does not exist and is not part of this plan (decision 8).
9. **AI picks.** Web `/discover/ai-picks` renders `AIPicksPage` (`src/App.tsx:1034-1038`; phone layout in the non-spotlight
   return of `src/pages/discover/AIPicksPage.tsx:303-437`, `isMobile` at `:312`, `:316`, `:369`). Native main has no route; #1573 aliases the path to
   `/discover?tab=suggested` in `src/navigation/resolve.ts:52-55` and tests it in
   `tests/discover-commerce/ai-picks-cold-start.test.tsx:37`. The ledger has no `/discover/ai-picks` row
   (`DISCOVER.AI_PICKS` uses `web_path: /discover?tab=suggested`, `ledger.json:929-930`).

## Decisions
1. **Six lanes, disjoint `paths`** (table below). `apps/mobile/src/orb/**` is only in `orb-guided-topic`. No file is in
   two lanes.
2. **Dependencies are re-checked against main.** #1573, #1575, #1565, #1553, #1584 and #1562 are merged, so
   `utility-bar`, `public-entry` and `screen-backfill` have no open-PR wait left except the stacked #1566, which closed
   unmerged: its autopilot/audiobook bar copy does not exist on main, so `utility-bar` has no #1566 file to delete (the
   journey `VoucherModal.tsx` arrived with #1565). #1567 (open) is not a dependency: `screens/health/HealthUtilityBar.tsx`
   is on main from #1562, and if #1567 merges first its bar is left as it is (it already emits the bus events). `depends_on` lists only lanes of this plan; each lane file names its PRs. **Fallback:** if
   one of those PRs closes without merging, the lane drops only the task that needs it, keeps the rest, and logs it.
3. **One utility bar, one voucher modal, one Life Compass popup** under `apps/mobile/src/shell/utility/`. The discover
   copies (the most complete: Life Compass popup and its data hook exist only there) move there; the marketplace and
   journey copies are deleted and their bars import the shared modal. Per-lane bars stay; replacing them is not asked.
4. **Global hosts in `OverlayHost`.** It registers `vitana:open-life-compass` (shared popup) and `gift-voucher:open`
   (shared modal, `returnTo` = event detail or the current path). The shared bar's buttons emit those events, so every
   bar that already emits them (journey, marketplace, health-hub) starts working with no change to its files, and the
   discover rail's "emit when a host listens" rule (#1573 `UtilityBar.tsx:17-20`) picks the host. IAP gate unchanged:
   `Platform.OS === 'ios'` (`shell/components/SideDrawer.tsx:105`, `shell/logic/drawer.ts:37`).
5. **ORB: new protocol field, one controller method, one bus event.** `focusGuidedTopic(topicId)` starts a session whose
   start payload carries `guided_topic_id` (widget `orb-widget.js:2594`, `:6297-6300`). Teaching end fires once per
   topic on the directive (`orb-widget.js:3908-3921`), the idle/ceiling backstop (45 s idle after audio, 5 min ceiling,
   checked every 5 s: `:5407-5408`, `:5432`, `:6349-6355`) or close after audio was delivered (`:5602-5605`), and is
   emitted on the overlay bus as `vitana:guided-topic-teaching-complete` `{ topicId, reason }`, the web event name.
   **Implementation split (R1-F2):** (a) the session's directive handler (`session.ts:355-358`, today one branch for all
   of `SESSION_END_DIRECTIVES`) compares the directive string and, only for `end_guided_topic_teaching`, first calls the
   new optional dep `onGuidedTopicTeachingEnd(topic_id, reason)`, then drains and ends as today; `end_conversation` and
   `end_teaching_session` take exactly today's path (a test pins that they emit nothing). (b) The idle (45 s) and
   ceiling (5 min) backstops, the 5 s check, the idle clock and the close-after-audio trigger have no native
   counterpart today: they are **new native logic** written in `orb-controller.ts` (explicit task 4 in `tasks.md`), not a
   restatement of widget lines. (c) One controller `reportTeachingEnd(reason)` is the single emitter for all three
   triggers and holds the once-per-topic guard, so a directive followed by a timer or a close fires once.
   Journey's bridge (`seams.ts`) is wired in `screen-backfill`, not in the ORB lane.
6. **Storefront at `/`, invites through the router.** `app/index.tsx` renders #1553's `PublicLandingScreen` for a
   signed-out user (signed in: `/home`, as today). The link router also navigates an invite link to `/i/<code>` as soon as
   the navigator is attached, with no sign-in hold (the route is public, `src/App.tsx:877`), and still delivers it to
   the auth port. **Bypass mechanism (R1-F1):** the existing `held`/`flush()` pair is untouched, because `flush()` requires
   `deps.isSignedIn()` (`link-router.ts:44-50`) and a cold-start signed-out user has `session === null`
   (`auth-port.ts:55`). `dispatch` `case 'invite'` calls `deliverInviteLink(link)` and then sets a separate slot
   `heldPublic = '/i/' + encodeURIComponent(code)` and calls `flushPublic()`, which navigates when a navigator is attached
   and has no sign-in check; `attachNavigator` calls `flushPublic()` as well as `flush()`. Latest invite wins; the slot
   is cleared when it navigates. The red test builds a router with `isSignedIn: () => false`, delivers `/i/ABC123`
   before `attachNavigator`, and asserts the navigator receives `/i/ABC123` on attach (and at once for a warm link). The ledger row `PUBLIC.LANDING` becomes `native`; the `/` entry leaves `native_only`.
7. **Timeouts in each folder's `helpers.tsx`**, the settings pattern (`asyncUtilTimeout: 5000`, `jest.setTimeout(30000)`).
   `jest.config.js` and `jest.setup.ts` are not touched. **Conflict check (R1-F3), done on `a763b4f01`:** no file in
   `tests/{memory,diary,community,ui}` calls `configure(` or `jest.setTimeout(` (the one `setTimeout` hit,
   `memory/gateway-i18n.test.tsx:130`, is a plain `setTimeout(res, 0)` delay), so there is no per-test override to
   conflict with. The two helpers that differ in shape (`community/helpers.tsx`, imports at `:10-17`; `ui/helpers.tsx`,
   imports at `:2-9`) have no configure call today, and both are imported first-party by every test file of their folder
   except `diary/app-config-plugins.test.ts` and `ui/tokens-contract.test.ts` (checked by listing imports). `configure`
   is a module-global and `jest.setTimeout` is per test file, so the statements are placed right after the imports and
   do not depend on import order. The lane re-runs the same grep before editing and records it in `commands.log`.
8. **Analytics = `track()` + `screen_viewed`.** A native client with the web event shape, `source` = `Platform.OS`,
   consent and tenant hold as web, mounted once in `ShellRoot`. Call-site events (`track(...)` inside screens) and the
   celebrate post wait for the screens and the native `celebrate()` that would send them. No new endpoint.
9. **AI picks gets its own screen** at `app/(app)/discover/ai-picks.tsx`, a port of the mobile branch of `AIPicksPage`
   on #1573's discover ports, product drawer and add-to-cart; `resolve.ts` lists `/discover/ai-picks` as native in place
   of #1573's alias, and the alias test moves to the new route at equal strength.

## Lanes
| Lane | Seat → reviewer | Scope (follow-ups) | depends_on |
|---|---|---|---|
| `utility-bar` | exafyltd → agent:vitana-lane-reviewer | 1, 3, 7: shared bar, voucher modal, Life Compass host; Home + Diary backfill; delete 3 modal copies | — (waits #1573, #1575, #1565/#1566) |
| `orb-guided-topic` | exafyltd → agent:vitana-lane-reviewer | 2 (ORB side): `guided_topic_id`, `focusGuidedTopic`, teaching-end event | — |
| `public-entry` | exafyltd → agent:vitana-lane-reviewer | 4: storefront at `/`, invite link navigation, ledger row | — (waits #1553) |
| `test-timeouts` | exafyltd → agent:vitana-lane-reviewer | 5: per-folder timeouts in four test helpers | — |
| `analytics` | exafyltd → agent:vitana-lane-reviewer | 8: native product analytics client + `screen_viewed` | — |
| `screen-backfill` | exafyltd → agent:vitana-lane-reviewer | 2 (journey bridge), 6 (AI key sheet), 9 (AI picks screen) | `orb-guided-topic` (waits #1565/#1566, #1584, #1573) |

Exact `paths` are in each `lanes/<lane>.md`. Shared files: none. Hot files: `apps/mobile/parity/ledger.json` only in
`public-entry`; `apps/mobile/src/navigation/resolve.ts` only in `screen-backfill`; both are rebased on latest main
before merge (serialized landing). Open PRs that touch this plan's files: `screens/journey/seams.ts` (#1565, #1566) and
every utility/voucher file (their own PRs), covered by decision 2. `apps/mobile/src/auth/link-bridge.ts` (#1554, #1559)
is avoided: invites go through `link-router.ts`, which no open PR touches.

## Test plan
- **Red first, offline**, one folder per lane under `apps/mobile/tests/` (`utility-bar/`, `orb/guided-topic/`,
  `public-entry/`, `test-timeouts/`, `analytics/`, `screen-backfill/`); fake gateway, fake `fetch`, mocked
  `expo-router`. Each new test is red on `origin/main` (or on the merged dependency head) for the gap it closes; the
  red output goes to `docs/validation/<VTID>/red-on-base.txt`.
- Tests that move to a new state (`tests/index.test.tsx` signed-out case, the two voucher suites, the AI-picks alias
  test) keep or raise their assertion strength; no test is skipped or deleted without its assertions moving.
- From `apps/mobile/`: `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`.
- `docs/validation/<VTID>/staging-tests.json` lists only `npm run X` / `npx jest P` refs.
- **Staging proof:** not verified on staging: the native app has no staging deploy and device runtime waits for G1
  (`next_actor: owner`). The tests above cover each outcome.

## Risks
- **Signed-out cold start changes** from the Maxina sign-in to the storefront grid (web `/` parity, decision 6). The
  Appilix web shell opens `/home` directly (`src/hooks/useSmartRouting.tsx:108-112`), so today's Maxina mobile-web users
  never see `/` on a cold start. PLAN-SPAR or the owner may prefer keeping `/maxina`; the fallback keeps today's redirect
  and ships only the invite fix.
- `utility-bar` is the largest lane and waits for three open PRs. If one stalls, the lane still ships the shared
  components, the hosts, the backfill and the copies that did merge (decision 2).
- Native analytics sends product-interaction data; the iOS privacy manifest and store data labels must declare it
  before store submission (no manifest on main: `app.config.ts` has none). Flagged for G3, not changed here.
- The ORB lane changes the start payload; the ORB parity CI check and `tests/orb/**` must stay green.

## Unchanged
`packages/core/**`, gateway and Supabase, the web app, `jest.config.js`, `jest.setup.ts`, i18n catalogs (every string
uses an existing web key), `apps/mobile/src/auth/**`, `app/_layout.tsx`, `+native-intent.tsx`, the per-lane utility
bars' layout, every other redirect target.
<!-- plan:end -->
