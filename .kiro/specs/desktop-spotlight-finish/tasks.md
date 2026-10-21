# Tasks — Finish the Spotlight desktop redesign

One PR per lane (`kiro/desktop-spotlight-finish/<lane-id>`, title `VTID-xxxxx (desktop-spotlight-finish/<lane-id>): …`,
trailers `Collab-Session` / `Collab-Lane`). A lane changes only its `paths` (Lane scope). Every lane: clear every
`design/*` finding in the files it owns, lower `baseline/design.json` + `baseline/eslint.json` for those files only
(`node scripts/ci/pr-gate/gate.mjs baseline-design|baseline-eslint <eslint-json>`), add
`docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}`, run `npx vitest run`, `npm run build`,
`npm run lint`. Mapping rules: design.md §2–§5. No What's New entry (redesign of existing screens).

## Skeletons — decision 3
<!-- lane: skeletons -->
- [ ] S1 `SpotlightLoading` in `src/components/layout/spotlight/skeletons/SpotlightLoading.tsx`, exported from
  `src/components/layout/spotlight/index.ts` (design.md §6; owner approved 2026-10-16: skeletons on desktop and
  mobile). Vitest `SpotlightLoading.test.tsx`: desktop Spotlight → archetype/row skeleton; mobile → the same
  skeleton shaped for the mobile layout; both with `aria-busy`, no spinner, reduced-motion → no cross-fade.
- [ ] S2 Replace the data-loading spinners in the owned pages with `SpotlightLoading` (desktop and mobile), including
  `CreatorOnboarded`'s residual legacy `animate-spin` (its Spotlight branch is already a skeleton; session eeb01b78
  R3-F1). Only `community/LiveRoomViewer` may keep a spinner, and only if its reported site is gated on a genuine user
  mutation (`isPending`) with a `// design-allow-next-line` reason the code supports — never on a data load. Owned pages (`BusinessHub`, `BusinessListings`, `BusinessOpportunities`,
  `CreatorOnboarded`, `Home` ×4, `IntentBoard`, `IntentMatchDetail`, `Messages`, `MyIntents`, `MyTickets`,
  `PostDetail`, `assistant/AIAssistant`, `community/EventGamePage`, `community/LiveRoomViewer`, `community/MediaHub`,
  `discover/Marketplace`, `patient/Dashboard`, `patient/Results`, `settings/Limitations`,
  `settings/SettingsNotifications`); page-level waits use the page's manifest archetype, in-section waits `rows`.
  Move each loading branch inside the page's `ScreenFrame`/`FrameWhen`.
- [ ] S3 Clear the other findings in these files (palette 119, card 7, size 11).
- [ ] S4 Staging spec `vtid-<VTID>-skeletons`: with delayed GETs, `[data-archetype-skeleton]` visible and no
  `.animate-spin` outside a button at **both** 1400×900 `?spotlight=1` and 390×844 (at 390 the app bar and bottom nav
  stay visible while loading); CLS < 0.1 on `/messages` and `/my-tickets` at both viewports. MP4 `docs/validation/<VTID>/spinner-vs-skeleton.mp4` (design.md §6) linked in the PR body.

## Public profile — decision 4
<!-- lane: public-profile -->
- [ ] P1 `PublicProfilePage` and `EditProfilePage`: `FrameWhen on={spotlight} archetype="detail"` around the shared
  `ProfileLayout`; the profile header becomes the one `spotlight` VCard; rail = compact/row cards (connections,
  badges, groups). Phone branch untouched.
- [ ] P2 `PublicProfilePage` spinner → `SpotlightLoading archetype="detail"`; `Profile.tsx` `require-screen-frame`
  via `FrameWhen`.
- [ ] P3 Clear every finding in `src/components/profile/**` (64 files) and the three pages (palette 406, size 39).
  New copy (if any) in `src/i18n/*/spotlightProfile.json`, DE first; `npm run i18n:inventory`.
- [ ] P4 Vitest for the framed/unframed branches; staging spec `vtid-<VTID>-public-profile` (`/u/<handle>`,
  `/me/profile`; read-only, no follow/like/edit clicks).

## Commerce shell — decision 4, Commerce UX contract
<!-- lane: commerce-shell -->
- [ ] C1 `CommerceShell`: third case — desktop + `useSpotlightEnabled()` + signed-in member + not
  `isCommerceHost()` → `AppLayout` skin (as `inApp` today). Guests and the commerce host unchanged.
- [ ] C2 `ShopFeed`: with Spotlight on render inside `AppLayout` with the existing `FrameWhen archetype="immersive"`.
- [ ] C3 Clear every finding in `src/components/commerce/**`, `src/pages/Commerce*.tsx`, `UniversalCart`,
  `portals/CommercePortalLogin` (palette 175 incl. the amber portal skin → `brand-*`/`primary` tokens).
- [ ] C4 Vitest (4 `CommerceShell` cases, `ShopFeed` shell); staging spec `vtid-<VTID>-commerce-shell`; PR body
  "UX acceptance" section — friction unchanged, no new step/field/dialog.

## Remaining screens + manifest — decision 4
<!-- lane: remaining-screens -->
- [ ] R1 Frame `/redeem` (`form`), `/tickets/success` + `/tickets/demo` (`detail`), `/delete-account` (`form`).
  Spinner classification is from the code at the pinned ref (session eeb01b78 R3-F1): `RedeemVoucher`
  (`authLoading || voucherLoading`) and `TicketPurchaseSuccess` (`loading || verifying`) are **data-load gated** →
  `SpotlightLoading` skeleton (`form` / `detail`), **no** allow-comment. `legal/DeleteAccount`: skeletonise any
  data-load spinner; only a spinner gated on the real delete mutation (`isPending`) keeps
  `// design-allow-next-line: <code-accurate reason>`.
- [ ] R2 `MobileSettings`, `MobileSubscriptions`, `MobileDailyDiary`, `NotAuthorized`: `require-screen-frame` /
  `no-raw-content-card` via `FrameWhen` / `Panel`.
- [ ] R3 Clear every finding in the owned pages, `src/components/tickets/**`, `src/components/voucher/**`.
- [ ] R4 `scripts/design/screen-manifest.mjs`: `REDIRECT_COMPONENTS` (design.md §7); `--sync`; test cases in
  `src/design/screen-manifest.test.ts`.
- [ ] R5 Flip every remaining route to `migrated` except `/business/sell-earn`; remove `/shop` from `NO_SHELL` in
  `tests/e2e/staging/design-contract.staging.spec.ts`.
- [ ] R6 Staging spec `vtid-<VTID>-remaining-screens` (read-only; the delete-account confirm is never clicked); update
  the "System-wide done" numbers in this file.

## Colours batch 2 — health, journey, supplements, diary, memory
<!-- lane: colours-batch-2 -->
- [ ] K2 Clear every finding in the lane's 86 files (palette 790, size 33, card 8, direction 6); PR lists shifts by
  category; staging spec `vtid-<VTID>-colours-batch-2` (`/health`, `/health/*`, `/memory/*`, `/journey` at 1440/390).

## Colours batch 3 — community, sharing, event game, live rooms, meetups, events, crossover, feed, home
<!-- lane: colours-batch-3 -->
- [ ] K3 Clear every finding in the lane's 81 files (palette 608, size 87, card 7, direction 2); staging spec
  `vtid-<VTID>-colours-batch-3` (`/comm`, `/comm/groups`, `/comm/live-rooms`, `/sharing/*`).

## Colours batch 4 — discover, wallet, payment, calendar, business, reseller, orders, subscription, intents
<!-- lane: colours-batch-4 -->
- [ ] K4 Clear every finding in the lane's 96 files (palette 545, size 51, card 10); staging spec
  `vtid-<VTID>-colours-batch-4` (`/discover/*`, `/wallet/*`, `/calendar`, `/business`).

## Colours batch 5 — shared popups, settings, AI, dev, admin, messages, onboarding
<!-- lane: colours-batch-5 -->
- [ ] K5 Clear every finding in the lane's 85 files (palette 454, size 40, card 6, direction 1); staging spec
  `vtid-<VTID>-colours-batch-5` (`/settings/*`, `/ai/*`, `/search`, `/wallet`, `/autopilot`).

## Colours — BackOffice dialogs
<!-- lane: colours-backoffice -->
- [ ] K6 Clear the 6 palette findings in the 3 BackOffice dialogs; staging spec `vtid-<VTID>-colours-backoffice`
  (role gate for the community account, read-only).

## Sizes — files without palette findings
<!-- lane: sizes -->
- [ ] Z1 Clear every finding in the lane's 52 files (size 63, card 5, direction 2) per design.md §3–§5; PR body
  summarises kept sizes by reason (`npm run design:allowances`); staging spec `vtid-<VTID>-sizes`.

## System-wide done (coordinator, no lane)
- [ ] Manifest 100 % `migrated` except `/business/sell-earn`; `design.json` 0 for every non-chrome file; STAGING-VERIFY
  green for every lane; Gate 2 per release.
- [ ] Open owner items: `desktop_spotlight` in production; `/business/sell-earn` visibility; I18N-PROPAGATE plan;
  admin-role staging account.
