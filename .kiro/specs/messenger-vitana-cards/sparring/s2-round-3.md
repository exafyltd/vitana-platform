# Sparring round 3 — escalated

Session: `b4758055-9799-486e-a3ba-cae375a5f642` · plan hash `06b2fd96c540f60878e14c13af972cefd9938dea3878987fe70fa9be36f4f508`

## Summary

Round 3 review of the revised plan. All three R2 findings were accepted and the planner's rationale is sound. R2-F2 (repeatAfterDays) and R2-F3 (unavailable parameter enforcement) are properly addressed. However, the R2-F1 fix (§2 vs §3 priority contradiction) was only partially applied: §3 item 3 now says "21–39" (correct) but still states "E1=39 → E11=21" while the §2 table explicitly assigns E11=29. Additionally, §3 claims "catalog order preserved" but the §2 table assigns priorities in numerical card order (E1…E11), not catalog order (E1, E2, E3, E6, E7…). One new finding raised.

## Findings

### R3-F1 [major]

§3 item 3 still contains two contradictions with the authoritative §2 table that would cause implementation ambiguity. (a) §3 says 'E1=39 → E11=21' but §2 assigns E11=29 (priorities 29–39, one per card). An implementer following §3 literally would space 11 cards across 21–39 (≈2 apart: 39, 37, 35, …, 21), not use the §2 table's 39, 38, 37, …, 29. (b) §3 says 'catalog order preserved' but the §2 table ranks in numerical card order (E1, E2, E3, E4, E5, E6…), not catalog priority order (E1, E2, E3, E6, E7, E8, E9, E4, E5, E10, E11). In the catalog, E6 (index 3) outranks E4 (index 7); in §2, E4 (priority 36) outranks E6 (priority 34). This is the same class of §2/§3 conflict as R2-F1, introduced because the R2-F1 fix updated the band bounds but not the endpoint values or the ordering claim.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:38` — export const ENRICHMENT_PRIORITY: readonly EnrichmentCardType[] = [
  'E1', 'E2', 'E3', 'E6', 'E7', 'E8', 'E9', 'E4', 'E5', 'E10', 'E11',
];
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:291` — export function pickMoment(ctx: MemberContext, moments: Moment[] = COMPANION_MOMENTS): MomentCandidate {
  const eligible: MomentCandidate[] = [];
  for (const m of moments) {
    const c = m.build(ctx);
    if (!c) continue;
    if (c.topic && !ctx.topics[c.topic]) continue;
    const last = ctx.lastUsed[c.momentKey];
    if (last && c.repeatAfterDays > 0 && daysBetween(last, ctx.localDate) < c.repeatAfterDays) continue;
    eligible.push(c);
  }
  eligible.sort((a, b) => b.priority - a.priority || a.momentKey.localeCompare(b.momentKey));
  return eligible[0] ?? (morningGreeting.build(ctx) as MomentCandidate);
}

Suggestion: Fix §3 item 3 to match §2: (a) replace 'E1=39 → E11=21' with 'E1=39 → E11=29' (11 consecutive integers); (b) replace 'catalog order preserved' with an accurate description: 'numerical card order (E1=39, E2=38, …, E11=29)'. If the owner actually wants catalog order in the companion, update the §2 table instead (E1=39, E2=38, E3=37, E6=36, E7=35, E8=34, E9=33, E4=32, E5=31, E10=30, E11=29). Either way, §2 and §3 must agree and the priority-pin test must assert the chosen values.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The planner's rationale for fixing the 20-49 → 21-39 band is sound, but the fix was only partially applied: §3 still says 'E1=39 → E11=21' while §2 shows E11=29. Re-raised as R3-F1.
- R2-F2: acknowledged — Properly addressed: the §2 table now carries repeatAfterDays values (4 for profile/setup, 7 for connector/social), and the plan includes a test for the ignored-E1-yesterday scenario.
- R2-F3: acknowledged — Properly addressed: the plan passes unavailableEnrichmentCards() explicitly at the companion call site and adds a unit test asserting no E6/E7 when Meta OAuth clients are unset.
