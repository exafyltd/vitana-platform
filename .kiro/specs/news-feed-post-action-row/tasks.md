# Tasks — news-feed-post-action-row

<!-- lane: card-actions -->
## Lane `card-actions` — author row on top, like / comment / send on their own row (vitana-v1)
- [ ] L1 Vitest case in `src/components/home/CommunityPostCard.test.tsx` written first; record it red on vitana-v1
      `origin/main` (no `post-author-row`).
- [ ] L2 `CommunityPostCard`: author row (avatar, name, ⋮ menu at the end) and, below a hairline, the action row
      (like, comment, send at the start, "{count} Likes" at the end), 44 px targets, 20 px icons (plan §Change 1-3).
- [ ] L3 Playwright screenshots 390×844 and 1400×900, before and after, plus the ⋮ menu opened; inspected; described
      in the PR.
- [ ] L4 `docs/validation/<VTID>/` with `scope.json`, `acceptance.md`, `commands.log`, `outputs/`,
      `staging-tests.json`, and the read-only staging spec
      `tests/e2e/staging/vtid-<VTID>-news-feed-post-action-row.staging.spec.ts`.

**Acceptance (reviewer agent):**
- Change types: UI
- **Outcome:** on the News Feed a member sees who posted on one line (avatar, name, ⋮) and the heart, comment and send
  controls on their own line below it, with clear space between them and the "{count} Likes" link at the end of
  that line; nothing crowds the author's name.
- **States:** 0 likes (no "{count} Likes" link, as today); a long author name truncates on the author row and never
  pushes the actions; large counts (3 digits) fit; a media_uploads-backed card (no send button) still shows like and
  comment; comments open and close as before.
- **Surfaces:** phone News Feed (`NewsFeedItemCard` → `CommunityPostCard`), `src/pages/Home.tsx`,
  `src/pages/PostDetail.tsx`; desktop Spotlight stage `FocusStageCard` unchanged.
- **Locales:** no new or changed string; logical properties only (`ms-`, `-ms-`), so ar mirrors.
- **Accessibility:** every control keeps its `aria-label` / `aria-pressed` / `aria-expanded`; each tap target is at
  least 44×44 px (likes link 44 px high); keyboard order author → menu → like → comment → send → likes.
- **Contract:** n/a: no boundary crossed (no hook, request, prop or data change).
- **Staging proof:** a read-only Playwright spec at 390×844 signs in as the test account (token call only), opens
  `/home`, and on the first post card asserts the action row sits below the author row, contains like and comment
  and not the author name, each control is at least 44 px high, and the page has no horizontal overflow; skipped,
  not failed, when the feed shows no post card.
- The new Vitest case fails on origin/main and passes on the PR head; the other cases of the file stay green
  unchanged; no change outside the lane `paths`; no behaviour change; `npx vitest run src/components/home`,
  `npm run build`, ESLint on the changed files (no error above main) green; PR-GATE and **Lane scope** green; no write
  to any live system, no test against production.
