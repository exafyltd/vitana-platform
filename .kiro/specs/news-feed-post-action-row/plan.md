---
change_class: light
---
# Plan — news-feed-post-action-row

Author: Kiro, session `kiro-jtadic-202611191143-e223` (seat `jtadic`). Code repo: `exafyltd/vitana-v1` (frontend
only: one component and its test; no backend, no migration, no gateway, no i18n string change, no data change). The
spec folder lives in vitana-platform because PLAN-SPAR runs here; `handoff.md` declares the `exafyltd/vitana-v1: main`
spar ref.

<!-- plan:begin -->
## Goal
Owner request 2026-11-19 (Kiro Web, with a phone screenshot of the News Feed): *"Let's arrange the like (heart),
comment and send post in a message better. Now it seems a bit crowded, too close to the account, the profile that
posted. It's in News Feed."* and *"I started this session already on Claude Code. Explore how far it has been
implemented and continue the end to end implementation."*

## What the earlier session did (vitana-v1 origin/main bbe90b713)
- PR exafyltd/vitana-v1#1685 (VTID-05795, merged 2026-11-13 as 447e46a82) first moved the actions onto their own row
  (commits b7e7c1213, 2e6daead8), then put them back on the author line, right-aligned (6e0ea0274). That last state
  is what merged and what the owner's screenshot shows: avatar + "Daniela Küper" + ♥ 7 + 💬 3 + send + ⋮ on one line,
  then a separate "7 Likes" line below.
- Its staging check was a vitest ref plus a GET of `/`. No visual check was recorded (PR body: "Not verified on a phone").

## Measured state
- `src/components/home/CommunityPostCard.tsx` is the card the phone News Feed renders (`NewsFeedItemCard` →
  `CommunityPostCard`, also `src/pages/Home.tsx`, `src/pages/PostDetail.tsx`). The author/actions row is the
  `mt-3 flex items-center gap-2` div after `EventAttachmentCard`; the actions group is `ms-auto flex shrink-0 items-center
  gap-0.5` with like and comment `h-11 px-2 text-xs`, 14 px icons, send `h-11 w-9`, then `NewsPostModerationMenu`.
  The likers button "{count} Likes" (VTID-03554) is a separate block below (`mt-1.5 block py-1.5`).
- Local harness measurement at 390×844 (mocked hooks, no live data): like at x=201, comment 244, send 287, ⋮ 325, all
  on the author's line; tap targets 41×44, 41×44, 36×44; "7 Likes" a 28 px high row below.
- `src/components/home/desktop/FocusStageCard.tsx` (desktop Spotlight stage) has its own action markup and is not
  changed.

## Change (one lane `card-actions`, one source file + its test)
1. Author row (`data-testid="post-author-row"`): avatar (`h-8 w-8`, was `h-7 w-7`), author name (`font-medium`,
   truncates), and the ⋮ `NewsPostModerationMenu` at the inline end (`ms-auto`). No action button on this row.
2. Action row (`data-testid="post-action-row"`) directly below, separated by a hairline (`mt-2 border-t
   border-border/40 pt-1`): like, comment and send grouped at the inline start (`-ms-3 gap-1`, so the heart's icon
   lines up with the avatar's edge), each a 44 px high, at least 44 px wide target (`h-11 min-w-11 px-3`, `text-sm`,
   20 px icons; send `h-11 w-11`); the "{count} Likes" likers button moves into this row at the inline end
   (`ms-auto h-11`), shown only when the count is above 0, as today.
3. No string, prop, hook, handler, aria-label, data or behaviour change: like toggles, comment opens the inline
   comments, send opens the send-in-message sheet, "{count} Likes" opens the likers dialog, the ⋮ menu is the same
   component. Logical properties only (`ms-`, `-ms-`), so Arabic mirrors.
4. Result measured on the harness at 390×844: author row alone; actions on the row below at x=21/83/145 (58×44,
   58×44, 44×44), "7 Likes" at the end (39×44); total card height unchanged within one row (the old separate likes line
   is gone, the action row replaces it).

## Tests
- Vitest `src/components/home/CommunityPostCard.test.tsx`, new case "puts the author on its own row and like, comment,
  send and the likes count on a separate row below it": red on origin/main (no `post-author-row`), green after. The
  existing 21 cases (counts, comments, likers dialog, auto-open, VTID-05795 grouping) stay green unchanged.
- `npx eslint` on both files: no new error (the test file's one `no-explicit-any` at line 19 is on main already).
- `npm run build`; `npx vitest run src/components/home`.
- Targeted visual check (CLAUDE.md): Playwright screenshots at 390×844 and 1400×900 of the card (image post, long name
  with large counts, post with 0 likes) and with the ⋮ menu opened, from a local harness with mocked hooks, before
  and after; inspected; described in the PR.
- Staging: `docs/validation/<VTID>/staging-tests.json` = the vitest ref above plus the read-only Playwright spec
  `tests/e2e/staging/vtid-<VTID>-news-feed-post-action-row.staging.spec.ts`: signed in as the documented test user
  (token call only; the staging guard aborts every other write), `/home` at 390×844 and `/home?spotlight=0` at
  1400×900; on the first post card the action row sits below the author row, holds like and comment and not the
  author name, every control is at least 44 px high, no horizontal overflow; comments, send sheet, likers dialog and
  ⋮ menu are opened and closed (Escape) without submitting or choosing anything. Skipped, not failed, when the feed
  has no post card. Heart toggling and sending are proven only by the Vitest suite and the local harness, never on
  staging. No production.
- Classes: `change_class: light` above is the sparring class; the lane's `scope.json` declares the PR-gate class
  `frontend-simple` (3 files outside `docs/validation/**`, all in its allow list).
- The comment composer's own send button is not changed (only the action-row send gets the 20 px icon).

## Risks
- The card gets one hairline more; height stays about the same because the likes line merges into the action row.
- `PostDetail` and `Home` render the same card and get the same layout; intended (one component).
- Rollback = revert one file.

## Unchanged
FocusStageCard (desktop stage), the native app (`apps/mobile`), profile Posts tab, i18n, data, gateway, screen manifest.
<!-- plan:end -->
