# AP-0500: Engagement Loops

> Automations that keep members active through briefings, digests, re-engagement, and milestone celebrations.

---

## AP-0501 — Morning Briefing with Social Context

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Cron 07:00 local time |
| **Skill** | `vitana-matchmaking` + `vitana-community` |

**What it does:**
Compiles a personalized morning briefing: today's matches, upcoming meetups, unread messages, group activity.

**Actions:**
1. Get today's matches from `GET /api/v1/match/daily`
2. Get upcoming meetups in next 24h
3. Get unread chat count from `GET /api/v1/chat/unread-count`
4. Get group activity summary
5. Send push: _"Good morning! You have [N] new matches, [M] meetups today, and [K] unread messages"_

**APIs used:**
- `POST /api/v1/scheduled-notifications/morning-briefing` (existing endpoint)

**Notes:** Endpoint already exists. Needs bridge integration for enhanced social context.

---

## AP-0502 — Weekly Community Digest

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Sunday 18:00 |
| **Skill** | `vitana-community` |

**What it does:**
Weekly summary of community activity: new connections, group highlights, popular events, personal stats.

**APIs used:**
- `POST /api/v1/scheduled-notifications/weekly-digest` (existing)
- `POST /api/v1/scheduled-notifications/weekly-summary` (existing)

---

## AP-0503 — Re-Engagement for Dormant Users

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User inactive > 7 days |
| **Skill** | `vitana-community` |

**What it does:**
Detects dormant users and sends a curated "what you missed" notification.

**Actions:**
1. Query users with no app activity in 7 days
2. Compile: new matches generated, group messages missed, events happened, new members in their groups
3. Send: _"While you were away: [N] people matched with you, [M] happened in your groups"_
4. Include one compelling CTA (best match or trending event)
5. After 14 days inactive: second nudge with different content
6. After 30 days: final nudge, then stop (respect silence)

**Success metric:** Return rate within 48h of re-engagement nudge

---

## AP-0504 — Milestone Celebrations

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | User reaches a milestone |
| **Skill** | `vitana-community` |

**What it does:**
Celebrates community milestones with personalized messages and shareable cards.

**Milestones tracked:**
- 1st connection made
- 5th, 10th, 25th, 50th connection
- 1st meetup attended
- 5th, 10th meetup
- 1st group created
- 30 days / 90 days / 1 year on Vitana
- Connection anniversary (1 year since connecting with someone)

**Actions:**
1. Detect milestone from activity tracking
2. Send celebratory notification with shareable card
3. Emit OASIS event `autopilot.engagement.milestone_reached`

---

## AP-0505 — Diary Reminder with Social Twist

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Cron 21:00 local time |
| **Skill** | `vitana-community` |

**What it does:**
Evening diary reminder enriched with social context: _"You connected with [Name] today — how did it go?"_

**APIs used:**
- `POST /api/v1/scheduled-notifications/diary-reminder` (existing)

---

## AP-0506 — Weekly Reflection with Connection Insights

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Friday 20:00 |
| **Skill** | `vitana-community` |

**What it does:**
Weekly reflection prompt with community insights: connections made, conversations had, groups participated in.

**APIs used:**
- `POST /api/v1/scheduled-notifications/weekly-reflection` (existing)

---

## AP-0507 — Conversation Continuity Nudge

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Active conversation goes quiet for 3 days |
| **Skill** | `vitana-community` |

**What it does:**
When a conversation that was active (3+ messages exchanged) goes silent, send a gentle topic suggestion.

**Actions:**
1. Detect conversations with 3+ messages where last message > 3 days ago
2. Query shared topics between the two users
3. Send Vitana Bot suggestion: _"It's been a few days since you chatted with [Name]. Ask them about [new topic]?"_
4. Max 1 nudge per conversation per week

---

## AP-0508 — "Someone Viewed Your Profile" Notification

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Profile view by non-connected user |
| **Skill** | `vitana-community` |

**What it does:**
Notifies users when someone views their profile (with privacy controls).

**Actions:**
1. Track profile views (anonymous by default)
2. If viewer is a match: _"Someone who matches your interests viewed your profile"_
3. Include CTA to view their matches
4. Respect privacy settings (users can disable this)
