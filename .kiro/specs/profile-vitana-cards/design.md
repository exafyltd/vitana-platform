# Design — Vitana cards on the own profile

## 1. Card list (R1, R5)

**vitana-v1 `src/components/vitana/vitana-card-catalog.ts`**
```ts
/** Profile shows only cards that enrich the profile itself (owner 2026-10-15). */
export const PROFILE_ENRICHMENT_CARDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E11'] as const;
profile: { server: 'profile', allow: [...PROFILE_ENRICHMENT_CARDS, 'G1'], boost: ['G1'], features: [] },
```
- `allow` must list G1. `isServerCardPlaced` checks `allow` before `boost`, so a missing G1 would hide the card.
- `features: []` removes F2, F4 and F7 from the profile.
- This uses the existing `allow` lever (already used by `make-a-post`). No new mechanism.

**vitana-platform `services/gateway/src/services/enrichment/card-catalog.ts`**
```ts
profile: ['E1', 'E2', 'E3', 'E4', 'E5', 'E11'],
```
- The server order stays `ENRICHMENT_PRIORITY` filtered: E1, E2, E3, E4, E5, E11.
- `SCREEN_BOOST_CARDS.profile` stays `['G1']`.

## 2. Placement (R2) — where the cards fit best

The guiding idea: the member sees **their profile first**, and the cards sit in the place where the member already
improves the profile. That place already exists: the **Cover Library tile** (VTID-02806) is an "enrich your profile"
action on both layouts. The cards move next to it, so there is one "improve your profile" zone instead of a banner
stack above the ID card.

**Mobile (`EditProfilePage.tsx`, Posts tab — the default tab, `useState<MobileProfileTab>("posts")`)**

New order:
1. ID card switcher
2. Stats
3. Sticky tab bar
4. Posts tab:
   1. Showcase header + hint
   2. Autopilot banner
   3. **G1 Complete your profile** (stacked)
   4. **Enrichment carousel** (E1–E5, E11)
   5. Cover Library tile
   6. Posts

Why this place:
- The Posts tab is the default, so the cards stay reachable without searching. But they come only after the
  profile itself (ID card, stats, tabs).
- E3 "Share your first post" sits directly above the (empty) posts list.
- The block is inside `!isBusinessTab`, as the tabs are today, so the Business segment stays clean.
- **G1 comes first.** It is the umbrella card with the percentage. The concrete steps follow in the carousel.

**Desktop (`EditProfilePage.tsx`)**
- Remove the strip container above `<ProfileLayout>`.
- Mount G1 + the carousel **below `<ProfileLayout>`**, in the existing `container mx-auto px-4 mt-4` block, right
  before the Cover Library tile.
- The desktop page then reads: ID card → stats → split navigation → showcase → autopilot suggestions →
  enrich-your-profile zone (G1, carousel, Cover Library).

**Mounts:**
- G1: `<EnrichmentCardStrip screen="profile" layout="stacked" only="features" />`, which holds only G1 now.
- Carousel: `<EnrichmentCardStrip screen="profile" layout="carousel" maxCards={6} only="server" />`.

Both mounts share one cached request (`useEnrichmentCards`), as today.

## 3. Alternatives considered

- **Each card in "its" tab** (E2/E4/E5 in About, E3 in Posts, E1/E11 near the ID card): this places the cards most
  precisely, but splits one task into 3–4 mounts, and the About tab is not the default tab. Rejected for now.
  It is the follow-up option if the owner wants it.
- **Between the stats and the sticky tab bar:** still above the content, and it pushes the tabs down. Rejected.
- **The very bottom of the page:** behind a long posts list the cards stop working as nudges. Rejected.
- **A section heading "Enrich your profile":** this needs a new key in every locale. Left out. The strip already has
  its aria-label (`screens.vitanaCards.stripLabel`).

## 4. Questions for sparring

- **Q1:** E6/E7 classed as "not profile" (they are data imports, not the visible links). Agree?
- **Q2:** Order inside the Posts tab: cards before the Cover Library tile (proposed) or after it?
