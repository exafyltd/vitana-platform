# Tasks — Vitana cards on the own profile, and card actions that work

Author: kiro. Owner requests and answers: 2026-10-15. VTIDs are allocated by Claude Code after sparring and Gate 1.
Lanes A, B and C are independent. Lane D needs the owner's Meta app and the provisioned secrets first.

<!-- lane: frontend-placement -->
## Lane A — Card list + placement on `/me/profile`  [vitana-v1]
depends_on: []

- [ ] **A1.** Add `PROFILE_ENRICHMENT_CARDS` (E1–E7, E11). Set `CARD_SCREENS.profile` to
  `{ server: 'profile', allow: [...PROFILE_ENRICHMENT_CARDS, 'G1'], boost: ['G1'], features: [] }` and update the
  comment.
- [ ] **A2. Mobile** (`EditProfilePage.tsx`): remove both strips above `MobileIdCardSwitcher`. In the Posts tab,
  mount G1 (stacked, `only="features"`) and the carousel (`only="server"`, `maxCards={8}`) after
  `MobileAutopilotBanner` and before the Cover Library tile.
- [ ] **A3. Desktop:** remove the strip container above `<ProfileLayout>`. Mount the same two strips below it, before
  the Cover Library tile.
- [ ] **A4. Tests:**
  - `feature-cards.test.tsx` L230: `profile.features` is `[]`, plus a pin for `profile.allow`;
  - `EnrichmentCardStrip.test.tsx`: the profile cases drop E8–E10 and F2/F4/F7, and G1 stays;
  - if `EditProfilePage` renders with the existing mocks, a test that the strips come after `MobileIdCardSwitcher`.
- [ ] **A5. Staging, read-only.** On `/me/profile`, mobile and desktop, with an incomplete test profile, check that:
  - the ID card is first;
  - the cards sit in the zone from `design.md` §2;
  - no Vitana Index, Talk to Vitana, Invite, Calendar, Contacts or Notifications card is shown.

Acceptance: R1–R4.

<!-- lane: gateway-profile-list -->
## Lane B — Gateway profile list + no dead social cards  [vitana-platform]
depends_on: []

- [ ] **B1.** `card-catalog.ts`: `SCREEN_ENRICHMENT_CARDS.profile = ['E1','E2','E3','E4','E5','E6','E7','E11']`.
- [ ] **B2.** `isSocialProviderConfigured('instagram'|'facebook')`, true when the client id **and** secret env vars are
  set. Exclude E6/E7 in `eligibleEnrichmentCards` (or in the route) while it returns false. `profile_completion_pct`
  is unchanged.
- [ ] **B3. Tests:**
  - `test/routes/enrichment-cards.test.ts` L171: profile list;
  - new cases: E6/E7 hidden without the env vars and present with them, on every screen that lists them;
  - check `docs/validation/VTID-05143/pglite-unified-card-system-check.mjs` and update it if it pins the lists.

Acceptance: R1 (server side), R3, R5, R7.

<!-- lane: card-actions -->
## Lane C — Card actions that work  [vitana-v1]
depends_on: []

- [ ] **C1. G1** (`CompleteProfileCard.tsx`): navigate to the deep link of the first open `/me/profile#…` card from
  `useEnrichmentCards('profile')`. Fallback: `/me/profile#about`. Test: on `/me/profile` the tap opens a drawer.
- [ ] **C2. F4** (`TalkToVitanaCard.tsx`): call `activateOrb()`. When it returns false, navigate to
  `/comm/talk-to-vitana`. Set `CARD_DEEP_LINKS.F4 = '/comm/talk-to-vitana'`. Test both branches.
- [ ] **C3. E8/E9** (`ConnectedApps.tsx`): add the `calendar` / `contacts` anchors and a hash → `scrollIntoView` effect
  that consumes the hash. Set `CARD_DEEP_LINKS.E8 = '/connectors#calendar'`. Test.
- [ ] **C4. F8** (`DidYouKnowCard.tsx`): when there is no URL, reset `busy` and decline. Test.
- [ ] **C5. Instagram/Facebook in Appilix** (`useGoogleConnect.ts`): send `?return=mobile` and start the poller for
  instagram/facebook. Test.
- [ ] **C6.** Click test for every registry card without one (E1, E2, E5, E8, E9, E11, F3, F4, F5, F6, F9, F11):
  each card's button calls its handler or navigates to an existing route. Run the same test inside
  `VitanaChatCard`.
- [ ] **C7. Staging, read-only:** tap each card's button on Home, Profile, My Journey, Community, Calendar,
  Vitana Index, Talk to Vitana, Messenger and the Make-a-post sheet. Record the result per card in
  `docs/validation/<VTID>/card-actions.md`.

Acceptance: R6. `npm run lint`, `npx tsc --noEmit` and `npx vitest --run` on the touched tests are green.

<!-- lane: meta-oauth -->
## Lane D — Instagram and Facebook connect working  [vitana-platform]
depends_on: [gateway-profile-list]

Blocked until both of these exist:
- the owner's Meta app: Facebook Login + Instagram API with Instagram Login, the redirect URIs, and app review;
- Claude Code has provisioned `INSTAGRAM_CLIENT_ID/SECRET` and `FACEBOOK_CLIENT_ID/SECRET` (Secrets Manager → gateway
  task definitions, through the canonical workflow, staging first).

- [ ] **D0.**
  - The production `GATEWAY_PUBLIC_URL` is set (`design.md` §5 finding). The value comes from Claude Code; Kiro does
    not write to AWS.
  - Add a `AWS-PROVISION-META-OAUTH-SECRETS.yml` workflow file that copies the `AWS-PROVISION-APPILIX-SECRETS.yml`
    pattern for the 4 secrets. Claude Code dispatches it.
- [ ] **D1.** `social-connect-service.ts`: move the Instagram provider to Instagram Login (`www.instagram.com/oauth/authorize`,
  `instagram_business_basic`, the token exchange, `graph.instagram.com/me?fields=user_id,username`, and the long-lived
  token exchange). Check the Facebook v19 config against the current Graph API version.
- [ ] **D2.** Unit tests for the new URLs, scopes and profile mapping (`profile_url`, username).
- [ ] **D3.** E6 description gets one sentence saying only business and creator Instagram accounts can be connected
  (Q3, owner-approved). It goes into every locale through the i18n pipeline: the gateway tips plus vitana-v1
  `screens.vitanaCards.E6`.
- [ ] **D4. Staging:** connect a test Instagram professional account and a test Facebook account. The card then
  disappears (E6/E7 completion via `social_connections`).

Acceptance: R6 for E6/E7. B2 then shows the cards automatically.
