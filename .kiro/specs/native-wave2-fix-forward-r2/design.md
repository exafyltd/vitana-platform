# Design — Native Wave 2 fix-forward (native-wave2-fix-forward-r2)

All file:line references are vitana-v1 `origin/main` `aac65bfeb` unless a PR number is given (then the PR head on
2026-11-03: #1573 `974d8ffb8`, #1575 `e488aaa32`, #1565 `907291e62`, #1566 `f9fece133`, #1562 `e1d9f6179`,
#1553 `646f00900`, #1584 `e051341f8`). A lane re-reads its dependency files on the merged main before it edits them.

## 1. `utility-bar` — one bar, one voucher modal, one Life Compass popup

### 1.1 Files
```
apps/mobile/src/shell/utility/
  UtilityBar.tsx        bar + slot order (web utility-action-button.tsx:26-27, :99-125)
  buttons.tsx           SearchButton, CalendarButton, VitanaIndexChip, AutopilotChip, RailPill
  VoucherModal.tsx      moved from #1573 screens/discover/VoucherModal.tsx
  LifeCompassPopup.tsx  moved from #1573 screens/discover/LifeCompassPopup.tsx
  data.ts               useCalendarEvents, useVitanaIndex, useAutopilotPendingCount, voucher checkout / order / PDF /
                        email calls, moved from #1573 screens/discover/data/utility.ts
  life-compass.ts       moved from #1573 screens/discover/data/life-compass.ts
  events.ts             LIFE_COMPASS_OPEN = 'vitana:open-life-compass', GIFT_VOUCHER_OPEN = 'gift-voucher:open',
                        INDEX_OPEN = 'vitana:open-index', AUTOPILOT_OPEN = 'autopilot:open'
apps/mobile/src/ports/utility.tsx  the kit parts and icons these files draw (the discover port's subset they use)
```
The discover copies are the source because only #1573 has the Life Compass popup and its data hook, and its voucher
modal already carries the post-purchase return fix applied to all three copies (driver tracker, 2026-11-02 21:05Z).
The moved files keep their logic; only imports change (`ports/discover` → `ports/utility`) and the `returnTo` prop
stays (journey's copy hard-codes `/autopilot`; the host passes the current path, which is `/autopilot` there).

### 1.2 Bar
```tsx
<UtilityBar afterGiftVoucher={<><VitanaIndexChip /><AutopilotChip pendingCount={n} /></>} trailing={…}>
  <SearchButton placeholder={t('screens.home.searchShort')} onSearch={setQuery} />
  <MobileModePill … />
  …page buttons…
</UtilityBar>
```
Life Compass → `overlayBus.emit(LIFE_COMPASS_OPEN)`; Gift Voucher (not rendered when `Platform.OS === 'ios'`) →
`overlayBus.emit(GIFT_VOUCHER_OPEN, { returnTo: pathname })`. Labels use the web keys the copies already use
(`voucher.*`, `screens.voucher.*`, the Life Compass keys of #1573).

### 1.3 Hosts (`shell/OverlayHost.tsx`)
```tsx
const [compassOpen, setCompassOpen] = useState(false);
const [voucher, setVoucher] = useState<{ returnTo: string } | null>(null);
useBusEvent(LIFE_COMPASS_OPEN, () => setCompassOpen(true));
useBusEvent<{ returnTo?: unknown }>(GIFT_VOUCHER_OPEN, (d) =>
  setVoucher({ returnTo: typeof d?.returnTo === 'string' && d.returnTo.startsWith('/') ? d.returnTo : pathname }));
…
{compassOpen && <LifeCompassPopup open onOpenChange={setCompassOpen} />}
{voucher && !iapRestricted && <VoucherModal open returnTo={voucher.returnTo} onOpenChange={(o) => !o && setVoucher(null)} />}
```
`OverlayHost` renders inside `ShellRoot` for signed-in and public screens alike; the popup and modal need a session
for their reads and writes, so the host ignores both events while signed out (web mounts the provider inside the
authed app). The ORB's open-overlay directive already checks `overlayBus.listenerCount` (`OrbProvider.tsx:52`), so a
voice "open life compass" (registry `screens.json:3744`) starts working once this host exists.

### 1.4 Backfill
- **Home** (`HomeScreen.tsx:276` today renders only the pill): the bar of §1.2 with Search (filters the rendered
  article cards by title, summary, source name and tags, `Home.tsx:260-266`; feed items the web does not filter stay
  unfiltered), the pill, Invite (`Share.share({ title: t('screens.downloadFlyer.inviteShareTitle'), url })`, url
  `https://vitanaland.com/download?lang=<language>`, web `src/hooks/useInviteFriendShare.ts`,
  `src/lib/store-links.ts:23`), Calendar, Create post (`router.push('/home/compose')`, the existing route).
- **Daily Diary** (`DailyDiaryScreen.tsx:79`): Search (no `onSearch`: the web query is never read), the pill,
  Calendar; then both chips.

### 1.5 Copy removal
| File | Change |
|---|---|
| `screens/discover/UtilityBar.tsx` | import the shared buttons' events; Life Compass and Gift Voucher emit; no private popup / modal |
| `screens/discover/{VoucherModal,LifeCompassPopup}.tsx`, `discover/data/life-compass.ts` | moved (git mv) |
| `screens/discover/data/utility.ts` | the moved functions leave; `logActivity` and anything else with a discover caller stays |
| `screens/marketplace-orders/UtilityBar.tsx` | Gift Voucher emits; `VoucherModal` import removed |
| `screens/marketplace-orders/VoucherModal.tsx` | deleted |
| `screens/marketplace-orders/data/chrome.ts` | `createVoucherCheckout`, `waitForPaidVoucherOrder` and their constants removed if no caller remains |
| `screens/journey/UtilityBar.tsx` | Gift Voucher emits; import removed |
| `screens/journey/VoucherModal.tsx` | deleted |
| `screens/journey/data/supabase.ts` | the four voucher functions removed if no caller remains |
| `tests/discover-commerce/voucher.test.tsx`, `tests/journey/voucher.test.tsx` | import the shared modal; same cases |

## 2. `orb-guided-topic`
- `protocol.ts`: `StartPayload.guided_topic_id?: string`; `StartContext.guidedTopicId?: string`;
  `buildStartPayload` sets it when non-empty. The comment at `:239` drops "guided topic" from the N6e list.
- `orb-controller.ts`: `focusGuidedTopic(topicId: string): Promise<void>` on `OrbController` (`:68-84`): closes any
  session, records `{ topicId, openedAt, lastActivityAt, audioDelivered: false, ended: false }`, opens with
  `guidedTopicId`. Idle clock touched by model audio, a completed turn and user speech (widget `:3251`, `:3304`,
  `:4038`). A 5 s interval checks `idle ≥ 45 000 ms && audioDelivered` → `idle_after_lesson`, or
  `elapsed ≥ 300 000 ms` → `backstop_timeout`. `close()` after `audioDelivered` → `overlay_closed_after_delivery`
  (deferred one tick, widget `:5602-5605`). The guard `ended` makes each topic fire once (widget `:5451`).
  All three triggers call one `reportTeachingEnd(reason)` on the controller (the single emitter and the once guard), so a
  directive followed by a timer or a close fires once. The idle clock, the 5 s check and both backstops are new native
  logic (task 4), not a re-statement of the widget lines.
- `session.ts:355-358`: the handler branches on the directive string; only for `end_guided_topic_teaching` the session first calls a new dep
  `onGuidedTopicTeachingEnd(msg.topic_id ?? null, msg.reason ?? null)`, then drains and ends as today; `end_conversation` and `end_teaching_session` are unchanged.
- `OrbProvider.tsx`: `onGuidedTopicTeachingEnd: (topicId, reason) => overlayBus.emit('vitana:guided-topic-teaching-complete', { topicId, reason })`
  (web event name, `useOrbVoiceWidget.ts:292-294`).
- Constants live next to the existing ORB constants with their widget line in a comment, so the ORB parity check can
  compare them.

## 3. `public-entry`
- `app/index.tsx`:
  ```tsx
  if (loading) return <DelayedLoader … />;
  if (user) return <Redirect href="/home" />;
  return <PublicLandingScreen />;
  ```
  `PublicLandingScreen` (#1553) already redirects a signed-in member and paints a loader while the session resolves;
  `app/index.tsx` keeps the signed-in redirect so a member never sees the grid for a frame. The header comment cites web
  `src/App.tsx:818`.
- `src/linking/link-router.ts`, `dispatch` `case 'invite'`:
  ```ts
  deliverInviteLink(link);
  heldPublic = `/i/${encodeURIComponent(link.code)}`;
  flushPublic();   // navigate now if a navigator is attached; attachNavigator() also calls flushPublic()
  ```
  `held`/`flush()` stay as they are (they require `isSignedIn()`, `link-router.ts:44-50`, and `session` starts `null`,
  `auth-port.ts:55`); the invite takes the separate `heldPublic` slot. `flushPublic` has no `isSignedIn()` gate (the web route has no `AuthGuard`, `src/App.tsx:877`). `InviteLandingScreen`
  (#1553) reads the route param and also receives the delivered link (`auth-port.ts` keeps it until the screen
  registers), and it remembers the code once (`rememberInviteCode` is idempotent for the same code).
- `ledger.json`: `PUBLIC.LANDING` → `status: native`, `last_parity_check` set by the ledger script; remove the `/`
  object from `native_only`.
- Tests: `tests/public-entry/landing.test.tsx` (signed out → storefront testID; signed in → `/home`; loading → loader),
  `tests/public-entry/invite-cold-start.test.ts` (`createLinkRouter` gets `/i/ABC123` before `attachNavigator` → the
  attached navigator receives `/i/ABC123` at once while signed out; the auth-port handler still receives the link;
  `g1-smoke/deep-link.test.ts:78-106` unchanged). `tests/index.test.tsx` signed-out case moves to the storefront.

## 4. `test-timeouts`
Each of the four `helpers.tsx` gets, after its imports:
```ts
// Give findBy*/waitFor 5 s instead of RNTL's 1 s default under default-worker load (as tests/settings/helpers.tsx).
configure({ asyncUtilTimeout: 5000 });
jest.setTimeout(30000);
```
`tests/test-timeouts/harness.test.ts`, per helper: `jest.spyOn(jest, 'setTimeout')`, then inside one
`jest.isolateModules` block require the helper and then `@testing-library/react-native/build/config` (same registry,
so the same config instance), and assert `getConfig().asyncUtilTimeout === 5000` and the spy was called with `30000`.
The deep import is needed because the package entry of `@testing-library/react-native` 13.3.3 does not re-export
`getConfig` (`build/pure.d.ts:9` exports only `configure`, `resetToDefaults`). Red on base for all four helpers.

## 5. `analytics`
```
apps/mobile/src/analytics/
  client.ts    track(), setAnalyticsContext(), consent; batch POST; outbox in AsyncStorage (300 cap)
  session.ts   session id per app launch, journey id (web session.ts semantics: one per tab lifetime)
  types.ts     AnalyticsEvent fields of web src/lib/product-analytics/types.ts, FORBIDDEN_PROPERTY_KEYS
  AnalyticsTracker.tsx  context from useAuth / tenant / I18n; screen_viewed on usePathname() change
```
- URL: `endpoints(config).gatewayOrigin` + `/api/v1/analytics/events/batch`; `fetch` with
  `{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'omit' }`. No bearer.
- Flush: 10 events, a 10 s interval started on first `track`, `AppState` → `background` (web `pagehide` /
  `visibilitychange`), failed POST keeps the batch.
- `ShellRoot.tsx` renders `<AnalyticsTracker />` next to `<OverlayHost />`. Without a gateway origin (tests,
  `ConfigMissing`) nothing is posted.
- Tests (`tests/analytics/`): event shape and `source` per platform; tenant hold; consent states; batching / interval /
  background flush; forbidden keys stripped; `screen_viewed` on path change; no request when signed-out consent is
  `denied`; `tests/shell.test.tsx` stays green unchanged (no-network helper).

## 6. `screen-backfill`
- **Journey bridge** (`screens/journey/seams.ts:49-63`, #1565/#1566): `useJourneyOrbBridge()` returns the context value
  when a provider set one, else `orbBridge` built from `useOrbSession().controller`:
  `focusGuidedTopic: (id) => void controller?.focusGuidedTopic(id)`,
  `onGuidedTopicTeachingComplete: (cb) => overlayBus.on('vitana:guided-topic-teaching-complete', cb)`. The no-op stays
  the context default so tests can still inject one. `GuidedJourneyCatalog.tsx` is unchanged (it already subscribes,
  #1565 `:134`). The comment at `seams.ts:18-20` is updated.
- **AI key** (`ConnectorsScreen.tsx:181-183`): before the placeholder, `if (i.category === 'ai' && (i.id === 'chatgpt' || i.id === 'claude')) { setAiProvider(i.id); return; }`
  and `<AIAssistantConnectSheet open={aiProvider !== null} provider={aiProvider} onClose={() => setAiProvider(null)} />`.
  The comment at `:181-182` drops "AI key paste".
- **AI picks**: `app/(app)/discover/ai-picks.tsx` mounts `screens/ai-picks/AIPicksScreen.tsx`, a port of the phone
  layout of `AIPicksPage.tsx:303-437` on `ports/discover`, #1573's `data/marketplace.ts` feed (`limit: 24`, web `:72`),
  `ProductDetailsDrawer` and `AddToCartButton`. `resolve.ts`: add `/discover/ai-picks` to the native list and drop
  #1573's alias comment block. `tests/discover-commerce/ai-picks-cold-start.test.tsx` asserts
  `{ kind: 'native', href: '/discover/ai-picks' }` and the cold-start navigation to `/discover/ai-picks`.
- Tests (`tests/screen-backfill/`): bridge focuses the topic and relays the bus event; ChatGPT / Claude open the sheet
  with the right provider, another AI app keeps the placeholder; AI picks renders states and filters, opens the drawer,
  back goes to `/discover`, all 11 locales render without missing keys.
