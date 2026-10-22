# Sparring round 1 — in_progress

Session: `b4758055-9799-486e-a3ba-cae375a5f642` · plan hash `80845fbd3e9018edf0985013018c5ed9db22a5f703950502bb24324238d28c24`

## Summary

The plan is structurally sound — it correctly identifies the priority-scale trap, the `now`-in-`build()` problem, the `unavailableEnrichmentCards()` requirement, and the `Promise.allSettled` error contract. Four issues were found after verifying the code: one blocker (an existing test the plan will silently break), two majors (topic assignment unspecified; bulk completion false-initialization unspecified), and two minors (`diaryNudge` priority overlap unacknowledged; no VTID assigned).

## Findings

### R1-F1 [blocker]

Adding 11 entries to COMPANION_MOMENTS will break the existing VTID-05101 'every moment' test in three distinct ways that the plan never mentions.

- `exafyltd/vitana-platform:services/gateway/test/vtid-05101-companion-generators.test.ts:198` — expect(COMPANION_MOMENTS.map((m) => m.key)).toEqual(
  ['morning_greeting', 'vitana_index', 'guided_journey_step', 'diary_nudge', 'feature_tip', 'invite_friend']);
…
for (const m of COMPANION_MOMENTS) {
  const c = m.build(rich);
  expect(c).not.toBeNull();
  …
  expect(c!.intent).toMatch(/^(Warmly greet|Greet) the member/);
}
expect(Object.fromEntries(COMPANION_MOMENTS.map((m) => [m.key, m.build(rich)!.cardType]))).toEqual({
  morning_greeting: 'F4', vitana_index: 'F2', …});
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:276` — export const COMPANION_MOMENTS: Moment[] = [
  ...MOMENTS, guidedJourneyStep, diaryNudge, featureTip, inviteFriend,
];

Suggestion: The plan must explicitly call out updating the VTID-05101 'every moment' describe block on three counts: (1) the strict `.toEqual` on `COMPANION_MOMENTS.map((m) => m.key)` at line 198 will fail with 17 keys; (2) the `expect(c).not.toBeNull()` loop at line 202 will fail for enrichment moments because the `rich` context has no `eligibleEnrichmentCardTypes` field, so their `build()` returns null or throws; (3) the `expect(c!.intent).toMatch(/^(Warmly greet|Greet) the member/)` at line 206 will fail unless enrichment intents are written to open with exactly those words, which the plan does not require. The `companion-enrichment-moments` lane must include explicit updates to the VTID-05101 test: extend `rich` with `eligibleEnrichmentCardTypes`, relax or split the intent-prefix assertion, and replace the strict 6-key equality with an assertion that checks the new 17-key set (or split the test so the F-moment contract remains pinned separately).

### R1-F2 [major]

The plan never specifies what `topic` field each of the 11 enrichment moments carries. `pickMoment` silently drops any candidate whose `c.topic` is set to a topic the member has switched off.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:291` — export function pickMoment(ctx: MemberContext, moments: Moment[] = COMPANION_MOMENTS): MomentCandidate {
  const eligible: MomentCandidate[] = [];
  for (const m of moments) {
    const c = m.build(ctx);
    if (!c) continue;
    if (c.topic && !ctx.topics[c.topic]) continue;
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:188` — topics: {
  health: pref?.topic_health ?? true,
  community: pref?.topic_community ?? true,
  business: pref?.topic_business ?? false,
},

Suggestion: The plan must add a `topic` column to the E1–E11 table in §2 and a test. Consider: cards that enrich the member's own profile and setup (E1, E2, E4, E5, E8, E9, E10, E11) are not community content — assigning them `topic: null` lets them fire regardless of topic toggles, which is the right default for setup tasks. Cards with explicit social or community actions (E3, E6, E7) are plausibly `'community'`. The choice is a real owner decision that changes who receives which cards; it cannot be left implicit.

### R1-F3 [major]

`eligibleEnrichmentCards` requires `completions.get(t) === false` (strict equality). The bulk seam the plan describes will fail to offer any enrichment cards to members who have no profile row, because 'no row returned' leaves those keys absent from the Map, and `undefined === false` is false in JavaScript.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:210` — return ENRICHMENT_PRIORITY
  .filter((t) => onScreen.has(t))
  .filter((t) => completions.get(t) === false)
  .filter((t) => !coolingDown.has(t))
  .filter((t) => !unavailable.has(t))
  .map((t) => ({ card_type: t, category: 'enrichment' as const, priority: enrichmentPriority(t) }));
- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/completion-resolver.ts:74` — export function computeCompletions(facts: EnrichmentFacts): Map<EnrichmentCardType, boolean> {
  const p = facts.profile ?? {};
  …
  const done: Record<EnrichmentCardType, boolean> = {
    E1: nonEmpty(p.avatar_url), E2: bio.length > 50, …
  };
  return new Map(ENRICHMENT_CARD_TYPES.map((t) => [t, done[t]]));
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-repository.ts:55` — export function fetchProfiles(sb: SupabaseClient, ids: string[]) {
  return inChunks<ProfileRow>(
    ids, (p) => sb.from('profiles').select('user_id, first_name, timezone').in('user_id', p), 'profiles');
}

Suggestion: The bulk enrichment seam must explicitly initialize every member's completion Map with `false` for all 11 card types before applying query results — exactly as `computeCompletions` does with `const p = facts.profile ?? {}`. Mirroring `fetchJourneyStates` is not sufficient: that function returns row-or-null, and `fetchMemberSignals` initializes all members to `journey: null` (line 47 of signals.ts: `for (const id of ids) by.get(id)!.journey = null`) before overriding. The enrichment analog must do the same per source table, and the test fixture must include a member with no profile row and assert that their E1/E2/E4/E5/E11 completion states are explicitly `false` (and thus eligible), not absent.

### R1-F4 [minor]

`diaryNudge` has a priority range of 40–50 (not 50–70), so the top enrichment cards at 45–49 can outrank a freshly-lapsed diary nudge, contradicting the plan's claim that 'daily habit and health cards keep precedence'.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:182` — priority: 40 + Math.min(10, days - DIARY_NUDGE_AFTER_DAYS),

Suggestion: Either (a) cap enrichment moments at 39 (below `diaryNudge`'s minimum of 40) to fully honour the stated health-first policy, or (b) acknowledge explicitly in §2 that enrichment cards E1–E? (the top band) may outrank a low-urgency diary nudge, which is a deliberate design choice. The priority-pin test should assert the absolute values for representative cases involving a freshly-lapsed diary, so the policy is machine-checked.

### R1-F5 [minor]

No VTID is assigned to the new implementation. Every substantive code block in the codebase carries a VTID, and the governance pattern requires one before lanes start.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:42` — const VTID = 'VTID-05099';
- `exafyltd/vitana-platform:services/gateway/src/services/companion/signals.ts:1` — /**
 * VTID-05101 — member signals for the Phase 3 moments…

Suggestion: Allocate a VTID (e.g., VTID-05210-series or the next available) before implementation starts. Add it to the file-level JSDoc comments of the new code, to the tick result field for `enrichment_unavailable`, and to the OASIS event payload so the event is correctly attributed in audit.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
