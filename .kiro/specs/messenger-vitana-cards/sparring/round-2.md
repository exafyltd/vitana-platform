# Sparring round 2 — in_progress

Session: `bd48d949-479e-4a3f-875a-8f5c1f7e820b` · plan hash `81b277ece9fc5a8f22bf1064fff64310eeef01d2e2157ad6fde6131dd34538ca`

## Summary

All eight R1 findings were accepted and addressed in the revised plan. Three new findings arise from the revision. The most important is a blocker: the plan claims to use the "existing shared rule `eligibleEnrichmentCards()`" but never mentions its mandatory fifth parameter `unavailableEnrichmentCards()`, which currently hides E6/E7 on all deployments because Meta OAuth credentials are not provisioned. Without that call, the companion engine would DM members to connect Instagram/Facebook when clicking the card would fail with 400. A major finding covers the missing error-handling contract for the new `FetchEnrichmentCompletions` seam — if it throws rather than following the `allSettled`/`unavailable` pattern of `fetchMemberSignals`, a single DB error aborts the entire tick for all in-window members. A minor finding notes that `EligibleEnrichmentCard.priority` (1–11, lower = more valuable) is on the opposite scale from `pickMoment` priorities (10–70, higher = wins), creating a silent trap an implementor could fall into.

## Findings

### R2-F1 [blocker]

The plan says E1–E11 moments will be gated 'using the existing shared rule eligibleEnrichmentCards()' and lists E6/E7 in the eligibility table without qualification. But the plan never mentions the function's fifth parameter `unavailable` or the companion module `card-availability.ts::unavailableEnrichmentCards()`. On every current deployment, `INSTAGRAM_CLIENT_ID/SECRET` and `FACEBOOK_CLIENT_ID/SECRET` are absent (card-availability.ts: 'no gateway stack has the Meta credentials…so both cards stay hidden'). `unavailableEnrichmentCards()` therefore returns `Set{'E6','E7'}`. The existing enrichment-cards route always passes this set to `eligibleEnrichmentCards()`. The companion engine, as the plan describes it, would call `eligibleEnrichmentCards(completions, dismissRows, 'messenger', now)` — omitting the fifth argument, which defaults to `new Set()` — and would surface E6/E7 DMs. A member tapping the resulting card hits `GET /api/v1/social-accounts/connect/instagram` → 400 'not configured'. This contradicts the plan's own stated invariant ('a card done or dismissed anywhere disappears everywhere') and the card-catalog.ts comment that names the companion engine as a consumer of the shared rule.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-availability.ts:1` — As of 2026-10-15 no gateway stack has the Meta credentials (owner is creating the Meta app; lane `meta-oauth`), so both cards stay hidden and come back on their own as soon as the four values are provisioned
…
export function unavailableEnrichmentCards(env: NodeJS.ProcessEnv = process.env): ReadonlySet<EnrichmentCardType> {
  const out = new Set<EnrichmentCardType>();
  for (const [card, provider] of Object.entries(SOCIAL_CONNECT_CARDS) as Array<[EnrichmentCardType, SocialProvider]>) {
    if (!isProviderConfigured(provider, env)) out.add(card);
  }
  return out;
}
- `exafyltd/vitana-platform:services/gateway/src/services/social-connect-service.ts:171` — export function isProviderConfigured(provider: SocialProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  const c = PROVIDER_CONFIGS[provider];
  return !!(c && env[c.clientIdEnv] && env[c.clientSecretEnv]);
}
- `exafyltd/vitana-platform:services/gateway/src/routes/enrichment-cards.ts:82` — const unavailable = unavailableEnrichmentCards();
const enrichment = eligibleEnrichmentCards(state.completions, state.dismissals, screen, now, unavailable).map((c) => ({
- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:197` — export function eligibleEnrichmentCards(
  completions: ReadonlyMap<string, boolean>,
  dismissRows: readonly EnrichmentDismissRow[],
  screen: string,
  now: Date,
  unavailable: ReadonlySet<string> = new Set(),
): EligibleEnrichmentCard[] {

Suggestion: Add an explicit call to `unavailableEnrichmentCards()` in the companion engine's enrichment moment gating — exactly as the enrichment-cards route does. The result must be passed as the fifth argument to `eligibleEnrichmentCards()`. Document this in §3 ('Architecture') and §2 (the E6/E7 rows in the eligibility table should note 'and provider OAuth client configured'). Add a test case: when `INSTAGRAM_CLIENT_ID` and `FACEBOOK_CLIENT_ID` are absent from the env, no E6/E7 moment is offered regardless of completion state.

### R2-F2 [major]

The plan adds a `FetchEnrichmentCompletions` seam to `CompanionTickDeps` but specifies no error-handling contract for it. `fetchMemberSignals` (signals.ts:40) uses `Promise.allSettled` internally — if any of the three source queries fail, it adds a label to `unavailable[]` and returns normally; it never throws. This means the existing `Promise.all([…, fetchSignals(sb, ids, now)])` at companion-service.ts:131 can never be rejected by a signal error. If the new enrichment seam is added to the same `Promise.all` and its implementation throws on a Supabase error (a natural first-cut implementation), the entire `Promise.all` rejects and the tick loop never runs — zero members are decided for everyone in the delivery window that tick. This is a silent regression: the tick returns an error, no moments fire, and no OASIS event is emitted for the decided members. The plan §5 says only 'following signals test patterns' in the testing section, but does not state the production contract.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/signals.ts:33` — export const fetchMemberSignals: FetchSignals = async (sb, ids, now) => {
  const by = new Map<string, RawMemberSignals>(ids.map((id) => [id, {}]));
  const unavailable: string[] = [];
  …
  const [journeys, diary, active] = await Promise.allSettled([
    repo.fetchJourneyStates(sb, ids),
    repo.fetchDiaryEntriesSince(sb, ids, sinceIso),
    repo.fetchActiveDaysSince(sb, ids, sinceDate),
  ]);
  if (journeys.status === 'fulfilled') { … } else unavailable.push('journey');
  …
  return { by, unavailable };
};
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:131` — const [prefs, ledger, onboarding, localeMap, signals] = await Promise.all([
  repo.fetchPreferences(sb, ids),
  repo.fetchRecentLedger(sb, ids, minusDays(earliest, LEDGER_LOOKBACK_DAYS)),
  repo.fetchOnboardingTouches(sb, ids, earliest),
  locales(sb, ids),
  fetchSignals(sb, ids, now),
]);

Suggestion: Add a contractual note to §3 and §4 (lane `companion-enrichment-signals`): the `FetchEnrichmentCompletions` function must follow the same `allSettled`/`unavailable` pattern as `FetchSignals` — it must never throw, must catch per-source errors with `Promise.allSettled`, and must return a result type analogous to `SignalsResult` (e.g. `{ by: Map<string, EnrichmentCompletionResult>, unavailable: string[] }`). Add a test case: when the profiles bulk query rejects, the function returns `{ by: <empty map>, unavailable: ['enrichment_profiles'] }` and the tick continues normally, with enrichment moments simply not firing.

### R2-F3 [minor]

`eligibleEnrichmentCards()` returns `EligibleEnrichmentCard[]` where `priority` is `enrichmentPriority(t)` = `ENRICHMENT_PRIORITY.indexOf(t) + 1`, yielding 1 for E1 through 11 for E11 (1 = most valuable). `pickMoment()` sorts candidates in descending order (`b.priority - a.priority`) on a scale where `morningGreeting` = 10, `inviteFriend` = 15, `featureTip` = 20, `vitanaIndex` = 50–70. If an implementor uses `EligibleEnrichmentCard.priority` directly as `MomentCandidate.priority`, enrichment cards E1–E9 (priorities 1–9) would rank below `morningGreeting` (10) and never win, and only E11 (11) could tie the greeting. The bug would be silent unless the priority pinning test uses explicit expected values in the companion scale.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:210` — return ENRICHMENT_PRIORITY
  .filter((t) => onScreen.has(t))
  .filter((t) => completions.get(t) === false)
  .filter((t) => !coolingDown.has(t))
  .filter((t) => !unavailable.has(t))
  .map((t) => ({ card_type: t, category: 'enrichment' as const, priority: enrichmentPriority(t) }));
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:291` — export function pickMoment(ctx: MemberContext, moments: Moment[] = COMPANION_MOMENTS): MomentCandidate {
  …
  eligible.sort((a, b) => b.priority - a.priority || a.momentKey.localeCompare(b.momentKey));
  return eligible[0] ?? (morningGreeting.build(ctx) as MomentCandidate);
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:79` — export const morningGreeting: Moment = {
  key: 'morning_greeting',
  build: () => ({
    …
    priority: 10,
    repeatAfterDays: 0,
  }),
};

Suggestion: Add an explicit note to §3 and the lane spec: the `EligibleEnrichmentCard.priority` returned by `eligibleEnrichmentCards()` is a 1-based catalog ordering (1 = highest value) used for the enrichment-cards News Feed display, and must NOT be used as `MomentCandidate.priority`. Each of the 11 moments must assign an explicit numeric priority in the 20–49 range (between `featureTip` at 20 and `vitanaIndex` at 50). The priority pin test must assert absolute values, not relative ordering only, so a wrong-scale value is caught immediately.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
