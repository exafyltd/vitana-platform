# Tasks — profile-posts-full-width

<!-- lane: card-layout -->
## Lane `card-layout` — header on top, post full width (vitana-v1)
- [ ] L1 Vitest `ProfilePostsTab.layout.test.tsx` written first; record it red on vitana-v1 `origin/main`.
- [ ] L2 `PostCardWithInteractions`: header row = avatar + name/handle/time/delete (`flex items-center gap-3`);
      text/background block, image, video moved below it as full-width siblings (plan §Change 1-2).
- [ ] L3 Mobile edge-to-edge media and background block (`-mx-5`, no rounding/shadow); desktop restored with
      `md:ps-14 md:mx-0 md:rounded-xl md:shadow-md` (plan §Change 3-4).
- [ ] L4 Playwright screenshots 390×844 and 1400×900 of the Posts tab (text post, image post, video post),
      inspected; attached to the PR.
- [ ] L5 `docs/validation/<VTID>/` with `scope.json`, `acceptance.md`, `staging-tests.json` and the read-only
      staging spec `tests/e2e/staging/vtid-<VTID>-profile-posts-full-width.staging.spec.ts`.

**Acceptance (reviewer agent):** the new test fails on origin/main and passes on the PR head; on < `md` text and
media start at the header row's left edge and media spans the card width; on ≥ `md` the card matches main
(screenshots); no change outside the lane `paths`; no string, hook, data or behaviour change; `npx vitest run`,
`npm run build`, `npm run lint` (errors not above main), `npm run test:design-contract` green; PR-GATE and **Lane
scope** green; no write to any live system, no test against production.
