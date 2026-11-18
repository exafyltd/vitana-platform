# Requirements — Native Wave 2 fix-forward (native-wave2-fix-forward-r2)

Follow-ups recorded while building native Wave 2 lanes that no lane could close inside its own `paths`
(`exafyltd/vitana-v1` `apps/mobile/`). Measured on vitana-v1 `origin/main` `aac65bfeb`; every follow-up still exists
there (plan "Today"). Offline tests only (fake gateway, fake `fetch`); no live system.

## R0 — Scope
0.1 Six lanes: `utility-bar`, `orb-guided-topic`, `public-entry`, `test-timeouts`, `analytics`, `screen-backfill`.
Each changes only the files in its `lanes/<lane>.md` `paths`; no file is in two lanes.
0.2 Only `orb-guided-topic` changes `apps/mobile/src/orb/**`.
0.3 A lane opens its PR only after the vitana-v1 PRs named in its lane file have merged (plan decision 2). If one of
them closes unmerged, the lane drops only the task that needs it and logs that.
0.4 No `packages/core/**`, gateway, Supabase, migration, web-app, i18n-catalog, `jest.config.js` or `jest.setup.ts`
change. Every visible string uses an existing web i18n key (NATIVE-APP-PLAN: "all strings through the same i18n keys").

## R1 — Shared utility bar (`utility-bar`)
1.1 `apps/mobile/src/shell/utility/UtilityBar.tsx` renders, in order: page children → Life Compass → Gift Voucher →
`afterGiftVoucherChildren` → `trailing`, as `src/components/ui/utility-action-button.tsx:26-27`, in a horizontal
scroll row. Props `hideLifeCompass`, `hideGiftVoucher` as web (`:14-15`).
1.2 Gift Voucher is hidden when IAP is restricted: `Platform.OS === 'ios'` (`shell/components/SideDrawer.tsx:105`).
1.3 Shared building blocks in the same folder: `SearchButton` (expand / collapse / clear, `onSearch` optional),
`CalendarButton` (opens `/calendar`, upcoming-count badge), `VitanaIndexChip` (emits `vitana:open-index`),
`AutopilotChip` (pending-count badge, emits `autopilot:open`), with the data hooks they need.
1.4 Home (`HomeScreen.tsx`) renders the bar as mobile web `Home.tsx:713-746`: Search (filters the article list with
the web predicate, `Home.tsx:260-266`), the existing mode pill, Invite (system share sheet with
`https://vitanaland.com/download?lang=<lang>`, web `useInviteFriendShare`), Calendar, Create post (opens
`/home/compose`); after Gift Voucher the Index and Autopilot chips.
1.5 Daily Diary (`DailyDiaryScreen.tsx`) renders the bar as `MobileDailyDiary.tsx:86-108`: Search (inert, the web query
is unused), the existing mode pill, Calendar; then the Index and Autopilot chips.
1.6 The deferral comments `HomeScreen.tsx:16-21` and `DailyDiaryScreen.tsx:15-20` are updated.

## R2 — Global Life Compass and gift-voucher hosts (`utility-bar`)
2.1 `OverlayHost` registers `vitana:open-life-compass` and renders the shared `LifeCompassPopup`, once app-wide, as
web `LifeCompassPopupContext.tsx:32`, `:68`.
2.2 `OverlayHost` registers `gift-voucher:open` and renders the shared `VoucherModal`; `returnTo` is the event detail's
`returnTo` when it is a string starting with `/`, else the current path.
2.3 The shared bar's Life Compass and Gift Voucher buttons emit these two events; no bar opens a private copy.

## R3 — One voucher modal (`utility-bar`)
3.1 `apps/mobile/src/shell/utility/VoucherModal.tsx` is the one native twin of `MaxinaVoucherModal`, moved from #1573's
discover copy with its post-purchase return handling unchanged.
3.2 `screens/discover/VoucherModal.tsx`, `screens/marketplace-orders/VoucherModal.tsx` and
`screens/journey/VoucherModal.tsx` are deleted; their `UtilityBar.tsx` files emit `gift-voucher:open` instead of
rendering a copy; discover's `LifeCompassPopup.tsx` and `data/life-compass.ts` move to `shell/utility/`.
3.3 Voucher data functions left without a caller in `discover/data/utility.ts`, `marketplace-orders/data/chrome.ts` and
`journey/data/supabase.ts` are removed; `marketplace-orders/data/orders.ts` stays (used by `OrderDetailSheet.tsx`).
3.4 `tests/discover-commerce/voucher.test.tsx` and `tests/journey/voucher.test.tsx` test the shared modal with at
least their current assertions.

## R4 — ORB guided topic (`orb-guided-topic`)
4.1 `StartContext` takes `guidedTopicId`; `buildStartPayload` sets `guided_topic_id` when present (widget
`orb-widget.js:2594`).
4.2 `OrbController.focusGuidedTopic(topicId)` ends any running session and starts one carrying that topic id, as
`orb-widget.js:6297-6300`.
4.3 Teaching end fires at most once per focused topic, with `{ topicId, reason }`, on: the `end_guided_topic_teaching`
directive (`reason` from the message); 45 s of idle after audio was delivered (`idle_after_lesson`) or 5 min after
the tap (`backstop_timeout`), checked every 5 s; the overlay closed after audio was delivered
(`overlay_closed_after_delivery`).
4.4 `OrbProvider` emits it on the overlay bus as `vitana:guided-topic-teaching-complete`.
4.5 Sessions without a topic behave as today; existing `tests/orb/**` stay green unchanged.

## R5 — Public entry (`public-entry`)
5.1 `/` signed out renders #1553's `PublicLandingScreen`; signed in redirects to `/home`; loading shows the loader
(`app/index.tsx`).
5.2 An `invite` link (`/i/:code`) received by the link router is delivered to the auth port as today and navigated to
`/i/<encodeURIComponent(code)>` as soon as a navigator is attached, signed in or not; a cold-start link is held until
then. Other link kinds are unchanged.
5.3 Ledger: `PUBLIC.LANDING` `status: native`; the `/` entry is removed from `native_only` (`ledger.json:5-8`).
5.4 `tests/index.test.tsx` signed-out case asserts the storefront (was `/maxina`); the signed-in case is unchanged.

## R6 — Test timeouts (`test-timeouts`)
6.1 `tests/memory/helpers.tsx`, `tests/diary/helpers.tsx`, `tests/community/helpers.tsx`, `tests/ui/helpers.tsx` call
`configure({ asyncUtilTimeout: 5000 })` and `jest.setTimeout(30000)`, as `tests/settings/helpers.tsx:26-28`.
6.2 No test, assertion, `jest.config.js` or `jest.setup.ts` changes.

## R7 — Native analytics (`analytics`)
7.1 `apps/mobile/src/analytics/client.ts` exports `track`, `setAnalyticsContext`, `setAnalyticsConsent`,
`getAnalyticsConsent` with the web event fields (`src/lib/product-analytics/client.ts:240-256`), `source` =
`Platform.OS`, `app_version` from `expo-constants`, `device_type` `tablet` on an iPad (`Platform.isPad`), else `mobile`.
7.2 Batching as web: flush at 10 events, every 10 s, at most 100 per POST, outbox capped at 300, flush when the app goes
to background; `POST <gatewayOrigin>/api/v1/analytics/events/batch`, no credentials, no Authorization header.
7.3 Consent and context as web `AnalyticsTracker.tsx`: signed out `anonymous`, `user_id_hash: null`; signed in
`granted` with the SHA-256 hex of the user id (`expo-crypto`); `denied` drops events and clears the buffer; events wait
for a tenant id; forbidden property keys are stripped.
7.4 A `screen_viewed` journey event per path change with `previous_route` and `search_present`, mounted once in
`ShellRoot`.
7.5 No call-site `track()` and no celebrate post (plan decision 8).

## R8 — Screen backfill (`screen-backfill`)
8.1 Journey: the default ORB bridge in `screens/journey/seams.ts` calls `controller.focusGuidedTopic(topicId)` and
subscribes to `vitana:guided-topic-teaching-complete` on the overlay bus; a provided `JourneyOrbBridgeContext` value
still wins.
8.2 Connectors: tapping ChatGPT or Claude opens #1584's `AIAssistantConnectSheet` with that provider (web
`MobileConnectedAppsView.tsx:261-264`); other apps keep today's handling (`ConnectorsScreen.tsx:181-183`).
8.3 AI picks: `/discover/ai-picks` renders a native port of `AIPicksPage`'s phone layout (back to `/discover`, header,
filter tabs all / service / supplement / expert, product cards with add-to-cart and the product drawer, loading /
error / empty states); `resolve.ts` lists `/discover/ai-picks` as native; the alias test asserts the new route.

## R9 — Verification and safety
9.1 Each lane's new tests in `apps/mobile/tests/<lane folder>/` are red on base for the gap they close (R6: the
harness test) and green after.
9.2 From `apps/mobile/`: `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle` green.
9.3 `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (refs only `npm run X` / `npx jest P`),
`red-on-base.txt` and `plan-sparring.md`.
9.4 Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS write, or a test against
production. The native app has no production profile.

## Out of scope
Replacing the per-lane utility bars (discover, marketplace, journey, health); call-site analytics events; a native
`celebrate()`; the iOS privacy manifest; the doubled `/api/v1` prefix in `GuidedModeProvider.tsx:71` (plan
`native-shell-fixes`); any web change.
