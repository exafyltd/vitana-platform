# profile-vitana-cards — Plan sparring record

- **Plan hash (sha256 of the text between the plan markers, first 16 hex):** `92964488a27e7401`
- **Verdict:** CONVERGED (2 rounds; no open blocker or major)
- **Owner approval (Gate 1):** 2026-10-15, owner "yes" in the Claude Code session `session_012cmH1XjbSwZqQxxAbKu321` (plan hash `92964488a27e7401`; lane D meta-oauth parked, only B2 ships)
- **Change class:** standard · **Partner:** `plan-sparring-partner` (independent, read-only, Claude Opus 4.6 on Bedrock)
- **Author of the draft:** Kiro `kiro-202610151240-0371` (PR exafyltd/vitana-platform#4132)
- **VTIDs (allocated 2026-10-15 after Gate 1):** VTID-05210 `frontend-placement`, VTID-05211 `gateway-profile-list`, VTID-05212 `card-actions`. Each lane PR copies this record to `docs/validation/<its VTID>/plan-sparring.md`.

Round 1 findings F1–F8 (F3 and F5 major) and the planner responses are in the section below; round 2: F1–F5, F8 closed, F6–F7 acknowledged, no new findings.


<!-- plan:begin -->

## [requirements.md]
# Requirements — Vitana cards on the own profile, and card actions that work

Owner requests to Kiro on 2026-10-15:
1. The standardized Vitana cards (Unified Card System, VTID-05085/05086/05087, built under VTID-05143) belong on the
   profile only when they **enrich the profile**, and they must **not be the first thing on the page**. Today every
   card is shown above the ID card, including Vitana Index and Talk to Vitana.
2. Answers to the first draft:
   - **keep Instagram and Facebook on the profile** ("they also enrich the profile and help Vitana get to know the
     member");
   - placement **as proposed**.
3. **Every action button in every Vitana card must actually work.**

## Current state (analysed 2026-10-15 on vitana-v1 and vitana-platform `main`)

- Only the own profile (`/me/profile` → `src/pages/EditProfilePage.tsx`) mounts the cards. Someone else's profile
  (`/u/:identifier` → `PublicProfilePage.tsx`) mounts none.
- `EditProfilePage.tsx` mounts two `EnrichmentCardStrip`s **before** the ID card, on mobile (L438–441) and desktop
  (L681–686):
  - all open enrichment cards E1–E11;
  - G1, plus F2 Vitana Index, F4 Talk to Vitana and F7 Invite.
- Sources of the list:
  - `vitana-card-catalog.ts` L185 `profile: { …, features: ['F2','F4','F7'] }`;
  - gateway `card-catalog.ts` L71 `profile: ALL_ENRICHMENT`.

## Cards on the profile (owner-confirmed)

| Keep | Remove from the profile (they stay on their other screens) |
|---|---|
| E1 photo, E2 bio, E3 first post, E4 interests, E5 location, **E6 Instagram, E7 Facebook**, E11 cover, G1 Complete your profile | E8 calendar, E9 contacts (connectors); E10 notifications (device setting); F2 Vitana Index (already inside the identity card, VTID-04470); F4 Talk to Vitana; F7 Invite |

## Action audit (every registry card, 2026-10-15)

Working end-to-end (no change):
- E2, E3, E4, E10, E11;
- F1, F2 (every host page renders inside `AppLayout`, where the Index sheet listens), F3, F5, F6, F7, F9, F10, F11;
- G2, G3.

Not working or partly working:

| Card | What happens today | Evidence |
|---|---|---|
| **E6 Connect Instagram** | Always the "connect failed" toast. | No gateway task definition has `INSTAGRAM_*` and no secret exists (read-only `aws ecs describe-task-definition` / `secretsmanager list-secrets`, 2026-10-15). The provider config also uses the Instagram Basic Display API (`api.instagram.com/oauth/authorize`, `user_profile,user_media`), which Meta shut down on 2024-12-04 ([Meta](https://developers.facebook.com/docs/instagram-platform/)). |
| **E7 Connect Facebook** | Always the "connect failed" toast. | No `FACEBOOK_*` env or secret. |
| E6/E7 in the Appilix app | Even once configured, the OAuth result would land in the system browser, not in the app. | `useGoogleConnect.ts` L414 sends `?return=mobile` and starts the poller only for google/youtube. |
| **G1 Complete your profile** | On the profile it does nothing. It navigates to `/me/profile`, the page you are already on. | `CARD_DEEP_LINKS.G1` |
| **F4 Talk to Vitana** ("Got a question? — Ask Vitana") | Opens `/assistant`, the assistant **settings** page. Nobody can ask anything there. | `TalkToVitanaCard.tsx`; `App.tsx` L1470 |
| E9 Import contacts | Lands at the top of `/connectors`. The `#contacts` hash is ignored. | `ConnectedApps.tsx` has no hash reader |
| E8 Connect calendar | Lands at the top of `/connectors`. The calendar panel is far down. | same file |
| F8 Did you know | If the tip has no URL, the button stays disabled (`busy` is never reset). | `DidYouKnowCard.tsx` L42–64 |
| E1 photo / E5 location | Work: they open the Identity / About drawer. | No change needed |

## Requirements

1. **R1 — Only profile-enriching cards.** `/me/profile` shows only E1–E7, E11 and G1. It never shows E8–E10 or any
   F card.
2. **R2 — Not first.** The member's profile comes first: the ID card, then the stats. The cards follow later
   (placement in `design.md` §2).
3. **R3 — Same behaviour otherwise.** Dismiss, auto-hide on completion and drawer-close refresh stay as they are.
   `profile_completion_pct` stays unchanged. Every other screen's list stays unchanged.
4. **R4 — Visitors.** `PublicProfilePage` stays without cards.
5. **R5 — One source of truth.** The frontend `allow` and the gateway `SCREEN_ENRICHMENT_CARDS.profile` carry the
   same list.
6. **R6 — Every action works.** Every card's button leads to a place where the member can complete the card's
   promise, in one tap, on web and in the Appilix app.
7. **R7 — No dead cards.** A card whose action cannot work in this environment is not shown. For example, E6/E7
   stay hidden while the Meta OAuth credentials are missing, and they appear automatically once those credentials
   are configured.

## [design.md]
# Design — Vitana cards on the own profile, and card actions that work

## 1. Card list (R1, R5)

**vitana-v1 `src/components/vitana/vitana-card-catalog.ts`**
```ts
/** Profile shows only cards that enrich the profile itself (owner 2026-10-15). */
export const PROFILE_ENRICHMENT_CARDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E11'] as const;
profile: { server: 'profile', allow: [...PROFILE_ENRICHMENT_CARDS, 'G1'], boost: ['G1'], features: [] },
```
- `allow` must contain G1, because `isServerCardPlaced` checks `allow` before `boost`.
- This uses the existing `allow` mechanism, already used by `make-a-post`.

**vitana-platform `services/gateway/src/services/enrichment/card-catalog.ts`**
- `profile: ['E1','E2','E3','E4','E5','E6','E7','E11']`.
- The server order is the filtered `ENRICHMENT_PRIORITY`: E1, E2, E3, E6, E7, E4, E5, E11.

## 2. Placement (R2) — owner-confirmed as proposed

The cards move into the existing "improve your profile" zone next to the Cover Library tile (VTID-02806).

- **Mobile, Posts tab** (the default tab). Order inside it:
  1. Showcase header and hint
  2. Autopilot banner
  3. **G1** (stacked)
  4. **The enrichment carousel**
  5. Cover Library tile
  6. Posts

  The whole page then reads: ID card → stats → sticky tabs → Posts tab as above. The cards stay inside
  `!isBusinessTab`.
- **Desktop:** below `<ProfileLayout>`, in the Cover Library container, before the tile.
- **Mounts:**
  - `<EnrichmentCardStrip screen="profile" layout="stacked" only="features" />` (holds only G1 now);
  - `<EnrichmentCardStrip screen="profile" layout="carousel" maxCards={8} only="server" />`.

## 3. Card actions (R6, R7)

| Card | Fix |
|---|---|
| **G1** | Opens the first open profile step. It reads the cached `useEnrichmentCards('profile')`, takes the first card whose `CARD_DEEP_LINKS` entry starts with `/me/profile#`, and navigates there. The `useProfileEditorDeepLink` hash consumer then opens the drawer, so this also works when the member is already on `/me/profile`. Fallback: `/me/profile#about`. |
| **F4** | Opens a conversation with Vitana through the existing `activateOrb()` (`src/lib/orbActivate.ts`). If the ORB widget is not available, it navigates to `/comm/talk-to-vitana`, the existing Talk to Vitana page. `CARD_DEEP_LINKS.F4` becomes `/comm/talk-to-vitana`. |
| **E8 / E9** | `ConnectedApps.tsx`: add `id="calendar"` and `id="contacts"` anchors on the Mail/Calendar/Contacts section, plus a `location.hash` effect that calls `scrollIntoView` and consumes the hash (same pattern as `useProfileEditorDeepLink`). `CARD_DEEP_LINKS.E8` becomes `/connectors#calendar`. |
| **F8** | When `accept()` returns no URL, reset `busy` and decline the tip, so the card neither freezes nor comes back. |
| **E6 / E7 (now)** | The gateway leaves E6/E7 out of `eligibleEnrichmentCards` while `INSTAGRAM_CLIENT_ID` / `FACEBOOK_CLIENT_ID` are unset (one `isSocialProviderConfigured(provider)` helper next to `getOAuthUrl`). Result: no dead card anywhere (Home, Community, Messenger, Profile), and `profile_completion_pct` is unchanged. |
| **E6 / E7 (working)** | (a) **Owner:** a Meta app with Facebook Login and the "Instagram API with Instagram Login", with the redirect URIs `…/api/v1/social-accounts/callback/{instagram,facebook}` and app review for the permissions. (b) **Claude Code:** puts the 4 values into Secrets Manager and the gateway task definitions through the canonical provisioning workflow. (c) **Code:** move the Instagram provider from the retired Basic Display API to Instagram Login (`www.instagram.com/oauth/authorize`, scope `instagram_business_basic`, `graph.instagram.com/me?fields=user_id,username`). Also send `?return=mobile` and start the poller for instagram/facebook inside Appilix. |
| E1, E5 | No change. They open the Identity drawer and the About drawer (the location field is in About). |

**Limit to know:** Meta's current Instagram API only connects **professional** (business or creator) Instagram
accounts. Personal accounts can no longer be connected by any app. The E6 copy should say this, or E6 shows only
after the member chooses "I have a business/creator account". This is decision Q3.

## 4. Decisions

- **Q1 — answered:** E6/E7 stay on the profile.
- **Q2 — answered:** placement as proposed.
- **Q3 — answered (owner 2026-10-15):** one sentence in the E6 description saying that only business and creator
  Instagram accounts can be connected.
- **Q4 — in progress:** the owner creates the Meta app using the checklist in §5.

## 5. Owner checklist for the Meta app (lane D prerequisite)

1. At developers.facebook.com, under the Vitana business portfolio, create one app. Complete **Business
   Verification**; Meta requires it before the app may serve all users.
2. **App settings → Basic:**
   - privacy policy `https://vitanaland.com/privacy`
   - terms `https://vitanaland.com/terms`
   - data deletion instructions `https://vitanaland.com/delete-account`
   - app icon, category and contact email
3. **Facebook Login:**
   - valid OAuth redirect URIs:
     - `https://<prod gateway>/api/v1/social-accounts/callback/facebook`
     - `https://preview-aws-gateway.vitanaland.com/api/v1/social-accounts/callback/facebook`
   - permissions `public_profile`, `email`
4. **Instagram → "API setup with Instagram login":**
   - the same two redirect URIs with `/callback/instagram`
   - permission `instagram_business_basic`
5. **App Review:** request access for every user (Advanced Access) to these permissions, then switch the app to
   **Live**. Until approval, only people with an app role (admin, developer or tester) can connect, which is enough
   for staging.
6. Add the staging test people as testers: one Instagram business or creator account and one Facebook account.
7. Put 4 values as **GitHub repository secrets in vitana-platform**. Never paste them into chat or a PR:
   - `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` (the Meta App ID and App Secret)
   - `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` (the Instagram App ID and Instagram App Secret on the
     Instagram login setup page; these are different from the Meta App ID)

   Claude Code then binds them to the gateways with a provisioning workflow, staging first. This follows the
   `AWS-PROVISION-APPILIX-SECRETS.yml` pattern.

**Finding for Claude Code (read-only, 2026-10-15):**
- The production gateway task definition `vitana-gateway-awsdr:198` sets neither `GATEWAY_PUBLIC_URL` nor `APP_URL`.
- So `social-connect-service.ts` L25 builds every OAuth callback on its fallback `https://vitana.app`. This affects
  Google and YouTube too.
- Before step 3, confirm the production gateway's public domain and set `GATEWAY_PUBLIC_URL`. The `<prod gateway>`
  above must be that domain.

Alternatives considered for placement:
- **Each card in its own tab:** rejected, it splits one task into 3–4 mounts.
- **Between the stats and the tabs:** rejected, the cards would still sit above the content.
- **The page bottom:** rejected, nobody sees the cards there.
- **A section heading:** rejected, it would need a new key in every locale.

## [tasks.md]
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

<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED (cosmetic): line refs are L439-441 / L683-685; implementers use the code, not the line numbers.
- F2 ACCEPTED: C5 also appends `?return=mobile` to the gateway fetch in `useStartSocialOAuth` (useGoogleConnect.ts ~L402) when `isAppilixWebView()`, matching `launchIncrementalConsent` L193, AND widens the L414 poller condition to instagram/facebook. Lane D's gateway handling of `return=mobile` for social callbacks is verified in C5's test before shipping; if the gateway ignores it for social providers, C5 is reduced to the already-parked lane D.
- F3 ACCEPTED, plan amended (C1): G1 reads `useEnrichmentCards('profile')` from the React Query cache only (the strip on the same page already warms it; no extra fetch is triggered from the card). While the query is unresolved, or no open card has a `/me/profile#…` deep link, G1 navigates to `/me/profile#about`. G1 only renders below 80 % profile completion (gateway trigger, card-catalog.ts L111), so an all-complete state is unreachable in practice; documented in the code comment. Tests: resolved, unresolved, none-open.
- F4 ACCEPTED (wording): audit row reads "E9 sends `/connectors#contacts` but ConnectedApps ignores the hash". C3 unchanged.
- F5 ACCEPTED as a clarification, no new design: `card-registry.tsx:70` maps F4 to `TalkToVitanaCard` for every surface, and `VitanaChatCard` renders registry components, so the `activateOrb()`-first logic lives once in `TalkToVitanaCard` and every surface inherits it. `CARD_DEEP_LINKS.F4 = '/comm/talk-to-vitana'` remains the fallback target and the voice-nav/other-consumer value. C6's VitanaChatCard test asserts the same ORB-first behaviour for F4.
- F6 REJECTED (no change): `profile_completion_pct` (routes/enrichment-cards.ts:99) is returned to the client, but R3 requires it unchanged, E6/E7 were already unachievable, and denominator changes would alter every screen. DEFERRED to the parked lane D: once E6/E7 work, the ceiling disappears. Tracked in lane meta-oauth.
- F7 DEFERRED: lane D / D1 (parked by owner). D1 will pin the current Graph version as a constant. Tracked in `.kiro/specs/profile-vitana-cards/tasks.md` lane D.
- F8 ACCEPTED: lanes A and C run `npm run i18n:inventory` if any i18n key changes; A and C add none (existing keys), so the commit step is conditional.
