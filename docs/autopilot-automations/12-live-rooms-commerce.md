# AP-1200: Live Rooms Commerce

> Automations for monetized live rooms — paid consultations, group sessions, expert Q&As, workshops, and streaming revenue. Bridges Live Rooms (VTID-01090/01228) with Business Hub (VTID-01092) and Stripe Connect (VTID-01231).

---

## AP-1201 — Paid Live Room Setup for Creators

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Creator creates a service with `delivery_mode: 'live_room'` |
| **Skill** | `vitana-daily` + `vitana-stripe` |

**What it does:**
Automates the end-to-end setup of paid live room sessions: creates the room, sets pricing, configures access control, and integrates with Stripe Connect for payment.

**Actions:**
1. Creator creates service listing with live room delivery
2. Auto-create `live_rooms` entry with `access_level: 'paid'`
3. Set up Daily.co room via `vitana-daily.schedule_room`
4. Attach Stripe price to room (platform 10%, creator 90%)
5. Generate booking page link for sharing
6. Emit OASIS event `autopilot.liverooms.paid_room_created`

**APIs used:**
- `POST /api/v1/live/rooms` (VTID-01090)
- `POST /api/v1/live/rooms/:id/daily` (VTID-01228)
- `POST /api/v1/catalog/services` (VTID-01092)
- Stripe Connect (VTID-01231)

**Database tables:**
- `live_rooms` — room config, `host_user_id`, pricing metadata
- `live_room_sessions` — session lifecycle
- `services_catalog` — service listing link

**Requires:** AP-0706 (Stripe Connect onboarding)

---

## AP-1202 — Live Room Booking & Payment Flow

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User books a paid live room session |
| **Skill** | `vitana-stripe` + `vitana-daily` |

**What it does:**
Handles the complete booking flow: payment collection, access grant, confirmation, and calendar reminders.

**Actions:**
1. User clicks "Book" on a paid room or service
2. Create Stripe Checkout session with Connect (destination charge: 90% to creator)
3. On payment success: add user to `live_room_attendance` with `status: 'booked'`
4. Send confirmation: _"You're booked for [Session] with [Creator] on [date]. Here's your join link."_
5. Trigger AP-0302 (graduated reminders) for the booked session
6. On payment failure: notify user, do NOT grant access
7. Emit OASIS events: `autopilot.liverooms.booking_created`, `autopilot.liverooms.payment_received`

**APIs used:**
- Stripe Checkout API (Connect destination charges)
- `POST /api/v1/live/rooms/:id/join`
- Notification service

**Success metric:** Booking completion rate, no-show rate for paid sessions

---

## AP-1203 — Live Room Upsell from Free Content

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | User attends 3+ free live rooms on the same topic |
| **Skill** | `vitana-marketplace` + `vitana-daily` |

**What it does:**
Detects users who regularly attend free community sessions and suggests relevant paid expert sessions.

**Actions:**
1. Query `live_room_attendance` — find users with 3+ free room attendances in same `topic_keys`
2. Find paid live rooms or services from creators with matching expertise
3. Check AP-0710 (monetization readiness) — only suggest when appropriate
4. Suggest via ORB: _"You've been attending [topic] rooms regularly! [Creator] offers a deep-dive session — interested?"_
5. Track conversion from free → paid
6. Emit OASIS event `autopilot.liverooms.upsell_suggested`

**APIs used:**
- `live_room_attendance`, `services_catalog` tables
- `GET /api/v1/offers/recommendations`

**Safety:**
- Never pressure — frame as "deeper exploration" not "upgrade"
- AP-0710 monetization readiness must pass
- Maximum 1 upsell suggestion per topic per month

**Requires:** AP-0710

---

## AP-1204 — Group Session Auto-Fill

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Paid group session has < 50% capacity filled, 72h before start |
| **Skill** | `vitana-daily` + `vitana-marketplace` |

**What it does:**
When a paid group session isn't filling up, proactively finds and notifies relevant users to boost attendance.

**Actions:**
1. Detect paid sessions with `max_participants` > current bookings, starting in < 72h
2. Find users with high topic alignment who haven't been notified
3. Check monetization readiness for each potential attendee
4. Send: _"[Creator] is hosting a [topic] session [date] — [N] spots left"_
5. If connections are attending, add social proof: _"[Name] is going!"_
6. Emit OASIS event `autopilot.liverooms.session_promoted`

**APIs used:**
- `live_room_sessions`, `live_room_attendance`
- `user_topic_profile`, `relationship_edges`
- Notification service

**Requires:** AP-0106 (social proof pattern)

---

## AP-1205 — Post-Session Revenue Report for Creator

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Paid live room session ends |
| **Skill** | `vitana-stripe` |

**What it does:**
Sends the creator an immediate revenue summary after their paid session ends.

**Actions:**
1. Detect session end: `POST /api/v1/live/rooms/:id/end`
2. Query: total attendees, no-shows, revenue collected, platform fee
3. Send to creator: _"Great session! [N] attendees, [amount] earned (after platform fee). Your rating: [stars]"_
4. Prompt: _"Want to schedule the next one?"_
5. Emit OASIS event `autopilot.liverooms.revenue_reported`

---

## AP-1206 — Session Highlight Clips for Marketing

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Live room session ends with highlights (AP-0304 in live_highlights) |
| **Skill** | `vitana-daily` + `vitana-sharing` |

**What it does:**
Packages session highlights into shareable content that creators can use to promote future sessions.

**Actions:**
1. Query `live_highlights` for the ended session
2. Format highlights as a summary card:
   _"Key moments from [Session]: [highlight1], [highlight2], [highlight3]"_
3. Generate shareable card (like AP-0403 social card but for sessions)
4. Send to creator: _"Here are your session highlights — share them to attract more attendees"_
5. Include WhatsApp + social share buttons
6. Emit OASIS event `autopilot.liverooms.highlights_packaged`

**APIs used:**
- `GET /api/v1/live/rooms/:id/summary`
- `live_highlights` table
- Sharing service (AP-0403 pattern)

---

## AP-1207 — Recurring Session Auto-Scheduling

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Creator holds 3+ sessions of same type |
| **Skill** | `vitana-daily` |

**What it does:**
Detects creators with recurring session patterns and suggests auto-scheduling.

**Actions:**
1. Detect 3+ sessions by same creator with similar `topic_keys` in 30 days
2. Suggest: _"Your [topic] sessions are popular! Want to make them a weekly recurring session?"_
3. If accepted: auto-create next 4 sessions with same config
4. Auto-notify previous attendees about the series
5. Emit OASIS event `autopilot.liverooms.recurring_suggested`

**Requires:** AP-0306 (event series pattern)

---

## AP-1208 — Consultation Matching (Expert + Client)

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User asks ORB for professional help or has AP-0612 referral |
| **Skill** | `vitana-marketplace` + `vitana-daily` |

**What it does:**
Connects users who need professional guidance (from health referral or explicit request) with the right creator's live room consultation.

**Actions:**
1. Detect need: AP-0612 (health referral), ORB conversation, or explicit search
2. Query `services_catalog` for matching `service_type` + `topic_keys`
3. Filter by: availability, Stripe Connect enabled, reviews/outcomes
4. Present top 3 creators with: expertise, price, next available slot, reviews
5. If user selects: trigger AP-1202 (booking flow)
6. After consultation: trigger AP-1105 (outcome tracking)
7. Emit OASIS event `autopilot.liverooms.consultation_matched`

**APIs used:**
- `GET /api/v1/offers/recommendations`
- `POST /api/v1/live/rooms` (create 1:1 room)
- `services_catalog`, `live_rooms` tables

**Success metric:** Time from need detection to booked consultation

**Cross-references:** AP-0612, AP-1105, AP-1202

---

## AP-1209 — Free Trial Session for New Creators

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | New creator completes shop setup (AP-1106) with no sessions yet |
| **Skill** | `vitana-daily` + `vitana-marketplace` |

**What it does:**
Helps new creators get their first clients by suggesting a free intro session to build reputation.

**Actions:**
1. Detect: creator completed AP-1106 but has 0 sessions after 7 days
2. Suggest: _"Kick off your Vitana business with a free intro session. It's the fastest way to get reviews and build trust."_
3. If accepted: create free live room, auto-invite topic-aligned users
4. After session: prompt attendees for reviews
5. Emit OASIS event `autopilot.liverooms.trial_session_suggested`

**Success metric:** Creators who do a free trial → conversion to paid sessions within 30 days

---

## AP-1210 — Live Room Revenue Optimization Tips

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Monthly (with AP-1108 creator analytics) |
| **Skill** | `vitana-marketplace` |

**What it does:**
Analyzes creator's live room performance and suggests optimizations: pricing, timing, topic adjustments, promotion strategies.

**Actions:**
1. Analyze: session fill rate, attendance vs. booking, revenue per session, time-of-day performance
2. Compare to category benchmarks
3. Suggest: _"Sessions at 18:00 get 40% more bookings than 14:00 in your category"_
4. Suggest: _"Your price is 20% below average for [service_type] — consider raising it"_
5. Suggest: _"Members who saved your profile also like [topic] — try offering a session on it"_
