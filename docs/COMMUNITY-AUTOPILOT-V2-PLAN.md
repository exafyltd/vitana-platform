# Community Autopilot v2: proactive, voice-first, community-growing

**2026-09-24** · builds on `docs/COMMUNITY-AUTOPILOT-PLAN.md` (VTID-04461), which
measured the current state and designed the execution pipeline. This document
adds what the owner asked for on top: Vitanaland as the proactive initiator,
twice-daily autonomous scans, suggestions across every feature, and
community growth. Owner decisions are recorded in §6.

## 1. Purpose

1. **Teach the system by doing.** Every suggestion shows one feature and offers
   to do it for the member.
2. **Motivate and connect.** Streaks, the Vitana Index, the diary, and above all
   other people: matches, messages, events, groups.
3. **Grow the community.** Friends and external people invited to accompany the
   member on the longevity journey.

## 2. Suggestion kinds

| Kind | Examples | What "Go" / "yes" does |
|---|---|---|
| Do it for me | Log water/sleep, book a slot, reminder, guided session, RSVP, join a group | Runs at once |
| Create with me | Diary entry, news-feed post, Media Hub caption | Draft in the member's language (Claude via Bedrock); member publishes |
| Connect | Match intro, reply to an unanswered message, invite a friend to an event | Draft; sent after confirmation |
| Explore | Discover marketplace, Media Hub, live rooms, unused Index pillars | Opens the screen, optionally with a guided explanation |
| Grow | Invite an external friend | Personal invite link + message, shared through the member's own channel |

Vitanaland never contacts non-members itself.

## 3. The autonomous loop

- Runs at 07:00 and 17:00 in each member's own timezone: an hourly job processes
  members whose local hour matches.
- Scanners (one per area) read the member's state and propose candidates with a
  typed action: Vitana Index, daily logs/diary, matches, messenger, events and
  groups, content, Media Hub, Discover, growth, feature discovery.
- Ranker: at most 3 open suggestions per member per role, one per category,
  a bonus for never-used features, a template rejected twice suppressed for
  30 days, fingerprint dedupe, expiry on every row. Wording is written by the
  model from an English intent in the member's language (NEVER-rule 41).
- Test and service accounts (`service_bot_accounts`, `notification_test_actors`)
  are excluded as members and as targets (rules 43–45).
- Accept/reject/complete rates feed ranking; templates nobody accepts retire.

## 4. One pipeline, three ways in

suggestion → offer → confirm → action → run record (`agent_runs`,
plane `community_autopilot`) → follow-through.

1. **Voice.** The offer is stored server-side with an expiry; `confirm_pending_action`
   runs exactly that offer on "yes". Drafts are read back before sending.
   Tools live in the shared registry so every voice transport has them.
2. **Pop-up / dashboard "Go".** Same activation function; draft items open a
   preview sheet; snooze button; role read from the server.
3. **Calendar.** A due autopilot slot wins the next ORB turn ("it's time for X,
   shall I?"); the reminder deep-links into the offer; completion (voice or
   click) completes the suggestion.

## 5. Build order (one VTID and PR per step, merge → staging only)

| Step | Scope |
|---|---|
| CA-0 | Ownership/safety fixes (VTID-04464) |
| CA-1 | One activation path for Go, voice, calendar; voice tools in the shared registry |
| CA-2 | Role-scoped lineups; frontend stops hard-coding `community` |
| CA-3 | Action registry + confirm-then-execute for do-it-for-me actions |
| CA-4 | Create-with-me and Connect drafts + preview sheet |
| CA-5 | Twice-daily scanners + ranker; old recommendation inbox folded in |
| CA-6 | Calendar due-now offers, deep-linked reminders |
| CA-7 | Growth: attributed invite links, wallet credit on join |
| CA-8 | Background automations on the pipeline (propose, not act silently); supervisor view |
| CA-9 | Cleanup of never-used tables and dead routes |

## 6. Owner decisions (2026-09-24)

1. **Voice commit.** A spoken "yes" may run low-risk actions on the member's own
   data. Messages and invites to existing contacts may be sent by voice after
   Vitana reads the draft back. Public feed posts always go through the app
   preview.
2. **Notifications.** At most one daily digest push, starting after a week of
   shadow mode on staging. The EventBridge `--apply` is the owner's step.
3. **Caps.** 3 open suggestions per member per role; 1–2 pushes per day.
4. **Old recommendation inbox** (`/api/v1/recommendations`): folded into the
   Autopilot queue (CA-5).
5. **Growth reward.** An invited friend who joins earns the inviter wallet
   credit (amount and anti-abuse rules set in CA-7).
