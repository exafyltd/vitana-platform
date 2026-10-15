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
