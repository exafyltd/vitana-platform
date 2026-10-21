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
