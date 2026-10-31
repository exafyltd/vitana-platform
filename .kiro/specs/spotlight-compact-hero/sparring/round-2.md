# Sparring round 2 — in_progress

Session: `68758ecb-ce43-444f-ba98-2fdf1dd0570b` · plan hash `fe127bd3606664b52610ef00e5f3666a106eafaacff2e1bec723d8b6a3c4e9de`

## Summary

Round 2 review of the compact-hero-grid plan. The rejected finding R1-F2 is acknowledged — the staging spec file exists and contains the claimed assertion. The accepted findings (R1-F1, R1-F3, R1-F4) appear to be addressed in the revision. Two new issues found: (1) the composition test MIGRATED array does not include `/autopilot`, so the local vitest verification claimed in steps 5 and 6 would not cover AutopilotDashboard at all, and the regex patterns wouldn't match `<JourneyHero` even if the route were added; (2) the Wallet hero's CurrencyToggle control is not mentioned in D4 and risks being silently dropped from the compact band, violating SR-26.

## Findings

### R2-F1 [major]

The composition test (spotlight-tier-b.vtid-05111.test.tsx:174-209) does not include `/autopilot` or `/autopilot/audiobook` in its MIGRATED array. Step 6 proposes to tighten this test but does not mention adding the autopilot routes. Step 5 lists this test in its Verify line for AutopilotDashboard, but it will never be checked. Furthermore, AutopilotDashboard.tsx uses `<JourneyHero` (line 512), which matches neither `size="spotlight"` nor `<VitanaIndexHeroCard` nor the proposed `<DashboardHeroBand` pattern. Even if `/autopilot` were added to MIGRATED, the regex at line 225 (plus the step 6 extension) would return a count of 0 and the test would fail. The local vitest gate for the one-spotlight invariant on My Journey is absent.

- `exafyltd/vitana-v1:src/pages/spotlight-tier-b.vtid-05111.test.tsx:174` — const MIGRATED: [string, string][] = [
      ['/health', 'Health.tsx'],
      ...
      ['/sharing/data-consent', 'sharing/DataConsent.tsx'],
    ];
- `exafyltd/vitana-v1:src/pages/spotlight-tier-b.vtid-05111.test.tsx:222` —     it('dashboard pages render exactly one spotlight-size element in their Spotlight branch', () => {
      for (const [route, file] of MIGRATED.filter(([r]) => archetypeOf(r) === 'dashboard')) {
        const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
        const spotlightCards = (src.match(/size="spotlight"/g) ?? []).length + (src.match(/<VitanaIndexHeroCard/g) ?? []).length;
        expect(spotlightCards, route).toBeGreaterThanOrEqual(1);
        expect(spotlightCards, route).toBeLessThanOrEqual(2); // card + its skeleton
      }
    });
- `exafyltd/vitana-v1:src/pages/AutopilotDashboard.tsx:510` —             <div className="flex flex-col gap-4">
              <GuidedModeSwitch className="px-1" />
              <JourneyHero
                goal={goal}
                journey={journey}

Suggestion: In step 6, add `['/autopilot', 'AutopilotDashboard.tsx']` to the MIGRATED array. Also extend the regex to match `<JourneyHero` (which wraps a `size="spotlight"` VCard internally), in addition to the already-proposed `<DashboardHeroBand`. Without both additions the local vitest gate is blind to My Journey.

### R2-F2 [minor]

D4 enumerates what the compact Wallet hero band keeps — 'the balance, the credits line and the two primary actions (Add funds, Send)' — but omits the CurrencyToggle that is currently rendered in the hero VCard's body slot (Wallet.tsx:581). If the compact band drops this toggle, the member loses the ability to switch display currency from the hero, which conflicts with D4's own SR-26 commitment ('Every existing control and handler stays reachable'). If it is kept, the one-row compact band needs to accommodate it.

- `exafyltd/vitana-v1:src/pages/Wallet.tsx:575` —                 <VCard
                  size="spotlight"
                  data-testid="spotlight-wallet-hero"
                  eyebrow={t('screens.wallet.usdBalance')}
                  title={<span className="text-2xl font-extrabold tabular-nums">{formatCashBalance()}</span>}
                  meta={credits !== null ? t('spotlightTierB.wallet.creditsLine', { amount: fmtNumber(credits) }) : undefined}
                  body={<CurrencyToggle value={displayCurrency} onChange={setDisplayCurrency} />}
                  actions={

Suggestion: Explicitly mention the CurrencyToggle in D4's Wallet hero inventory. Either keep it in the compact band (possibly in the actions or body slot) or move it to the 'Quick actions' tile, but declare which.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — The file `tests/e2e/staging/design-contract.staging.spec.ts` exists at the pinned commit and contains exactly the `SINGLE.has(entry.archetype)` assertion described. Lines 29 and 136-145 confirm the planner's rationale. My R1 search miss was indeed due to the search tool's limitations. The rejection is sound.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
