# Requirements — Native Wave 2: Media Hub port (native-wave2-media-hub)

Wave 2 screen port of the Maxina native app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021). Port the Media Hub (shorts, music, podcasts) that the parity ledger assigns to `"lane": "media"` to the
native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** branch, built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime
verification on a device needs the isolated test environment G1 and is marked `depends-on-owner`.

Measured against vitana-v1 `origin/main` `a41e89a0d`, parity ledger `apps/mobile/parity/ledger.json` version 2
(435 rows): **4 rows carry `"lane": "media"`, every one `status: "not_started"`** (`kind: screen`, `scope: in`,
`source: registry`, `exception: null`, `owner: null`; `ledger.json:737-783`). One lane, `media-hub`, owns all 4.

Contract that does not change: `NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification & safety), the N2 README
web→native prop map (`apps/mobile/README.md`), the design rules via tokens. No new web screen, no `App.tsx` route, no
`screens.json` / `exclusions.json` entry, no screen-manifest or voice-registry change, no new parity row — status
flips on the 4 existing rows plus one `native_only` entry for the legacy redirect.

## R0 — Scope

0.1 The plan ports exactly the 4 web destinations under `"lane": "media"`: `COMM.MEDIA_HUB /comm/media-hub`,
`COMM.MEDIA_MUSIC /comm/media-hub?tab=music`, `COMM.MEDIA_PODCASTS /comm/media-hub?tab=podcasts`,
`COMM.MEDIA_SHORTS /comm/media-hub?tab=shorts`.

0.2 All 4 are one web component, `src/pages/community/MediaHub.tsx` (1622 lines; route `src/App.tsx:1263-1267`).
The `tab` param picks the mode (`MediaHub.tsx:237-247`, default `shorts`; re-synced `:274-279`); `?short=<id>`
forces Shorts and opens that short (`:236`, `:240`, `:458-489`). One native route file reads both params; the 4 rows
flip to `native` together.

0.3 The legacy path `/community/media-hub` redirects to `/comm/media-hub` on web (`src/App.tsx:1321`) and is still
linked from web code (`src/components/crossover/MotivationCard.tsx:53`). Native mirrors the redirect with a route
file and a ledger `native_only` entry.

0.4 Scope is the **non-Spotlight mobile branch**. Phones never get Spotlight (`src/hooks/useSpotlightEnabled.ts:49-50`),
so `MediaHubSpotlight` (`MediaHub.tsx:599-690`) is out. Desktop-only parts are out: `VideoPlayerModal` (opened only by
`handleVideoClick`, `:441-452`, from desktop / Spotlight / non-mobile deep link `:476-478,606,1004`),
`BulkVideoUploadModal` (`:849`), `PopularShowsList` + `SubscribeButton` (`:77-206`, rendered `:1437`), podcast
delete (`:282-308`, `:1514-1537`; `MobilePodcastList` has no delete), density control and filter chips (`:917-1019`).

## R1 — 1:1 parity with the mobile web branch

1.1 The native screen mirrors the `isMobile` branch (`src/hooks/use-mobile.tsx:3`, `< 1024`): `StandardHeader`
(`:700-703`); the compact action rail (`:706-773`) with Autopilot pill, search button, `MobileModePill`
shorts/music/podcasts, Calendar button and the primary Upload button; `EnrichmentCardStrip screen="community"`
(`:875`); per mode `MobileShortsCarousel` → `MobileShortsFeed` (`:895-916`, `:1449-1477`), `MobileMusicList`
(`:1023-1024`), `MobilePodcastList` (`:1375-1376`); the delete-short confirm (`:1540-1558`), `EditShortVideoModal`
(`:1561-1582`) and `UnifiedUploadModal` (`:1585-1611`). Same sections, order, wording and navigation targets. Only
program §4 native improvements (transitions, gestures, keyboard avoidance, safe areas, haptics, system share and
permission sheets).

1.2 Web behaviour is mirrored as it is, including: the 3 demo shorts when no real short is returned
(`:375-405`, chosen `:408`/`:439`); empty states standing in for loading and error on music and podcasts (the mobile
lists receive no loading/error flag, `:1024`, `:1376`); a search button with no result action (`:745`); owner-only
edit/delete on shorts (`MobileShortsCarousel.tsx:151-170`).

1.3 Chrome owned by other lanes: the Calendar button emits `calendar:open` (handled by
`apps/mobile/src/shell/components/MobileAppShell.tsx:50`); the Autopilot pill emits `autopilot:open`. The Autopilot
pending badge and the Vitana Index pill value are deferred to their lanes (journey-autopilot, health-biology), as the
merged Home port did (`apps/mobile/src/screens/home/HomeScreen.tsx:16-21`).

1.4 Composition through the N3 shell and N2 kit via `src/ports/*` only (`MobileAppShell`, `MobileModePill`,
`BottomSheet`, `Button`, `Badge`, `Avatar`, `IconButton`, `notify`); no web component, no raw colour, every visual
value from `@vitana/tokens`. The N2 README prop map applies.

1.5 Deep link: `?short=<id>` opens the feed at the matching short once shorts load; closing a deep-link-opened feed
replaces to `/comm/events-meetups?tab=hot` (`:1455-1461`). The web `history.replaceState` workaround (`:482-486`)
is not ported. Android back closes the feed (`MobileShortsFeed.tsx:52-62`); the feed covers the bottom bar and ORB
(`MobileShortsFeed.tsx:48-51`).

## R2 — Data, classes and ports

2.1 Only `src/lib/shortsTags.ts` is class-A end to end; it is re-exported by name through `@vitana/core/media` with
a `packages/core/manifest.json` line. The types `Short`, `FetchShortsParams`, `DeleteShortInput`
(`src/hooks/useShorts.ts:5-41,213-217`) reach native through a `packages/core/extract.json` entry (verbatim copy).
No `export *` from a web file.

2.2 Every data path is class-B (imports `@/integrations/supabase/client`): shorts, likes, deletes
(`useShorts.ts:2`), bookmarks (`useBookmarks.ts:2-3`), comments (`useShortComments.ts:2`), music and podcast
queries (`MediaHub.tsx:27,340-361,535-548`), uploads (`useMediaUpload.ts:2`, `useVideoUpload.ts:3`), edit
(`EditShortVideoModal.tsx:9`). They are re-implemented natively with the same tables, columns, filters, limits and
buckets, behind the `MediaHubData` interface in `apps/mobile/src/ports/media.ts`, on `getSupabase()`
(`apps/mobile/src/auth/client.ts:17`) and `getGateway()` / `gatewayJson` (`apps/mobile/src/auth/gateway.ts:12-24`).
Screen code never imports `@supabase/supabase-js`.

2.3 Writes (toggle like, toggle bookmark, add / delete / like comment, delete short, edit short, upload
video / music / podcast) go through the `MediaHubData` port and are tested only against a fake. No test, script or
CI step writes to a live system.

2.4 After any `packages/core/**` change the lane runs `npm run gen:core` and commits
`packages/core/src/extracted/media.generated.ts`, `packages/core/closure.generated.json` and
`scripts/native/mobile-ci-paths.generated.json` in the same PR.

## R3 — Native media packages

3.1 `expo-video`, `expo-audio`, `expo-image-picker` and `expo-document-picker` are already in `apps/mobile/package.json` and
registered in `apps/mobile/app.config.ts` (`chatMediaPlugins()`, `diaryCapturePlugins()`, `contactsImportPlugins()`); this
lane adds no package, no plugin and no usage string, and does not edit `package.json`, `package-lock.json`,
`app.config.ts` or `tests/app-config.test.ts`.

3.2 No plugin option sets a camera or microphone permission to `false` (that blocks Android `RECORD_AUDIO` and
deletes the iOS key that `withVitanaVoice` writes, `modules/vitana-voice/plugin/withVitanaVoiceIos.js:61`,
`withVitanaVoiceAndroid.js:18`).

3.3 A lane test `tests/media/app-config-media.test.ts` asserts, read-only, the four existing entries and their options
on `buildConfig('development', …)` and the 3.2 rule.

3.4 Share uses React Native `Share`; the URL is built from `config.webBaseUrl` with the web path shapes and omitted
when `webBaseUrl` is unset. No production host literal in `apps/mobile/**`.

## R4 — i18n (11 locales) + RTL

4.1 Every user-visible string and accessibility label comes from the catalog shards (`mediaHub.*`, `actionBar.*`,
`toasts.community.*`, …; `mediaHub.json` has 129 keys in each of the 11 locales). Web's hard-coded English
(`MediaHub.tsx:375-405,409,412`, `MobileMusicList.tsx:49,62`, `MobileShortsFeed.tsx:129`) becomes new keys.

4.2 New keys go to `src/i18n/de/mediaHubNative.json` first, then ar en es fr pl pt ru sr tr zh. Register: German du,
Portuguese (Brazilian) você, French tu, Russian ты; Arabic is RTL. `npm run i18n:register` and `npm run i18n:gate`
pass.

4.3 RTL (`ar`): `start`/`end` only, never physical `left`/`right`; a test scans the lane's files.

## R5 — React 19 / typing

5.1 No global `JSX` namespace; `ReactElement`. `npm run typecheck` green.

## R6 — Parity ledger and routes

6.1 The 4 rows go `not_started` → `in_progress` → `native` (status by hand, then
`node scripts/native/parity-ledger.mjs --sync`); `--check` green.

6.2 `apps/mobile/app/(app)/comm/media-hub.tsx` and `apps/mobile/app/(app)/community/media-hub.tsx` exist; both
paths are in `NATIVE_ROUTES` (`apps/mobile/src/navigation/resolve.ts:42-63`); `/community/media-hub` has a
`native_only` entry with its reason (`parity-ledger.mjs:255`).

## R7 — Verification and safety

7.1 Never test against production; staging specs are read-only; the native app has no production profile.

7.2 Offline checks: from `apps/mobile/` `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
`APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`; from the root `node scripts/native/parity-ledger.mjs
--check`, `node scripts/native/core-closure.mjs --check`, `node scripts/native/gen-core-extract.mjs --check`,
`npm run i18n:register`, `npm run i18n:gate`.

7.3 Device runtime (Maestro `apps/mobile/maestro/media/*.yaml`, simulator/emulator screenshots, screenshot parity vs
390×844 read-only staging web, live playback and picker exercise) is one `next_actor: owner` task for G1.

7.4 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (references only
`npm run X` / `npx jest P`) and `plan-sparring.md`.

7.5 No What's New entry.

## Out of scope
- Spotlight and every desktop-only part listed in 0.4.
- The app-global `MiniAudioPlayer` (`src/App.tsx:33,799`) — shell chrome.
- Native Autopilot sheet, Vitana Index source, calendar screen — their own lanes.
- Universal-link claiming of `vitanaland.com/shorts/*` (`apps/mobile/src/linking/resolve-link.ts`) — linking / G1.
- Any backend, gateway, storage-policy or migration change; any web file except new `mediaHubNative.json` shards.
