---
change_class: standard
---
# Plan — native-wave2-media-hub
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/extract/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`;
no backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2 lane "Media hub/shorts"
(`NATIVE-APP-PLAN.md:198`). Every `file:line` below is measured on vitana-v1 `origin/main` at `a41e89a0d`.

<!-- plan:begin -->
## Goal
Owner task: "finish the native app program in exafyltd/vitana-v1 docs/programs/native-app/NATIVE-APP-PLAN.md (Waves
0–3, gates G1–G3)". This plan is the Wave 2 screen port of the **media** cluster: the 4 web destinations the parity
ledger assigns to `"lane": "media"` become one native screen in `apps/mobile/`, built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit on the N3 shell, at 1:1 parity with today's **mobile web** branch of
`src/pages/community/MediaHub.tsx` (the non-Spotlight `useIsMobile()` branch). Fixture / fake-gateway unit tests
only; no live write; device-runtime parity deferred to G1 (`next_actor: owner`). No redesign (program §4), no web
screen change, no `App.tsx` route, no `screens.json` / `exclusions.json` / screen-manifest change.

## Measured state (vitana-v1 origin/main `a41e89a0d`)
- **Ledger** (`apps/mobile/parity/ledger.json`, version 2, 435 rows): exactly 4 rows carry `"lane": "media"`, all
  `status: "not_started"`, `kind: screen`, `source: registry`, `scope: in`, `exception: null`, `owner: null`:
  `COMM.MEDIA_HUB /comm/media-hub` (`ledger.json:737`), `COMM.MEDIA_MUSIC /comm/media-hub?tab=music` (`:749`),
  `COMM.MEDIA_PODCASTS /comm/media-hub?tab=podcasts` (`:761`), `COMM.MEDIA_SHORTS /comm/media-hub?tab=shorts`
  (`:773`). `scripts/native/parity-scope.json:98` maps prefix `/comm/media-hub` → lane `media` (no scope edit).
- **Web route:** `src/App.tsx:1263-1267` (`/comm/media-hub` → `<AuthGuard><MediaHub/>`, lazy import `:252`); legacy
  redirect `src/App.tsx:1321` (`/community/media-hub` → `/comm/media-hub`). The legacy path is still emitted by web
  code (`src/components/crossover/MotivationCard.tsx:53`) and is **not** a ledger row; today the native resolver
  returns `not-found` for it (`apps/mobile/src/navigation/resolve.ts:104-130`: not in `NATIVE_ROUTES`, no
  `mobileRoute` alias — `screens.json:1546-1549` lists it only as a voice alias).
- **Web source:** `src/pages/community/MediaHub.tsx`, 1622 lines. All 4 rows are this one component; the `tab` param
  picks the mode (`:237-247`, allowed `shorts|music|podcasts`, default `shorts` `:246`; re-synced `:274-279`).
  `?short=<id>` forces Shorts and auto-opens that slide (`:236`, `:240`, effect `:458-489`).
- **Phones get no Spotlight:** `useSpotlightEnabled()` returns false on mobile
  (`src/hooks/useSpotlightEnabled.ts:49-50`; comment `MediaHub.tsx:216-217`), so `MediaHubSpotlight` (`:599-690`)
  never renders on a phone. Mobile breakpoint `< 1024` (`src/hooks/use-mobile.tsx:3`).
- **What the mobile branch renders** (`isMobile` true, `spotlight` false):
  - Header `StandardHeader` (`:700-703`) + compact `UtilityActionButton` rail (`:706-773`): Vitana Index pill →
    `/health` (`:711-719`), Autopilot pill with pending badge → `AutopilotPopup` (`:722-738`, `:1512`),
    `ExpandableSearchButton` whose `onSearch` only `console.log`s (`:743-746`), `MobileModePill` shorts/music/podcasts
    (`:749-757`), `UniversalCalendarButton` (`:760`), primary Upload → `UnifiedUploadModal` (`:763-771`, `:1585-1611`).
  - `EnrichmentCardStrip screen="community" layout="carousel"` (`:875`).
  - Shorts: `MobileShortsCarousel` (`:895-916`; owner kebab edit/delete) → full-screen `MobileShortsFeed`
    (`:1449-1477`) of `MobileShortSlide` (`<video>` `MobileShortSlide.tsx:284-286`; like via `useToggleLike`
    `MobileShortsFeed.tsx:4,45,119`; share via `getShareUrl('short')` + `navigator.share`/clipboard
    `MobileShortsFeed.tsx:125-146`; comments `ShortCommentsSheet` `MobileShortSlide.tsx:8`). When no real short is
    returned (empty, loading or error) the carousel shows 3 hard-coded demo shorts (`fallbackShorts` `:375-405`,
    chosen at `:408`/`:439`; thumbnails `src/assets/shorts-*.jpg` `:59-61`).
  - Music: `MobileMusicList tracks={approvedMusic}` (`:1023-1024`) — play/pause through the global
    `useAudioPlayer` (`MobileMusicList.tsx:32,42-55`), bookmark toggle `useBookmarks` (`:33,147`), share
    `${window.location.origin}/comm/media-hub?tab=music&track=<id>` (`:57-73`), empty state (`:76`).
  - Podcasts: `MobilePodcastList podcasts={approvedPodcasts}` (`:1375-1376`) — play only; `currentUserId` is
    declared (`MobilePodcastList.tsx:30,33`) but unused, so **podcast delete is desktop-only**.
  - Dialogs: delete-short confirm (`:1540-1558`, `useDeleteShort` `:311-333`), `EditShortVideoModal` (`:1561-1582`).
- **Desktop-only (not ported):** `VideoPlayerModal` opens only through `handleVideoClick` (`:441-452`), called from
  the desktop grid (`:1004`), Spotlight (`:606`) and the non-mobile deep-link branch (`:476-478`); on mobile the
  deep link opens `MobileShortsFeed` (`:473-475`). `BulkVideoUploadModal` opens only from the desktop dropdown
  (`:849`). `PopularShowsList` / `SubscribeButton` (`usePopularPodcastShows`, `usePodcastShowSubscription`,
  `:77-206`) render only in the desktop podcasts column (`:1437`). Podcast delete (`:282-308`, `:1514-1537`) has no
  mobile trigger. Density control, filter chips and the filtered-empty state are inside the desktop grid (`:917-1019`).
- **Native state:** no media screen, no `apps/mobile/app/(app)/comm/media-hub.tsx`; `NATIVE_ROUTES`
  (`resolve.ts:42-63` at `a41e89a0d`) lacks it. **Native packages and plugins are already on `main`** (re-measured on
  vitana-v1 `origin/main` `a763b4f01`, after the diary, conversation-chat and inbox-list lanes merged; sparring R1-F1/F2):
  `apps/mobile/package.json` has `expo-audio` 57.0.5, `expo-document-picker` 57.0.3, `expo-image-picker` 57.0.20 and
  `expo-video` 57.0.5. `app.config.ts` `buildPlugins()` (`:60-77`) already pushes `diaryCapturePlugins()` (`:130-139`:
  `expo-image-picker` with `photosPermission`/`cameraPermission`/`microphonePermission`; `expo-audio` with
  `microphonePermission`, `enableBackgroundPlayback: false`, `enableBackgroundRecording: false`), `chatMediaPlugins()`
  (`:93-95`: `expo-video` with `supportsBackgroundPlayback: false, supportsPictureInPicture: false`) and
  `contactsImportPlugins()` (`:153-159`: `expo-contacts` + `expo-document-picker`). `tests/app-config.test.ts:137-155`
  already asserts all of them. `withVitanaVoice` still owns `NSMicrophoneUsageDescription`. The shell already routes
  `calendar:open` (`MobileAppShell.tsx:50`) and emits `autopilot:open` (`SideDrawer.tsx:245`) on the overlay bus
  (`src/navigation/overlay-bus.ts`). The Home port links to `/comm/media-hub` (`src/screens/home/data/feed.ts:185`).
- **i18n:** `src/i18n/<locale>/mediaHub.json` exists in all 11 locales with 129 leaf keys each. Web hard-codes some
  user-visible English the native port must not copy: `'Community Member'` (`MediaHub.tsx:409,412`),
  `'Unknown Artist'` (`MobileMusicList.tsx:49`), the share texts (`MobileMusicList.tsx:62`,
  `MobileShortsFeed.tsx:129`) and the demo-short titles/creators (`MediaHub.tsx:375-405`).

## Class-A / class-B classification (measured with `scripts/native/extraction-deps.mjs` `analyze()`)
A module is class-B (re-implemented natively behind the lane's data port, never core-extracted) when it imports
`@/integrations/supabase/client` or `@/lib/community-gateway` directly or transitively; class-C modules (DOM, web
packages) are re-authored natively.
| Web module | Own / transitive | Evidence | Native treatment |
|---|---|---|---|
| `src/lib/shortsTags.ts` (`SHORTS_TAG_IDS`, `ShortsTagId`) | A / A | no imports (`shortsTags.ts:10-23`) | **core re-export** (named, not `export *`) |
| `src/hooks/useShorts.ts` types `Short`, `FetchShortsParams`, `DeleteShortInput` | file A / C | `supabase` `:2`; types `:5-41,213-217` import nothing | **extract.json** verbatim copy of the 3 types |
| `useShorts` / `useToggleLike` / `useDeleteShort` / `useTrackMediaEvent` | A / C | `useShorts.ts:2,47,114,227,245,263` | class-B, native data port |
| `src/hooks/useBookmarks.ts` | A / C | `supabase` `:2`, realtime `:3,121` | class-B, native data port |
| `src/hooks/useShortComments.ts` | A / C | `supabase` `:2`, tables `:30,77,90,106` | class-B, native data port |
| music / podcast queries inline in `MediaHub.tsx` | C / C | `supabase` `:27`, `.from('media_uploads')` `:340-361`, `:535-548` | class-B, native data port |
| `src/hooks/useMediaUpload.ts`, `src/hooks/useVideoUpload.ts` | C / C | `supabase` `:2` / `:3`; storage `useMediaUpload.ts:91-107`, `useVideoUpload.ts:127`; gateway thumbnail `useVideoUpload.ts:27,81` | class-B, native data port |
| `src/components/community/EditShortVideoModal.tsx` | C / C | `supabase` `:9,146,164` | class-B + native sheet |
| `src/hooks/useAudioPlayer.ts` | C / C | `HTMLAudioElement` `:44-50` | native player on `expo-audio` |
| `src/lib/shareUrl.ts` | C / C | `window.location` `:46,71`; production apex literals `:36,40` | native helper on `config.webBaseUrl` |
| `src/stores/userInterestsStore.ts` | B / B | `zustand persist()` → localStorage `:20-21` | not needed: mobile never sets interest tags natively (see decision 2) |
| `Mobile*` components, `MobileModePill`, upload modals | C / C | `lucide-react`, DOM (`MobileShortsCarousel.tsx:48` IntersectionObserver, `MobileShortsFeed.tsx:49` document) | re-authored on N2/N3 |
Only `shortsTags.ts` is class-A end to end; no other module is promoted.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **One lane, `media-hub`.** The 4 rows are one web component and one native route file
   (`apps/mobile/app/(app)/comm/media-hub.tsx`) that reads `tab` (and `short`), so the rows cannot be split without
   two lanes editing the same file. All 4 rows flip to `native` together. 4 rows, 1 lane, 0 overlap, 0 orphan.
2. **1:1 parity with the non-Spotlight mobile branch** (Measured state "What the mobile branch renders"), including
   web behaviour that looks odd: the 3 demo shorts when no real short is returned (`:375-405`, `:439`); empty states
   standing in for loading and error (the mobile lists get no `isLoading`/`isError`, `:1024`, `:1376`); search with
   no result action (`:745`). The shorts query passes interest tags only when `userInterestsStore` has filtering on
   (`:368-371`); nothing on the mobile branch turns it on, so the native query sends no tag filter (the same request
   a phone sends on a fresh install). Desktop-only parts (list above) are out of scope. Hard-coded web English
   becomes `mediaHubNative.*` keys.
3. **Data: class-B re-implemented behind one port.** `apps/mobile/src/ports/media.ts` is the screen's only door to
   data and core: it re-exports `@vitana/core/media` (the `shortsTags` re-export + extracted types) and declares the
   `MediaHubData` interface (reads: shorts, music, podcasts, bookmarks, comments; writes: toggle like, toggle
   bookmark, add/delete/like comment, delete short, edit short, upload video/music/podcast) with a
   `MediaHubDataProvider` / `useMediaHubData` seam; the route file `app/(app)/comm/media-hub.tsx` provides the
   real implementation and tests provide a fake. The real implementation
   (`src/screens/media/data/*.ts`) uses the native Supabase client through `getSupabase()`
   (`apps/mobile/src/auth/client.ts`) and the gateway through `getGateway()` + `gatewayJson`
   (`apps/mobile/src/auth/gateway.ts:12-24`, `src/ports/core.ts:21`), with the same tables, columns, filters,
   limits and buckets as web (music `:340-361`, podcasts `:535-548`, shorts `useShorts.ts:47-60`, bookmarks
   `useBookmarks.ts:22,45,79`, comments `useShortComments.ts:30-107`, uploads `useMediaUpload.ts:91-171`,
   `useVideoUpload.ts:27,81,127`), never a direct `@supabase/supabase-js` import in screen code. Tests register a
   fake `MediaHubData` built on fixtures and the fixture gateway; **no write reaches a live system** — every write
   is asserted on the fake only.
4. **Core: one named re-export + one extract entry.** `packages/core/manifest.json` gains `src/lib/shortsTags.ts`
   (consumer lane `media`); `packages/core/extract.json` gains entry `media` taking `Short`, `FetchShortsParams`,
   `DeleteShortInput` from `src/hooks/useShorts.ts` (interfaces with no references, so the generator accepts them);
   `packages/core/src/media.ts` exports `{ SHORTS_TAG_IDS, type ShortsTagId } from '@/lib/shortsTags'` and the
   generated types — no `export *` from a web file. `npm run gen:core` (= `gen-core-extract.mjs` +
   `core-closure.mjs --write`) regenerates `packages/core/src/extracted/media.generated.ts`,
   `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json`, all committed in the
   lane PR. The demo-short array cannot go through extract: its `thumbnailImage` fields are identifiers, which
   `isPureLiteral` rejects (`scripts/native/gen-core-extract.mjs:107-121`).
5. **Playback and pickers reuse the packages and plugins already on `main`; this lane adds none** (program library map
   `NATIVE-APP-PLAN.md:141-143`: `<video>` → expo-video, audio → expo-audio, `navigator.share` → native share sheet).
   `expo-video` (plugin from `chatMediaPlugins()`, no background playback, no PiP), `expo-audio` (plugin from
   `diaryCapturePlugins()`, `enableBackgroundPlayback: false`, which is what media playback needs: the app-global
   `MiniAudioPlayer` is not ported, see Open items), `expo-image-picker` (video file for upload; its camera / photos
   permissions are already registered) and `expo-document-picker` (audio file for music/podcast upload; registered
   by `contactsImportPlugins()`) need no new option. The lane therefore does **not** touch `package.json`,
   `package-lock.json`, `app.config.ts` (including `diaryCapturePlugins()`, `chatMediaPlugins()`,
   `contactsImportPlugins()`) or `tests/app-config.test.ts`, and adds no usage string and no `mediaHubNative`
   `photosPermission` key. `tests/media/app-config-media.test.ts` is read-only: it asserts that
   `buildConfig('development', …)` already registers the four plugins with the options above and that no camera or
   microphone option is `false`, so a later lane cannot silently drop one. Share uses React Native `Share`; URLs
   come from `config.webBaseUrl` (env port) with the web path shapes, and the URL is omitted when `webBaseUrl` is
   unset (every non-production profile), like `src/identity/web-console.ts:4-12`. No production host literal is added
   to `apps/mobile/**`.
   **Provenance (sparring R2-F1/F2):** `expo-video` and `chatMediaPlugins()` landed in vitana-v1 commit `409359e2a`
   (VTID-05458, conversation-chat, #1561); `expo-document-picker` and `contactsImportPlugins()` in `b443a955b`
   (VTID-05459, inbox-list, #1564); `diaryCapturePlugins()` earlier (VTID-05426). All are ancestors of `origin/main`
   `a763b4f01`. **Base rule for the builder:** the lane branches from the then-current `origin/main` and, first,
   re-checks the four packages in `apps/mobile/package.json` and the four registrations in `buildConfig('development', …)`;
   if any is missing on that base (it is not on `main` today), the lane adds **only the missing** package with
   `npx expo install` plus its single plugin entry in a new `mediaHubPlugins()` pushed from `buildPlugins()`, with the
   options above, and updates `tests/app-config.test.ts` for that entry only. It never edits an existing plugin function.
6. **Routes.** `apps/mobile/app/(app)/comm/media-hub.tsx` (the screen) and
   `apps/mobile/app/(app)/community/media-hub.tsx` (a `<Redirect>` to `/comm/media-hub` with the query kept,
   mirroring `App.tsx:1321`); both paths join `NATIVE_ROUTES` in `resolve.ts`; the redirect gets a ledger
   `native_only` entry with its reason (the mechanism `parity-ledger.mjs:255` names and the `/` landing redirect
   already uses, `ledger.json:5-8`). Deep link `?short=<id>`: the screen opens the feed at that short once shorts
   load and, on close, replaces to `/comm/events-meetups?tab=hot` exactly when the feed was deep-link-opened
   (`:1455-1461`). The web `window.history.replaceState` (`:482-486`) is an Appilix WebView workaround with no
   native counterpart and is not ported. The feed is a full-screen modal over the shell (hides bottom bar and ORB,
   as `document.body.dataset.shortsOpen` does at `MobileShortsFeed.tsx:48-51`); Android back closes it
   (`MobileShortsFeed.tsx:52-62`).
7. **Chrome owned by other lanes.** Calendar button emits `calendar:open` (shell handles it, `MobileAppShell.tsx:50`);
   Autopilot pill emits `autopilot:open` (the journey-autopilot lane registers the sheet). The Autopilot pending-count
   badge (`useAutopilot`, class-B, `src/hooks/use-autopilot.ts:3-4`) and the Vitana Index pill value
   (`VitanaIndexValue` → `VitanaIndexProvider` → `useVitanaIndex`, class-B: `src/components/health/VitanaIndexProvider.tsx:2`, `src/hooks/useVitanaIndex.ts:2`) are deferred to their owning
   lanes (journey-autopilot, health-biology), the same deferral the merged Home port made
   (`apps/mobile/src/screens/home/HomeScreen.tsx:16-21`). The enrichment strip reuses the native
   `useEnrichmentCards(screen)` + `EnrichmentCard` (`src/screens/home/data/enrichment.ts:138`,
   `src/screens/home/cards/EnrichmentCard.tsx`) with `screen = 'community'` and `CARD_SCREENS` from the feed port
   (`src/ports/feed.ts:37-40`); this lane imports them read-only and edits nothing under `src/screens/home/**`.
8. **Demo-short thumbnails** are copied byte-identical from `src/assets/shorts-{morning-stretch,healthy-breakfast,
   breathing-exercise}.jpg` to `apps/mobile/src/screens/media/assets/` (the native resolver blocks a direct `src/`
   require, `apps/mobile/resolution.js:96-97`); a unit test compares their sha256 with the web files.
9. **i18n**: strings come from `mediaHub.*`, `actionBar.*`, `toasts.community.*` and existing shards; genuinely new
   keys go to `src/i18n/de/mediaHubNative.json` first, then the other 10 locales (ar en es fr pl pt ru sr tr zh), in
   the product register: German du, Portuguese (Brazilian) você, French tu, Russian ты, Arabic RTL with start/end
   only. Gate: `npm run i18n:register` and `npm run i18n:gate` (root `package.json:44-45`).
10. **Device runtime deferred to G1.** Maestro `apps/mobile/maestro/media/*.yaml`, simulator/emulator screenshots,
   screenshot parity vs the 390×844 read-only staging web screen, and the live playback / picker exercise are one
   `next_actor: owner` task; they do not block the merge.
11. **Not changed:** any web file except the new `mediaHubNative.json` shards; `src/App.tsx`;
   `src/navigation/registry/**`; `screens.json`; `exclusions.json`; the screen manifest; backend; gateway; DB.

## Lanes
| Lane | Seat → reviewer | Rows | depends_on |
|---|---|---|---|
| `media-hub` | exafyltd → hotmail | `COMM.MEDIA_HUB`, `COMM.MEDIA_MUSIC`, `COMM.MEDIA_PODCASTS`, `COMM.MEDIA_SHORTS` (4) | — |
Paths: `lanes/media-hub.md`.

## Shared and hot files
Shared with other Wave 2 lanes by line or row (resolve a conflict by keeping both sides): `apps/mobile/parity/ledger.json`
(this lane edits its 4 rows and adds 1 `native_only` entry), `apps/mobile/src/navigation/resolve.ts` (2
`NATIVE_ROUTES` lines), `apps/mobile/src/ports/**` (new `media.ts` only), `packages/core/manifest.json`,
`packages/core/extract.json`, `packages/core/src/**` (new `media.ts`), the two generated files (always regenerate, never
hand-merge). `apps/mobile/package.json`, `package-lock.json`, `app.config.ts` and `tests/app-config.test.ts` are not
edited by this lane (decision 5; the lane file's `paths` still list those four files from the first draft, and this plan block overrides them: the lane
must not touch them, and the lane file is trimmed in the lane's first commit): the diary, conversation-chat and inbox-list lanes already merged the packages and
plugins it needs.

## Test plan
- Offline, from `apps/mobile/`: `npm run typecheck`, `npm test` (jest-expo + RNTL, `tests/media/**`: tab param
  default/each value/switch writes `tab` back; shorts carousel real + demo fallback; feed open/close/swipe; like
  toggle; comments read/add; share payload with and without `webBaseUrl`; owner-only kebab; delete-short confirm;
  edit-short save; `?short=<id>` opens the feed and close replaces to `/comm/events-meetups?tab=hot`; music list
  play/pause + bookmark + empty; podcast list play + empty; upload sheet video/music/podcast with faked pickers;
  `/community/media-hub` redirect keeps the query; Calendar/Autopilot emit their bus events; existing plugins asserted read-only;
  thumbnail sha256; no raw text; no physical `left`/`right`; `ar` RTL render; React 19 `ReactElement`),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`.
- From the repo root: `node scripts/native/parity-ledger.mjs --check`, `node scripts/native/core-closure.mjs
  --check`, `node scripts/native/gen-core-extract.mjs --check`, `npm run i18n:register`, `npm run i18n:gate`.
- Every write (like, bookmark, comment, delete, edit, upload) is asserted against the fake `MediaHubData` only.
- `docs/validation/<VTID>/staging-tests.json` lists only `npm run X` / `npx jest P` references; the G1 device task is
  recorded there as deferred with `next_actor: owner`.
- No What's New entry (port of an existing screen).

## Risks
- A later lane removing a media plugin from `app.config.ts`: `tests/media/app-config-media.test.ts` fails on it.
- `expo-video` needs a development build (not Expo Go); jest mocks it, the real player is a G1 check.

## Open owner / sparring items
- G1 isolated test environment (program gate) for the device-runtime task, and macOS minutes / G3 for iOS on a
  device.
- The app-global `MiniAudioPlayer` (`src/App.tsx:33,799`) is shell chrome outside this cluster; until a shell/audio
  lane ports it, playback state lives in the Media Hub screen's `expo-audio` player and stops when the screen
  unmounts.
<!-- plan:end -->
