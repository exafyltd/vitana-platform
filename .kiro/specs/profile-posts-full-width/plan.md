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
Mechanism (R1-F1): line 209 `flex items-start gap-3` becomes a two-column grid
`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 items-center md:items-start`, so one DOM serves both layouts:
1. Header (`data-testid="profile-post-header"`, `display: contents`): the avatar (unchanged classes plus
   `md:row-span-2`, Tooltip unchanged) in column 1 and the name/handle/time/delete row in column 2, row 1.
   Phones: `items-center` (avatar and name vertically centred, as in the examples). Desktop: `md:items-start` =
   today's top alignment.
2. Body (`data-testid="profile-post-body"`) = text/background block, image, video, moved out of the old
   `flex-1 min-w-0` column: `col-span-2 min-w-0` on phones (full width under the header),
   `md:col-span-1 md:col-start-2` from `md` (column 2, next to the row-spanning avatar = today's desktop column).
3. Phones edge to edge, each of the three blocks separately (R1-F2, R1-F4): image = `FeedMedia` className
   `mt-4 rounded-xl shadow-md` → `-mx-5 mt-4 w-auto md:mx-0 md:w-full md:rounded-xl md:shadow-md` (`w-auto`
   overrides FeedMedia's own `w-full` through `cn`/twMerge so the negative margins widen it); video = the raw
   `<video>` wrapper (FeedMedia is not used for video here) `mt-4 rounded-xl overflow-hidden shadow-md bg-black` →
   `-mx-5 mt-4 overflow-hidden bg-black md:mx-0 md:rounded-xl md:shadow-md`; background-style block
   `mt-2.5 … rounded-xl px-5 py-8 …` → `-mx-5 mt-2.5 … px-5 py-8 … md:mx-0 md:rounded-xl`. Rounding and shadow
   exist only from `md`; `-mx-5` equals the body's mobile `px-5`, the Card's `overflow-hidden` clips nothing extra.
   Plain text stays inside the card padding.
4. Desktop (≥ `md`) renders as on main. Measured on a local prototype at 1400×900 (mocked hooks, no live data):
   avatar, name, text and media left/top edges identical to main (avatar 341/53, name 397/53, text 397/87, media
   397/131 on both). At 390×844 text moves from x=93 to x=37 (header left edge) and media from 260 px to 356 px
   wide (card width 358 minus borders). Decision taken: the owner asked about the mobile app; desktop stays as is.
5. No string, prop, hook, data or behaviour change (like, comment, share, delete, mentions, Tooltip, video
   controls untouched).

## Tests
- New Vitest `src/components/profile/shared/tabs/ProfilePostsTab.layout.test.tsx` (R1-F3: rendered inside
  `MemoryRouter`; mocks `@/hooks/useProfilePosts`, `@/hooks/usePostInteractions`, `@/context/AuthProvider`,
  `@/hooks/useShareOrCopy`, `@/hooks/useTranslation`, `@/lib/i18n-toast`, `@/lib/locale-format` and
  `@/components/media/FeedMedia` (stub keeping `className`); `Tooltip`, `renderMentions`, `getPostBackground`,
  `MentionInput` render real — the tab itself mounts its `TooltipProvider`). Cases: header contains avatar + name
  and not the text; body contains text + media with `col-span-2 md:col-span-1 md:col-start-2`; image media classes
  `-mx-5 md:mx-0 md:rounded-xl md:shadow-md`; raw video wrapper inside the body with `-mx-5 md:mx-0 md:rounded-xl`;
  avatar `md:row-span-2`. Prototype result: 4/4 red on origin/main, 4/4 green after; `src/components/profile`
  14 files / 81 tests green.
- `npx vitest run src/components/profile`, `npm run build`, `npm run lint` (prototype: ProfilePostsTab.tsx 15
  pre-existing `design/no-raw-palette` errors, identical to main; test file clean), `npm run test:design-contract`.
- Targeted visual check (CLAUDE.md): Playwright screenshots of the Posts tab at 390×844 and 1400×900 (local harness
  with mocked hooks, or the lane's preview build viewed read-only — never posting/liking as the test user, never
  production), inspected, attached to the PR.
- Staging: `docs/validation/<VTID>/staging-tests.json` names a read-only staging spec that opens a public profile
  Posts tab at 390×844 and asserts the first post's text left edge equals the avatar's left edge (± 1 px) and is
  skipped (not failed) when the profile has no posts.

## Risks
- Media now ~112 px wider on phones → taller images (aspect ratio kept by `FeedMedia`); intended.
- `EditProfilePage` shows the same card — it gets the same layout; intended (same component).
- Rollback = revert one file.

## Unchanged
News Feed card, PostDetail, native app, parity ledger, screen manifest, i18n, data, desktop appearance.
<!-- plan:end -->
