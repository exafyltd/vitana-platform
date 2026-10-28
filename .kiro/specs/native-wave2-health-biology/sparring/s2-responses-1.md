# Planner responses — session 2, round 1

Session: `fd2711ec-7768-4b2a-afe3-e4c80ba0d2d5` · answering `s2-round-1.md`.

All four findings are **accepted**. Verified each against vitana-v1 `main` (the session now has `spar_refs`
read access) and corrected `plan.md` accordingly. Summary of the fixes, then the disposition block.

## What changed in `plan.md`

- **Dependency graph (decision 3 + lanes table).** `health-plans-services` is no longer labelled data-free. It now
  **`depends_on health-hub`** because two of its screens read live health data in the mobile-web branch the native
  port targets:
  - `Plans.tsx` → `useHealthPlans()` reads `user_health_plans` via the prod Supabase client. The native twin consumes
    `health-hub`'s native health-data module for the read instead of re-implementing fetching.
  - `PillarsOfHealth.tsx` renders `<VitanaIndexValue />` in its non-Spotlight (mobile-web) branch
    (`src/pages/health/PillarsOfHealth.tsx:85`), and `VitanaIndexValue` reads the live Index via `useVitanaIndexCache()`
    (`src/components/health/VitanaIndexValue.tsx:1` → `VitanaIndexProvider.tsx`). The native twin consumes
    `health-hub`'s Vitana Index value/provider twin.
  `health-hub` now runs first; `vitana-index-biology` and `health-plans-services` both wait on it, then run in parallel
  with each other on disjoint route files. `conditions`, `education` and `services-hub` stay static/navigational.
- **Reads-only twin (new decision 3a).** The `Plans.tsx` write mutations are **stubbed/omitted, not ported**:
  `generatePlan` (invokes the `generate-personalized-plan` edge function — LLM path, Bedrock governance unverified for
  a native caller), `updateAdherence` (UPDATE), `logAdherence` (INSERT) are not wired; the native `useHealthPlans` port
  exposes the read only; the "Generate New Plan" button and adherence controls are disabled/hidden behind a `readsOnly`
  constant; the generator wizard is omitted. Documented as a hard "reads only" constraint in the lane file. The
  network-guard unit test (test plan) explicitly covers these paths — no non-GET, no edge-function invoke.
- **vitanaIndex.ts exports (decision 2).** Corrected to the **actual** exports verified on main: `VITANA_INDEX_TIERS`,
  `getVitanaIndexTier`, `nextTier`, `pointsToNextTier`, `getVitanaIndexPercentage`, `formatVitanaIndexScore`, and the
  `VitanaIndexTier` type. The earlier `pillarKeys`/`pillarLabel` reference was wrong — **no such exports exist** in
  that file. Pillar labels come from the i18n `screens.health.pillar_*` keys and the local `pillars` array in
  `PillarsOfHealth.tsx`, so there is no pillar-key helper to extract and the plan no longer claims one.
- **Test plan** updated: plans screen reads-only assertions; pillars renders the Index value via the shared twin; the
  consent/no-write network guard now names the Plans mutation paths explicitly.

## Dispositions

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed against vitana-v1 main: Plans.tsx:16 imports useHealthPlans; useHealthPlans.ts selects from user_health_plans via the prod Supabase client and exposes generatePlan/updateAdherence/logAdherence. Plans.tsx is a health-data-reading screen, not static/navigational. Fixed the plan: health-plans-services now depends_on health-hub and consumes health-hub's native health-data module for the read (decision 3 + lanes table); writes handled read-only per new decision 3a. Dependency graph resolved honestly (health-hub first; vitana-index-biology and health-plans-services both depend on it, run in parallel with each other on disjoint route files).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: PillarsOfHealth.tsx:85 renders <VitanaIndexValue /> in the NON-Spotlight (mobile-web) branch; VitanaIndexValue (VitanaIndexValue.tsx:1) reads the live Index through useVitanaIndexCache() from VitanaIndexProvider. Since the native port mirrors the mobile-web branch (decision 6), the Index read IS in scope (the Spotlight/desktop branch omits the tile, but that branch is not ported). PillarsOfHealth therefore consumes health-hub's native Vitana Index value/provider twin rather than adding its own subscription; added to decision 3 and the lanes table. Not a parity exception — the data dependency is real for the ported branch.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed: src/lib/vitanaIndex.ts exports VITANA_INDEX_TIERS, getVitanaIndexTier, nextTier, pointsToNextTier, getVitanaIndexPercentage, formatVitanaIndexScore and the VitanaIndexTier interface. There are no pillarKeys/pillarLabel exports anywhere in that file. Corrected decision 2 to list the real exports and to state plainly that pillarKeys/pillarLabel do not exist there; pillar labels come from i18n screens.health.pillar_* keys and the local pillars array in PillarsOfHealth.tsx, so no pillar-key helper is extracted.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Confirmed the three mutations in useHealthPlans.ts (generatePlan invokes the generate-personalized-plan edge function at line 23; updateAdherence UPDATEs user_health_plans; logAdherence INSERTs plan_adherence_logs). Took the conservative read-only option (a), not the port option (b): new decision 3a makes the native twin reads-only — mutations unwired, generate button and adherence controls disabled/hidden behind a readsOnly constant, generator wizard omitted — documented as a hard 'reads only' constraint. The network-guard test now explicitly covers these paths (no non-GET, no edge-function invoke). Option (b) is deferred: porting the mutations would need separate LLM-governance verification of the edge function from a native client; out of scope for this read-only screen-port cluster.",
    "deferred_to": ""
  }
]
```

## Next

Committing `plan.md` + this file and pushing to start the next round.
