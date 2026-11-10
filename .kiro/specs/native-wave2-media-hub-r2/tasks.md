# Tasks — Native Wave 2: Media Hub port

One lane. `plan.md`, `requirements.md` and `design.md` in this folder are authoritative — follow them exactly;
anything outside them is a plan change (log it, set `next_actor: claude` only if Claude is available, else park per
collaboration §7a). The VTID is assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set in
`lanes/media-hub.md`. The spec lives on the plan branch until the lane merges: read it with
`git show origin/kiro/native-wave2-media-hub-r2/plan:.kiro/specs/native-wave2-media-hub-r2/<file>`. Commands run from
`apps/mobile/` unless noted; every command is offline.

<!-- lane: media-hub -->
## Lane `media-hub` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
Ports `COMM.MEDIA_HUB /comm/media-hub`, `COMM.MEDIA_MUSIC ?tab=music`, `COMM.MEDIA_PODCASTS ?tab=podcasts`,
`COMM.MEDIA_SHORTS ?tab=shorts` (4 ledger rows, `"lane": "media"`). depends_on: none. Web source
`src/pages/community/MediaHub.tsx` (1622 lines), mobile branch only.

- [ ] 1. Core: add `src/lib/shortsTags.ts` to `packages/core/manifest.json`; add extract entry `media`
  (`src/hooks/useShorts.ts`: `Short`, `FetchShortsParams`, `DeleteShortInput`) to `packages/core/extract.json`;
  create `packages/core/src/media.ts` (named re-exports only); run `npm run gen:core`; commit the generated
  `packages/core/src/extracted/media.generated.ts`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Files: `packages/core/manifest.json`, `packages/core/extract.json`, `packages/core/src/**`,
  `packages/core/closure.generated.json`, `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/gen-core-extract.mjs --check`, `node scripts/native/core-closure.mjs --check`.
- [ ] 2. Port: `apps/mobile/src/ports/media.ts` — re-exports `@vitana/core/media`, declares `MediaHubData`,
  `MediaHubDataProvider`, `useMediaHubData` (design §3).
  Files: `apps/mobile/src/ports/media.ts`. Verify: `npm run typecheck`; `npm test -- tests/ports.test.ts`.
- [ ] 3. Existing native packages and plugins (no change to them): add `tests/media/app-config-media.test.ts`
  asserting, on `buildConfig('development', …)`, that `expo-video` (no background playback / PiP), `expo-audio`
  (`enableBackgroundPlayback: false`), `expo-image-picker` and `expo-document-picker` are already registered and that no
  camera or microphone option is `false`. First re-check the base (plan Decision 5): at the pinned commit all four are present, and this lane does not edit `package.json`, `package-lock.json`, `app.config.ts` or `tests/app-config.test.ts` (not in its `paths`). If one is missing on the lane's base, stop and park the lane with the five-part message (a plan change), do not add it.
  Files: `apps/mobile/tests/media/**`.
  Verify: `npm test`; `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`.
- [ ] 4. Data layer: `apps/mobile/src/screens/media/data/*.ts` implementing `MediaHubData` with the web tables,
  filters, limits, buckets and endpoints (design §3 table) on `getSupabase()` / `getGateway()`; the route file passes it to
  `MediaHubDataProvider`.
  Files: `apps/mobile/src/screens/media/**`. Verify: `npm run typecheck`.
- [ ] 5. Screen + routes: `MediaHubScreen` and its parts (design §2); `apps/mobile/app/(app)/comm/media-hub.tsx`;
  `apps/mobile/app/(app)/community/media-hub.tsx` (redirect, query kept); both in `NATIVE_ROUTES`
  (`apps/mobile/src/navigation/resolve.ts`); demo thumbnails copied to `src/screens/media/assets/`.
  Files: `apps/mobile/app/(app)/comm/media-hub.tsx`, `apps/mobile/app/(app)/community/media-hub.tsx`,
  `apps/mobile/src/screens/media/**`, `apps/mobile/src/navigation/resolve.ts`.
  Verify: `npm test -- tests/navigation.test.ts`; `npm run typecheck`.
- [ ] 6. i18n + RTL: reuse `mediaHub.*` / `actionBar.*` / `toasts.community.*`; new keys (demo-short texts,
  `communityMember`, `unknownArtist`, share texts, accessibility labels) in
  `src/i18n/de/mediaHubNative.json` first, then ar en es fr pl pt ru sr tr zh — German du, Portuguese você, French tu,
  Russian ты, Arabic RTL; start/end only.
  Files: `src/i18n/*/mediaHubNative.json`, `apps/mobile/src/screens/media/**`.
  Verify (repo root): `npm run i18n:register`, `npm run i18n:gate`; `apps/mobile` → `npm run typecheck`.
- [ ] 7. Unit tests (fake `MediaHubData`, fixture gateway, mocked Expo packages, no network): the list in design §6.
  React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/media/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`.
- [ ] 8. Ledger: the 4 rows → `native` (status by hand, then `node scripts/native/parity-ledger.mjs --sync`); add the
  `native_only` entry for `/community/media-hub` with its reason (`src/App.tsx:1321`).
  Files: `apps/mobile/parity/ledger.json`, `docs/validation/<VTID>/{scope,staging-tests}.json`,
  `docs/validation/<VTID>/plan-sparring.md`. `scope.json` lists every touched path.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check`.
- [ ] 9. **(depends-on-owner / G1 — `next_actor: owner`)** Device runtime: Maestro
  `apps/mobile/maestro/media/*.yaml` (open each mode, open a short, swipe, play/pause a track and an episode, open
  and dismiss the upload sheet without submitting), iOS simulator + Android emulator screenshots, screenshot parity vs
  390×844 read-only staging web `/comm/media-hub`, RTL screenshots. No write against any live system.
  Files: `apps/mobile/maestro/media/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log.
- [ ] 10. PR: branch `kiro/native-wave2-media-hub-r2/media-hub`, title
  `VTID-xxxxx (native-wave2-media-hub-r2/media-hub): native Media Hub port (shorts, music, podcasts)`; body names the
  Kiro session id, Summary / Decisions taken / Tests / Handoff. Trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-media-hub-r2/media-hub`. Lane → `in-review`, `next_actor: kiro` (reviewer agent
  `vitana-lane-reviewer`). Never merge, deploy or write to a live system (protocol §7a).

**Acceptance (the reviewer agent checks these):**
- Change types: UI, Integration, Tooling/docs.
- **Outcome** — a member opening Media Hub in the native app (from Home, the drawer, a push `data.url`, the ORB or a
  `/community/media-hub` link) sees the same header, action rail, mode pill, enrichment strip and Shorts / Music /
  Podcasts content as on mobile web, can watch shorts full-screen, like, comment, share, play music and podcasts,
  bookmark music, and upload / edit / delete their own shorts.
- **States** — shorts: real list, demo fallback when empty / loading / error (web parity); music and podcasts: the
  web empty state when empty / loading / error; enrichment strip hidden while loading or on error; owner-only kebab;
  share without `webBaseUrl` omits the URL; `?short=<id>` for an unknown id opens nothing.
- **Surfaces** — native `/comm/media-hub` (all `tab` values, `short` param) and the `/community/media-hub`
  redirect; phones only (phones get no Spotlight, `useSpotlightEnabled.ts:49-50`); desktop-only parts not ported
  (plan Measured state).
- **Locales** — de first (du-form) and en, then the other 9; pt você, fr tu, ru ты; `ar` RTL rendered with
  start/end only; dates via the native locale-format helpers.
- **Accessibility** — every pressable (pills, mode pill, slide actions, kebab, play buttons, sheets) has an
  accessible name from the catalogs; focus order follows the visual order.
- **Contract** — Supabase tables / buckets and the gateway thumbnail endpoint exactly as design §3 (web lines cited
  there); no backend change; every write tested only against the fake `MediaHubData`.
- **Staging proof** — not verified on staging: device runtime needs G1 (task 9, `next_actor: owner`); covering
  checks are the offline jest suite `npx jest tests/media` and `npm run typecheck` / `npm run bundle`.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `parity-ledger --check`, `core-closure --check`,
  `gen-core-extract --check`, `npm run i18n:register`, `npm run i18n:gate` green.
- The 4 rows `native`; `/community/media-hub` in `native_only`; both routes in `NATIVE_ROUTES`.
- Packages and plugins reused as on `main` (design §5); `package.json`, `package-lock.json`, `app.config.ts` and `tests/app-config.test.ts` unchanged; read-only plugin test passes.
- Generated core files committed in the same PR; no `export *` from a web file.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (only `npm run X` / `npx jest P` refs) and
  `plan-sparring.md`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production. No web screen, `App.tsx`, registry or manifest change.
