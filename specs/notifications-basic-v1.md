# Vitana Platform — Basic Notifications v1

**VTID**: TBD (Notifications System)
**Date**: 2026-02-25
**Status**: Draft — Pending Approval

---

## Overview

70 basic notifications covering all existing Vitana features, designed to build community engagement and encourage users to invite friends and family. Each notification maps to an existing OASIS event, database trigger, or scheduled computation already in the codebase.

---

## 1. MATCHMAKING (VTID-01088) — 7 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 1 | **New daily matches available** | `match_recompute_daily` completes with >0 matches | Push + In-app |
| 2 | **Person match suggested** | New `person` match in `matches_daily` | Push + In-app |
| 3 | **Group match suggested** | New `group` match in `matches_daily` | In-app |
| 4 | **Event match suggested** | New `event` match in `matches_daily` | Push + In-app |
| 5 | **Live Room match suggested** | New `live_room` match in `matches_daily` | Push + In-app |
| 6 | **Match accepted by other person** | Other user accepts a mutual `person` match | Push + In-app |
| 7 | **Your match was accepted** | `match_set_state` → accepted + relationship edge created | Push + In-app |

---

## 2. COMMUNITY GROUPS (VTID-01084) — 5 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 8 | **Someone joined your group** | `community_join_group` for a group you created | In-app |
| 9 | **New group recommended for you** | `community_recommendations` with `rec_type=group` | Push + In-app |
| 10 | **Group activity update** | New post/meetup in a group you belong to | In-app |
| 11 | **New member in your group** | New `community_memberships` entry for your group | In-app |
| 12 | **Group milestone reached** | Group reaches member count threshold (5, 10, 25, 50) | In-app |

---

## 3. COMMUNITY MEETUPS / EVENTS (VTID-01084 + VTID-01090) — 7 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 13 | **New meetup recommended** | `community_recommendations` with `rec_type=meetup` | Push + In-app |
| 14 | **Meetup starting soon (1h)** | `community_meetups.starts_at` minus 1 hour | Push + In-app |
| 15 | **Meetup starting now** | `community_meetups.starts_at` reached | Push |
| 16 | **Meetup RSVP confirmed** | User RSVPs to a meetup | In-app |
| 17 | **Someone RSVPd to your meetup** | Other user RSVPs to a meetup you created | In-app |
| 18 | **Meetup cancelled** | Meetup deleted or cancelled by organizer | Push + In-app |
| 19 | **New meetup in a group you follow** | `community_create_meetup` in your group | Push + In-app |

---

## 4. LIVE ROOMS (VTID-01090 + VTID-01228) — 6 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 20 | **Live room starting** | `room_state` → `live` for a room you're invited to / matched with | Push + In-app |
| 21 | **Someone joined your live room** | `live_rooms/:id/join` event | In-app |
| 22 | **Live room ended — summary available** | `room_state` → `ended` + summary generated | Push + In-app |
| 23 | **Live room highlight added** | New highlight in a room you participated in | In-app |
| 24 | **You were invited to a live room** | Direct invite to join a live room | Push + In-app |
| 25 | **Live room recording ready** | Post-session recording/summary available | In-app |

---

## 5. CHAT / CONVERSATION (VTID-01216) — 3 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 26 | **New message from ORB assistant** | Proactive ORB message (autopilot-generated) | Push + In-app |
| 27 | **Conversation follow-up reminder** | 24h after an unfinished conversation topic | In-app |
| 28 | **ORB has a suggestion for you** | Autopilot generates proactive insight from conversation context | Push + In-app |

---

## 6. CALENDAR / SCHEDULER (VTID-01095) — 4 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 29 | **Daily recompute complete** | `processDailyRecomputeBatch` finishes for user | In-app (silent) |
| 30 | **Morning briefing ready** | Daily scheduler generates morning summary | Push + In-app |
| 31 | **Upcoming event today** | Calendar event within 2 hours | Push |
| 32 | **Weekly community digest** | Weekly cron — groups + matches + meetups summary | Push + In-app |

---

## 7. AUTOPILOT / RECOMMENDATIONS (VTID-01179 + VTID-01180) — 4 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 33 | **New recommendation available** | `autopilot_recommendations` with `status=new` | Push + In-app (badge) |
| 34 | **Recommendation expires soon** | `snoozed_until` approaching | In-app |
| 35 | **High-impact recommendation** | `impact_score >= 8` and `risk_level in (high, critical)` | Push + In-app |
| 36 | **Recommendation activated** | User activates recommendation → VTID created | In-app |

---

## 8. HEALTH & LONGEVITY (VTID-01081 + VTID-01083 + VTID-01103) — 6 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 37 | **Daily Vitana Index ready** | `health_recompute_daily` generates new scores | In-app |
| 38 | **Health score improvement** | Vitana Index increased by >=5 points vs 7-day avg | Push + In-app |
| 39 | **Health score decline detected** | Vitana Index decreased by >=5 points vs 7-day avg | Push + In-app |
| 40 | **Longevity signal alert** | Longevity signal trend = `declining` for >=3 days | Push + In-app |
| 41 | **New lab report processed** | `lab_reports_ingest` completes | In-app |
| 42 | **Wearable data synced** | `wearables_ingest` completes | In-app (silent) |

---

## 9. PREDICTIVE SIGNALS & RISK (VTID-01138 D44 + VTID-01143 D49) — 5 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 43 | **New predictive signal detected** | `d44_predictive_signals` inserted with `user_impact=high` | Push + In-app |
| 44 | **Positive momentum detected** | Signal type = `positive_momentum` | In-app |
| 45 | **Social withdrawal signal** | Signal type = `social_withdrawal`, confidence >= 60 | Push + In-app |
| 46 | **Risk mitigation suggestion** | New `risk_mitigations` row with `status=active` | Push + In-app |
| 47 | **Signal expired** | `d44_predictive_signals.status` → `expired` | In-app (silent) |

---

## 10. CONTEXTUAL OPPORTUNITIES (VTID-01142 D48) — 3 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 48 | **New opportunity surfaced** | `contextual_opportunities` with `status=active` | Push + In-app |
| 49 | **Opportunity expiring soon** | `expires_at` within 24 hours | In-app |
| 50 | **Health-priority opportunity** | `priority_domain=health` + confidence >= 70 | Push + In-app |

---

## 11. DIARY & MEMORY (VTID-01097 + VTID-01192) — 4 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 51 | **Daily diary reminder** | No diary entry today, evening time | Push |
| 52 | **Diary streak milestone** | Consecutive diary entries (3, 7, 14, 30 days) | Push + In-app |
| 53 | **Memory Garden grew** | New facts extracted via Cognee from conversation | In-app (silent) |
| 54 | **Weekly reflection prompt** | Weekly cron — guided template suggestion | Push + In-app |

---

## 12. RELATIONSHIPS & SOCIAL (VTID-01087 + VTID-01129 D35) — 3 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 55 | **New connection formed** | `relationship_edges` created with type `connection` or `match_accepted` | Push + In-app |
| 56 | **Relationship strength increased** | `relationship_edges.strength` increased significantly | In-app |
| 57 | **Social comfort boundary respected** | System filtered action based on comfort profile | In-app (silent) |

---

## 13. OFFERS & SERVICES (VTID-01092) — 3 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 58 | **New service recommendation** | Personalization engine suggests a service from `services_catalog` | In-app |
| 59 | **New product recommendation** | Personalization engine suggests a product from `products_catalog` | In-app |
| 60 | **Usage outcome check-in** | 7 days after user marks offer as `used` | In-app |

---

## 14. INVITE & GROWTH (Community Building) — 6 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 61 | **Invite friends to your group** | User creates or joins group with < 5 members | In-app |
| 62 | **Your friend joined Vitana** | Referred user completes onboarding | Push + In-app |
| 63 | **Your friend joined your group** | Referred user joins same group | Push + In-app |
| 64 | **People near you share your interests** | Matchmaking finds high-score person match in same locale | Push + In-app |
| 65 | **Weekly community growth summary** | Weekly cron — new members, meetups, active rooms | In-app |
| 66 | **Someone wants to connect with you** | Another user accepts a person-match involving you | Push + In-app |

---

## 15. SYSTEM & ACCOUNT — 4 notifications

| # | Notification | Trigger | Channel |
|---|---|---|---|
| 67 | **Welcome to Vitana** | User completes registration | Push + In-app |
| 68 | **Complete your profile** | Profile < 60% complete after 24h | In-app |
| 69 | **Onboarding step completed** | User completes each onboarding stage | In-app |
| 70 | **Weekly activity summary** | Weekly cron — diary entries, health, matches, community | Push + In-app |

---

## Summary

### Counts by Feature

| Feature | Count |
|---------|-------|
| Matchmaking | 7 |
| Community Groups | 5 |
| Meetups / Events | 7 |
| Live Rooms | 6 |
| Chat / Conversation | 3 |
| Calendar / Scheduler | 4 |
| Autopilot / Recommendations | 4 |
| Health & Longevity | 6 |
| Predictive Signals & Risk | 5 |
| Contextual Opportunities | 3 |
| Diary & Memory | 4 |
| Relationships & Social | 3 |
| Offers & Services | 3 |
| Invite & Growth | 6 |
| System & Account | 4 |
| **Total** | **70** |

### Delivery Channels

| Channel | Purpose | Example |
|---------|---------|---------|
| **Push** | Time-sensitive, high-engagement | Meetup starting, health alert, match accepted |
| **In-app** | Standard visibility (badges, inbox, feed) | Group activity, recommendations, diary reminder |
| **In-app (silent)** | Background updates, no interruption | Data synced, memory grew, signal expired |
| **Push + In-app** | Dual delivery for maximum engagement | New matches, friend joined, weekly digest |

### Priority Tiers

| Tier | Description | Examples |
|------|-------------|---------|
| **P0 (Critical)** | Health safety, time-critical | Health decline, high-impact signal, live room now |
| **P1 (High)** | Engagement drivers | New matches, meetup reminders, friend joined |
| **P2 (Medium)** | Community building | Group activity, diary reminders, opportunities |
| **P3 (Low/Silent)** | Background awareness | Data synced, memory grew, streaks |

### User Preference Controls (respects VTID-01119)

Users should be able to configure:
- Per-category toggle (health, social, community, autopilot)
- Channel preference (push only, in-app only, both, off)
- Quiet hours (no push between user-defined times)
- Frequency cap (max N push notifications per day)

### Governance Alignment

- All notifications respect `user_consent_states` (VTID-01135)
- All notifications respect `user_personal_boundaries`
- No dark patterns, no urgency manipulation (per D48 governance)
- Explainability: every notification links to its source data
- All notification deliveries emit OASIS events for audit trail

---

## Infrastructure Required (Not Yet Built)

| Component | Purpose |
|-----------|---------|
| `notifications` table | Notification storage with read/dismissed state |
| `notification_preferences` table | Per-user channel + category preferences |
| `notification_templates` table | Template definitions for each notification type |
| Push delivery service | FCM (Firebase Cloud Messaging) or equivalent |
| Notification gateway route | `/api/v1/notifications/*` CRUD endpoints |
| Scheduled notification worker | Cron-based triggers (reminders, digests, streaks) |
| Real-time delivery via SSE | Extend existing `sse-service.ts` for user-targeted delivery |
