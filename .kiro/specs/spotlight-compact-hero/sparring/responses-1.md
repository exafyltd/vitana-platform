# Responses to round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct. My Journey passes a rail at AutopilotDashboard.tsx:508 (JourneyRail, compact VCards only, JourneySpotlight.tsx:116), and /autopilot/audiobook renders the same component (App.tsx:1545). D1 is rewritten to KEEP the existing JourneyRail unchanged on My Journey. It already meets SR-08 and the stage-rail layout (archetypes.ts:28, SpotlightLayout.tsx:34, index.css:443-444), and keeping it drops nothing members use today. No rail is added to the three rail-less dashboards (Health, Vitana Index, Wallet). On those, the 'Up Next' content (NextBestActionCard, NextSteps) becomes a bento tile. JourneyHero (JourneySpotlight.tsx:22) is added to the compact-hero scope, with steps 2 and 5 updated. The false 'no rail to keep' claim is removed."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "rejected",
    "rationale": "The file exists on vitana-v1 origin/main: `git ls-tree -r origin/main -- tests/e2e/staging` lists tests/e2e/staging/design-contract.staging.spec.ts and tests/e2e/staging/vtid-05111-tier-b.staging.spec.ts. The check is the `SINGLE.has(entry.archetype)` block that asserts 'exactly one spotlight card in the first viewport' over every migrated manifest entry with ?spotlight=1. The plan now cites it by that assertion, not by a line number, so it cannot drift. The partner's search miss is most likely the companion-ref path filter; the file is real and is the enforcement D2 relies on."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct: spotlight-tier-b.vtid-05111.test.tsx:222-227 accepts 1–2 (card + skeleton). D2 now states that tolerance. A new step 6 extends the counted patterns with `<DashboardHeroBand`, keeps the 1–2 tolerance commented as card + skeleton, and adds a regression assertion that each migrated dashboard renders a compact hero, so a page cannot silently fall back to 0 or to the old full hero. DashboardHeroBand also renders `<VCard size=\"spotlight\">` itself, so the runtime one-spotlight checks see it."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Corrected against vitana-v1 origin/main 847a9f68: SpotlightLayout.tsx:34, ArchetypeSkeleton.tsx:39 (case 'dashboard'), SpotlightLoading.tsx:59, archetypes.ts:28, VitanaIndexDetail.tsx:649/:650, Health.tsx:441/:442, Wallet.tsx:545/:546, AutopilotDashboard.tsx:483/:484 and :508. The plan now names the pinned commit."
  }
]
```

Also added (not raised, to head off a likely next finding): D4. Grid tiles use only content and data each page already loads (SR-24/25/26, no invented KPIs). Long-form sections stay full-width below the grid. Wallet's secondary actions move to a 'Quick actions' tile with the same handlers and IAP guards.
