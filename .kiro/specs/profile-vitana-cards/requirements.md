# Requirements — Vitana cards on the own profile (`/me/profile`)

Owner request to Kiro (2026-10-15): the standardized Vitana cards (Unified Card System, VTID-05085/05086/05087,
built under VTID-05143) must appear on the profile only when they **enrich the profile**, and they must **not be the
first thing on the page**. Today every card is shown, including Vitana Index and Talk to Vitana, above the ID card.

## Current state (analysed 2026-10-15, vitana-v1 `main` @ origin)

- Only the own profile (`/me/profile` → `src/pages/EditProfilePage.tsx`) mounts the cards. Someone else's profile
  (`/u/:identifier` → `PublicProfilePage.tsx`) mounts none, so visitors never see them.
- `EditProfilePage.tsx` mounts two `EnrichmentCardStrip`s **before** the ID card, on mobile (L438–441) and desktop
  (L681–686):
  - `only="server"`, `maxCards={11}`: every open enrichment card E1–E11;
  - `only="features"`: boost G1 + static feature cards **F2 Vitana Index, F4 Talk to Vitana, F7 Invite a friend**.
- Sources of this list:
  - `src/components/vitana/vitana-card-catalog.ts` L185: `profile: { server: 'profile', boost: ['G1'], features: ['F2','F4','F7'] }`;
  - gateway `services/gateway/src/services/enrichment/card-catalog.ts` L71: `profile: ALL_ENRICHMENT` (E1–E11).

## Classification of the cards the profile shows today

| Card | Enriches the profile? | Reason |
|---|---|---|
| E1 Show your face (avatar) | **yes** | shown on the ID card |
| E2 Tell others about you (bio) | **yes** | About tab |
| E3 Share your first post | **yes** | Posts tab |
| E4 What are you into? (interests) | **yes** | profile data |
| E5 Where are you based? (location) | **yes** | profile data |
| E11 Add a cover photo | **yes** | profile header |
| G1 Complete your profile (%) | **yes** | the profile-completion umbrella card |
| E6 / E7 Connect Instagram / Facebook | no | an OAuth data import (`social_connections`) for connectors. The visible social links on the ID card back have their own "Connect" control. |
| E8 Connect your calendar | no | a connector, no profile content |
| E9 Import your contacts | no | a connector |
| E10 Don't miss a thing (notifications) | no | a device setting |
| F2 Vitana Index | no | a global health feature. The Index is already inside the identity card (VTID-04470), so the card is a duplicate. |
| F4 Talk to Vitana | no | a generic assistant CTA |
| F7 Invite a friend | no | a growth CTA. It stays on Community and Make-a-post. |

The cards removed here stay on their other screens unchanged. Home still shows E6–E10 and Messenger still uses all
E1–E11. F2, F4 and F7 keep their current placements elsewhere.

## Requirements

1. **R1 — Only profile-enriching cards.** On `/me/profile` the strips show only E1, E2, E3, E4, E5, E11 and G1.
   They never show E6–E10 or any F card.
2. **R2 — Not first.** On mobile and desktop the first thing on `/me/profile` is the member's profile itself: the ID
   card, then the stats. The cards come later (placement: `design.md` §2).
3. **R3 — Same behaviour otherwise.** Existing dismiss rules stay the same: server cooldown of 7 days, a card hides
   itself when complete, and closing a drawer refreshes the cards. `profile_completion_pct` is unchanged: the gateway
   computes it over all E1–E11, independent of the screen. Every other screen's list is unchanged.
4. **R4 — Visitors.** `PublicProfilePage` stays without cards (this is the invariant today; no change).
5. **R5 — One source of truth.** The frontend catalog (`allow`) and the gateway `SCREEN_ENRICHMENT_CARDS.profile`
   carry the same list. Either alone is enough for R1, so the two lanes can ship in any order.
