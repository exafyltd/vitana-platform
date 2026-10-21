# AP-0300: Events & Live Rooms

> Automations for scheduling, reminders, attendance, and post-event follow-up for live rooms and meetups.

---

## AP-0301 — Auto-Schedule Daily.co Room for Meetup

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Online meetup created via community API |
| **Skill** | `vitana-daily` |

**What it does:**
Automatically creates a Daily.co room when an online meetup is scheduled.

**Actions:**
1. Detect `POST /api/v1/community/meetups` with `mode: 'online'`
2. Call `vitana-daily.schedule_room` with meetup datetime, participant list, topic
3. Store room URL in meetup record
4. Emit OASIS event `autopilot.events.room_created`

**APIs used:**
- `POST /api/v1/live-rooms`
- `vitana-daily` skill (OpenClaw bridge)

**Notes:** Already implemented in OpenClaw bridge.

---

## AP-0302 — Graduated Meetup Reminders

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Heartbeat loop (every 15 min) |
| **Skill** | `vitana-daily` |

**What it does:**
Sends cascading reminders at 24h, 1h, and 15min before meetup start.

**Actions:**
1. Query upcoming meetups with RSVP'd participants
2. At T-24h: _"[Meetup] is tomorrow at [time]. See you there!"_
3. At T-1h: _"[Meetup] starts in 1 hour. Get ready!"_
4. At T-15m: _"[Meetup] starts in 15 minutes. [Join link]"_
5. Include number of attendees for social proof
6. Emit OASIS event per reminder

**APIs used:**
- `POST /api/v1/scheduled-notifications/meetup-reminders` (existing endpoint)
- `vitana-daily.send_reminder`

**Notes:** Scheduled notifications endpoint already exists. Bridge wraps for heartbeat integration.

---

## AP-0303 — "Go Together" Event Match

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Event match generated in daily matching |
| **Skill** | `vitana-matchmaking` |

**What it does:**
When a user is matched with an event, checks if any of their connections are attending. Adds social context to the match.

**Actions:**
1. Detect event-type matches in daily match results
2. Query `community_meetup_attendance` for the event
3. Cross-reference with user's `relationship_edges`
4. If connections attending: _"Join [Event] — [Name] is going too!"_
5. If no connections: _"[Event] matches your interest in [topic]"_
6. Emit OASIS event `autopilot.events.go_together_suggested`

**APIs used:**
- `GET /api/v1/match/daily` (filtered by match_type=event)
- `GET /api/v1/social/connections`

**Requires:** AP-0101

---

## AP-0304 — Post-Event Feedback & Connect

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Meetup/event end time + 1 hour |
| **Skill** | `vitana-community` |

**What it does:**
After an event ends, asks attendees for feedback and suggests connecting with co-attendees.

**Actions:**
1. Wait 1h after meetup `ends_at`
2. Send to each attendee: _"How was [Meetup]? Rate your experience"_
3. List co-attendees they're not connected with: _"Connect with people you met?"_
4. Store feedback for future event recommendation tuning
5. Emit OASIS event `autopilot.events.feedback_requested`

**APIs used:**
- `POST /api/v1/match/:id/feedback` (adapted for events)
- Notification service

**Requires:** AP-0208

---

## AP-0305 — Trending Events Weekly Digest

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Weekly Sunday 18:00 (with weekly digest) |
| **Skill** | `vitana-community` |

**What it does:**
Compiles the top upcoming events ranked by RSVP count and topic relevance to each user.

**Actions:**
1. Query all meetups in next 7 days with RSVP counts
2. For each user, score events by topic alignment (`user_topic_profile`) + social proof (connections attending)
3. Send top 5 as weekly push/inapp: _"This week: [Event1] (12 going), [Event2] (8 going)..."_
4. Emit OASIS event `autopilot.events.weekly_digest_sent`

**APIs used:**
- `POST /api/v1/scheduled-notifications/weekly-digest` (existing)
- Community meetup queries

---

## AP-0306 — Event Series Auto-Suggestion

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Same group holds 3+ meetups on same topic |
| **Skill** | `vitana-community` |

**What it does:**
Detects recurring meetup patterns and suggests making them a regular series.

**Actions:**
1. Detect 3+ meetups in same group with similar topics in last 30 days
2. Suggest to group creator: _"Your [topic] sessions are popular! Make it a weekly series?"_
3. If accepted, auto-schedule next 4 occurrences
4. Emit OASIS event `autopilot.events.series_suggested`

---

## AP-0307 — Live Room from Trending Chat Topic

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Same topic mentioned in 3+ separate conversations within 4 hours |
| **Skill** | `vitana-community` + `vitana-daily` |

**What it does:**
When multiple unrelated conversations revolve around the same topic, suggest a community live room.

**Actions:**
1. Analyze recent chat topics across conversations (no content reading — topic tags only)
2. If 3+ users discussing same topic tag: suggest impromptu live room
3. Send to interested users: _"[Topic] is trending today — join a live discussion?"_
4. If 3+ accept, auto-create Daily.co room
5. Emit OASIS event `autopilot.events.trending_room_created`

**APIs used:**
- `POST /api/v1/live-rooms`
- Notification service

---

## AP-0308 — No-Show Follow-Up

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | User RSVP'd but didn't attend |
| **Skill** | `vitana-community` |

**What it does:**
Gently follows up with users who RSVP'd but didn't show up.

**Actions:**
1. After meetup ends, compare RSVP list vs. attendance
2. For no-shows, send 24h later: _"We missed you at [Meetup]! Here's a recap: [summary]. Next one is [date]."_
3. Do NOT shame — frame as helpful, include next event
4. Emit OASIS event `autopilot.events.noshow_followup_sent`

**Notes:**
- Max 1 no-show follow-up per user per week (prevent annoyance)
- Skip if user marked as declined before meetup started
