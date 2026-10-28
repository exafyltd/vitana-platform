# Tasks — profile-posts-full-width

<!-- lane: card-layout -->
## Lane `card-layout` — header on top, post full width (vitana-v1)
- [ ] L1 Vitest `ProfilePostsTab.layout.test.tsx` written first; record it red on vitana-v1 `origin/main`.
- [ ] L2 `PostCardWithInteractions`: two-column grid; header (avatar `md:row-span-2` + name/handle/time/delete,
      `items-center md:items-start`); body (text/background block, image, raw video wrapper) `col-span-2` on
      phones, `md:col-span-1 md:col-start-2` from md (plan §Change 1-2).
- [ ] L3 Phones: image `FeedMedia`, raw video wrapper and background block edge to edge (`-mx-5`, no
      rounding/shadow); from md `md:mx-0 md:rounded-xl` (+ `md:shadow-md` on image/video) (plan §Change 3-4).
- [ ] L4 Playwright screenshots 390×844 and 1400×900 of the Posts tab (text post, image post, video post),
      inspected; attached to the PR.
- [ ] L5 `docs/validation/<VTID>/` with `scope.json`, `acceptance.md`, `staging-tests.json` and the read-only
      staging spec `tests/e2e/staging/vtid-<VTID>-profile-posts-full-width.staging.spec.ts`.

**Acceptance (reviewer agent):** the new test fails on origin/main and passes on the PR head; on < `md` text and
media start at the header row's left edge and media spans the card width; on ≥ `md` the card matches main
(screenshots); no change outside the lane `paths`; no string, hook, data or behaviour change; `npx vitest run`,
`npm run build`, `npm run lint` (errors not above main), `npm run test:design-contract` green; PR-GATE and **Lane
scope** green; no write to any live system, no test against production.
