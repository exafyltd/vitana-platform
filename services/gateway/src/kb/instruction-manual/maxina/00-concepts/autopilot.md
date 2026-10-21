---
chapter: 0.6
screen_id: null
title: The Autopilot
tenant: maxina
host_screens: [COM-AI, COM-AI_RECOMMENDATIONS, COM-HOME, COM-HOME_ACTIONS]
keywords: [autopilot, airplane button, autopilot button, recommended actions, autopilot popup, autopilot aktionen, autopilot wave, los button, vorschläge, empfehlungen]
related_concepts: ["0.1", "0.3", "0.5"]
related_screens: [COM-AI, COM-AI_RECOMMENDATIONS, COM-HOME_ACTIONS]
---

## What it is

The Autopilot is the AI engine that turns Vitana's understanding of you into a concrete to-do list for today. The airplane icon you see in the header (with a number badge) is the Autopilot's surface — tap it and a popup opens with a ranked list of actions Vitana thinks will move your Vitana Index the most given your active Life Compass. You select the ones you actually want to do, tap **LOS (N)** ("Go (N)") to commit, and Vitana executes them — opening screens, sending messages, drafting diary entries, scheduling reminders.

Autopilot is the "automation without losing control" layer. Vitana never executes silently; it always proposes, you always approve. But once you approve a batch, the system handles the steps so you don't have to.

## Why it matters

Most wellness tools ask you to remember to do things. Autopilot inverts that — it remembers, ranks, and queues. Each morning the queue is built fresh from your sleep last night, your meetings today, your weakest pillar, your active Compass, and what you've already done recently (so you don't get the same nudge twice). The badge number on the airplane icon is "actions waiting for your call."

Autopilot is also the place where Vitana's recommendation engine becomes legible. Each card shows a `[Pillar +N]` pill so you know what move it expects, and a one-line "why" so you know how it got there. No black box.

## Where to find it

- **Airplane icon in the header** — visible on every screen; the number badge is the count of pending recommendations
- **AI → Recommendations (`/ai/recommendations`)** — the full list view
- **Home → Actions (`/home/actions`)** — today's top three on the home feed
- **My Journey (Autopilot Dashboard)** — wave-level Autopilot context

## How to use it

1. Tap the airplane icon to open the popup. You'll see "Autopilot-Aktionen" / "Autopilot Actions" with a ranked list.
2. Each card shows the action, the time estimate (30sec / 1min / 2min), the priority (Hoch / Mittel = High / Medium), and the expected pillar lift.
3. Tick the boxes for actions you want to do. Untick the ones you don't.
4. Tap **LOS (N)** to commit. Vitana executes them — opening Diary, sending messages, scheduling reminders — one by one.
5. Tap **Nicht jetzt** ("Not now") to dismiss the popup; the actions stay pending.
6. Tap **Optionen anzeigen** ("Show options") to tune which categories Autopilot is allowed to suggest.

## Related

- See concept 0.1 for the Vitana Index that Autopilot is trying to move.
- See concept 0.3 for the Life Compass that tunes the ranking.
- See concept 0.5 for ORB, which is how you can say "yes" to Autopilot by voice.
- AI → Recommendations (chapter 7.3) is the screen-level documentation.
