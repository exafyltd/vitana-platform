-- =============================================================================
-- Book of the Vitana Index — chapters 0 through 6
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (Phase E step 1)
--
-- Seeds the canonical narrative of the Vitana Index into Knowledge Hub under
-- the `vitana_system` namespace. These docs precede the scoring code rewrite
-- so product + code + Assistant agree on the story.
--
-- This book is built on EXACTLY five pillars — Nutrition, Hydration, Exercise,
-- Sleep, Mental health. Any earlier mention of a 6-pillar model is drift and
-- will be erased in the follow-up cleanup migration.
--
-- Idempotent via upsert_knowledge_doc() (upsert on path). Safe to re-run.
-- =============================================================================

-- ===========================================================================
-- Chapter 0 — Overview
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Overview',
  p_path  := 'kb/vitana-system/index-book/00-overview.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','longevity','five-pillars','maxina'],
  p_content := $CONTENT$
# Book of the Vitana Index — Overview

Your Vitana Index is a single number between 0 and 999 that answers one question:
**how well is today compounding into a longer, healthier, more fulfilling life?**

It is the one score you can keep in your eye across every screen in Maxina and
Vitana. The higher the number, the more your daily behaviour is aligned with
longevity. The lower the number, the more the system has to suggest to lift you
back on track.

## The five pillars of quality of life

Longevity isn't one thing — it is five things, in balance, compounding over time.
The Vitana Index is the weighted sum of five pillars, each scored 0–200:

1. **Nutrition** — what and how you eat. Meals, macro balance, biomarkers.
2. **Hydration** — how well you hydrate through the day, adjusted for activity
   and climate.
3. **Exercise** — how your body moves. Steps, workouts, heart-rate zones,
   recovery.
4. **Sleep** — how you rest. Duration, regularity, stages, HRV.
5. **Mental health** — the state of your mind. Stress, mood, mindfulness,
   cognitive load.

These five are not independent — they are deeply conditional on each other.
Poor sleep wrecks tomorrow's nutrition choices. Dehydration slows exercise
recovery. A stressed mind chooses worse food. You can't grind one pillar and
ignore the rest — the number won't climb because the practice isn't real.

That is why the Vitana Index rewards **balance**, not peaks. See the Balance
chapter for how this is computed.

## The 90-day arc

When you join, Maxina pre-populates your calendar with a 90-day journey of
small, concrete actions that touch every pillar. The idea is simple: do the
actions, watch the number move.

The journey is your **route**. The Index is your **measurement**. The Calendar
is your **day-level plan**. The Autopilot is the **nudge engine** that surfaces
the next right action at the right moment.

## How each number is built (in one picture)

For each of the five pillars (max 200 each), four things contribute:

| Component | Max | How it grows |
|---|---|---|
| Baseline survey | 40 | You tell us how you're doing — once, during onboarding |
| Action completions | 80 | Doing the actions the journey suggests |
| Connected data | 40 | Linking wearables, food logs, lab reports |
| Streak bonus | 40 | Consistency — showing up day after day |

Sum the five pillars, apply a balance factor (penalty if pillars are lopsided,
bonus if they're in harmony), cap at 999.

## Tier bands — read your number honestly

| Range | Tier | What it means |
|---|---|---|
| 0–99 | Starting | You've begun. Five pillars, 90 days — let's go. |
| 100–299 | Early | Baseline established. Every completion counts now. |
| 300–499 | Building | Habits are forming. Keep the balance across all five. |
| 500–599 | Strong | This is where most people land after a real 90-day push. |
| 600–799 | Really good | Your practice is working. This is the "thriving" zone. |
| 800–999 | Elite | Sustained excellence across all five pillars. Rare and earned. |

**We never force you to the top.** Every life has different capacity — time,
circumstance, health. A score of 500 for a busy parent who shows up three times
a week means more than a 700 from someone with unlimited free time. The number
is a compass, not a verdict.

## What you'll find in this book

- **01-nutrition** — the Nutrition pillar, unpacked.
- **02-hydration** — the Hydration pillar, unpacked.
- **03-exercise** — the Exercise pillar, unpacked.
- **04-sleep** — the Sleep pillar, unpacked.
- **05-mental** — the Mental pillar, unpacked.
- **06-balance** — why balance matters more than any single peak.
- **07-the-90-day-journey** (coming) — how each wave of the journey targets
  the pillars.
- **08-reading-your-number** (coming) — what a 10-point move means, when to
  celebrate, when to recalibrate.
- **10-your-five-agents** (coming) — the five specialised agents that watch
  your pillars and surface the right next action.

When you ask Maxina *"how does my Index work?"*, this overview is what she
starts from.
$CONTENT$
);

-- ===========================================================================
-- Chapter 1 — Nutrition
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Nutrition',
  p_path  := 'kb/vitana-system/index-book/01-nutrition.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','nutrition','five-pillars','maxina'],
  p_content := $CONTENT$
# Nutrition — the first pillar

Nutrition is the foundation. What you eat becomes who you are — literally, at
the cellular level. The Nutrition pillar of your Vitana Index tracks how well
your eating pattern supports long, healthy life.

## What the Nutrition pillar measures

Max 200 points, built from four components:

- **Baseline (0–40)** — your one-time self-rating at onboarding. Question:
  *"How well do you feel you're eating these days?"* Rating 5 = 40 points.
- **Action completions (0–80)** — journey + Autopilot actions tagged
  `nutrition`, `meal`, or `food-log`. Logging a meal, cooking at home,
  reviewing your macros — each completion adds 4–8 points up to 80.
- **Connected data (0–40)** — signals from food logs (MyFitnessPal,
  Cronometer), lab reports (HbA1c, lipid panels, vitamin D), or biomarker
  imports. The more real data, the higher this component.
- **Streak bonus (0–40)** — consecutive days with at least one nutrition
  action or log entry. 7 days → +15, 14 days → +25, 30 days → +40.

## What lifts this pillar

**Easy wins (every longevity practice starts here):**
- Log one meal per day for a week — builds awareness, starts the streak.
- Swap one ultra-processed snack for whole food.
- Add a vegetable to lunch and dinner.
- Drink water before each meal (also lifts Hydration).

**Intermediate:**
- Track macronutrients for a week — protein, carbs, fat balance.
- Add one fermented food (yogurt, kimchi, kefir) daily.
- Eat within a 10–12h window (time-restricted eating).
- Connect a food log app.

**Advanced (once habits are in place):**
- Import a lipid panel / HbA1c / fasting glucose.
- Continuous glucose monitor for a 2-week experiment.
- Work with a nutritionist using the data you've been logging.
- Track micronutrients over a month; adjust based on gaps.

## The longevity science in plain language

The evidence for what moves the needle on a long healthspan:

- **Protein adequacy** — especially as you age. Protein preserves muscle, which
  protects metabolic health, which underpins everything else.
- **Fibre from whole plants** — feeds your gut microbiome, which regulates
  inflammation, immunity, and (surprisingly) mood.
- **Minimal ultra-processed food** — the single strongest dietary predictor of
  disease across large population studies.
- **Adequate omega-3s** — from fatty fish, flax, walnuts — for brain, heart,
  joint health.
- **Glucose stability** — avoiding big glucose spikes is easier than dieting
  and probably matters more for long-term health.

## What the Nutrition agent watches for you (coming in Phase F)

When the pillar agent is live:
- Parses any meal photo you send.
- Reads biomarker imports and flags out-of-range values with context.
- Suggests meal swaps based on what's actually in your food log.
- Correlates glucose spikes with what you ate (if CGM data is connected).
- Routes Nutrition questions from the Assistant to grounded answers using
  your real data.

## Relationship to the other pillars

- Nutrition ↔ **Sleep**: late heavy meals wreck sleep quality. Caffeine after
  2pm shows up in HRV.
- Nutrition ↔ **Exercise**: under-fueling kills recovery. Over-fueling masks
  fitness gains.
- Nutrition ↔ **Hydration**: most hunger cues are thirst. Drink first.
- Nutrition ↔ **Mental**: ultra-processed diets correlate with depression
  risk. The gut is mental infrastructure.

A great Nutrition score that tanks your Sleep score doesn't give you a high
Index — balance matters. That's by design.
$CONTENT$
);

-- ===========================================================================
-- Chapter 2 — Hydration
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Hydration',
  p_path  := 'kb/vitana-system/index-book/02-hydration.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','hydration','five-pillars','maxina'],
  p_content := $CONTENT$
# Hydration — the second pillar

Hydration is the most underrated longevity lever. Water is involved in every
cellular process, every hormone cascade, every nerve signal. Even mild chronic
dehydration accelerates cognitive decline, joint wear, and metabolic stress.
And almost nobody does it well.

## What the Hydration pillar measures

Max 200 points:

- **Baseline (0–40)** — onboarding self-rating. *"How much water / fluids are
  you getting these days?"*
- **Action completions (0–80)** — completed actions tagged `hydration` or
  `water`. Logging a bottle, hitting a daily target, morning-hydration rituals.
- **Connected data (0–40)** — integrations with smart bottles (HidrateSpark),
  Apple Health (Water), Google Fit (Hydration), manual logs in Maxina.
- **Streak bonus (0–40)** — consecutive days with at least one intake log or
  goal-hit.

The agent also **adjusts your daily target** based on activity (more exercise
= more water) and climate (hot/humid days = more water), so a streak-day in
August isn't the same as one in December.

## What lifts this pillar

**Easy wins:**
- Glass of water when you wake up (before coffee).
- Bottle at your desk — refill 3x/day.
- Water before each meal (also lifts Nutrition).
- Track for a week so you know your actual baseline.

**Intermediate:**
- Electrolytes on long exercise days or in heat.
- Reduce caffeine after noon — it's a diuretic that compounds with undersleep.
- Drink 500ml 30 min before workouts.
- Connect a smart bottle or Apple Health.

**Advanced:**
- Time your fluid intake around circadian rhythm (front-load the day, taper
  by evening so sleep isn't interrupted).
- Balance sodium/potassium during heavy training blocks.
- Use urine colour + morning weight as personal signals.

## The longevity science in plain language

- **Cellular water content declines with age**. Habitual hydration is one of
  the few levers that slows this.
- **Chronic mild dehydration** is associated with higher markers of biological
  ageing (see serum sodium in the NIH longevity cohort data).
- **Kidney function** depends on consistent fluid intake — and kidney
  decline is one of the silent accelerators of cardiovascular risk.
- **Brain performance** drops measurably at ~2% dehydration. Most people walk
  around at 1–3%.

The trick isn't drinking gallons — it's steady, sufficient, all-day intake,
adjusted for what your body is actually doing.

## What the Hydration agent watches for you (coming in Phase F)

- Recalculates your target daily based on yesterday's exercise + today's
  weather.
- Detects under-hydration patterns from Exercise/Sleep data (e.g., elevated
  morning HR often = dehydration).
- Connects smart bottles and health apps as you grant permission.
- Suggests when to add electrolytes, when to pull back.

## Relationship to the other pillars

- Hydration ↔ **Exercise**: dehydrated training = poor recovery, higher
  injury risk, blunted adaptation.
- Hydration ↔ **Sleep**: too little = cramps and dry mouth; too late =
  disrupted sleep. Front-load the day.
- Hydration ↔ **Nutrition**: mistaken thirst causes snacking.
- Hydration ↔ **Mental**: brain fog and irritability often resolve with
  water alone.

Hydration is the quiet multiplier — strong hydration makes every other pillar
perform better.
$CONTENT$
);

-- ===========================================================================
-- Chapter 3 — Exercise
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Exercise',
  p_path  := 'kb/vitana-system/index-book/03-exercise.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','exercise','five-pillars','maxina'],
  p_content := $CONTENT$
# Exercise — the third pillar

Exercise is the closest thing to a longevity drug we have. Every form of
movement — walking, lifting, yoga, sport — stacks benefits for the brain,
heart, bones, and mood. The Exercise pillar tracks how consistently your body
gets to do what bodies are built for.

## What the Exercise pillar measures

Max 200 points:

- **Baseline (0–40)** — onboarding self-rating. *"How active has your body
  been this week?"*
- **Action completions (0–80)** — completed actions tagged `movement`,
  `workout`, `walk`, or `steps`. Each counts for 4–8 points.
- **Connected data (0–40)** — wearable signals (steps, heart rate, workouts,
  VO2-max estimates) from Apple Health, Google Fit, Strava, Whoop, Oura,
  Garmin, Fitbit.
- **Streak bonus (0–40)** — consecutive days with at least one qualifying
  movement event.

Not all exercise is created equal — the agent (Phase F) distinguishes between
zone-1 walks, zone-2 cardio, resistance training, and HIIT, and weights them
based on what your whole practice needs.

## What lifts this pillar

**Easy wins:**
- 20-minute walk most days.
- Take stairs, not elevators.
- One strength session a week (even bodyweight counts).
- 5-minute morning mobility routine.

**Intermediate:**
- 150 min/week of zone-2 cardio (brisk walking, light jogging, cycling).
- Two resistance sessions a week.
- Track a workout app.
- Connect a wearable.

**Advanced:**
- 3–4 strength sessions + 2–3 cardio sessions per week, structured.
- Heart-rate zone tracking — keep most volume in zone 2.
- VO2-max workouts 1x/week (hard interval day).
- Recovery monitoring via HRV — push when ready, rest when not.

## The longevity science in plain language

- **Cardio fitness (VO2 max)** is the strongest single predictor of all-cause
  mortality — stronger than smoking, blood pressure, or diabetes.
- **Strength and muscle mass** after age 30 predict independence, fall risk,
  and metabolic health at 70.
- **Zone-2 training** (conversational pace, 2–3+ hours a week) builds
  mitochondrial density — the engine of durability.
- **Movement breaks** throughout a sedentary day undo much of the damage
  of sitting.
- **The dose-response curve** flattens around 7–8 hours/week — you don't
  have to be an athlete; you have to be consistent.

## What the Exercise agent watches for you (coming in Phase F)

- Ingests every wearable signal you grant access to.
- Builds your personal training pattern and flags imbalances (all cardio and
  no strength, all strength and no cardio).
- Watches HRV for readiness; suggests hard days vs. recovery days.
- Correlates your performance with sleep + nutrition — tells you *why* today
  felt heavy.

## Relationship to the other pillars

- Exercise ↔ **Sleep**: the biggest sleep-quality lift comes from regular
  exercise (but not too close to bed).
- Exercise ↔ **Nutrition**: under-fueled training = burnout, over-fueled =
  weight gain without adaptation. They have to match.
- Exercise ↔ **Hydration**: 500ml pre-workout, electrolytes for anything
  over 60 min.
- Exercise ↔ **Mental**: 30 minutes of moderate exercise has antidepressant
  effects comparable to SSRIs in multiple trials.

Exercise without sleep is self-harm. Exercise with good sleep is a miracle
drug.
$CONTENT$
);

-- ===========================================================================
-- Chapter 4 — Sleep
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Sleep',
  p_path  := 'kb/vitana-system/index-book/04-sleep.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','sleep','five-pillars','maxina'],
  p_content := $CONTENT$
# Sleep — the fourth pillar

Sleep is where the body rebuilds. Every pillar depends on it. A lifetime of
under-sleep is a lifetime of accelerated ageing — and most people run on far
less than they need, convinced they're fine. They're not. The Sleep pillar of
the Vitana Index tracks the recovery half of your practice.

## What the Sleep pillar measures

Max 200 points:

- **Baseline (0–40)** — onboarding self-rating. *"How rested do you feel when
  you wake up?"*
- **Action completions (0–80)** — actions tagged `sleep`, `rest`, or
  `recovery`. Setting a bedtime, a wind-down routine, a sleep-hygiene review.
- **Connected data (0–40)** — wearable sleep tracking (Oura, Whoop, Apple
  Sleep, Eight Sleep, Fitbit, Garmin). Duration, stages, HRV, regularity.
- **Streak bonus (0–40)** — consecutive days with sleep data that meets your
  personal target (not one fixed number — adjusted for you).

## What lifts this pillar

**Easy wins:**
- Same bedtime, 7 days a week (regularity matters more than duration for most
  people).
- No screens for 30 minutes before sleep.
- Bedroom cool and dark.
- Daylight within 30 min of waking — the single most effective circadian
  anchor.

**Intermediate:**
- Track sleep for two weeks; see the pattern.
- Cut caffeine after 2pm (caffeine half-life is 5–7 hours).
- Alcohol wrecks REM — experiment with two weeks off and watch the data.
- Connect a wearable.

**Advanced:**
- Aim for 85%+ sleep efficiency and consistent sleep-stage distribution.
- Use HRV trends to catch under-recovery before it catches you.
- Bedroom temperature 18–19°C for most people.
- Address sleep apnea risk (snoring + daytime fatigue — see a doctor).

## The longevity science in plain language

- **Sleep duration under 6 hours** chronically is linked to 20–30% higher
  all-cause mortality in longitudinal cohorts.
- **Regularity beats duration** for most biomarker outcomes. An unpredictable
  8-hour sleeper may fare worse than a steady 7-hour one.
- **Deep sleep** clears glymphatic waste — including the proteins involved
  in Alzheimer's. Under-sleeping is neurologically corrosive.
- **REM sleep** consolidates emotional processing; chronic REM deficit shows
  up as anxiety and mood instability.
- **Evening light + screens** suppress melatonin. Dim the environment.

## What the Sleep agent watches for you (coming in Phase F)

- Pulls data from Oura / Whoop / Apple Sleep / Eight Sleep / Fitbit as you
  connect.
- Builds your personal sleep fingerprint — target time, stages, HRV.
- Flags trends, not single nights (one bad night is fine; three in a row is
  a signal).
- Suggests bedtime-routine experiments based on your actual data.
- Correlates sleep with Exercise, Nutrition, Mental — tells you the story,
  not just the numbers.

## Relationship to the other pillars

- Sleep ↔ **Exercise**: exercise improves sleep; poor sleep tanks exercise.
  A tight two-way loop.
- Sleep ↔ **Nutrition**: late meals and alcohol wreck sleep architecture.
  Caffeine timing matters.
- Sleep ↔ **Mental**: sleep debt is the fastest path to anxiety and
  depression — resolving under-sleep resolves a surprising amount of mental
  distress.
- Sleep ↔ **Hydration**: too much fluid late = broken sleep; chronic
  under-hydration = cramps and grogginess.

If you improve only one pillar in your first 90 days, make it Sleep. Every
other pillar gets easier.
$CONTENT$
);

-- ===========================================================================
-- Chapter 5 — Mental
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Mental health',
  p_path  := 'kb/vitana-system/index-book/05-mental.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','mental','mental-health','five-pillars','maxina'],
  p_content := $CONTENT$
# Mental health — the fifth pillar

Your mind is the operator of the other four pillars. A stressed mind chooses
worse food, skips the workout, stays up too late, forgets to drink. A calm
mind makes every other practice easier. The Mental pillar tracks the state of
your inner life — how well your nervous system is regulated, how much
resilience you're building, how often your thinking helps or hurts you.

## What the Mental pillar measures

Max 200 points:

- **Baseline (0–40)** — onboarding self-rating. *"How clear and calm is your
  mind today?"*
- **Action completions (0–80)** — actions tagged `mindfulness`, `mental`,
  `stress`, `meditation`, `learning`, or `journal`. Diary entries, breathwork,
  meditation, reading, cognitive tasks.
- **Connected data (0–40)** — HRV (from Oura / Whoop / Apple / Garmin), mood
  logs, meditation app data (Calm, Headspace), community-social signals.
- **Streak bonus (0–40)** — consecutive days with at least one mindfulness,
  journal, or mood-check action.

## What lifts this pillar

**Easy wins:**
- 3 minutes of slow breathing, once a day.
- Write down 3 things that went well at the end of the day.
- One walk without your phone.
- One real conversation with a friend each day.

**Intermediate:**
- A daily 10-minute meditation — any form, any app.
- Morning pages / journaling — unfiltered, first thing.
- Time in nature each week.
- Connect HRV tracking so you can see stress patterns.

**Advanced:**
- Longer meditation practice + retreat a couple of times a year.
- Therapy — best-evidence mental health lever after sleep and exercise.
- Psychometric tracking over months (mood scales, resilience measures).
- Cold exposure / heat exposure as nervous-system training (where medically
  safe).

## The longevity science in plain language

- **Chronic stress** accelerates biological ageing via cortisol, inflammation,
  and mitochondrial dysfunction.
- **Social connection** is one of the strongest longevity predictors — the
  Harvard Adult Development Study ran for 80+ years and the findings come
  back to relationships.
- **Sense of purpose** correlates with longer healthspan, independent of
  income, education, and health.
- **Meditation** measurably changes brain structure over 8+ weeks —
  grey-matter density in regions associated with attention and emotional
  regulation.
- **Cognitive load management** — rest between tasks, single-tasking —
  preserves executive function into old age.

## What the Mental agent watches for you (coming in Phase F)

- Reads your diary entries and extracts mood + themes (with your permission).
- Watches HRV for early stress-trend signals.
- Suggests the right action for *your* current state — a 3-minute breath when
  you're frazzled, a walk when you're flat, a rest when you're depleted.
- Correlates mental state with Sleep + Exercise data — shows the real drivers.
- Connects to Calm / Headspace / mood-tracking apps you use.

## Relationship to the other pillars

- Mental ↔ **Sleep**: bidirectional. Anxiety destroys sleep. Sleep debt causes
  anxiety.
- Mental ↔ **Exercise**: movement is a mood regulator — 30 minutes of moderate
  exercise rivals SSRIs in multiple trials for mild-to-moderate depression.
- Mental ↔ **Nutrition**: the gut–brain axis is real. Ultra-processed diets
  correlate with depression risk.
- Mental ↔ **Hydration**: most "brain fog" is dehydration. Drink water first,
  then panic.

Mental health isn't a separate thing from physical health — it is the
orchestra conductor of physical health. Treat it as first among equals.
$CONTENT$
);

-- ===========================================================================
-- Chapter 6 — Balance
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Balance',
  p_path  := 'kb/vitana-system/index-book/06-balance.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','balance','five-pillars','maxina'],
  p_content := $CONTENT$
# Balance — why a high number alone isn't enough

The Vitana Index is not a score that rewards obsession. You can't game it by
grinding one pillar and ignoring the rest. The longevity concept is built on
the **interdependence** of five pillars, and the Index applies a balance
factor that reflects this.

## The balance factor, in plain language

After summing your five pillar scores, the system looks at how far apart they
are. If your weakest pillar is close to your strongest pillar, that is a
**balanced** practice — and the Index treats your total at its full value. If
one pillar is way below the others, you get a **dampened** total: the system
assumes the weak pillar will drag the rest down over time, and reflects that
honestly.

## The exact rule

```
ratio = min_pillar / max_pillar

balance_factor =
  1.00   if ratio >= 0.70    (well balanced)
  0.90   if 0.50 ≤ ratio < 0.70
  0.80   if 0.30 ≤ ratio < 0.50
  0.70   if ratio < 0.30     (seriously unbalanced)

score_total = round(sum_of_pillars × balance_factor), capped at 999
```

## Examples

**User A: 150 / 140 / 150 / 130 / 160**
- sum = 730
- min/max = 130/160 = 0.81 → factor 1.00
- Index = **730**. Balanced practice; full credit.

**User B: 200 / 80 / 200 / 60 / 150**
- sum = 690 (similar raw total)
- min/max = 60/200 = 0.30 → factor 0.80
- Index = round(690 × 0.80) = **552**.
- The system tells User B: *"Your exercise and nutrition are peaking but your
  sleep and hydration are tanking. Close the gap before you push harder."*

**User C: 190 / 190 / 190 / 190 / 180**
- sum = 940
- min/max = 180/190 = 0.95 → factor 1.00
- Index = **940**. Elite territory — all five are strong.

## Why we do this

Because **that's what longevity science actually says**. People who optimise
one axis and ignore the rest die at the same rates as people who do nothing.
An athlete who skips sleep doesn't outlive a couch-sitter with good sleep.
The Vitana Index refuses to reward half-practices.

## What to do when you see your balance factor drop

Open the Index Detail Screen. Find the pillar with the lowest score. Ask the
Assistant *"what's the cheapest thing I can do today to lift my [pillar]
score?"* — the relevant pillar agent (Phase F) will give you a concrete next
action from your calendar or an Autopilot recommendation.

One action on your weakest pillar, today. That's how the balance factor
climbs.

## Balance chip on the Index Detail Screen

You'll see a small chip near your pillar bars: **Balance: 1.0×** or
**Balance: 0.8×** etc. Tap it, and the Assistant explains (using this chapter)
what your current ratio is and which pillar is pulling the average down.

## The bigger picture

Balance is not about being mediocre at everything. It is about making sure
the five foundations of a long life are all **sufficiently** in place before
you push any one of them to extremes. Strength doesn't compensate for poor
sleep. Perfect nutrition doesn't compensate for chronic stress. The Vitana
Index — via the balance factor — keeps you honest.
$CONTENT$
);
