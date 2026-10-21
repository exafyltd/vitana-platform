-- =============================================================================
-- Book of the Vitana Index — Chapter 09: Community is Mental Health
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (G10)
-- Date: 2026-04-24
--
-- Why: the Mental pillar is driven by mindfulness AND community engagement
-- in equal measure. The tag-map bridge in lib/vitana-pillars.ts and the DB
-- compute RPCs were extended in migration 20260424120000 so that community
-- actions (meetups, matches, invites, chats, groups, live rooms, deepened
-- connections) now lift the Mental score when completed. This chapter
-- grounds that behavior in user-facing narrative so voice can cite it when
-- a user asks "why are you suggesting a meetup?".
--
-- Idempotent: upsert_knowledge_doc() is upsert-by-path.
-- =============================================================================

BEGIN;

SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Community is Mental Health',
  p_path  := 'kb/vitana-system/index-book/09-community-is-mental-health.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','mental','community','social','meetup','autopilot','maxina'],
  p_content := $CONTENT$
# Community is mental health

When we say "mental health" inside the Vitana Index, we mean more than
meditation and breathing. Mental well-being is driven by two things in
equal measure: **a calm inner life and a connected outer life.** Strip
either one away and the pillar can't hold. That is why community
engagement — the actions you take with other people — lifts your
Mental score just as much as mindfulness does.

## Two equal halves of the Mental pillar

Vitana treats the Mental pillar as **reflection + connection**:

| Half | What it looks like in your life |
|---|---|
| **Reflection** | Journaling, mindfulness, meditation, quiet time, checking in with your own mood and stress |
| **Connection** | Spending time with friends, meeting new people, joining or creating events, chatting with your community, inviting others in, finding people like you |

A user who meditates every day but never sees anyone has a fragile
Mental pillar. A user who's surrounded by people but never pauses has
the same problem from the other side. The best pillar is a balanced
pillar — some of both.

## What counts as community engagement

These are the actions Vitana recognises as mental-health engagement,
and any of them will lift your Mental score when you complete them:

- **Socializing** — spending time with friends, deepening an existing
  connection, checking in on someone.
- **Joining events** — going to a meetup, a class, a live room, a
  workshop.
- **Creating your own events** — organising a meetup, hosting a live
  room, leading a group conversation.
- **Chatting** — one-to-one or in groups, including conversations with
  Maxina or other community members.
- **Inviting people to join the community** — bringing a friend into
  Vitana, sharing what you're working on.
- **Meeting like-minded people** — matches, interest-based groups,
  mentor pairings.
- **Match-making** — accepting suggested matches, introducing people
  to each other.

Each completed action is tagged on your calendar. Those tags feed
directly into the Mental pillar on your next Index recompute.

## Why this matters for the 90-day journey

Your 90-day journey intentionally leans into community in the first
three waves — *Getting Started*, *Daily Anchors*, *Deepening
Connections*. That's not filler. If your first three weeks are all
solo (only sleep logs and meditations), your Mental pillar will climb
slowly and your total Index will stall. If you mix in a few meetups,
an invite, and a deepened connection, the Mental pillar jumps and
pulls the rest of the Index with it — because balance across all five
pillars is what the number actually rewards.

## Why the Autopilot surfaces community actions

When Maxina's Autopilot notices that your Mental score is low
*specifically because your `completions` sub-score is low* — meaning
you've done the reflection side but not the connection side — it will
start surfacing community actions over more meditation nudges. This
isn't a punishment, it's the system recognising that "more time alone"
won't move the number you're trying to move.

The opposite is also true: if you've had a very social week but
haven't journaled or paused, the Autopilot will swing toward
reflection. Balance is the goal, not one side winning.

## How much each action lifts the pillar

You don't need to memorise the weights, but here's the feel of it:

- A meetup you actually attend: around **+6 Mental** per completion.
- A deepened connection (real conversation, not just a like): **+6**.
- Inviting a friend into Vitana: **+5**.
- Creating a live room or mentoring a newcomer: **+6**.
- Attending a live room or joining a group: **+4** to **+5**.
- A chat check-in with Maxina or the community: **+4**.

Each pillar is capped at 200 per day's computation, so the goal isn't
to grind — it's to do a few meaningful things across the week.

## Quiet months and connection droughts

If life gets quiet — a stressful work stretch, a move, a health event
— the community half of the Mental pillar will drop first. That's
normal and the Index will reflect it honestly. When that happens, the
90-day journey doesn't push harder; it offers easier on-ramps:
checking a single message, joining one low-pressure event, texting
one friend. The goal is always to make reconnection possible, not
mandatory.

## One number, many doors

Your Mental pillar reaching *Really good* territory (a pillar score
of 140+) is almost impossible without some form of community life.
Almost every user who hits that band has at least one of: a weekly
meetup they actually attend, a couple of people they check in with
regularly, or a group they belong to. When you see Maxina suggesting
any of those, it isn't randomness — it's the single highest-leverage
move for the number you're trying to lift.

Connection is health. Vitana's Mental pillar treats it that way.
$CONTENT$
);

COMMIT;
