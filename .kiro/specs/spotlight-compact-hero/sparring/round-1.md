# Sparring round 1 — in_progress

Session: `68758ecb-ce43-444f-ba98-2fdf1dd0570b` · plan hash `cc77e3405261f02762da989df3e0ea21574cc28ca0a35e7b48e4cf8bbe2085de`

## Summary

The plan has a critical false premise in Decision D1. AutopilotDashboard.tsx passes a `rail` prop (JourneyRail) to ScreenFrame on its Spotlight branch (line 508), which is rendered because the `dashboard` archetype maps to `stage-rail` width. The plan states "No dashboard page renders a rail today" and bases the entire D1 decision on that claim. Additionally, the `design-contract.staging.spec.ts` file cited as an enforcement mechanism cannot be found. The existing composition test also does not enforce "exactly one" spotlight per dashboard—it allows 1-2.

## Findings

### R1-F1 [blocker]

D1 premise is false: AutopilotDashboard.tsx DOES pass a `rail` prop to ScreenFrame in its Spotlight branch. Line 508 passes `rail={<JourneyRail pendingCount={autopilotCount} onOpenAutopilot={handleOpenAutopilot} />}`. The `dashboard` archetype maps to `stage-rail` width (archetypes.ts:28), and SpotlightLayout renders the rail when `width === 'stage-rail' && rail != null` (SpotlightLayout.tsx:34). The entire D1 decision ('FOLD, do not keep … There is no rail to keep') is built on a false premise. Implementing the plan as-is would remove the JourneyRail from the Autopilot dashboard, losing the autopilot-count context panel and the sheet toggle for narrower viewports.

- `exafyltd/vitana-v1:src/pages/AutopilotDashboard.tsx:505` —             rail={<JourneyRail pendingCount={autopilotCount} onOpenAutopilot={handleOpenAutopilot} />}
- `exafyltd/vitana-v1:src/components/layout/spotlight/archetypes.ts:28` —   dashboard: 'stage-rail',
- `exafyltd/vitana-v1:src/components/layout/spotlight/SpotlightLayout.tsx:34` —   const hasRail = width === 'stage-rail' && rail != null;

Suggestion: Revise D1 to acknowledge the existing JourneyRail on AutopilotDashboard. Either keep the rail (requiring the `:has(> .sp-rail)` widening logic the plan explicitly dismisses), or fold its content into a bento tile AND update/add tests proving the autopilot-count information is still surfaced. The 'no rail to keep' claim must be removed.

### R1-F2 [major]

The plan cites `design-contract.staging.spec.ts:137` as one of three mechanisms that 'require exactly one spotlight element per dashboard' (D2). This file cannot be found in the repository (search returns no hits). If the file does not exist, the enforcement triad cited in D2 is incomplete and the claim that 'all three mechanisms [are] unchanged' is unverifiable.

- `exafyltd/vitana-v1:src/pages/spotlight-tier-b.vtid-05111.test.tsx:222` —     it('dashboard pages render exactly one spotlight-size element in their Spotlight branch', () => {
      for (const [route, file] of MIGRATED.filter(([r]) => archetypeOf(r) === 'dashboard')) {
        const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
        const spotlightCards = (src.match(/size="spotlight"/g) ?? []).length + (src.match(/<VitanaIndexHeroCard/g) ?? []).length;
        expect(spotlightCards, route).toBeGreaterThanOrEqual(1);
        expect(spotlightCards, route).toBeLessThanOrEqual(2); // card + its skeleton

Suggestion: Confirm the actual file path and line of the staging design-lint spec, or drop the reference. If it lives only in CI / a different repo / is planned-but-not-yet-written, say so. Do not cite phantom enforcement.

### R1-F3 [minor]

D2 says the composition test requires 'exactly one spotlight element per dashboard,' but the actual test at lines 225-227 allows 1 or 2 (`toBeGreaterThanOrEqual(1)` + `toBeLessThanOrEqual(2)`) because it counts both the card and its skeleton. The plan's characterisation overstates the strictness of this gate. If the compact hero introduces a new component name that is neither `size="spotlight"` nor `<VitanaIndexHeroCard`, the regex-based test will not detect it and the count could drop to 0 (skeleton only), passing silently.

- `exafyltd/vitana-v1:src/pages/spotlight-tier-b.vtid-05111.test.tsx:222` —         const spotlightCards = (src.match(/size="spotlight"/g) ?? []).length + (src.match(/<VitanaIndexHeroCard/g) ?? []).length;
        expect(spotlightCards, route).toBeGreaterThanOrEqual(1);
        expect(spotlightCards, route).toBeLessThanOrEqual(2); // card + its skeleton

Suggestion: Ensure the new `DashboardHeroBand` component either renders a VCard with `size="spotlight"` (so the existing regex catches it) or update the composition test regex to also match `<DashboardHeroBand`. Document the test's actual tolerance (1-2, not exactly 1).

### R1-F4 [minor]

The plan cites SpotlightLayout.tsx:38 for the rail-null guard, but the actual line is 34. Similarly, ArchetypeSkeleton.tsx 'dashboard branch' is cited as lines 42-51 but the switch case is at lines 39-49. The plan also cites VitanaIndexDetail.tsx:650 for the ScreenFrame call, but it is at line 649. These are small inaccuracies but they erode trust in the plan's references.

- `exafyltd/vitana-v1:src/components/layout/spotlight/SpotlightLayout.tsx:34` —   const hasRail = width === 'stage-rail' && rail != null;
- `exafyltd/vitana-v1:src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx:39` —     case 'dashboard':
      return (
        <div {...label} className="flex flex-col gap-4">
          <VCardSkeleton size="spotlight" />
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <VCardSkeleton key={i} size="standard" />
            ))}
          </div>
        </div>
      );

Suggestion: Correct the line references to match the pinned commit. These matter because reviewers may rely on them to spot-check.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
