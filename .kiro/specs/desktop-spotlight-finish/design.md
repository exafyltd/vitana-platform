# Design — Finish the Spotlight desktop redesign

Builds only on what exists: `ScreenFrame`, `FrameWhen`, `Panel`, `ArchetypeSkeleton`
(`src/components/layout/spotlight/**`), `VCard` / `VCardSkeleton` (`src/components/ui/vcard/`), the shadcn `Skeleton`
(`src/components/ui/skeleton.tsx`), `useSpotlightEnabled()` (`src/hooks/useSpotlightEnabled.ts`: `!isMobile &&
(override ?? tenant flag)`), the tokens in `src/index.css`, and the ratchet tooling in `scripts/ci/pr-gate/gate.mjs`.

## 1. Measured state (origin/main 5c4632ea9, 2026-10-16)

`npx eslint src/pages src/components -f json`, `design/*` only:

| Rule | Lines | Files |
|---|---:|---:|
| `design/no-raw-palette` | 3,220 | 411 |
| `design/no-arbitrary-size` | 359 | 208 |
| `design/no-raw-content-card` | 50 | 50 |
| `design/no-physical-direction` | 32 | 16 |
| `design/no-page-spinner` | 27 | 24 |
| `design/require-screen-frame` | 6 | 6 |
| **total** | **3,694** | **541** |

`baseline/design.json` carries 3,705 in its entries (11 of slack from earlier PRs; lanes lower to the real count).
Batch 1 (#1411, VTID-05112) already took 60 files to 0; the 411 palette files here are what it left.

Arbitrary sizes (420 values on the 359 lines, static classification): 47 identical to a scale class, 38 within 2 px,
335 keep (175 px values > 2 px off the scale, 113 `vh`/`dvh`, 13 `%`, 26 `calc()`/`vw`/`ch`/`min()`). The per-line review
in each lane decides; these are planning numbers.

Manifest: 346 routes, 329 `migrated`, 17 `legacy`.

Sidebar/ORB chrome (never touched, SR-01; keeps 58 errors): `src/components/AppLayout.tsx`,
`src/components/dev/DevSidebar.tsx`, `src/components/vitanaland/OrbDiscoveryHint.tsx`,
`src/components/mobile/MobileBottomNav.tsx`, `src/components/mobile/SideDrawerNav.tsx`,
`src/components/mobile/TopAppBar.tsx` (the phone counterparts of the sidebar, ORB and Soundscape per contract §D).

## 2. Colour mapping (decision 1, option A)

### 2.1 Order of precedence
1. SPOTLIGHT_RULES §E row that matches the usage.
2. The semantic role of the element: status (success/warning/error/info + `-subtle`), severity, `category-1..8`
   for chart/category colours (stable order per component: the first distinct hue → `category-1`, …), surfaces
   (`surface-page|raised|sunken`, `card`, `muted`, `popover`), text (`foreground`, `muted-foreground`,
   `primary-foreground` on primary fills), borders (`border`, `input`, `ring`).
3. A domain or system token that already exists for that screen family (`domain-health-*`, `domain-community-*`,
   `pill-*`, `sys-*`, `util-*`, `calendar-*`, `contact-*`, `profile-*`, `gradient-*-start/end`, `brand-*`) when the
   screen already uses that family.
4. Opacity suffixes carry over (`bg-purple-500/20` → `bg-category-3/20`).

### 2.2 Families §E does not name
| Raw | Token |
|---|---|
| `text-white` / `text-white/NN` on a primary/brand fill | `text-primary-foreground` (`/NN` kept) |
| `bg-white/NN` glass panels on app surfaces | `bg-card/NN` |
| `border-white/NN` on app surfaces | `border-border/NN` |
| `text-gray-900`/`slate-900`, `text-black` | `text-foreground` |
| `text-gray-400..700` | `text-muted-foreground` |
| `bg-gray-50`/`slate-50` | `bg-surface-sunken` |
| `bg-gray-200..300` (tracks, dividers) | `bg-muted` / `bg-border` |
| page gradients (`from-*-50 via-*-50 to-*-50`) | `from-surface-page-from via-surface-page-via to-surface-page-to` |
| brand / CTA gradients (`from-purple-500 to-pink-500`) | `from-primary to-accent`, or the matching `gradient-*-start/end` |
| `text-[#hex]`, `bg-[#hex]`, `style={{ color: '#…' }}` | nearest token; in `style`: `hsl(var(--token))` |

### 2.3 Kept literals (escape hatch with reason, listed in each PR)
- Scrims and text over photos/video (`bg-black/NN`, `from-black/NN`, `text-white` on media): photos are the same in
  both themes; a theme token inverts the scrim in one mode (a contrast failure, not a "small shift").
- Third-party brand marks with no `contact-source-*` token (e.g. Google/Apple logo fills).
Reason strings: `on-media scrim, theme-independent` / `third-party brand colour`.

## 3. Sizes (decision 2)
Replace with the identical class, else the nearest class when ≤ 2 px away (spacing scale, 4 px steps; `max-w-*`
named scale for widths; `h-screen`, `h-dvh`, `w-full`, `h-full` for 100 % values). Otherwise keep the value with
`// design-allow-next-line: <reason>` — e.g. `viewport-bound sheet height`, `measured media box`, `calc against fixed
chrome`. No new size tokens.

## 4. Raw content cards (SR-09)
A file that imports `@/components/ui/card`: member content items (post, product, event, provider, group) → `VCard`
(size per archetype); everything else (settings sections, form containers, operator panels) → `Panel` from
`@/components/layout/spotlight/Panel` — it re-exports the shadcn Card, so the DOM is identical and phones do not change.

## 5. Physical directions (SR-19)
Logical classes. Kept with a reason: centring (`left-1/2 -translate-x-1/2`), slide animations bound to
`translate-x`, and sheets/drawers whose `side`/`direction` prop is physical.

## 6. Skeletons (decision 3)

New file `src/components/layout/spotlight/skeletons/SpotlightLoading.tsx`, exported from
`src/components/layout/spotlight/index.ts`:

```tsx
type SpotlightLoadingProps = {
  /** page-level wait: the archetype of the screen that is loading */
  archetype?: Archetype;
  /** in-section wait (load more, a tab body): this many row skeletons instead */
  rows?: number;
};
```

Owner approved 2026-10-16 (after seeing the desktop MP4 and asking for the mobile version): data-loading spinners
become skeletons on desktop Spotlight **and** on mobile.

- Desktop with `useSpotlightEnabled()` true → `ArchetypeSkeleton archetype` (or `rows` × `VCardSkeleton size="row"`)
  inside the page's `ScreenFrame` / `FrameWhen`.
- Mobile (and desktop with Spotlight off) → the same `ArchetypeSkeleton` / `VCardSkeleton` shaped like the page's
  final mobile layout (single column, the stage and rail stacked as the loaded page stacks them), rendered where the
  page content goes: `TopAppBar` and `MobileBottomNav` stay mounted and do not move.
- Both branches: `aria-busy` and a visually hidden "loading" label from the existing `loading.json` shard; no spinner.
  Content replaces the skeleton with a short cross-fade (`motion-safe:` opacity transition, none under
  `prefers-reduced-motion`); the skeleton reserves the loaded layout's boxes, so there is no layout shift (CLS < 0.1).
- Placement: each page moves its loading branch inside the frame/layout it renders when loaded, so the header, utility
  row and rail (desktop) or app bar and bottom nav (mobile) appear at once and only the content swaps.
- **Only genuinely mutation-gated spinners keep a spinner**, verified against the code at the pinned ref (session
  eeb01b78 R3-F1): `community/LiveRoomViewer` (only if its reported spinner is gated on a user mutation `isPending`)
  and `legal/DeleteAccount` (only on the actual delete mutation `isPending`). Each keeps its inline spinner with a
  `// design-allow-next-line: <reason>` the code supports. **The spinners that were wrongly called
  "action-in-progress" are data-load gated and become skeletons, not allow-comments:** `RedeemVoucher`
  (`authLoading || voucherLoading`) → `form`, `TicketPurchaseSuccess` (`loading || verifying`) → `detail`, and
  `CreatorOnboarded`'s legacy `animate-spin` (`isLoading || isRefetching`) → `form` (its Spotlight branch is already a
  skeleton). The raw palette class (`border-blue-600` in `CreatorOnboarded`) maps to `border-primary` (decision 1).

Spinner inventory (27 in 24 files), classification derived from the code at the pinned ref (session eeb01b78 R3-F1):
the data-loading spinners → skeletons — `skeletons` (incl. `CreatorOnboarded`'s Spotlight branch and its residual
legacy spinner), `public-profile` 1 (`PublicProfilePage`), and `remaining-screens` for `RedeemVoucher` (`form`) and
`TicketPurchaseSuccess` (`detail`). Only genuinely mutation-gated (`isPending`) spinners keep a `design-allow-next-line`
with an accurate reason: `skeletons` — `LiveRoomViewer` (only if its reported spinner is action-gated); `remaining-screens`
— `legal/DeleteAccount` (only on the real delete mutation). No data-load spinner is masked by an allow-comment.

MP4: a Playwright script (not committed to the suite) records `/messages`, `/community/media` and `/my-tickets` with
the data request delayed by `page.route` (GETs only, delay then `route.continue()`), before (main) and after (branch),
at 1400×900 `?spotlight=1` and 390×844 (both now show the skeleton after); `ffmpeg` joins them side by side into
`docs/validation/<VTID>/spinner-vs-skeleton.mp4` (≤ 5 MB). Run on a local dev build or the PR preview, signed in as the
test user, read-only.

## 7. Remaining screens (decision 4)

| Route | Today | After (Spotlight on) | Lane |
|---|---|---|---|
| `/u/:identifier` | `legacy`, `ProfileLayout` without frame | `detail`: profile = the one spotlight VCard; posts/tabs in stage; connections, badges, groups as compact/row cards in the rail | public-profile |
| `/me/profile` | `legacy`, same `ProfileLayout` in edit mode | same `detail` frame, edit affordances unchanged | public-profile |
| `/profile/:id` | `LegacyProfileRedirect` | leaves the manifest (redirect) | remaining-screens |
| `/redeem` | `legacy` | `form` (`Panel` container) | remaining-screens |
| `/tickets/success`, `/tickets/demo` | `legacy` | `detail` (the ticket/result is the spotlight card) | remaining-screens |
| `/delete-account` | `legacy` | `form`; confirm flow unchanged | remaining-screens |
| `/settings`, `/profile/subscriptions`, `/daily-diary` | desktop redirects; phone pages | `migrated` (desktop lands on a framed target); phone pages get `FrameWhen` for `require-screen-frame` | remaining-screens |
| `/settings/connected-apps`, `/settings/social`, `/earthlinks/*`, `/i/:code`, `/commerce/connections/:id` | redirect components | leave the manifest | remaining-screens |
| `/dev` | index redirect inside `DevLayout` | `migrated` (`workspace`, operator route) | remaining-screens |
| `/shop` | `immersive`, no app shell | `immersive` inside `AppLayout` (sidebar + ORB stay) | commerce-shell |
| `/commerce/*` portal | standalone shell on desktop | `AppLayout` skin for signed-in members on the app host (same as the phone app already does); standalone for guests and `commerce.vitanaland.com` | commerce-shell |
| `/business/sell-earn` | `legacy` | unchanged — open owner item | — |

Manifest generator (`scripts/design/screen-manifest.mjs`): a `REDIRECT_COMPONENTS` set
(`RedirectPreservingSearch`, `LegacyProfileRedirect`, `RetiredTenantRedirect`, `CommerceConnectionRedirect`,
`InviteLanding`) is treated like `<Navigate>`; `--sync` drops those routes; `screen-manifest.test.ts` gets a case per
component.

## 8. Lanes and file ownership

Each measured file belongs to exactly one lane; that lane clears **every** `design/*` rule in it (so no two PRs edit
one file). Computed from the ESLint report; the generator's self-check found 0 overlaps and 0 orphans.

| Lane | Seat → reviewer | Files with findings | Main findings | depends_on |
|---|---|---:|---|---|
| `skeletons` | exafyltd → hotmail | 20 | spinner 23, palette 119, card 7, size 11 | — |
| `public-profile` | exafyltd → hotmail | 67 | palette 406, size 39, frame 3, spinner 1 | skeletons |
| `commerce-shell` | exafyltd → hotmail | 28 | palette 175, size 6, card 1 | — |
| `remaining-screens` | exafyltd → hotmail | 17 | palette 93, size 13, card 5, frame 3, spinner 3 | skeletons, public-profile, commerce-shell |
| `colours-batch-2` (health, journey, diary, memory) | exafyltd → hotmail | 86 | palette 790, size 33, card 8 | — |
| `colours-batch-3` (community, sharing, live rooms, events, home) | exafyltd → hotmail | 81 | palette 608, size 87, card 7 | — |
| `colours-batch-4` (discover, wallet, calendar, business, orders) | exafyltd → hotmail | 96 | palette 545, size 51, card 10 | — |
| `colours-batch-5` (shared popups, settings, AI, dev, admin, messages) | exafyltd → hotmail | 85 | palette 454, size 40, card 6 | — |
| `colours-backoffice` | jtadic → exafyltd | 3 | palette 6 | — |
| `sizes` (files without palette findings) | exafyltd → hotmail | 52 | size 63, card 5, direction 2 | — |
| chrome (no lane, SR-01) | — | 6 | palette 24, size 16, direction 18 | — |

Seats from `docs/programs/areas.yaml`: `frontend` → `exafyltd` (catch-all; `messenger` is also `exafyltd`),
`backoffice` → `jtadic`. Reviewer seats differ from the lane seat.

Shared paths (the only exception to disjointness): `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` in every
lane (each lowers only its own entries; regenerate on conflict), and `docs/SCREEN_INVENTORY.md` in the three lanes that
add copy (`public-profile`, `commerce-shell`, `remaining-screens`), each with its own new i18n shard
(`spotlightProfile`, `spotlightCommerce`, `spotlightRemaining`, DE first, all 11 locales). Colour, size and skeleton
lanes add no copy.

## 9. Testing
- Vitest per lane (`npx vitest run`), `npm run build`, `npm run lint`, `node scripts/ci/pr-gate/gate.mjs
  ratchet-design <eslint-json> --base <sha>`; `npm test` runs the manifest and nav-registry tests.
- Staging: one read-only Playwright spec per lane, `tests/e2e/staging/vtid-<VTID>-<lane>.staging.spec.ts`, listed in
  `docs/validation/<VTID>/staging-tests.json`; at 1440×900 with `?spotlight=1` and at 390×844. Signs in, navigates,
  reads; the network guard aborts every non-GET except sign-in. Never against `vitanaland.com`.
- `design-contract.staging.spec.ts` covers every route flipped to `migrated`.
- Colour shifts: each PR body lists them; screenshots at 1440 light/dark and 390 attached for Gate 2.
