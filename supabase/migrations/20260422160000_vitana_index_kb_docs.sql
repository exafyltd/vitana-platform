-- =============================================================================
-- Vitana Index onboarding — Knowledge Hub seed (vitana_system namespace)
-- Date: 2026-04-22
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (Phase D)
--
-- Seeds the user-facing documentation that ties the Vitana Index, the 90-day
-- Maxina journey, the Calendar, and the Autopilot into one coherent story
-- the Assistant can retrieve and quote when asked "how does my Index work?"
-- or "how do I level up?". All docs are tagged `vitana_system` so they flow
-- through the priority-100 retrieval rule in retrieval-router.ts.
--
-- Idempotent via upsert_knowledge_doc() — safe to re-run when docs are
-- revised.
-- =============================================================================

-- ===========================================================================
-- DOC 1 — Vitana Index explained (the anchor doc)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Vitana Index — what it is and how it moves',
  p_path  := 'kb/vitana-system/vitana-index-explained.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','longevity','onboarding','maxina'],
  p_content := $CONTENT$
# Vitana Index — what it is and how it moves

Your Vitana Index is a single number between 0 and 999 that answers one
question: **how well is today compounding into a longer, healthier,
more fulfilling life?**

The higher the number, the more your daily behaviour is aligned with
longevity. The lower the number, the more the system has to suggest to
lift you back on track. It is the one score you can keep in your eye
across every screen in Maxina and Vitana.

## The six pillars

Your Index is the weighted sum of six pillars, each scored 0–200:

1. **Physical** — Movement, heart rate, sleep and recovery signals.
2. **Mental** — Stress, mindfulness, cognitive load and mood.
3. **Nutritional** — Glucose, hydration, macro balance and meal timing.
4. **Social** — Relationships, community engagement, connection quality.
5. **Environmental** — Time outdoors, living-space quality, exposure.
6. **Prosperity** — Business progress, marketplace activity, rewards.

At launch, Physical / Mental / Nutritional read real data from your
wearables and lab results. Social, Environmental and Prosperity start at
a neutral baseline and will read their own signal sources as each feature
area lands (Proactive Guide phase 1a–1c).

## The tiers

| Range | Tier | Meaning |
|---|---|---|
| 0–99 | Very Poor | Significant concerns across multiple pillars |
| 100–299 | Poor | Below optimal — real room to grow |
| 300–499 | Fair | Moderate well-being, mixed signals |
| 500–699 | Improving | Good progress toward optimal |
| 700–849 | Good | Strong well-being across most pillars |
| 850–999 | Excellent | Exceptional optimisation |

Your Maxina 90-day goal by default is **Good (600+)** — we aim to lift
your Index into that band within your first 90 days.

## Where you see it

- **Every screen header** — the circle badge with your current number
  (tap it for the full Index Detail Screen).
- **Health section** — the full breakdown by pillar, with 7-day trend.
- **My Journey (`/autopilot`)** — your trajectory across the 90-day
  timeline, pillar-by-pillar.
- **Autopilot popup** — each suggested action shows which pillars it
  lifts and by how much.

## How it moves

Your Index recomputes daily and incrementally whenever you complete an
action. Three things push it up:

1. **Completing Autopilot actions** — each action declares a
   contribution vector (e.g., a 30-minute walk = `Physical +3 Mental +1`).
   When you mark it done on your calendar, that contribution lands.
2. **Fresh data arriving** — wearable syncs, lab reports and community
   signals update the pillar readings the Index is built from.
3. **Habit consistency** — long streaks of a positive signal compound
   faster than one-off spikes.

Two things can hold it back:

1. **Missing data** — if we can't read your wearable, Physical stays at
   a conservative baseline. Connect devices to let the Index see you.
2. **Declining pillar signals** — if your sleep or stress drifts, the
   pillar will drift with it. The Proactive Guide notices and surfaces
   an action that targets exactly that pillar.

## The Day-0 baseline survey

On your very first visit to the Health screen, Maxina asks three quick
self-rating questions (physical, mental, nutritional). Those answers seed
a confidence-0.5 baseline so you're never staring at an empty score. As
your real data arrives over the following days, the baseline gives way
to real signals.

## How the Assistant uses your Index

When you talk to Maxina, she always knows your current Index, your
weakest pillar, and your 90-day trajectory. When you ask a question, she
frames recommendations in terms of which pillar to lift next — not
abstractly, but concretely: "Your Physical dropped 12 points this week —
want me to put a 20-minute walk on tomorrow morning?"

## Privacy

Your Index is yours. It is never shared outside your tenant. Community
aggregates (later phases) use only anonymous tier distributions and
never reveal individual scores.
$CONTENT$
);


-- ===========================================================================
-- DOC 2 — 90-day journey and your Index
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := '90-day Maxina journey — the route to a higher Index',
  p_path  := 'kb/vitana-system/90-day-journey-and-your-index.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','90-day-journey','autopilot','calendar','maxina'],
  p_content := $CONTENT$
# 90-day Maxina journey — the route to a higher Index

When you register for Vitana, Maxina pre-populates your calendar with
roughly 30 wellness events spread across 90 days. This is your default
Maxina journey. You can adapt it, speed it up, slow it down, or ignore
parts — but the calendar is never empty.

## Six waves

The journey is organised in six waves, each targeting different pillars
of your Vitana Index:

1. **Wave 1: Getting Started (days 0–7)** — Onboarding basics. Complete
   your profile, add a photo, explore your community, say hello to
   Maxina, first diary entry, first health check, first matches. Lifts
   **Onboarding / Social**.
2. **Wave 2: Daily Anchors (days 1–14)** — Building habits. Daily diary,
   matches check, join a group, first meetup, health scores review.
   Lifts **Mental / Social**.
3. **Wave 3: Deepening Connections (days 7–30)** — Relationships & goals.
   Deepen a connection, set a health goal, invite a friend. Lifts
   **Social / Mental**.
4. **Wave 4: Health Intelligence (days 14–60)** — Expertise & streaks.
   Share your knowledge, start a wellness streak, streak check-ins.
   Lifts **Physical / Mental**.
5. **Wave 5: Insight Moments (days 30–60)** — Content & live rooms.
   Explore wellness content, join a live room, host a discussion.
   Lifts **Mental / Social**.
6. **Wave 6: Recommendations & Discovery (days 30–90)** — Marketplace &
   mentoring. Mentor a newcomer, explore the marketplace, 60-day review,
   90-day celebration. Lifts **Social / Prosperity**.

## How the journey lifts your Index

Each event in the journey carries wellness tags — `movement`,
`mindfulness`, `social`, `health-check`, `nutrition`, `learning`,
`community` — that map to pillar contributions. When you mark an event
done, the calendar emits a completion signal and the next nightly
recompute lifts the relevant pillars.

The trajectory is visible on the **My Journey** screen: a line across
the 90-day timeline showing your real Index scores so far, plus a simple
projection for the remaining days based on your current rate.

## Adaptivity — the calendar is alive

- Skip a task → the smart rescheduler moves it to tomorrow (up to three
  times, then it releases the slot).
- Complete tasks faster → later waves can pull forward.
- Health signal drops in a specific pillar → a weakness-driven event is
  inserted (e.g., a 15-minute walk if Physical dips).
- Natural-language change → "Move my yoga to 3pm" via the Assistant.

## The 90-day goal

By default, Maxina's target is to lift your Vitana Index into the
**Good (600+)** tier by day 90. You can see your current gap on the
Index Detail Screen. Individual Life Compass goals (Build Financial
Freedom, Find Life Partner, Transform Health, Advance Career, Master
New Skills) re-weight the pillars so the journey naturally emphasises
what matters most to you — that surface lands in a later phase.
$CONTENT$
);


-- ===========================================================================
-- DOC 3 — Autopilot and your Index
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'Autopilot — why items appear and how they lift your Index',
  p_path  := 'kb/vitana-system/autopilot-and-your-index.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','autopilot','calendar','maxina'],
  p_content := $CONTENT$
# Autopilot — why items appear and how they lift your Index

Autopilot is the engine that puts the right next action in front of you
at the right moment. It sits behind the airplane icon in the header of
every screen, and it behaves the same everywhere: a small badge counts
the actions waiting for you, a tap opens the popup, and you choose
which ones to run.

## Where actions come from

Autopilot pulls actions from several analyzers that watch your state:

- **Community analyzer** — suggests social and community engagement
  actions based on where you are in the 90-day journey.
- **Personalization analyzer** — spots your weakest Index pillar and
  suggests an action that lifts exactly that pillar.
- **D43 drift engine** — notices when a habit you had going has slipped
  and proposes a gentle restart.
- **Journey mapper** — surfaces the next wave milestone at the right
  moment in your 90 days.

## Every action carries a contribution vector

When Autopilot proposes an action, it includes a `contribution_vector`
declaring how many points it expects to lift each pillar, e.g.:

```
{ "physical": 3, "mental": 1, "social": 0, ... }
```

This is visible on the action card as pill badges: `[Physical +3]
[Mental +1]`. Over time, the index-delta learner (a later phase)
compares declared contributions with observed Index movement and updates
the priors — so the system learns what actually lifts your number.

## From activation to calendar to Index

When you activate an Autopilot action, three things happen in sequence:

1. **Calendar event created.** A new entry appears on your calendar at
   the next appropriate slot (morning / afternoon / evening matching
   the action type and your history), tagged with the action's wellness
   tags.
2. **Reminder + nudge.** You get a reminder at the scheduled time. The
   Assistant can help you move or reshape the event via natural
   language ("Move my walk to 5pm").
3. **Completion lifts the Index.** When you mark the event done, the
   calendar emits a `calendar.event.completed` signal. The index-delta
   emitter maps the event's wellness tags to pillar deltas and triggers
   an incremental recompute. Your Index badge updates within seconds.

## The Priority Action card

On the Health screen, the Priority Action card always shows your
weakest pillar and a recommendation whose contribution vector has a
positive value on that pillar. It's the single-best thing you could do
right now to raise your Index the fastest.

## Respecting you

You're always in control:

- Dismiss an action → it's silenced for 24 hours (or longer if you set
  the dismissal scope).
- "Not today" → all proactive nudges pause until tomorrow.
- "Don't mention X again" → that category is muted until you lift it.

The dismissal-honor system is on by default and non-negotiable; the
number of points an action could lift your Index never overrides your
consent.
$CONTENT$
);


-- ===========================================================================
-- DOC 4 — Umbrella: how Maxina tracks your progress
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How Maxina tracks your progress — the full picture',
  p_path  := 'kb/vitana-system/how-maxina-tracks-your-progress.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','90-day-journey','autopilot','calendar','life-compass','maxina','onboarding'],
  p_content := $CONTENT$
# How Maxina tracks your progress — the full picture

Maxina's job is to improve your quality of life and help you live longer
and more fulfilled. The way she tracks whether she's doing that is
deliberately simple:

- **One number** — your Vitana Index (0–999).
- **One route** — your 90-day Maxina journey across 6 waves.
- **One day-level plan** — your Calendar.
- **One nudge engine** — Autopilot.
- **One goal compass** — Life Compass (lands in a later phase).

Everything else is in service of those five elements.

## The loop

```
You register
   ↓
Maxina pre-populates 90-day calendar (≈30 events)
   ↓
First visit to Health → 3-question baseline survey → Day-0 Index
   ↓
Every day: Autopilot surfaces the next best action
   ↓
You activate → calendar event created
   ↓
You complete → completion signal emitted
   ↓
Index recomputes → pillar delta applied
   ↓
Trajectory visible on My Journey → assistant frames next suggestion
   ↓
Day 90 → celebration + reflection ("where did your Index start, where
   did it end, which pillars moved most?")
```

## Why four surfaces, one system

The Index is the **measurement**. The Journey is the **route**. The
Calendar is the **day**. The Autopilot is the **nudge**. The Assistant
is the **voice**.

They are all looking at the same underlying data and the same active
goal. When you ask Maxina "how am I doing?", she doesn't open a
separate report — she reads the Index, cross-checks your calendar
completion, notices the weakest pillar, and responds in terms of your
goal.

## Goals and Life Compass

At launch, the default goal is: **reach the Good tier (600+) by day
90**. In a later phase, the Life Compass modal lets you swap that for
one of five presets (Build Financial Freedom, Find Life Partner,
Transform Health, Advance Career, Master New Skills) or write your
own. Changing the goal re-weights the pillars so the journey naturally
emphasises what matters most — without ever letting Physical or Mental
drop below a safety floor.

## Privacy and control

- Your Index and calendar history are scoped to you and your tenant.
- You can dismiss or pause any proactive nudge; the system honours it
  silently, without apology.
- You can ask Maxina to "explain" anything — why an Autopilot item
  appeared, why a pillar moved — and she will ground the answer in this
  Knowledge Hub (the `vitana_system` namespace).
- You can edit your goal any time. Historical Index values are never
  rewritten when the goal changes — the past is the past.

## If you're just starting

Open the Health screen. Answer the three baseline questions. That's it
— Maxina takes it from there. Every day after, the Autopilot popup is
where the next action lives.
$CONTENT$
);
