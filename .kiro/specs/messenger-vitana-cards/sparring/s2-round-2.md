# Sparring round 2 — in_progress

Session: `b4758055-9799-486e-a3ba-cae375a5f642` · plan hash `9d176d3f167632fac4ae34d1932e4078fa056bba3acf2cf34b2c5f0a2ed6b390`

## Summary

All five R1 findings were accepted by the planner and the key defects are substantially addressed in the revised plan. However, the revision introduced one blocker (a direct contradiction between §2 and §3 on the priority band, which undoes the accepted R1-F4 fix), one major gap (no `repeatAfterDays` value is specified for any of the 11 enrichment moments, leaving a design decision that materially affects member experience undefined), and one minor misstatement about the TypeScript signature of `eligibleEnrichmentCards`. No R1 findings were rejected or deferred, so no acknowledgements are required.

## Findings

### R2-F1 [blocker]

§2 and §3 give directly contradictory priority ranges for the enrichment moments. §2 states the corrected band is 21–39; §3 item 3 (Priority-scale trap) still says 20–49. The 20–49 range overlaps diary_nudge (40–50), which is exactly the violation R1-F4 was accepted to fix.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:182` — priority: 40 + Math.min(10, days - DIARY_NUDGE_AFTER_DAYS),
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:244` — priority: 20,

Suggestion: §3 item 3 was not updated when §2 was corrected for R1-F4. The sentence "Each of the 11 moments assigns an explicit companion-scale priority in **the 20–49 range** (above `featureTip` 20, below `vitanaIndex` 50)" must be replaced with the §2 wording: **21–39**, E1=39 → E11=21, strictly below diary_nudge's floor of 40. Also fix the inline statement 'above `featureTip` 20' — the 21–39 band is strictly above 20 (not a tie), which matters because a tie at 20 would be broken by key-name lexicographic order and could let an enrichment moment beat featureTip. The priority-pin test must assert absolute values drawn from the §2 range, not the §3 range.

### R2-F2 [major]

No `repeatAfterDays` value is specified for any of the 11 enrichment moments. Without a non-zero value, an incomplete enrichment card (e.g. E1 'Upload profile photo') will fire every single day until the member completes it or explicitly dismisses it. The 7-day cooldown only activates after an explicit dismiss; an ignored companion DM provides no cooldown. Every existing moment carries a non-zero repeat window (index: 3 d, journey: 2 d, diary: 4 d, tip: 5 d, invite: 14 d).

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:86` — priority: 10,
      repeatAfterDays: 0,
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:118` — priority: 50 + Math.min(20, Math.abs(trend)),
        repeatAfterDays: 3,
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:158` — priority: 65,
        repeatAfterDays: 2,
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:187` — priority: 40 + Math.min(10, days - DIARY_NUDGE_AFTER_DAYS),
        repeatAfterDays: 4,
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:244` — priority: 20,
        repeatAfterDays: 5,
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:269` — priority: 15,
        repeatAfterDays: 14,

Suggestion: Add a `repeatAfterDays` column to the §2 E1–E11 table and an owner decision for each moment. A reasonable default for incomplete-profile cards (E1, E2, E4, E5, E11) is 3–5 days so the member is reminded without being pestered daily; social/connector cards (E3, E6, E7, E8, E9, E10) may warrant 5–7 days. The exact values are an owner decision. Also add a §5 test scenario: 'a member who received but did not complete E1 yesterday does not receive E1 again today' (to machine-pin the chosen cadence).

### R2-F3 [minor]

The plan states the `unavailable` fifth argument to `eligibleEnrichmentCards` is 'mandatory, not optional', but the TypeScript signature has `= new Set()` as a default. TypeScript will not reject an omission. A companion tick that calls `eligibleEnrichmentCards(completions, dismissRows, 'messenger', now)` without the fifth argument compiles cleanly and silently enables E6/E7 on stacks where the OAuth client is absent.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:197` — export function eligibleEnrichmentCards(
  completions: ReadonlyMap<string, boolean>,
  dismissRows: readonly EnrichmentDismissRow[],
  screen: string,
  now: Date,
  unavailable: ReadonlySet<string> = new Set(),
): EligibleEnrichmentCard[]

Suggestion: Either (a) remove the default parameter from `eligibleEnrichmentCards` (making omission a compile error — a one-line breaking change, but the only callers are the enrichment-cards route and the new companion tick), or (b) acknowledge explicitly in the plan that TypeScript will not enforce the fifth argument, and add a lint rule or unit test that asserts `unavailableEnrichmentCards()` is always passed at the companion call site. Option (a) is the cleanest governance fix.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
