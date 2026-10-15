# Tasks — Vitana cards on the own profile

Author: kiro (owner request 2026-10-15). VTIDs are allocated by Claude Code after sparring and Gate 1. The two lanes
are independent: each one alone satisfies R1 (`requirements.md` R5).

<!-- lane: frontend-placement -->
## Lane A — Card list + placement on `/me/profile`  [vitana-v1]
depends_on: []

- [ ] **A1. Catalog.** In `src/components/vitana/vitana-card-catalog.ts`:
  - add `PROFILE_ENRICHMENT_CARDS`;
  - set `CARD_SCREENS.profile` to `{ server: 'profile', allow: [...PROFILE_ENRICHMENT_CARDS, 'G1'], boost: ['G1'], features: [] }`;
  - update the comment above `CARD_SCREENS`.
- [ ] **A2. Mobile.** In `src/pages/EditProfilePage.tsx`:
  - remove both strips above `MobileIdCardSwitcher` (L437–441);
  - mount G1 (stacked, `only="features"`) and then the carousel (`only="server"`, `maxCards={6}`) in the Posts tab,
    after `MobileAutopilotBanner` and before the Cover Library tile.
- [ ] **A3. Desktop.** In `EditProfilePage.tsx`:
  - remove the strip container above `<ProfileLayout>` (L680–686);
  - mount the same two strips below `<ProfileLayout>`, in the Cover Library container, before the tile.
- [ ] **A4. Tests:**
  - `src/components/feature/feature-cards.test.tsx` L230: `profile.features` is now `[]`, and add a pin for `profile.allow`;
  - `src/components/vitana/EnrichmentCardStrip.test.tsx`: update the profile cases that expect E6–E10;
  - add a case showing the profile strips drop E6–E10 and F2/F4/F7 while G1 stays;
  - if `EditProfilePage` can be rendered with existing mocks, add a test that the first strip comes after
    `MobileIdCardSwitcher`. Otherwise this is covered by A5.
- [ ] **A5. Staging check, read-only:** on `/me/profile`, mobile and desktop, as a test user with an incomplete
  profile:
  - the ID card is first;
  - the cards appear only in the zone from `design.md` §2;
  - there is no Vitana Index, Talk to Vitana, Invite, Connect or Notifications card.

Acceptance: R1–R4. `npm run lint`, `npx tsc --noEmit` and `npx vitest --run` on the touched tests are green.

<!-- lane: gateway-profile-list -->
## Lane B — Gateway profile list  [vitana-platform]
depends_on: []

- [ ] **B1.** In `services/gateway/src/services/enrichment/card-catalog.ts`:
  - set `SCREEN_ENRICHMENT_CARDS.profile` to `['E1','E2','E3','E4','E5','E11']`;
  - update the doc comment.
- [ ] **B2.** In `services/gateway/test/routes/enrichment-cards.test.ts` L171: `profile` now expects
  `['E1','E2','E3','E4','E5','E11']`. `profile_completion_pct` tests stay unchanged.
- [ ] **B3.** Check whether `docs/validation/VTID-05143/pglite-unified-card-system-check.mjs` pins the profile list.
  If it does, update it.

Acceptance: R1 (server side), R3 (`profile_completion_pct` unchanged), R5. The gateway unit tests are green.
