# Matchmaking Redesign Spec — "Explainable, Never-Empty Matching"

**Status:** Draft for review · **Owner:** (TBD) · **Date:** 2026-06-14
**Tag:** BOOTSTRAP-MATCHMAKING-EXPLAINABLE

> Trigger incident: a user asked Vitana (voice) to *"find me a tennis partner."*
> Vitana said *"I found 5 matches — want to see them?"* The user said yes; the
> screen showed **dance** partners, not tennis. When challenged, Vitana
> apologized incorrectly instead of explaining. This spec fixes the root causes
> and redefines how we **explain and present** matches so the feature becomes a
> daily-return engine for both social and business intents.

---

## 1. What we have today (as-built)

**Engine.** One `user_intents` table (8 kinds), an `intent_compatibility` matrix,
and `compute_intent_matches` (v3) which scores the catalog into `intent_matches`.
Federation already exists: `commercial_buy` matches affiliate **products**; dance
intents match upcoming **live rooms / classes**.

**Current score formula** (`compute_intent_matches` v3):
```
score = 0.40·cosine(embedding)        ← the ONLY place "activity meaning" lives
      + 0.20·kind_overlap             ← for activity_seek = TIME overlap only
      + 0.20·geo
      + 0.10·recency
      + small dance/category bonuses
density floor: 0.05 (pool<5) / 0.15 (pool<50) / 0.30 (pool≥50)
```

**Display.** A `% match` + **one** humanized reason chip (`FindPartnerMatchCard`);
one card type leaks raw keys ("cosine: 40%"). The only explanation of how matching
works is an empty-state line: *"The AI ranks people across dance and fitness."*

## 1bis. Full inventory — every matchmaking system that ALREADY exists (do NOT duplicate)

A codebase sweep found **multiple parallel match systems**. This is the central
risk: most of the redesign is *consolidation + re-wiring*, not new building.

| # | System | What it is | Scores on | Status |
|---|--------|-----------|-----------|--------|
| 1 | `compute_intent_matches` (+ `search_intent_catalog`) | The intent engine; **3 layered versions** (P2-A baseline w/ compass bonus, dance fn, v3 w/ density floor+category prefix) | embedding, time/budget/etc, geo, recency, compass | **LIVE** — powers voice `find_match` |
| 2 | `matchmaker-agent.ts` | **Gemini 2.5 Pro re-ranker** on top of #1; produces explainable reasons + counter-questions + voice readback | intent score + profile + city + dance variety + density | **LIVE** — async post-intent |
| 3 | `matches_daily` (VTID-01088) | Deterministic **daily** people/group/event/product/live-room matcher; feeds push notifications | topics, tags, metadata location/time, user prefs | **LIVE** — proactive messenger |
| 4 | `daily_matches` (v1 edge fn) | A second daily table the **frontend reads** (`useRealMatches`) | **`Math.random()` 60–90 — FAKE** | **DORMANT/DEMO — dangerous** |
| 5 | D47 social-alignment | Proactive people/group/event surfacing | relevance, shared signals, confidence, social-energy | **LIVE** |
| 6 | D39 taste-alignment | Taste + lifestyle profile fit (this **is** much of my "profile_fit") | simplicity, aesthetic, routine, social orientation, novelty… | **LIVE** (feeds recs) |
| 7 | recommendation-engine / feed-ranker | Content/product ranking (economic-axis tags some as `find_match`) | featured, rating, topic, condition, budget | **LIVE** (content) |

**Implication:** "find a match" people-matching is already served by **at least
three live systems** (#1+#2 intent, #3 daily, #5 social-alignment) plus a
**fake** one (#4) the frontend still reads. The original "5 matches → dance
screen" bug is almost certainly worsened by these paths disagreeing. The job is
to **pick one source of truth and consolidate**, not add an engine.

## 2. Root cause of the tennis→dance incident

Two bugs, stacked — both must be fixed.

**Bug A — the activity is effectively not weighed.**
1. The 40% activity weight is **embedding-only**, but embeddings are written
   fire-and-forget *after* the post and match-compute runs async immediately, so
   at match time `embedding IS NULL` → the term is **hard-coded to 0.5 for
   everyone**. Tennis and dance become identical on the biggest axis.
   *(`compute_intent_matches_v3.sql:69-73`; async writes `intents.ts:323-378`.)*
2. `kind_overlap` for `activity_seek` calls `intent_overlap_time()` — compares
   **time windows only**, never `kind_payload.activity`.
   *(`v3.sql:74-84`, `compute_intent_matches_fn.sql:188-214`.)*
3. The density floor is permissive in a small pool, so ~0.20–0.34 from time+geo
   alone clears the bar. *(`v3.sql:38-52`.)*
   **Net: time & location outrank the activity, and activity is nearly ignored.**

**Bug B — "5 matches" and the screen are different queries.**
- *"find tennis"* → `find_match` → `search_intent_catalog` (live, **tennis-scoped**) → 5.
- *"show me"* → `viewAllMyMatches` → reads persisted `intent_matches` **aggregated
  across ALL the user's open posts, no activity filter** → an old dance post drags
  its matches onto the screen. *(`orb-tools-shared.ts:3218-3274`; `intentApi.ts:285-312`.)*

**Why Vitana flailed:** the reason breakdown is **dropped** before it reaches her
(both voice paths strip `match_reasons`), so she had nothing to explain with.
*(`intent-find-match.ts:265-272`, `orb-tools-shared.ts:3314-3321`.)*

## 3. Design principles

1. **NEVER EMPTY (hard rule).** Every search / matches view returns something
   actionable — exact matches, then clearly-labeled alternatives, then
   federation/classes/products, then "be the first → post" + invite. A blank
   matches screen is a bug.
2. **Location and time are the primary axis — in that order — and activity is
   flexible.** The user's real goal is *"do something, that day, near me, with
   someone."* If there's no tennis partner but someone nearby is free at the same
   time and wants to walk, that is a **good** match — the underlying need (a local
   meet-up that day) is met. Ranking priority is strictly **Location → Time →
   Activity → other profile params.** Location & time behave as near-gates;
   activity re-orders *within* the location+time-qualified set and is never a
   reason to show nothing.
3. **Transparency is the feature.** Every match shows *why* (activity / time /
   location / profile) and the overall %. Off-activity items are always labeled
   and explained, never silently mixed in.
4. **One framework, context-aware formulas (§4.5).** The same explainable engine
   serves four contexts — physical/online × social/business — by switching which
   dimensions gate and in what order. Physical-leisure leads with location; online
   leads with timezone; business leads with complementary role + trust. Same
   transparency, different copy.
5. **Honest voice.** Vitana names the tradeoff ("no exact tennis yet, but…")
   instead of apologizing.

## 4. Redesigned scoring model — Location → Time → Activity → Profile

The model is **gates first, then ranking**. Location and time qualify *who can
appear*; activity and profile decide *the order*. This guarantees every shown
person fits where & when, while keeping the activity flexible.

### 4.1 Stage 1 — Qualify (gates, in priority order, auto-widening so it's never empty)
1. **Location gate (primary).** Candidate within the user's area / radius (or
   remote-compatible). If too few qualify, **progressively widen the radius**
   (e.g. 5 → 15 → 50 km) rather than return empty — and label the widening.
2. **Time gate (secondary).** Same day / overlapping or *near* the requested
   window. If too few, **widen the time** (this evening → this week) — labelled.

Location is never sacrificed for activity; time is never sacrificed for activity.
Activity is sacrificed *before* either of them.

### 4.2 Stage 2 — Rank the qualified set
```
match% = 35·location_fit + 30·time_fit + 25·activity_fit + 10·profile_fit
```
- **`location_fit` (35)** — proximity within the (possibly widened) radius; closer = higher.
- **`time_fit` (30)** — degree of window/day overlap or nearness.
- **`activity_fit` (25)** — deterministic, embedding-independent (table below); re-orders *within* the location+time pool. Same activity ranks first, but a different activity still appears.
- **`profile_fit` (10)** — level, age band (where relevant), language, Life-Compass alignment, shared interests.

Weights encode the priority order (location > time > activity > profile). Because
location & time are *also* gates, a low location/time fit can't be bought back by
a perfect activity match — it drops to a "widen" tier instead.

**Deterministic `activity_fit`** (works with or without embeddings):
| Relationship | activity_fit |
|---|---|
| Same activity (tennis ↔ tennis) | 1.00 |
| Same sub-tree (tennis ↔ padel) | 0.60 |
| Same kind, different activity (tennis ↔ walk/dance) | 0.15 |
| Embeddings present | blend semantic similarity to refine the middle band |

**Hard filters** the user sets (must-haves) remove candidates; **soft prefs** adjust score.

### 4.3 Tiers for display (this is how "never empty" + honest framing coexist)
Now bucketed by location+time first, then activity:
- **Tier 1 — Perfect:** near you **+** your time **+** same activity (tennis). The dream.
- **Tier 2 — Same place & time, different activity:** near you + your time, *not* tennis (the walk/dance case). **This is the headline behavior the user asked for** — surfaced prominently *with* the explanation, not hidden.
- **Tier 3 — Widened:** location✓ but time widened (other days), or time✓ but radius widened. Labelled "a bit further / another day."
- **Tier 4 — Always-on fallback:** classes/coaches nearby (live-room/product federation), new/active members open to meet, *"Be the first — post your wish, I'll alert you,"* invite-a-friend.

The result **always leads with an explainer card** (§6) stating the criteria, so
a tennis search that returns a walking buddy is understood, not confusing.

### 4.4 Fix the embedding race
Recompute matches once the embedding lands (the matchmaker-poll/recompute path
exists). Because location, time, and `activity_fit` are all deterministic,
correctness no longer depends on embeddings — they only refine fuzzy activity cases.

### 4.5 Match contexts — the formula is mode-aware (physical/online × social/business)

The Location→Time→Activity→Profile order above is **one of four** contexts. Two
independent axes pick the formula per intent:

- **Setting** — *Physical/local* vs *Online/remote* (from `kind_payload.location_mode`
  = `on_site|hybrid|remote`, or an explicit online flag). Online → **location is
  not a gate**; it is replaced by **timezone + language** (can they actually
  connect live?).
- **Domain** — *Social/leisure* vs *Business/professional* (from `intent_kind` +
  category: activity/social/partner = social; commercial_buy/sell, mentor/learning,
  and "business partner / co-founder / networking" = business). Social = **mirror**
  match (both want the same thing). Business = **complementary** match (offer ↔
  need) — the `intent_compatibility` matrix already encodes this for
  buy↔sell and learn↔mentor; we extend it to partnership/networking roles.

| | **Social / leisure** (mirror) | **Business / professional** (complementary) |
|---|---|---|
| **Physical / local** | tennis buddy → **Location → Time → Activity → Profile** | local service / local networking → **Location → Role-complementarity → Time → Trust/Profile** |
| **Online / remote** | online chess, language exchange → **Time(+timezone) → Activity/Topic → Profile(lang) → (no location)** | remote co-founder, B2B, online mentor → **Role-complementarity → Domain/Industry → Trust/Profile → Timezone** |

**Gate changes by quadrant:**
- *Physical*: location gate (auto-widening radius) — as defined.
- *Online*: location gate **off**; **timezone+language** become the "can-we-connect" gate; time still gates for synchronous, relaxes for async.
- *Business*: a **complementarity gate** comes first — a buyer is only shown sellers, a founder needing design is only shown designers (never other buyers/founders-needing-design). Then domain/industry. Location gates **only** if the intent is explicitly local; otherwise online rules apply. **Trust/verification is weighted much higher** for business.

**Never-empty + explainability still apply in every quadrant** — only the
dimension *order* and the lead-card/voice copy change.

### 4.6 Profile parameters (the dimension I previously left undefined)

`profile_fit` is a weighted blend, **universal + context-specific**:

- **Universal:** language overlap; trust/verification tier (reputation,
  verified); account activity/recency (is this a live, responsive user); Life
  Compass / values alignment.
- **Physical leisure adds:** skill level, intensity/pace; gender preference and
  age band *only where the user set them* (e.g. partner_seek) and consented.
- **Online leisure adds:** timezone overlap, platform/tool preference, language, level.
- **Business adds (weighted up):** role complementarity (offer↔need), industry/
  domain, seniority/stage (e.g. startup stage, deal size), commitment/terms
  (budget, equity, hours), credentials/portfolio, and **trust tier** (the dominant
  business-profile signal). Federation here points at **events/meetups, products,
  and live rooms** rather than only people — "ways to act on this now."

### 4.7 Full criteria catalog (every signal that moves the score)

The four "buckets" each decompose into concrete criteria. Each row: what it
means · where the data comes from · role (**Gate** = removes/qualifies candidates;
**Weight** = moves the %; **Filter** = user-set hard constraint; **Tiebreak** =
orders near-equals) · build status.

**A — LOCATION** *(gate for physical; off for online)*
| Criterion | Means | Source | Role | Status |
|---|---|---|---|---|
| Proximity / same place | Same city/area or within radius | `kind_payload.location_label`, `geo_overlap` | Gate+Weight | Built (label only) |
| Distance | Actual km apart | coords / `maxDistanceKm` filter | Weight+Filter | Partial (sparse) |
| Location mode | on_site / hybrid / **remote** | `kind_payload.location_mode` | Gate switch | Built (remote→1.0) |

**B — TIME**
| Criterion | Means | Source | Role | Status |
|---|---|---|---|---|
| Day / date | Same day or date range (e.g. "Jun 20–Oct 1") | `kind_payload.time_windows` | Gate+Weight | Built |
| **Time of day** | morning / afternoon / **evening** slot overlap | `time_windows` | Weight | Partial (windows exist, not slotted) |
| Recurrence / consistency | regular vs one-off; matching cadence | `time_windows` | Tiebreak | New |
| Timezone | overlap for **online** intents | `profiles.timezone` | Gate (online) | **New** (column unused) |
| Post freshness | how recently the counterpart posted | `recency_bonus` | Weight | Built |

**C — ACTIVITY / TOPIC** *(the "what" — flexible per your rule)*
| Criterion | Means | Source | Role | Status |
|---|---|---|---|---|
| Activity match | tennis = tennis | `kind_payload.activity` → `activity_fit` | Weight | **New (deterministic)** — today only via embedding |
| Category / sub-category | `sport.tennis`, `dance.*` | `category` | Weight | Built (prefix bonus) |
| Semantic similarity | fuzzy "padel ≈ tennis" | embedding cosine | Weight | Built (but NULL at match time — see §2) |
| Style / variety / discipline | salsa vs bachata; road vs MTB | `kind_payload.*.variety` | Weight | Built (dance only) |
| Complementary role *(business)* | offer ↔ need (buy↔sell, learn↔mentor) | `intent_compatibility` | Gate | Built |

**D — USER PROFILE & COMPATIBILITY** *(this is what "profile" actually means)*
| Criterion | Means | Source | Role | Status |
|---|---|---|---|---|
| **Experience / skill level** | beginner ↔ pro; same level scores higher | `kind_payload.skill_level`, reason key `level_match` | Weight | Partial (key exists) |
| **Age / age band** | within desired range; peer age | `profiles.date_of_birth`, `kind_payload.age_range`, age filter | Weight+Filter | Partial |
| **Gender / gender preference** | where the user set one (e.g. partner) | `kind_payload.gender_preference` | Filter | Partial |
| Language | shared spoken language (vital online) | `profiles` language | Gate (online) / Weight | Partial |
| Values / life goals | Life Compass alignment | `compass_alignment_bonus` | Weight | Built |
| Taste & lifestyle | routine, intensity/pace, social orientation, novelty | **D39 taste-alignment** | Weight | Built (not wired to match) |
| Social fit | shared interests, prior interaction, recency | **D47 social-alignment** | Weight | Built (not wired to match) |
| Trust & verification | verified, reputation/trust tier | trust tier / verification | Weight (high for business/partner) | Partial |
| Activity / responsiveness | recently active, likely to reply | `partner_last_active_at`, online filter | Tiebreak | Partial |
| Energy / vibe | `energy_match` | reason key | Tiebreak | Partial |
| Group preference | solo vs group size | `kind_payload.group_size_pref` | Weight | Partial |

**E — USER-SET CONSTRAINTS** *(hard gates, not soft weights)*
| Must-haves | hard include | `kind_payload.must_haves` | Filter | Partial |
| Deal-breakers | hard exclude | `kind_payload.deal_breakers` | Filter | Partial |
| Budget range *(commercial)* | price overlap | `intent_overlap_budget` | Gate | Built |

**Default weight split per context** (top-level buckets; sub-criteria compose
each bucket): *Physical-social* = 35 location / 30 time / 25 activity / 10
profile · *Online-social* = 35 time+timezone / 30 activity / 25 profile(lang) /
10 — · *Business* = 40 complementary-role / 25 domain / 25 trust+profile / 10
location-or-timezone. Hard filters (E) apply first in every context.

### 4.8 Always show a ranked list — even at 13%
Per the never-empty rule, **the result set is never truncated to "good matches
only."** After gates + widening, everything is ranked and shown; low scores are
labelled, not hidden. A 13% match still appears (in the "long shot / expand"
tier) with its reason ("same area, very different activity & time") so the user
can choose. The user always has a list to pick from.
- "Show me what I just searched" scopes the screen to that activity/intent
  (pass the searched `intent_id`/category through), so spoken == shown.
- `viewAllMyMatches` gains activity/tier labeling; cross-activity items only under
  "You might also enjoy."
- **Pipe `match_reasons` end-to-end**: include the dimension breakdown in
  `find_match` + `view_intent_matches` results so Vitana can explain, and surface
  the full breakdown on the card.

## 6. Explaining the criteria (visual + acoustic)

The whole result is framed so the user instantly understands *why* these people
appear — location & time first, activity flexible.

### 6.1 Lead explainer card (always the first thing shown)
A header card that states the search, the outcome, and the ranking logic. Two
variants:

**Exact found:**
> 🎾 **Tennis near you, this evening** — 3 people in Palma free around your time.

**No exact activity, but location + time fit (the key case):**
> 📍🕖 **No tennis in Palma this evening — but these are near you, at your time.**
> *"Location and timing come first, so you can still get out today. Same activity
> first, then close-by people open to something else."*

This card is what turns "why am I seeing a walk for a tennis search?" into
"ah — same place, same time, different activity, makes sense."

### 6.2 Each match card — dimensions in priority order
Show the four dimensions **in the priority order** (location → time → activity →
profile), each as a labelled chip/bar, plus the overall %:
> **82% — Near you, your time** · 📍 5 min away · 🕖 Free this evening · 🚶 Walk *(different activity)* · 👤 Similar pace
> *"Ana is 5 minutes away and free this evening — she's up for a walk."*

- Location & time chips lead and are always "green" for shown cards (they passed the gates).
- The activity chip is **explicitly badged "different activity"** when it isn't an exact match — honest, not hidden.
- Tier section headers reinforce it: **"Tennis near you" → "Near you, same time — other activities" → "A bit further / another day."**

### 6.3 Acoustic — Vitana's wording (voice contract)
Vitana always anchors on location+time and frames the activity as the flexible
part. Scripted patterns the voice layer must follow (the reason breakdown is
piped to her so she can say the real numbers):

- **Exact:** *"I found 3 people near you in Palma, free this evening for tennis."*
- **No activity match, location+time fit (the incident, done right):**
  *"We've got no buddy looking for tennis near you today — but there's someone
  in your area, free around the same time, who'd love to take a walk. Want me to
  show you them and a couple of others nearby?"*
- **Widening:** *"Nobody at your exact time — but tomorrow evening there are two
  people near you. Want those, or should I post your tennis wish so I can alert
  you the moment someone matches?"*
- **Online activity (no location; timezone leads):** *"No one online for chess in
  your timezone right now — but two people in a close timezone are around this
  evening. Want me to introduce you?"*
- **Business / complementary (role leads, not 'same activity'):** *"No co-founder
  in fintech yet — but there's a growth marketer in your timezone, verified,
  open to a venture. Different skillset, which is exactly what a co-founder is
  for. Want to see their profile?"*

Rule: **never apologize** for a non-exact match; explain the criteria that *did*
fit (location/time, or timezone, or complementary role + trust) and offer the
next step.

### 6.4 Score presentation — make a high score feel like a win

The score must be instantly readable as "how good is this?" — **color + icon +
label**, not a bare number. Five visual tiers (thresholds tunable after a data pass):

| Score | Tier label | Color | Icon | Treatment |
|---|---|---|---|---|
| 85–100% | **Perfect match** | gold | 🏆 / 💎 | glow / confetti on open; top of list |
| 70–84% | **Great match** | green | ⭐⭐⭐ | bold % badge |
| 55–69% | **Good match** | teal/blue | ⭐⭐ | standard badge |
| 35–54% | **Worth a look** | amber | ⭐ | muted badge |
| <35% | **Long shot** | grey | ○ | under "Expand your search," with the reason |

Rules:
- **Always a ranked list, never empty** (§4.8) — even a 13% "long shot" shows,
  labelled, so the user always has something to choose.
- The **list is visually self-explanatory**: color + tier label + icon means a
  user instantly sees the best matches at a glance and feels the win at the top.
- Each card also shows the **per-dimension mini-bars** in priority order
  (📍 location · 🕖 time · 🎾 activity · 👤 profile) so the % is explainable.
- Celebrate wins: a Perfect/Great match gets a small celebratory moment (icon +
  micro-animation) so posting & matching feels rewarding — fuelling return visits.

## 7. The story (daily-return engine)
- **Transparency builds trust** → users accept matches and trust the %.
- **Daily hooks:** "3 new people posted tennis near you this week," "you're the
  first — I'll alert you," partner reciprocal-reveal excitement.
- **Business story, same engine:** buyer↔seller, learner↔mentor, products,
  classes — *"You wanted a padel coach: 2 coaches + 1 class near you, ranked by
  fit & distance."*
- **User-steerable weights:** a simple "I care most about: the activity / staying
  nearby / anyone open to meet" control tunes the formula — the algorithm becomes
  a feature the user owns.

## 8. Worked examples
- **Tennis, exact exists:** lead card "Tennis near you this evening"; Tier-1
  tennis partners first, dimensions shown location→time→activity→profile. ✅
- **Tennis, NO tennis but a nearby walker at the same time (the incident):**
  lead card *"No tennis in Palma this evening — but these are near you, at your
  time."* Tier-2 shows the walker, badged "different activity," ~82%. Vitana
  speaks the location+time framing. Screen never empty. ✅
- **Tennis, nobody near you at your time at all:** auto-widen → Tier-3 "tomorrow
  evening / a bit further" + Tier-4 "be the first, I'll alert you" + a local
  class. Still never empty, still explained. ✅
- **Scoring check (tennis-seeker vs nearby same-time walker):**
  `35·location(1.0) + 30·time(1.0) + 25·activity(0.15) + 10·profile ≈ 0.35+0.30+0.04+… ≈ 0.72`
  → high, correctly surfaced as "near you, your time, different activity." A
  *far-away* tennis match at a *different* time scores low and drops to "widen."
  Location & time dominate, exactly as required. ✅
- **Online leisure:** "online chess this evening" → location ignored; ranked by
  timezone+time → topic/level → language. Lead card: *"Players around your time
  online."* ✅
- **Business / complementary (online):** "find a co-founder" → complementarity
  gate first (only shows people offering complementary roles, never other
  founders seeking the same), then domain → trust/verification → timezone. Lead
  card: *"No exact co-founder yet — here are complementary people, verified, in
  your timezone."* ✅
- **Business (transactional):** "buy a road bike" → buyer shown sellers +
  affiliate products; local → ranked by location then price/time; online →
  shipping/price/trust. Each explained. ✅

## 9. Phased plan — CONSOLIDATE before building (revised after inventory)

- **Phase 0 (consolidate — do first, no new scoring):**
  1. Pick **one** source of truth for on-demand "find a match" → the **intent
     engine (#1+#2)**. 2. **Kill the fake `daily_matches` (#4)** path the
     frontend reads, or repoint it at the real source. 3. Collapse the **3
     `compute_intent_matches` versions into one**. 4. Decide the role split:
     intent engine = on-demand search; `matches_daily` (#3) = proactive daily
     push; D47 (#5) = ambient social nudges. No two systems scoring the same
     "find a match" surface.
- **Phase 1 (correctness, as edits to the consolidated engine):** location/time
  gates + auto-widen; deterministic `activity_fit`; context modes (§4.5); unify
  the spoken vs shown data path. *Kills the tennis→dance bug.*
- **Phase 2 (explainability — wire existing, don't rebuild):** the
  matchmaker-agent (#2) **already** produces reasons and `matchReasons.ts`
  **already** humanizes them — stop dropping them before voice/card; build the
  lead explainer card; honest off-activity voice script.
- **Phase 3 (profile_fit via existing engines):** feed **D39 taste (#6)** +
  **D47 social (#5)** + compass into `profile_fit` rather than a new engine.
- **Phase 4 (genuinely new):** timezone dimension; a `business_seek`/partnership
  intent kind + complementary-role mappings; user-tunable weights; display tiers
  + daily hooks.

## 10. Touch points (for implementation)
- SQL: new `search_intent_catalog` + `compute_intent_matches` (add `activity_fit`,
  re-weight, return tier + per-dimension reasons) — `vitana-v1/supabase/migrations`.
- Gateway: `intent-find-match.ts`, `intent-matcher.ts`, `orb-tools-shared.ts`
  (carry reasons + tier; scope view to searched activity), `live-tool-catalog.ts`
  (voice explanation contract).
- Frontend: `FindPartner.tsx`, `FindPartnerMatchCard.tsx`/`IntentMatchCard.tsx`
  ("Why you matched" + tier sections), `matchReasons.ts` (full humanized
  breakdown), empty-state → never-empty cascade.

## 11. Open decisions for review
1. Exact tier thresholds (0.8 / 0.4) and weights (45/20/20/15) — tune after a
   data pass on the real catalog.
2. Should user weight-tuning ship in Phase 1 or Phase 3?
3. Business matches in the same list vs a separate "Ways to fulfill this now" rail.
4. How prominent should classes/products (federation) be vs people?
