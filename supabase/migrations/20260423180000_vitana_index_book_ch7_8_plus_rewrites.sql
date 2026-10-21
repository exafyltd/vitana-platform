-- =============================================================================
-- Book of the Vitana Index — chapters 7 & 8 + rewrite of stale Phase-D docs
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (step 7)
--
-- Adds the two remaining Book chapters:
--   07-the-90-day-journey.md   — how the journey's calendar waves target
--                                each pillar and lift the Index
--   08-reading-your-number.md  — tier framing, what a +10/+50/+100 means,
--                                how to interpret a drop, the "compass not
--                                verdict" principle
--
-- Rewrites the older Phase-D docs that predated the 5-pillar correction
-- and the v3 scoring model. They now point to the Book chapters so the
-- retrieval-router serves a consistent story:
--   vitana-index-explained.md       — pointer to index-book/00 + 06
--   90-day-journey-and-your-index.md — pointer to index-book/07
--   autopilot-and-your-index.md     — updated to the v3 contribution_vector
--                                      model (still user-facing)
--   how-maxina-tracks-your-progress.md — high-level umbrella, updated copy
--
-- Idempotent: upsert_knowledge_doc() is upsert-by-path.
-- =============================================================================

-- ===========================================================================
-- Chapter 7 — The 90-day journey
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — The 90-day journey',
  p_path  := 'kb/vitana-system/index-book/07-the-90-day-journey.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','journey','90-day','calendar','autopilot','maxina'],
  p_content := $CONTENT$
# The 90-day journey — how your calendar lifts your Index

When you register for Vitana, Maxina puts a 90-day wellness journey on
your calendar automatically. This is the default, concrete starting
plan. Every event on that calendar is a small, specific action. Every
action you complete nudges your Vitana Index upward.

## Why 90 days

90 days is the shortest window where real habit change shows up in the
body *and* in the numbers. Too short (14 or 30 days) and the signal is
noise — you've just had a good week. Too long (6 months) and the arc
becomes abstract; people disengage. 90 days is enough to form two to
three stable habits per pillar and enough for the Index to swing by
hundreds of points if you push.

## The journey targets all five pillars

The calendar is seeded with actions across **Nutrition, Hydration,
Exercise, Sleep, and Mental health** — deliberately. Because the five
pillars are interdependent, a journey that only exercises you while
ignoring your sleep would sabotage the whole number (the balance factor
dampens a lopsided score — see the Balance chapter).

A typical day in the journey might contain:
- A 10-minute walk (Exercise)
- Logging a meal (Nutrition)
- A hydration check-in (Hydration)
- A wind-down routine (Sleep)
- A short breathing practice or journal entry (Mental)

Not every day hits every pillar. The goal is to touch each one
*regularly* — aim for three to four times per week per pillar — not
every single day.

## How a completed event lifts the Index

Every event on your calendar has `wellness_tags`. When you mark it
complete, the Index recompute runs within seconds. Tags map to pillars
like this:

| Tags | Pillar they feed |
|---|---|
| `nutrition`, `meal`, `food-log` | Nutrition |
| `hydration`, `water` | Hydration |
| `movement`, `workout`, `walk`, `steps`, `exercise` | Exercise |
| `sleep`, `rest`, `recovery` | Sleep |
| `mindfulness`, `mental`, `stress`, `meditation`, `learning`, `journal` | Mental |

Each completion tagged for a pillar adds **6 points** to that pillar's
completion sub-score (capped at 80 per pillar). Unmapped tags like
`onboarding` or `community` don't target any single pillar — they
instead drop a small "halo" bump of +1 to all five (a community gathering
is gently good for everything).

## Streak bonuses

A completion or data point on a pillar, repeated on consecutive days,
builds a streak:

- 7 days → +15 points streak bonus on that pillar
- 14 days → +25
- 30 days → +40

The streak bonus is separate from the completion sub-score. So a 30-day
walking streak gives you 30 days × up to 6 points of completion-score
**plus** a +40 streak bonus on Exercise. Consistency compounds.

## Personalizing the journey

The default calendar package is a starting point. You can:
- **Skip an event** — it does nothing to the Index (no penalty).
- **Complete an event** — it lifts the pillar it targets.
- **Reschedule** an event into a different time slot — it still counts
  when completed.
- **Add your own events** — give them wellness_tags and they'll feed
  the relevant pillar when you complete them.
- Over time, the Autopilot engine learns what you complete and what you
  skip, and tunes the next wave of suggestions.

## What happens on day 91

The Index continues to compute daily on real signals — completions,
data, streaks — well after the 90-day banner comes down. The journey
framework was the onboarding vehicle; the practice (and the number)
keep going for as long as you do.

## Where to see your journey

- **Calendar** (`/autopilot`) — all the seeded events.
- **Autopilot popup** on every screen — the next-action surface; each
  action shows which pillars it's about to lift.
- **Index Detail** (`/health/vitana-index`) — the stacked pillar bars
  show, per pillar, how much of your score comes from completions vs.
  baseline / data / streak. When the blue (completions) segment grows,
  the journey is working.

For specific pillars, see chapters 01–05. For how the total number is
computed and why balance matters, see chapter 06. For how to read your
number in practice, see chapter 08.
$CONTENT$
);

-- ===========================================================================
-- Chapter 8 — Reading your number
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Reading your number',
  p_path  := 'kb/vitana-system/index-book/08-reading-your-number.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','tiers','interpretation','maxina'],
  p_content := $CONTENT$
# Reading your number — what your Vitana Index actually means

Your Index is a compass, not a verdict. Read it like a practitioner:
track trend over time, not the absolute value on any single day.

## The six tiers, in plain language

| Range | Tier | What it says |
|---|---|---|
| 0–99 | Starting | "You've begun. Five pillars, 90 days — let's go." |
| 100–299 | Early | "Baseline established. Every completion counts now." |
| 300–499 | Building | "Habits are forming. Keep the balance across all five." |
| 500–599 | Strong | "This is where most people land after a real 90-day push." |
| 600–799 | Really good | "Your practice is working. This is the 'thriving' zone." |
| 800–999 | Elite | "Sustained excellence across all five pillars. Rare and earned." |

**We never frame these as pass/fail.** Different lives have different
capacities — time, health, circumstance. A 500 for a busy parent who
shows up three days a week is worth more than a 700 from someone with
unlimited leisure. The tier tells you the zone you're in, not whether
you're "good enough."

## What a move of +10 means

A **+10** in a day is usually one of:
- One meaningful completion (+6 on its pillar) plus a small halo bump
- A new 7-day streak just crossed (+15 streak bonus — but balance factor
  might dampen the total if it was only on one pillar)
- A wearable was connected for the first time (connected-data jumps)

Don't celebrate +10 on a single day. Celebrate a **7-day moving
average** that keeps climbing.

## What a move of +50 over a week means

You're a week into a real practice. Completions are stacking up (roughly
8–10 completions across the five pillars), streaks are starting to
trigger on at least one pillar, maybe a data source just came online.
This is the *building* motion — you're doing it.

## What a move of +100 over a month means

You've moved up a full tier. Four weeks of consistent 4-a-week practice
across multiple pillars, likely one streak sustained and connected data
on at least one pillar. That's a meaningful shift — both the number and
your actual body feel different.

## What if the number drops

The Index can drop. Reasons:
- **A streak broke.** One day gap ≠ disaster, but seven days gap =
  streak bonus resets from 40 → 0 on that pillar.
- **The balance factor dropped.** You invested a lot into one pillar
  and neglected another; the weakest pillar now drags the total.
- **Data stopped flowing.** A wearable stopped syncing or a biomarker
  import expired. Connected-data sub-score decays when data ages out
  past 7 days.

A drop is information, not failure. Open the Index Detail Screen, look
at the sub-score stacks, find what moved. Fix the one thing.

## How to read the sub-score stacks

On the Index Detail Screen, each pillar shows a coloured stack:

- **Slate (baseline)**: fixed by your onboarding survey. Doesn't move
  unless you retake the survey. Max 40.
- **Blue (completions)**: recent 30 days of journey actions. Grows with
  each completion; decays as old completions age out. Max 80.
- **Green (connected data)**: wearables, food logs, lab imports. Grows
  when you connect a source; decays if data stops flowing. Max 40.
- **Amber (streak)**: consecutive days with signal on this pillar.
  Snaps to 0 when you miss a day (streak reset). Max 40.

A thin slate-only bar means baseline only — no real practice yet.
A wide blue + amber stack means the journey is working.
A wide green stack means you've got strong data feeding the pillar.

## What to do if your weakest pillar is pulling the average

Open the Detail Screen. Find the lowest pillar. Ask Maxina:

> "What's one thing I can do today for my [pillar] score?"

She'll pull the next Autopilot recommendation whose contribution_vector
targets that pillar. Do that one thing. The balance factor will close
the gap faster than piling more on your strongest pillar.

## The 7-day moving average

A single day's number can bounce by ±20 points for reasons outside your
control (a wearable didn't sync, a backend recompute was deferred, you
logged one extra meal). **Read the 7-day sparkline, not the absolute
value.** If the sparkline trends up, the practice is working. If it
trends flat, the practice is maintaining. If it trends down for more
than a week, something needs attention.

## The honest truth

Most people, doing real work, end a focused 90-day push somewhere in
**Strong (500–599)** or low **Really good (600–700)**. Getting above
800 takes multi-month sustained practice with good data and consistent
streaks on at least four pillars. Getting above 900 is elite.

The number doesn't reward obsession, it rewards balance. Keep all five
pillars moving, keep the streaks alive, and the Index rises itself.
$CONTENT$
);

-- ===========================================================================
-- Rewrite: vitana-index-explained.md
-- Older Phase-D doc — pointer to Book chapters 00 and 06.
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Vitana Index — what it is and how it moves',
  p_path  := 'kb/vitana-system/vitana-index-explained.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','overview','maxina'],
  p_content := $CONTENT$
# Vitana Index — what it is and how it moves

Your Vitana Index is a single number between 0 and 999 that tracks how
your daily practice is compounding into a long, healthy life. It is
built on **five pillars** — Nutrition, Hydration, Exercise, Sleep,
Mental health — which are interdependent; balance across the five
matters more than peaking on one.

For the full picture, see the **Book of the Vitana Index**:

- [Overview](kb/vitana-system/index-book/00-overview.md) — the five
  pillars, the 90-day arc, how numbers grow, the tier ladder.
- [Nutrition](kb/vitana-system/index-book/01-nutrition.md) — what lifts
  the Nutrition pillar, the science, the agent roadmap.
- [Hydration](kb/vitana-system/index-book/02-hydration.md)
- [Exercise](kb/vitana-system/index-book/03-exercise.md)
- [Sleep](kb/vitana-system/index-book/04-sleep.md)
- [Mental health](kb/vitana-system/index-book/05-mental.md)
- [Balance](kb/vitana-system/index-book/06-balance.md) — why the Index
  dampens when pillars are lopsided.
- [The 90-day journey](kb/vitana-system/index-book/07-the-90-day-journey.md)
- [Reading your number](kb/vitana-system/index-book/08-reading-your-number.md)

## Quick summary

Each pillar (max 200) is the sum of four sub-scores:

| Component | Max | How it grows |
|---|---|---|
| Baseline survey | 40 | You tell us how you're doing — once, during onboarding |
| Action completions | 80 | Doing the actions the 90-day journey suggests |
| Connected data | 40 | Wearables, food logs, lab reports |
| Streak bonus | 40 | Consistency — showing up day after day |

Sum the five pillars (0–1000 raw), apply a balance factor (0.7–1.0
depending on how lopsided the pillars are), cap at 999.

## The tiers, honestly

| Range | Tier |
|---|---|
| 0–99 | Starting |
| 100–299 | Early |
| 300–499 | Building |
| 500–599 | Strong |
| 600–799 | Really good |
| 800–999 | Elite |

Most focused 90-day pushes end in **Strong** or low **Really good**.
Above 800 is multi-month sustained practice. The Index is a compass,
not a verdict — we never force anyone to the top.
$CONTENT$
);

-- ===========================================================================
-- Rewrite: 90-day-journey-and-your-index.md
-- Now a pointer to Book chapter 07.
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := '90-day Maxina journey — the route to a higher Index',
  p_path  := 'kb/vitana-system/90-day-journey-and-your-index.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','90-day-journey','calendar','maxina'],
  p_content := $CONTENT$
# 90-day Maxina journey — the route to a higher Index

When you register, Maxina puts a 90-day wellness journey on your
calendar automatically. Every completion on that calendar lifts one or
more of the five Vitana Index pillars (Nutrition, Hydration, Exercise,
Sleep, Mental).

For the full chapter — why 90 days, how completions map to pillars, the
tag→pillar table, streak bonuses, how to personalise — see:

**[Book of the Vitana Index — The 90-day journey](kb/vitana-system/index-book/07-the-90-day-journey.md)**

For how to read your number as it moves:

**[Book of the Vitana Index — Reading your number](kb/vitana-system/index-book/08-reading-your-number.md)**
$CONTENT$
);

-- ===========================================================================
-- Rewrite: autopilot-and-your-index.md
-- Updated to the v3 contribution_vector model.
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Autopilot — why items appear and how they lift your Index',
  p_path  := 'kb/vitana-system/autopilot-and-your-index.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','autopilot','calendar','maxina'],
  p_content := $CONTENT$
# Autopilot — why items appear and how they lift your Index

Autopilot is the engine that puts the right next action in front of you
at the right moment. It lives behind the airplane icon in every screen's
header. A badge counts the actions waiting for you; a tap opens the
popup; you choose which to activate.

## Where actions come from

Autopilot pulls recommendations from several analyzers watching your
state:

- **Community analyzer** — social and journey engagement actions
  appropriate for where you are in the 90-day journey.
- **Personalization analyzer** — spots your weakest Index pillar and
  suggests an action that lifts exactly that pillar.
- **D43 drift engine** — notices when a habit has slipped and proposes
  a gentle restart.
- **Journey mapper** — surfaces the next wave milestone at the right
  moment.

## Every action carries a contribution vector

When Autopilot proposes an action, a `contribution_vector` is attached
declaring how many points it's expected to lift each of the five
pillars — e.g., `{ exercise: 6 }` for a movement action, or
`{ mental: 4 }` for a meditation. This is shown on the action card as
pill badges: **[Exercise +6]**, **[Mental +4]**.

The contribution_vector is auto-populated on every Autopilot
recommendation from a canonical `source_ref → pillars` map that mirrors
the tag→pillar map used by the Index compute engine — so Autopilot and
the calendar are always in sync on what moves each pillar.

## From activation to calendar to Index

When you activate an Autopilot action, three things happen:

1. **Calendar event created.** A new entry appears on your calendar at
   the next appropriate slot (morning / afternoon / evening based on
   the action type and your completion history), tagged with the
   action's `wellness_tags`.
2. **Reminder + nudge.** You get a reminder at the scheduled time; the
   Assistant can help you reshape the event via natural language
   ("move my walk to 5pm").
3. **Completion lifts the Index.** When you mark the event done, the
   calendar trigger fires the Index recompute. The pillar the event
   targets rises within seconds — typically by 6 points per completion,
   plus any streak bonus that just clicked in.

## The Priority Action card

On the Health screen, the Priority Action card shows your weakest
pillar and a recommendation whose contribution_vector has a positive
value on that pillar. It's the single best thing you could do *right
now* to raise your Index the fastest — not by piling on your strongest
pillar, but by closing the gap on the weakest (the balance factor
rewards that).

## Respecting you

You're always in control:

- **Dismiss** an action → silenced for 24 hours (or longer if you set
  the dismissal scope).
- **"Not today"** → proactive nudges pause until tomorrow.
- **"Don't mention X again"** → that category is muted until you lift
  it.

## See also

- [Book of the Vitana Index — The 90-day journey](kb/vitana-system/index-book/07-the-90-day-journey.md)
- [Book of the Vitana Index — Reading your number](kb/vitana-system/index-book/08-reading-your-number.md)
- [Book of the Vitana Index — Balance](kb/vitana-system/index-book/06-balance.md)
$CONTENT$
);

-- ===========================================================================
-- Rewrite: how-maxina-tracks-your-progress.md
-- High-level umbrella — updated copy.
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How Maxina tracks your progress — the full picture',
  p_path  := 'kb/vitana-system/how-maxina-tracks-your-progress.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','five-pillars','autopilot','calendar','maxina','onboarding'],
  p_content := $CONTENT$
# How Maxina tracks your progress — the full picture

Maxina's job is to improve your quality of life and help you live
longer, healthier, more fulfilled. The way she tracks whether she's
doing that is deliberately simple:

- **One number** — your Vitana Index (0–999).
- **One model** — the five pillars: Nutrition, Hydration, Exercise,
  Sleep, Mental. Balance across all five matters more than peaking
  on any one.
- **One route** — your 90-day Maxina journey on the calendar.
- **One day-level plan** — your Calendar.
- **One nudge engine** — Autopilot.

Everything else is in service of those five elements.

## The loop

```
You register
   ↓
Maxina pre-populates 90-day calendar (≈30 events across all 5 pillars)
   ↓
First visit to Health → 5-question baseline survey → Day-0 Index
   ↓
Every day: Autopilot surfaces the next best action
   ↓
You activate → calendar event created
   ↓
You complete → DB trigger fires Index recompute
   ↓
Index climbs → trajectory visible on the Detail Screen
   ↓
Day 90 → you review the climb (starting Index vs. today, which
   pillars moved most, which pillar still needs attention)
```

## Why five pillars, in harmony

The longevity science is clear: you cannot optimise one axis of health
and ignore the rest. Great exercise with bad sleep ages you faster.
Good nutrition with chronic stress doesn't protect you. The Vitana
Index reflects this by applying a **balance factor** — if your weakest
pillar is far behind your strongest, your total gets dampened (0.7× to
0.9× instead of 1.0×). The only way to climb is to keep all five
moving.

## The tiers, briefly

| Range | Tier |
|---|---|
| 0–99 | Starting |
| 100–299 | Early |
| 300–499 | Building |
| 500–599 | Strong |
| 600–799 | Really good |
| 800–999 | Elite |

We never force anyone to the top. Different lives, different
capacities. The number is a compass, not a verdict.

## Deeper reading — the Book of the Vitana Index

The canonical docs live in the `vitana_system` namespace and are
surfaced automatically by the Assistant when you ask meta-questions
like *"how does the Index work?"* or *"what does 600 mean?"*:

- [Overview](kb/vitana-system/index-book/00-overview.md)
- [Nutrition](kb/vitana-system/index-book/01-nutrition.md) · [Hydration](kb/vitana-system/index-book/02-hydration.md) · [Exercise](kb/vitana-system/index-book/03-exercise.md) · [Sleep](kb/vitana-system/index-book/04-sleep.md) · [Mental](kb/vitana-system/index-book/05-mental.md)
- [Balance](kb/vitana-system/index-book/06-balance.md)
- [The 90-day journey](kb/vitana-system/index-book/07-the-90-day-journey.md)
- [Reading your number](kb/vitana-system/index-book/08-reading-your-number.md)

In a later phase, five specialised **pillar agents** (one per pillar)
will continuously improve the signals feeding the Index and surface
personalised suggestions. That's documented in chapter 10 (landing with
Phase F — pillar agents).
$CONTENT$
);
