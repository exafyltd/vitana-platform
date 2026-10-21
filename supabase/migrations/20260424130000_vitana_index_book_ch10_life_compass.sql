-- =============================================================================
-- Book of the Vitana Index — Chapter 10: Your Life Compass
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (G10 / G3)
-- Date: 2026-04-24
--
-- Why: users can save a Life Compass goal (tables + modal shipped, 7 preset
-- goals). G3 wires that goal into the Autopilot ranker, the voice ORB
-- profiler, and the morning brief. This chapter is the durable narrative
-- voice cites when a user asks "what is my Life Compass?", "how does my
-- goal affect suggestions?", or "why did Vitana pick this for me?".
--
-- Idempotent: upsert_knowledge_doc() is upsert-by-path.
-- =============================================================================

BEGIN;

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Your Life Compass',
  p_path  := 'kb/vitana-system/index-book/10-your-life-compass.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','life-compass','goals','autopilot','maxina'],
  p_content := $CONTENT$
# Your Life Compass — the direction that steers Vitana

Your **Vitana Index** tells you where your health stands right now.
Your **Life Compass** tells Vitana which direction you want to go. The
two work together: the Index is a state, the Compass is a heading. With
both set, every Autopilot suggestion, every morning brief, and every
voice response bends toward the life you're actually trying to build.

## What the Life Compass is

The Life Compass is one active goal you pick — the thing that matters
most to you right now. You can change it anytime. Vitana comes with
seven preset goals, each tied to a category, and you can also write a
custom one.

| Preset goal | Category | What Vitana biases toward |
|---|---|---|
| Build Financial Freedom | finance | Reflective check-ins that protect the Mental pillar while Business Hub is coming |
| Find Life Partner | community / connection | Matches, meetups, deepened connections, invites |
| Transform Health | health / longevity | Daily streaks on your weakest pillar, wearable connections, balanced practice |
| Advance Career | career | Skill-sharing, mindful reflection, protecting Mental pillar under workload |
| Master New Skills | skills | Live rooms, sharing expertise, learning-tagged actions |
| Spiritual Life | spiritual | Journaling, meditation, mindful practice, reflection |
| Improve Longevity | longevity | Whichever pillar is lagging — streak plus balance |

Each category has a category key — `community`, `connection`, `health`,
`longevity`, `career`, `finance`, `skills`, `spiritual` — and every
Autopilot recommendation Vitana issues is weighted against that key.

## How the goal steers the Autopilot

When you activate a Life Compass goal:

1. **Ranker alignment.** Every candidate action in your Autopilot queue
   gets a *compass boost* when its template matches your goal's
   category. A user aiming at "Find Life Partner" sees `engage_matches`,
   `deepen_connection`, and `invite_friend` climb above equal-impact
   health nudges. A user aiming at "Improve Longevity" sees the streak
   and pillar-gap nudges climb instead.
2. **Voice framing.** Voice Vitana (ORB) greets you and anchors
   suggestions to your goal when it's set: *"You're working toward
   finding a partner — today's move is a meetup tonight."* When no
   goal is set, voice gently invites you to pick one rather than
   guessing.
3. **Morning brief alignment.** The daily brief (when enabled) leads
   with your goal alongside the Index and the top action picked through
   the ranker — so the plan for the day, the number for the day, and
   the direction you chose line up.
4. **Plan creation.** When you say "make me a plan," the plan template
   picker biases toward templates that fit your goal's category —
   community categories prefer social templates, longevity prefers
   daily-practice templates.

## The goal is a direction, not a gate

The Compass never blocks anything. You can still complete a sleep
action even if your goal is "Find Life Partner" — your Index still
climbs and the balance factor still protects you. All the Compass
does is **order which things come up first in the queue** and **how
voice frames suggestions**. If you want something else for a day, just
ask for it; Vitana will answer.

## Changing your goal

Your goal is flexible by design. Three ways to change it:

- Say "open my goals" or "open my life compass" to voice.
- Tap the Life Compass button in the utility bar on any screen.
- From the Autopilot, activate the **Set your Life Compass** card when
  no goal is active — it opens the Life Compass overlay on your current
  screen without losing context.

You can keep one goal for months (recommended for longevity goals) or
rotate seasonally (recommended for skills / career goals). Vitana
doesn't track "failed" goals — a goal you set and then change is a
signal that you've learned something about what you want, which is
exactly what the Compass is for.

## When no goal is set

No goal is a valid state. When the Compass is empty, Vitana's Autopilot
runs on the Index alone: weakest pillar first, balance protected,
journey wave still biasing the early weeks. Voice will mention that you
haven't set a goal and offer to open the Compass — once, gently, not
repeatedly. You can ignore that invitation and keep using Vitana
indefinitely.

## Two surfaces, one goal

Your Life Compass is shared across voice and the Autopilot — they
never disagree about what you're working on. If you change your goal
mid-week, the next morning brief, the next voice session, and the
next Autopilot batch all pick up the new direction on the first
interaction after the change.

Compass gives direction. Index tells the truth. Together they turn the
Vitana system from a passive tracker into a practice you're actually
running.
$CONTENT$
);

COMMIT;
