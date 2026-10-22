# Sparring round 1 — in_progress

Session: `bd48d949-479e-4a3f-875a-8f5c1f7e820b` · plan hash `dc237659afb6ac06b91f97cf13bb1fcf09da17cd6dfa906554c526a06c543049`

## Summary

The plan correctly identifies the companion engine's architecture and its existing VTID-05099/05100/05101 foundation. The genuinely new work — adding E1–E11 enrichment moment entries — is sound in concept. However the plan contains three blockers and three majors: two blockers arise from the plan treating already-shipped VTID-05101 moments (F1/F7/F8 and the diary/index cadences) as if they need to be created; a third blocker is a structurally impossible staging test assertion. The majors concern a false "one extra read, batched" claim (the enrichment resolver is per-member and has no bulk form), missing dismissal-state injection, and a stated behavioural goal (nudge members who never wrote a diary entry) that the existing `diaryNudge` code explicitly refuses to deliver.

## Findings

### R1-F1 [blocker]

Lane `companion-enrichment-moments` instructs implementors to 'add COMPANION_MOMENTS entries for E1–E11 gated on incompleteness and for F1/F7/F8'. F1 (guidedJourneyStep), F7 (inviteFriend) and F8 (featureTip) are already present in COMPANION_MOMENTS, shipped as VTID-05101. Adding them again produces duplicate entries; `pickMoment` builds each registered Moment independently, so duplicates inflate the eligible pool and corrupt priority ranking.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:276` — export const COMPANION_MOMENTS: Moment[] = [
  ...MOMENTS, guidedJourneyStep, diaryNudge, featureTip, inviteFriend,
];
- `exafyltd/vitana-platform:services/gateway/test/vtid-05101-companion-generators.test.ts:1` — VTID-05101 — Vitana Companion Messages, Phase 3: the remaining moments and
 * the back-off ... Pins: guided_journey_step → F1, diary_nudge → F3, feature_tip
 * → F8, invite_friend → F7

Suggestion: Remove F1/F7/F8 from the lane's scope entirely. Those entries are live. The lane should add only E1–E11 moments (plus the new enrichment-completion field on MemberContext). A comment in the PR should confirm the VTID-05101 moments are intentionally retained unchanged.

### R1-F2 [blocker]

Lane `companion-weekly-reminders` says to 'add the two recurring moments — Improve your Vitana Index and Make a diary entry — with repeatAfterDays: 7'. Both already exist in COMPANION_MOMENTS. vitanaIndex has repeatAfterDays:3 and diaryNudge has repeatAfterDays:4. If new moments with new keys are added alongside the existing ones, pickMoment sees two competing Index moments and two competing diary moments simultaneously; the weekly cadence goal becomes unachievable because the existing higher-priority entries (vitanaIndex priority up to 70) are always picked first and consume the member's slot, preventing the new weekly ones from ever winning.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:98` — export const vitanaIndex: Moment = {
  key: 'vitana_index',
  build: (ctx) => {
    ...
    return {
      ...
      priority: 50 + Math.min(20, Math.abs(trend)),
      repeatAfterDays: 3,
    };
  },
};
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:174` — export const diaryNudge: Moment = {
  key: 'diary_nudge',
  build: (ctx) => {
    ...
    return {
      ...
      priority: 40 + Math.min(10, days - DIARY_NUDGE_AFTER_DAYS),
      repeatAfterDays: 4,
    };
  },
};
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:276` — export const COMPANION_MOMENTS: Moment[] = [
  ...MOMENTS, guidedJourneyStep, diaryNudge, featureTip, inviteFriend,
];

Suggestion: Drop lane `companion-weekly-reminders`. If the desired cadence for Index or diary differs, modify the existing moments' `repeatAfterDays` values directly and document the change. Do not add parallel moments for the same card types — pickMoment has no concept of surface-specific moment lists and will race them indefinitely.

### R1-F3 [blocker]

Section 5 specifies a staging test that 'signs in as the test user and asserts the Vitana thread can render a card payload'. This is structurally impossible. config.ts line 85 returns mode='disabled-on-staging' unconditionally when running on staging, before any mode flag is examined. The companion engine never claims a ledger slot, never calls the composer and never inserts a DM on staging. There will be no companion card payload in the staging thread to assert against. The VTID-05100 and VTID-05101 staging test files already acknowledge this: their staging suites test only GET /api/v1/companion/status and run unit tests offline.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/config.ts:84` — const staging = opts.isStaging ?? runningOnStaging;
    if (staging) return { mode: 'disabled-on-staging', reason: 'staging_shares_production_database', ...common };
- `exafyltd/vitana-platform:docs/validation/VTID-05100/staging-tests.json:4` — "name": "companion messages stay disabled on staging (read-only GET, no member data)",
     "path": "/api/v1/companion/status",
     "expect_status": 200,
     "expect_json": {
      "ok": true,
      "mode": "disabled-on-staging"

Suggestion: Replace the staging assertion with the established pattern from VTID-05100/05101: (a) GET /api/v1/companion/status asserts mode=disabled-on-staging; (b) the unit/integration tests run offline proving moment selection, card metadata shape, and locale coverage. If a rendering smoke-test is wanted, inject a synthetic chat_messages row manually in a staff-mode dev environment, not staging.

### R1-F4 [major]

The plan states the enrichment completion map will be 'one extra read, batched with the existing signal reads' and that 'net new backend code is small'. This is false. The existing completion resolver (completion-resolver.ts:loadEnrichmentCardState) issues 8 parallel per-member Supabase queries (profiles, profile_posts, social_connections, connected_app_settings, contacts, user_device_tokens, user_enrichment_cards, and a boost-trigger sub-call). No bulk/batch form exists in completion-resolver-repository.ts or companion-repository.ts. The pattern used by signals.ts — inChunksPaged with a single query for all member IDs per page — does not exist for any of these seven source tables in the enrichment path. Adding per-member completion reads inside the companion tick's inner loop creates an N×8 query storm across the delivery window.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/completion-resolver.ts:232` — export async function loadEnrichmentCardState(
    sb: SupabaseClient,
    userId: string,
    ...
  ): Promise<EnrichmentCardState> {
    const [profile, posts, social, calendar, contacts, tokens, states, boosts] = await Promise.all([
      repo.fetchProfileEnrichmentFields(sb, userId),
      repo.fetchAnyProfilePost(sb, userId),
      repo.fetchActiveSocialConnections(sb, userId),
      repo.fetchEnabledCalendarApp(sb, userId),
      repo.fetchAnyContact(sb, userId),
      repo.fetchActiveDeviceToken(sb, userId),
      repo.fetchEnrichmentCardStates(sb, userId),
      resolveBoostTriggers(sb, userId, now),
    ]);
- `exafyltd/vitana-platform:services/gateway/src/services/companion/signals.ts:33` — export const fetchMemberSignals: FetchSignals = async (sb, ids, now) => {
    const by = new Map<string, RawMemberSignals>(ids.map((id) => [id, {}]));
    ...
    const [journeys, diary, active] = await Promise.allSettled([
      repo.fetchJourneyStates(sb, ids),
      repo.fetchDiaryEntriesSince(sb, ids, sinceIso),
      repo.fetchActiveDaysSince(sb, ids, sinceDate),
    ]);

Suggestion: Before implementing the enrichment moment gates, build bulk versions of all seven enrichment source reads in companion-repository.ts (mirroring fetchJourneyStates / fetchActiveDaysSince using inChunks / inChunksPaged). Add a FetchEnrichmentCompletions seam to CompanionTickDeps so the integration test can inject stubs without real DB. Scope this as a separate lane and account for it explicitly in the effort estimate.

### R1-F5 [major]

The plan injects an enrichment completion map into MemberContext, but makes no mention of fetching or injecting dismissal state from `user_enrichment_cards`. The card-catalog.ts eligibleEnrichmentCards() function accepts a dismissRows parameter and applies a 7-day cooldown: a card dismissed on the News Feed disappears from that surface for 7 days. Without the same dismissal data in the companion engine, a member who dismissed E8 (Connect Calendar) anywhere else will continue to receive it as a companion DM during the cooldown window, violating the 'done or dismissed anywhere disappears everywhere' rule stated in card-catalog.ts line 8–10.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:7` — * the eligibility rule (incomplete AND not cooling down) shared by
   *     GET /api/v1/enrichment-cards and, later, the Messenger companion engine
   *     (VTID-05099), so a card done or dismissed anywhere disappears everywhere.
- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:197` — export function eligibleEnrichmentCards(
    completions: ReadonlyMap<string, boolean>,
    dismissRows: readonly EnrichmentDismissRow[],
    screen: string,
    now: Date,
    unavailable: ReadonlySet<string> = new Set(),
  ): EligibleEnrichmentCard[] {

Suggestion: The bulk enrichment signal read (R1-F4) must also fetch user_enrichment_cards for each member in the window (one IN-clause query for all IDs, the same way completion-resolver-repository.ts already does fetchEnrichmentCardStates per member). Store dismissal rows keyed by userId alongside the completion map in MemberContext. The enrichment moment gate must pass them to eligibleEnrichmentCards() rather than reading completions alone.

### R1-F6 [major]

The plan's opening summary states 'if the member never writes a diary entry, Vitana nudges them weekly'. This goal cannot be met by the existing diaryNudge moment. diaryNudge.build() returns null unconditionally when ctx.diaryLastEntryDate is falsy — the code comment explicitly says 'never wrote inside the window: no habit to pick up again'. A member with zero diary history will never receive this moment. The code gate and the plan's stated intent are in direct contradiction, and no lane documents a change to this gate.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:174` — export const diaryNudge: Moment = {
    key: 'diary_nudge',
    build: (ctx) => {
      const last = ctx.diaryLastEntryDate;
      if (!last) return null; // never wrote inside the window: no habit to pick up again
      const days = daysBetween(last, ctx.localDate);
      if (!Number.isFinite(days) || days < DIARY_NUDGE_AFTER_DAYS || days > SIGNAL_LOOKBACK_DAYS) return null;

Suggestion: Either (a) clarify the plan's intent: the diary nudge is for members who had a habit and lapsed, not for members who never started — remove the 'never writes a diary entry' language from the summary; or (b) if nudging never-started members is a genuine requirement, document a new 'diary_introduction' moment with its own gate (no prior entry in lookback), intent copy, priority, and test case, and add it as an explicit lane item.

### R1-F7 [minor]

Risk item 3 justifies adding a 'distinct Messenger weekly moment' for the Vitana Index by saying 'changing it to 7 affects other surfaces'. COMPANION_MOMENTS is consumed exclusively by the companion engine tick (companion-service.ts). No other surface reads this list. There are no 'other surfaces' to protect.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:197` — const moment = pickMoment(ctx);
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:291` — export function pickMoment(ctx: MemberContext, moments: Moment[] = COMPANION_MOMENTS): MomentCandidate {

Suggestion: Remove the 'other surfaces' rationale. If the cadence change is warranted, modify vitanaIndex.repeatAfterDays directly with a noted behaviour change. The added complexity of a parallel weekly Index moment is not justified and directly causes the blocker in R1-F2.

### R1-F8 [minor]

morningGreeting already emits cardType:'F4' unconditionally as the lowest-priority fallback (priority 10, repeatAfterDays 0). Phase 2 proposes adding a new F4 moment gated on 'member has never used voice'. When Phase 2 ships, the engine will have two F4 entries: the always-on greeting and the new gated one. On days when neither enrichment nor other higher-priority moments fire, both F4 entries compete. The plan gives no guidance on how to resolve this card-type collision.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:79` — export const morningGreeting: Moment = {
    key: 'morning_greeting',
    build: () => ({
      momentKey: 'morning_greeting',
      cardType: 'F4',
      topic: null,
      intent: MORNING_GREETING_INTENT,
      facts: {},
      priority: 10,
      repeatAfterDays: 0,
    }),
  };

Suggestion: Document in the Phase 2 F4 design note that the morning-greeting moment will need its cardType changed (e.g. to null or a dedicated greeting card type) when the usage-gated F4 ships, so the greeting slot no longer conflicts with the 'never used voice' promotion slot. Flag this in the Phase 2 pre-conditions, not left implicit.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
