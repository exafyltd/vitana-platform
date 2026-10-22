---
change_class: standard
---
# Plan — profile-posts-full-width

Author: Kiro, session `kiro-exafyltd-202610220818-5273` (seat `exafyltd`). Code repo: `exafyltd/vitana-v1` (frontend
only — no backend, no migration, no gateway, no i18n string change). Spec folder lives in vitana-platform because
PLAN-SPAR runs here; `handoff.md` declares the `exafyltd/vitana-v1: main` spar ref.

<!-- plan:begin -->
## Goal
Owner request 2026-10-22 (Kiro Web): *"Posts are shifted too far to the right because of the profile picture, the
avatar. Let's set it up like in the example, profile picture above, post right below and taking up the entire
space."* Examples: two Facebook mobile posts (avatar + name + time on one header line, text and media full width
below). Owner confirmed the scope with a phone screenshot: **"The profile Posts tab only"** (card of "Stefan Ehlke",
text and map video indented next to the avatar).

## Measured state (vitana-v1 origin/main 60c18aee4)
- `src/components/profile/shared/tabs/ProfilePostsTab.tsx` `PostCardWithInteractions` (rendered from line 136,
  defined line 154) is the card. Body wrapper `space-y-4 relative px-5 py-4 md:px-6 md:py-5` (line 208).
- Line 209 `<div className="flex items-start gap-3">` holds the avatar (`h-11 w-11`, line 212, inside a Tooltip)
  and line 221 `<div className="flex-1 min-w-0">`, which contains **everything else**: the name/handle/time/delete
  row (222-234), the text or background-style block (235-246), `FeedMedia` image (247-253), video (254-266). So
  text and media start 44 px + 12 px = 56 px right of the card padding — the bug in the owner's screenshot.
- The divider (269) and the like/comment/share pill (271) are already outside the column, full width.
- `ProfilePostsTab` is used by `src/components/profile/shared/ProfileLayout.tsx:267`,
  `src/components/profile/shared/ProfileSplitNavigation.tsx:161` and `src/pages/EditProfilePage.tsx:517`. No test
  covers the card today.
- The News Feed card (`src/components/home/CommunityPostCard.tsx`) has no avatar column and is **out of scope**
  (owner: "profile Posts tab only").

## Change (one lane `card-layout`, one source file)
1. Line 209 row keeps only the avatar and the name/handle/time/delete row: `flex items-center gap-3`; the avatar
   and its Tooltip are unchanged.
2. Text/background block, image and video move out of the column and become siblings below the header row, full
   width of the card.
3. Mobile (< `md`): the image, the video frame and the background-style text block go edge to edge of the card
   (`-mx-5`, no rounding, no shadow), as in the examples; plain text stays inside the card padding.
4. Desktop (≥ `md`): unchanged look — the moved blocks get `md:ps-14` (= 44 px avatar + 12 px gap) and keep
   `md:mx-0 md:rounded-xl md:shadow-md`, so the desktop card renders as on main. Decision taken (most
   conservative): the owner asked about the mobile app; desktop stays as is.
5. `data-testid`s on the header row, the text block and the media wrapper for the test. No string, prop, hook,
   data or behaviour change (like, comment, share, delete, mentions, Tooltip, video controls untouched).

## Tests
- New Vitest `src/components/profile/shared/tabs/ProfilePostsTab.layout.test.tsx` (mocks `useProfilePosts`,
  `usePostInteractions`, `useAuth`, `useShareOrCopy`): for a text + image post and a text + video post, the text and
  the media are **not** inside the header row / not siblings of the avatar column; the header row contains the
  avatar and the name; mobile edge-to-edge and `md:ps-14` classes are present. Red on origin/main (text is inside
  the avatar's sibling column), green after.
- `npx vitest run src/components/profile`, `npm run build`, `npm run lint` (error count not above main),
  `npm run test:design-contract`.
- Targeted visual check (CLAUDE.md): Playwright screenshots of the Posts tab at 390×844 and 1400×900 on the
  lane's preview/local build, read-only, test user only viewed — never posting/liking as it, never production.
- Staging: `docs/validation/<VTID>/staging-tests.json` names a read-only staging spec that opens a public profile
  Posts tab at 390×844 and asserts the text's left edge equals the header row's left edge.

## Risks
- Media now ~112 px wider on phones → taller images (aspect ratio kept by `FeedMedia`); intended.
- `EditProfilePage` shows the same card — it gets the same layout; intended (same component).
- Rollback = revert one file.

## Unchanged
News Feed card, PostDetail, native app, parity ledger, screen manifest, i18n, data, desktop appearance.
<!-- plan:end -->
