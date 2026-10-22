# Sparring round 3 — escalated

Session: `bd48d949-479e-4a3f-875a-8f5c1f7e820b` · plan hash `8eea9f09446b3000479532dc422007cb5e26f40d8ca5403c581056b41d8f3572`

## Summary

All three Round 2 findings were accepted and are genuinely reflected in the revised plan. Two new findings arise from the revision: one major (the `now: Date` parameter required by `eligibleEnrichmentCards()` is unavailable inside `Moment.build(ctx)`, which would silently break the dismissal-cooldown invariant the plan explicitly sets out to enforce) and one minor (the LLM intent source for the 11 enrichment moments is unspecified and the plan's reference to `enrichment-card-tips.ts` is misleading because that file contains display copy, not composer intent strings).

## Findings

### R3-F1 [major]

`eligibleEnrichmentCards()` requires `now: Date` as its 4th argument to compute the 7-day dismissal cooldown (`isCoolingDown(row, now)`), but `Moment.build()` receives only `ctx: MemberContext`, which carries `localDate: string` — not a `Date` object. The plan's primary proposed shape (`incompleteEnrichmentCards` / `enrichmentDismissRows`) stores raw data in `MemberContext`, so the moment's `build()` must call `eligibleEnrichmentCards(completions, dismissRows, 'messenger', now, unavailableEnrichmentCards())` — but there is no `now` to pass. The tick's `now` (companion-service.ts:88: `const now = deps.now ?? new Date()`) is never added to `ctx` (companion-service.ts:182–196). Using `new Date(ctx.localDate)` as a substitute gives midnight UTC of the local date, which is wrong for timestamp comparisons against `dismissed_at`. The net effect: the dismissal cooldown is silently dropped and a member who dismissed E8 three days ago continues to receive 'Connect Calendar' DMs — exactly the invariant the plan (§2: 'done or dismissed anywhere disappears everywhere') is supposed to protect.

- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:197` — export function eligibleEnrichmentCards(
  completions: ReadonlyMap<string, boolean>,
  dismissRows: readonly EnrichmentDismissRow[],
  screen: string,
  now: Date,
  unavailable: ReadonlySet<string> = new Set(),
): EligibleEnrichmentCard[] {
- `exafyltd/vitana-platform:services/gateway/src/services/enrichment/card-catalog.ts:177` — export function isCoolingDown(row: Pick<EnrichmentDismissRow, 'dismissed_at' | 'cooldown_days'>, now: Date): boolean {
  const until = dismissedUntil(row);
  return until !== null && until.getTime() > now.getTime();
}
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:21` — export interface MemberContext {
  userId: string;
  tenantId: string;
  firstName: string | null;
  locale: string;
  localDate: string;
  topics: Record<CompanionTopic, boolean>;
  vitanaIndex: VitanaIndexSnapshot | null;
  lastUsed: Record<string, string>;
  journey?: JourneySignal | null;
  diaryLastEntryDate?: string | null;
  activeDays?: number | null;
  recentFeatureTips?: string[];
}
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:70` — export interface Moment {
  key: string;
  build(ctx: MemberContext): MomentCandidate | null;
}
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:88` — const now = deps.now ?? new Date();
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:182` — const ctx: MemberContext = {
  userId: m.user_id,
  tenantId: m.tenant_id,
  firstName: m.firstName,
  locale: localeMap.get(m.user_id) ?? 'de',
  localDate: m.date,
  topics: {
    health: pref?.topic_health ?? true,
    community: pref?.topic_community ?? true,
    business: pref?.topic_business ?? false,
  },
  vitanaIndex: index,
  lastUsed,
  ...memberSignals(signals.by.get(m.user_id), rows, m.date),
};

Suggestion: Pick one of two explicit resolutions and document it in §3 and both lane specs:

(a) **Add `now: Date` to `MemberContext`** — populated from the tick's `now` at context-build time (companion-service.ts:182). Each enrichment moment then calls `eligibleEnrichmentCards(ctx.completions, ctx.dismissRows, 'messenger', ctx.now, unavailableEnrichmentCards())` correctly. The cooldown test can inject a deterministic `now`.

(b) **Pre-compute the eligible set in the tick loop** — call `eligibleEnrichmentCards(completions, dismissRows, 'messenger', now, unavailableEnrichmentCards())` before building `ctx` (where `now` is already in scope), and store the result as `eligibleEnrichmentCardTypes: ReadonlySet<EnrichmentCardType>` in `MemberContext`. Each enrichment moment checks `ctx.eligibleEnrichmentCardTypes.has('E1')` — no call to `eligibleEnrichmentCards` inside `build()`.

Either way, add an explicit test: member dismissed E8 at `T`; tick runs at `T + 3 days`; E8 moment returns `null`; tick runs at `T + 8 days`; E8 moment fires.

### R3-F2 [minor]

The plan says 'Copy reuses `enrichment-card-tips.ts`; each moment carries an English `intent`.' But `enrichment-card-tips.ts` contains only localized display copy (title + description shown on the card face) with the explicit comment 'No spoken text: these are card labels, never read by the voice pipeline.' There is no LLM intent string in this file. The established moment pattern (featureTip, moments.ts:200–248) uses a separate `FEATURE_TIP_INTENT` English instruction constant and passes the data file's `title.en`/`description.en` as `facts`. The plan does not state whether the 11 enrichment moments share one intent template (referencing fact keys for card name/description) or each have distinct intent strings, and it does not state that the description strings from `enrichment-card-tips.ts` must be passed as `facts` rather than used directly as `intent`. The `description.en` strings are finished imperative sentences ('Members connect more easily when they see a face. Add your photo in a few seconds.'); using them directly as the LLM `intent` field violates NEVER-41 in spirit because the intent must instruct the composer, not be the message itself.

- `exafyltd/vitana-platform:services/gateway/src/data/enrichment-card-tips.ts:13` — No spoken text: these are card labels, never read by the voice pipeline.
- `exafyltd/vitana-platform:services/gateway/src/data/enrichment-card-tips.ts:26` — export interface EnrichmentCardTip {
  title: Record<GatewayLocale, string>;
  description: Record<GatewayLocale, string>;
}
- `exafyltd/vitana-platform:services/gateway/src/data/enrichment-card-tips.ts:47` — en: 'Members connect more easily when they see a face. Add your photo in a few seconds.',
- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:199` — export const FEATURE_TIP_INTENT =
  'Greet the member by first name for the morning. Introduce one Vitanaland feature they may not have tried ' +
  'yet, described by feature_name and feature_summary in the facts, in your own words and in one or two short ' +
  'sentences, and say why it could be useful for them. Mention that the card below opens it.';
…
  facts: { tip_key: tip.key, feature_name: tip.title.en, feature_summary: tip.description.en },

Suggestion: Add an explicit note to §3 item 3 and the `companion-enrichment-moments` lane: each enrichment moment (or a single shared template for all 11) must define an English `intent` constant in the form of an instruction to the LLM composer (e.g. 'Tell the member warmly that completing one more profile step — described by card_title in the facts — makes their profile more visible, and mention that the card below opens it directly.'). The `ENRICHMENT_CARD_TIPS[Ex].title.en` and `.description.en` values must be passed as `facts` (keys `card_title` / `card_description`), not used as the `intent` string — following the established `featureTip` pattern exactly. This resolves the NEVER-41 ambiguity and means the locale-coverage test does not need to change (facts are always English source data for the model).

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and fully addressed. Plan §2 now explicitly states 'The `unavailable` fifth argument is mandatory' and names `unavailableEnrichmentCards()`. The E6/E7 eligibility rows note 'OAuth client configured'. A test is specified for the absent-credentials case.
- R2-F2: acknowledged — Accepted and fully addressed. Plan §3 item 1 adds a mandatory error-contract paragraph requiring `Promise.allSettled`/`unavailable[]`, a `SignalsResult`-analogous return type, and a test asserting tick continuity on a rejected profiles query.
- R2-F3: acknowledged — Accepted and fully addressed. Plan §3 item 3 explicitly forbids reusing `EligibleEnrichmentCard.priority`, mandates explicit companion-scale priorities in 20–49, and requires the priority-pin test to assert absolute values.
