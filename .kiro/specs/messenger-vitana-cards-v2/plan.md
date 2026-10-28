# Messenger Vitana Cards ΓÇö Plan

Deeply-personalized, one-per-day Vitana recommendation cards in the direct
Vitana chat, delivered by the existing Vitana Companion Messages engine.

<!-- plan:begin -->

## 1. Summary

Vitana is the member's everyday life companion. The direct Vitana chat
(`/inbox/u/00000000-0000-0000-0000-000000000001`) already receives one
personalized Vitana DM per day from the **Vitana Companion Messages engine**
(VTID-05099/05100/05101, `services/gateway/src/services/companion/`). That
engine already ships these moments: `morning_greeting` (F4), `vitana_index`
(F2), `guided_journey_step` (F1), `diary_nudge` (F3), `feature_tip` (F8),
`invite_friend` (F7). It already reads usage signals, paces via the guide
pacer, delivers a card as a Vitana DM, and `MessageBubble` renders it.

**What this plan adds is exactly one thing: the 11 enrichment cards (E1ΓÇôE11)
as new companion moments, gated so each is offered only when the member has
NOT completed AND has not dismissed it.** It does not re-create any shipped
moment, does not add parallel Index/diary moments, and does not change the
cadence of shipped moments. The "deeply personalized" and "weekly reminder"
behaviour the owner asked for is **already provided** by the shipped
`vitana_index` (repeatAfterDays 3) and `diary_nudge` (repeatAfterDays 4)
moments; the new value is the enrichment set (connect calendar / Instagram /
Facebook, add photo/bio/cover, etc.) appearing only when relevant.

**Decisions taken (owner, this conversation):**
- **One card per day** ΓÇö the companion engine's existing model. Not a strip.
- **Lab tests OUT of scope** ΓÇö a separate follow-up plan
  (`messenger-vitana-cards-labs`): no lab-upload table or card type exists and
  it carries health-data/consent work.
- **Usage-gated feature cards (F4 voice, F5 matches, F10 media) held for a
  later plan**, not shown ungated.

**Corrections after sparring round 1 (all accepted):**
- F1/F7/F8 and the Index/diary cadences are **already shipped** ΓÇö removed from
  scope. The lane adds ONLY E1ΓÇôE11.
- Dropped the `companion-weekly-reminders` lane: the weekly reminders already
  exist as shipped moments; adding parallel ones would race `pickMoment` and
  never win.
- The staging test cannot assert a delivered card: the engine is
  `disabled-on-staging` unconditionally. Staging verification is the
  established pattern (GET `/api/v1/companion/status` = `disabled-on-staging`);
  moment selection is proven by offline unit/integration tests.
- The enrichment completion read is **not** "one batched read" ΓÇö the resolver
  is per-member with no bulk form. A bulk read (completion + dismissal) is its
  own lane and the single biggest piece of real work.

## 2. Scope

### In scope ΓÇö E1ΓÇôE11 as personalized companion moments
Add 11 new `COMPANION_MOMENTS` entries, one per enrichment card, each eligible
only when the member is **incomplete AND not in a dismissal cooldown AND the
card's action is available on this stack** ΓÇö using the existing shared rule
`eligibleEnrichmentCards(completions, dismissRows, screen, now, unavailable)`
(`services/gateway/src/services/enrichment/card-catalog.ts`), which takes
completion state + `user_enrichment_cards` dismissal rows + an `unavailable`
set, and applies the 7-day cooldown, "done or dismissed anywhere disappears
everywhere".

**The `unavailable` fifth argument is mandatory, not optional.** The companion
engine MUST pass `unavailableEnrichmentCards()`
(`services/gateway/src/services/enrichment/card-availability.ts`) exactly as the
`/api/v1/enrichment-cards` route does (`routes/enrichment-cards.ts:82`). On
every current deployment the Meta OAuth clients
(`INSTAGRAM_CLIENT_ID/SECRET`, `FACEBOOK_CLIENT_ID/SECRET`) are absent, so
`unavailableEnrichmentCards()` returns `{E6, E7}` and those cards must NOT be
offered ΓÇö otherwise a member would get a "Connect Instagram/Facebook" DM whose
card taps into a 400 "not configured". E6/E7 return on their own once the
credentials are provisioned, no code change.

**Enforcement (R2-F3).** TypeScript will NOT catch an omitted 5th arg ΓÇö its
signature defaults `unavailable = new Set()`, so a call missing it compiles and
silently surfaces E6/E7. Since the only two callers are the enrichment-cards
route and this new companion tick, the signals lane passes `unavailable`
explicitly at the single companion call site, and the lane adds a unit test
that asserts: with `INSTAGRAM_CLIENT_ID`/`FACEBOOK_CLIENT_ID` unset, the
companion tick offers no E6/E7 for a member who is incomplete on both ΓÇö proving
the argument is wired, not relying on the doc word "mandatory".

| Card | `topic` | `repeatAfterDays` | priority | Offered only ifΓÇª (via `eligibleEnrichmentCards`) |
|---|---|---|---|---|
| E1 Upload profile photo | `null` | 4 | 39 | no avatar |
| E2 Add bio | `null` | 4 | 38 | bio Γëñ 50 chars |
| E3 Make first post | `community` | 7 | 37 | no post |
| E4 Add interests | `null` | 4 | 36 | none |
| E5 Set location | `null` | 4 | 35 | none |
| E6 Connect Instagram | `community` | 7 | 34 | not connected AND Instagram OAuth client configured (else hidden by `unavailableEnrichmentCards()`) |
| E7 Connect Facebook | `community` | 7 | 33 | not connected AND Facebook OAuth client configured (else hidden) |
| E8 Connect calendar | `null` | 7 | 32 | no calendar connected |
| E9 Import contacts | `null` | 7 | 31 | none |
| E10 Enable notifications | `null` | 7 | 30 | no active device token |
| E11 Add cover image | `null` | 4 | 29 | none |

(Priorities 29ΓÇô39 sit in the 21ΓÇô39 band, all strictly below `diary_nudge` 40;
`repeatAfterDays` 4 for profile cards, 7 for connector/social cards ΓÇö R2-F2.)

**Topic (R1-F2).** `pickMoment` drops any candidate whose `topic` is a toggle
the member turned off. Setup/profile cards that are not community content
(E1/E2/E4/E5/E8/E9/E10/E11) carry `topic: null` so they fire regardless of
toggles ΓÇö correct for setup tasks. The three cards with an explicit social
action (E3 first post, E6/E7 social connect) carry `topic: 'community'` so a
member who switched community off is not nudged to post or connect socials. A
test asserts each moment's topic and that a community-off member gets none of
E3/E6/E7.

**Priority band (R1-F4, corrected).** The shipped `diary_nudge` is **40ΓÇô50**
(not 50ΓÇô70). To honour "daily habit and health cards keep precedence", the 11
enrichment moments are capped **at 39** ΓÇö below `diary_nudge`'s minimum (40),
`vitana_index` (50ΓÇô70) and `guided_journey_step` (65), and above `feature_tip`
(20) / `invite_friend` (15). So the band is **21ΓÇô39**, E1 highest (39) ΓåÆ E11
lowest, strictly below any health/habit moment. Pinned by a test asserting
absolute values, including a freshly-lapsed-diary case where `diary_nudge`
outranks every enrichment card.

**Intent vs. display copy (R3-F2 resolution).** `enrichment-card-tips.ts` holds
*display* copy (card face title/description, "never read by the voice
pipeline") ΓÇö it is NOT a composer intent and must not be used as the moment's
`intent`. Following the shipped `featureTip` pattern exactly: each enrichment
moment uses an English `intent` *instruction* to the composer (one shared
template referencing fact keys, or per-card constants), and passes
`ENRICHMENT_CARD_TIPS[Ex].title.en` / `.description.en` as `facts`
(`card_title` / `card_description`) ΓÇö English source data for the model, which
writes in the member's language. This keeps NEVER-41 clean (the intent
instructs, it is never the finished sentence) and requires no locale-coverage
change (facts stay English).

**Existing test to update (R1-F1, mandatory).** The VTID-05101 "every moment"
test (`test/vtid-05101-companion-generators.test.ts:198+`) will break three
ways when 11 moments are added: (1) the strict `.toEqual` on the 6-key
`COMPANION_MOMENTS.map(m=>m.key)` list; (2) the `expect(c).not.toBeNull()` loop,
because the `rich` fixture has no `eligibleEnrichmentCardTypes`; (3) the
`intent` prefix regex `/^(Warmly greet|Greet) the member/`. The
`companion-enrichment-moments` lane MUST update this test in the same PR:
extend `rich` with `eligibleEnrichmentCardTypes` (all 11), update the key set to
17 (or split so the F-moment contract stays pinned separately), and relax/split
the intent-prefix assertion so enrichment intents (which open with their own
instruction) are allowed. This is not optional ΓÇö the build fails otherwise.

**VTID attribution (R1-F5).** CI PLAN-SPAR allocates the lane VTIDs on
convergence; the new files' JSDoc headers, the tick's `enrichment_unavailable`
field, and the OASIS event payload carry the allocated VTID (Kiro does not
hand-allocate).

### Explicitly NOT in scope (sparring corrections)
- **No new Index or diary moments.** The shipped `vitana_index` and
  `diary_nudge` already deliver the weekly-style reminders; `pickMoment` has no
  surface-specific lists, so a second moment for the same card type would race
  and never win. If the owner later wants a different Index/diary cadence, that
  is a one-line change to the existing moment's `repeatAfterDays`, documented
  as a behaviour change ΓÇö a separate decision, not this plan.
- **No F1/F7/F8 additions.** Already shipped (VTID-05101); retained unchanged.
- **No staging assertion of a delivered card.** Engine is
  `disabled-on-staging`.
- **Lab tests, F4/F5/F10, a pinned `EnrichmentCardStrip` header, boost cards in
  the messenger** ΓÇö all out of scope.

## 3. Architecture (reuse map, corrected)

Reused unchanged:
- `companion/moments.ts` `COMPANION_MOMENTS`, `pickMoment`, `MomentCandidate`.
- `companion/signals.ts` `fetchMemberSignals` (bulk, per page of member ids) ΓåÆ
  `MemberContext`.
- `companion/delivery.ts` (Vitana DM + pacer touch `messenger_companion`).
- `enrichment/card-catalog.ts` `eligibleEnrichmentCards(completions,
  dismissRows, screen, now)` ΓÇö the shared eligibility rule.
- `guide/presence-pacer.ts`, `data/enrichment-card-tips.ts`,
  vitana-v1 `MessageBubble.tsx` → `VitanaChatCard` (no vitana-v1 change —
  VERIFIED R1-F1: `VitanaChatCard` renders ANY `card_type` via the shared
  `getVitanaCardComponent` registry, not an F-series allowlist, and already
  handles E-series dismissal, so E1–E11 render unchanged).

Genuinely new (the real work):
1. **Bulk enrichment completion + dismissal reads.** The per-member
   `loadEnrichmentCardState()` issues ~8 per-member queries and has no bulk
   form. Build bulk reads in `companion-repository.ts` mirroring
   `fetchJourneyStates`/`fetchActiveDaysSince` (`inChunks`/`inChunksPaged`,
   one IN-clause per source table across all member ids in the page): profiles
   fields, any-post, active social connections, enabled calendar app, any
   contact, active device token, and the `user_enrichment_cards` dismissal
   rows. Add a `FetchEnrichmentCompletions` seam to the companion tick deps so
   tests can stub it without a DB.
   **False-initialization contract (mandatory, R1-F3):** `eligibleEnrichmentCards`
   requires `completions.get(t) === false` (strict) ΓÇö `undefined` is NOT
   eligible. So the bulk seam MUST initialize every member's completion map
   with `false` for all 11 card types BEFORE applying query results (exactly as
   `computeCompletions` does with `facts.profile ?? {}` and as `signals.ts`
   seeds `journey: null` per member). A member with no `profiles` row must come
   out with E1/E2/E4/E5/E11 = `false` (eligible), not absent. Test fixture
   includes a member with no profile row asserting those are `false`.
   **Error contract (mandatory):** the seam MUST follow the same
   `Promise.allSettled` / `unavailable[]` pattern as `fetchMemberSignals`
   (`signals.ts`) and MUST NEVER throw ΓÇö a per-source failure adds a label to
   `unavailable` and returns normally (return shape analogous to
   `SignalsResult`, e.g. `{ by: Map<string, EnrichmentCompletionResult>,
   unavailable: string[] }`). It is added to the existing
   `Promise.all([...])` at `companion-service.ts:131`; if it threw, the whole
   tick would reject and zero members would be decided that tick. A test
   asserts: when the profiles bulk query rejects, the seam returns an empty map
   + `unavailable: ['enrichment_profiles']` and the tick continues, enrichment
   moments simply not firing.
2. **MemberContext field (R3-F1 resolution ΓÇö pre-compute in the tick):**
   `Moment.build(ctx)` has no `Date`, only `ctx.localDate: string`, so it
   cannot call `eligibleEnrichmentCards(..., now, ...)` correctly (using
   `new Date(ctx.localDate)` gives midnight UTC and silently breaks the 7-day
   dismissal cooldown). Therefore the eligible set is computed **in the tick
   loop**, where the real `now` is in scope (`companion-service.ts:88`), BEFORE
   `ctx` is built: call
   `eligibleEnrichmentCards(completions, dismissRows, 'messenger', now,
   unavailableEnrichmentCards())` and store the result on `MemberContext` as
   `eligibleEnrichmentCardTypes: ReadonlySet<EnrichmentCardType>`. Each
   enrichment moment just checks `ctx.eligibleEnrichmentCardTypes.has('E1')` ΓÇö
   no `eligibleEnrichmentCards` call and no `now` inside `build()`. Test:
   member dismisses E8 at T; tick at T+3d ΓåÆ E8 moment returns null; tick at
   T+8d ΓåÆ E8 fires.
3. **11 enrichment moments** gated through
   `eligibleEnrichmentCards(..., unavailableEnrichmentCards())`.
   **Priority-scale trap (mandatory):** `EligibleEnrichmentCard.priority`
   returned by `eligibleEnrichmentCards()` is a **1-based catalog ordering**
   (1 = E1 ΓÇª 11 = E11, lower = more valuable) used for News Feed display ΓÇö it is
   on the OPPOSITE scale from `pickMoment` priorities (higher wins: greeting 10,
   invite 15, tip 20, Index 50ΓÇô70). It MUST NOT be used as
   `MomentCandidate.priority`. Each of the 11 moments assigns an explicit
   companion-scale priority in **the 21ΓÇô39 range** (strictly above `featureTip`
   20 ΓÇö not a tie ΓÇö and strictly below `diary_nudge`'s floor of 40), in
   **numerical card order: E1=39, E2=38, E3=37, E4=36, E5=35, E6=34, E7=33,
   E8=32, E9=31, E10=30, E11=29** ΓÇö exactly the ┬º2 table (11 consecutive
   integers). This is numerical card order, NOT the News-Feed catalog order
   (`ENRICHMENT_PRIORITY` = E1,E2,E3,E6,E7,E8,E9,E4,E5,E10,E11); the companion
   deliberately uses simple card order since it shows one card per day, so the
   relative ranking among setup cards rarely matters. The priority-pin test
   asserts these **absolute** values. (This matches ┬º2; the earlier "20ΓÇô49" was
   the pre-R1-F4 band and is superseded ΓÇö R2-F1/R3-F1.)

4. **repeatAfterDays per moment (R2-F2, mandatory).** `repeatAfterDays` defaults
   to nothing meaningful; an incomplete card with no repeat window fires EVERY
   day until done/dismissed (the 7-day cooldown only starts on an explicit
   dismiss, not on an ignored DM). Every shipped moment has a non-zero window
   (index 3, journey 2, diary 4, tip 5, invite 14). Owner decision for the
   enrichment moments: **profile/setup cards E1, E2, E4, E5, E11 ΓåÆ
   `repeatAfterDays: 4`; connector/social cards E3, E6, E7, E8, E9, E10 ΓåÆ
   `repeatAfterDays: 7`.** Added as a column to the ┬º2 table. Test: a member who
   got but ignored E1 yesterday does not get E1 again today.

## 4. Lanes

- **Lane `companion-enrichment-signals`** (gateway): the bulk completion +
  dismissal reads and the `MemberContext` fields + tick-deps seam. This is the
  dependency for the moments lane. Paths:
  `services/gateway/src/services/companion/**`, `services/gateway/test/**`.
- **Lane `companion-enrichment-moments`** (gateway, depends on
  `companion-enrichment-signals`): the 11 E1ΓÇôE11 moments gated via
  `eligibleEnrichmentCards`, priorities, intents (reusing
  `enrichment-card-tips.ts` copy), and the selection tests. Paths:
  `services/gateway/src/services/companion/**`, `services/gateway/test/**`.
- **Lane `messenger-companion-verification`** (gateway, depends on the moments
  lane): run-mode doc + the established staging test (status =
  `disabled-on-staging`) + offline integration proof that an incomplete member
  gets the right enrichment card and a complete/dismissed member does not.
  Paths: `services/gateway/src/services/companion/**`,
  `services/gateway/test/**`, `docs/validation/**`.

`companion-enrichment-moments` and `companion-enrichment-signals` both touch
`moments.ts`/companion files ΓÇö sequenced, not parallel (┬º8a). The moments lane
starts only after the signals lane is `done`.

## 5. Testing

- Bulk reads return correct per-member completion + dismissal maps over a
  multi-member page (stubbed Supabase, following `signals` test patterns).
- Moment selection: an incomplete, non-dismissed member is offered the
  highest-priority eligible enrichment card; a completed member never is; a
  member who dismissed E8 elsewhere does not get E8 during the 7-day cooldown
  (drives `eligibleEnrichmentCards` with dismissal rows).
- Priority: enrichment moments never outrank `vitana_index`/
  `guided_journey_step`; pinned by a test.
- No duplicate/parallel moments for F1ΓÇôF8 / Index / diary (a test asserts
  `COMPANION_MOMENTS` card-type/key set is unchanged except the new E-moments).
- Locale coverage: no new copy needed (reuses `enrichment-card-tips.ts`); if
  any string is added, the existing coverage test enforces all locales.
- Staging: GET `/api/v1/companion/status` ΓåÆ `mode: disabled-on-staging`
  (read-only), matching VTID-05100/05101.

## 6. Risks and open questions

1. **Bulk read cost/correctness.** Seven source tables + dismissal rows, bulk,
   per page. Must match the per-member resolver's semantics exactly
   (e.g. social `is_active && disconnected_at IS NULL`, calendar app allowlist).
   Mitigation: unit tests compare bulk vs per-member on the same fixtures.
2. **Engine run mode.** `disabled-on-staging` always; live sends need
   `COMPANION_SEND_ENABLED` + mode in production. This plan does NOT enable
   live member DMs ΓÇö that is a separate owner go-live step. So Phase 1
   completion means "built, tested, selectable", not "members see it".
3. **`user_active_days` undocumented** (used by the shipped invite/feature-tip
   gates, not by this plan's E-moments). No new dependency on it here.
4. **Later plan, F4 collision:** the shipped `morning_greeting` already emits
   `cardType:'F4'` as the priority-10 fallback. A future "never used voice" F4
   moment must change the greeting's card type (e.g. to null/a greeting type)
   to avoid two F4s competing. Recorded here so the follow-up plan accounts for
   it; not part of this plan.

<!-- plan:end -->
