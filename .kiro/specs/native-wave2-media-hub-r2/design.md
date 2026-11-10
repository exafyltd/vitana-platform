# Design — Native Wave 2: Media Hub port (native-wave2-media-hub-r2)

How the `media-hub` lane ports the `media` ledger cluster. Follows `docs/programs/native-app/NATIVE-APP-PLAN.md` §3
(architecture) and §4 (parity method), the N3 shell and N2 kit on main, and `apps/mobile/README.md`. Evidence lines
are vitana-v1 `origin/main` `e31bf4627ff3` (full SHA in `plan.md` Measured state). `plan.md` is authoritative where they differ.

## 1. Routes and resolution

| Native route file (`apps/mobile/app/`) | Web path(s) | Ledger |
|---|---|---|
| `(app)/comm/media-hub.tsx` | `/comm/media-hub`, `?tab=shorts`, `?tab=music`, `?tab=podcasts`, `?short=<id>` | the 4 `media` rows |
| `(app)/community/media-hub.tsx` (`<Redirect>` to `/comm/media-hub`, query kept) | `/community/media-hub` (`src/App.tsx:1321`) | new `native_only` entry |

Both paths are added to `NATIVE_ROUTES` (`apps/mobile/src/navigation/resolve.ts:42-147`; `tests/navigation.test.ts`
keeps the list equal to the files). The ledger matches rows by path shape with the query dropped, so the single file
satisfies all 4 rows. Today `/community/media-hub` resolves `not-found` (`resolve.ts:195-222`), because
`screens.json:1546-1549` lists it only as a voice alias, not a `mobileRoute`.

## 2. Screen structure (`apps/mobile/src/screens/media/**`)

- `MediaHubScreen.tsx` — reads `tab` (`shorts` default | `music` | `podcasts`, invalid → `shorts`, matching
  `MediaHub.tsx:237-247`) and `short` via `useLocalSearchParams`; mode changes write `tab` back with
  `router.setParams` (the Home pattern). Renders inside `MobileAppShell`: header, action rail, enrichment strip,
  mode body, sheets.
- `MediaActionRail.tsx` — Autopilot pill (`overlayBus.emit('autopilot:open')`), search button (no result action,
  like `:745`), `MobileModePill` (shell component `src/shell/components/MobileModePill.tsx`, imported the way
  `src/screens/home/HomeScreen.tsx:32` does), Calendar button (`overlayBus.emit('calendar:open')`), primary Upload button.
- `ShortsCarousel.tsx` / `ShortsFeed.tsx` / `ShortSlide.tsx` — horizontal carousel of short cards (real shorts, or
  the 3 demo shorts when none is returned); tap opens the full-screen feed (a `Modal` over the shell, vertical
  paging `FlatList`, one `expo-video` `VideoView` per visible slide, thumbnail behind the video); like, comments
  sheet, share, owner kebab (edit / delete). Android back closes the feed.
- `ShortCommentsSheet.tsx` — comment list, add, delete own, like (twin of `ShortCommentsSheet.tsx` /
  `useShortComments.ts`).
- `MusicList.tsx`, `PodcastList.tsx` — rows with play/pause on the screen's audio player, music bookmark toggle and
  share, the web empty states.
- `DeleteShortSheet.tsx`, `EditShortSheet.tsx`, `UploadSheet.tsx` — the confirm, edit and upload flows as bottom
  sheets (`BottomSheet` from the UI port). Upload: type choice video / music / podcast as on web
  (`UnifiedUploadModal.tsx:41-77`), video file from `expo-image-picker`, audio file from `expo-document-picker`,
  tags from `SHORTS_TAG_IDS`.
- `player/useMediaAudio.ts` — one `expo-audio` player for the screen (replaces the web global
  `HTMLAudioElement`, `src/hooks/useAudioPlayer.ts:44-50`); `currentMedia`, `isPlaying`, `play`, `pause`.
- `data/*.ts` — the real `MediaHubData` implementation (§3).
- `assets/shorts-*.jpg` — the 3 demo thumbnails, byte-identical copies of `src/assets/shorts-*.jpg`.
- Enrichment strip: `useEnrichmentCards('community')` and `EnrichmentCard` imported read-only from
  `src/screens/home/data/enrichment.ts:138` and `src/screens/home/cards/EnrichmentCard.tsx`, picked with
  `CARD_SCREENS` / `isServerCardPlaced` / `cardCategory` from `src/ports/feed.ts:37-40`. Renders nothing while
  loading or on error, as web does (`EnrichmentCardStrip.tsx:10-12`).

## 3. Data port (`apps/mobile/src/ports/media.ts`)

```ts
export { SHORTS_TAG_IDS, type ShortsTagId, type Short, type FetchShortsParams, type DeleteShortInput } from '@vitana/core/media';
export interface MediaHubData {
  // reads
  useShorts(params: FetchShortsParams): QueryResult<Short[]>;
  useMusic(): QueryResult<MusicTrack[]>;
  usePodcasts(): QueryResult<PodcastEpisode[]>;
  useBookmarks(): { isBookmarked(type: 'music', id: string): boolean };
  useShortComments(videoId: string): QueryResult<ShortComment[]>;
  // writes
  toggleLike(input: { videoId: string; action: 'like' | 'unlike' }): Promise<void>;
  toggleBookmark(input: BookmarkInput): Promise<void>;
  addComment / deleteComment / toggleCommentLike(...): Promise<void>;
  deleteShort(input: DeleteShortInput): Promise<void>;
  editShort(input: EditShortInput): Promise<void>;
  uploadVideo(input: VideoUploadInput): Promise<void>;
  uploadAudio(input: AudioUploadInput): Promise<void>; // music | podcast
}
export function MediaHubDataProvider(props: { value: MediaHubData; children: ReactNode }): ReactElement;
export function useMediaHubData(): MediaHubData; // throws outside a provider
```
Exact signatures are the builder's; the rule is that screens reach data only through this port, the route file
`app/(app)/comm/media-hub.tsx` wraps the screen in `MediaHubDataProvider` with the real implementation, and tests
wrap it with a fake. The real implementation in `src/screens/media/data/` mirrors web exactly:

| Concern | Web source | Native call |
|---|---|---|
| shorts list | `useShorts.ts:43-97` (`media_videos`, `status='published'`, newest first, limit 100 from `MediaHub.tsx:368-371`, profiles join `:82`) | `getSupabase().from('media_videos')…` + profiles read |
| like | `useShorts.ts:258-288` | same table updates |
| delete short | `useShorts.ts:219-256` (row delete + storage remove `:245`) | same |
| music | `MediaHub.tsx:337-366` (`media_uploads` + `music_metadata`, `media_type='music'`, approved, public, limit 10) | same select |
| podcasts | `MediaHub.tsx:535-551` (`media_uploads` + `podcast_metadata`, approved, public, limit 10) | same select |
| bookmarks | `useBookmarks.ts:21-137` (`bookmarked_items`, realtime channel `:121`) | same table + native realtime channel |
| comments | `useShortComments.ts:20-146` (`media_video_comments`, `media_video_comment_likes`) | same |
| edit short | `EditShortVideoModal.tsx:146-171` (thumbnail to storage bucket `media`, `media_videos` update) | same |
| upload music/podcast | `useMediaUpload.ts:66-171` (bucket map `:91`, `media_uploads` + metadata, rollback on error) | same |
| upload video | `useVideoUpload.ts:27,71-127` (storage `media`, gateway `/api/v1/media-hub/shorts/extract-thumbnail`) | storage via `getSupabase()`, endpoint via `getGateway()` |

Share URLs: shorts `${config.webBaseUrl}/shorts/<id>` (web `src/lib/shareUrl.ts:39-41` shape), music
`${config.webBaseUrl}/comm/media-hub?tab=music&track=<id>` (`MobileMusicList.tsx:62`); URL omitted when
`config.webBaseUrl` is unset.

## 4. Core change

- `packages/core/manifest.json`: `"src/lib/shortsTags.ts": { "entry": "media.ts", "lanes": ["media"], "reason":
  "Shorts tag allow-list for the upload tag picker; no imports, pure." }`.
- `packages/core/extract.json`: entry `media`, source `src/hooks/useShorts.ts`, take `Short`, `FetchShortsParams`,
  `DeleteShortInput`.
- `packages/core/src/media.ts`: named re-export of `SHORTS_TAG_IDS` / `ShortsTagId` from `@/lib/shortsTags` and the
  generated types from `./extracted/media.generated`.
- `npm run gen:core` regenerates `packages/core/src/extracted/media.generated.ts`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.

## 5. Expo config (no change)

`app.config.ts` is not edited. `buildPlugins()` already registers (vitana-v1 `origin/main` `e31bf4627ff3`)
`['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: false }]` (`chatMediaPlugins()`),
`expo-image-picker` and `expo-audio` with `enableBackgroundPlayback: false` (`diaryCapturePlugins()`) and
`expo-document-picker` (`contactsImportPlugins()`). Playback needs no background mode (the global mini player is not
ported). Camera and microphone options are untouched, so the ORB voice plugin keeps its microphone string.

## 6. Tests (`apps/mobile/tests/media/**`)

- `helpers.tsx` — render inside the shell providers with a fake `MediaHubData` (fixtures) passed to
  `MediaHubDataProvider`, the fixture gateway, and jest mocks for `expo-video`, `expo-audio`, `expo-image-picker`,
  `expo-document-picker` and `Share`.
- Screen tests: tab default / each value / invalid → shorts / switch writes `tab`; shorts real list and demo
  fallback (empty and error); feed open at index, swipe, close; Android back closes; like calls `toggleLike`;
  comments read / add; owner-only kebab; delete confirm calls `deleteShort`; edit saves; `?short=<id>` opens the
  feed, close replaces to `/comm/events-meetups?tab=hot`; music play/pause, bookmark, share payload (with and
  without `webBaseUrl`), empty; podcast play, empty; upload video / music / podcast with faked pickers calls the
  right port method; Autopilot / Calendar emit their bus events; `/community/media-hub` redirect keeps the query.
- `app-config-media.test.ts` — read-only: the four existing plugin entries and options; no camera/microphone `false`.
- `assets.test.ts` — sha256 of the 3 thumbnails equals the web files.
- i18n: no raw user-visible text in `src/screens/media/**`, no physical `left`/`right`, `ar` render uses RTL.

## 7. Disjointness

One lane, so no lane-to-lane overlap inside this plan. Cross-plan shared files and the merge rule are in `plan.md`
"Shared and hot files".
