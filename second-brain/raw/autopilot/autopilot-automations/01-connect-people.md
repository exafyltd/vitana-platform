# AP-0100: Connect People

> Automations that bring Vitana members together — matching, introductions, icebreakers, and first conversations. This is the **#1 priority domain** for community building.

---

## AP-0101 — Daily Match Delivery

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Cron — every day at 08:00 local time |
| **Skill** | `vitana-matchmaking` |

**What it does:**
Recomputes daily matches for all active users, generates one-tap prompt cards, and sends a push notification.

**Actions:**
1. Call `POST /api/v1/match/recompute/daily` — deterministic, longevity-weighted scoring
2. Call `POST /api/v1/autopilot/prompts/generate` — create prompt cards from matches
3. Emit push notification `new_daily_matches` via notification service
4. Emit OASIS event `autopilot.heartbeat.matches_delivered`

**APIs used:**
- `POST /api/v1/match/recompute/daily`
- `POST /api/v1/autopilot/prompts/generate`
- Notification service (FCM push)

**Success metric:** % of users who view their daily matches within 2 hours

**Notes:**
- Respects user `quiet_hours` from `autopilot_prompt_preferences`
- Skips users with `enabled: false` in prompt prefs
- Max `max_prompts_per_day` per user (default 5)
- Match types: `person`, `group`, `event`, `service`, `product`, `location`, `live_room`

---

## AP-0102 — "Someone Shares Your Interest" Nudge

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User idle > 3 days (no match interaction) |
| **Skill** | `vitana-matchmaking` |

**What it does:**
Detects users with sparse social graphs and proactively surfaces the most relevant person match with a personalized nudge.

**Actions:**
1. Query `relationship_edges` — count connections for user
2. If < 3 connections, query top person match from `user_matches`
3. Find shared `topic_key` from `user_topic_profile` for both users
4. Send push: _"Someone shares your passion for [topic] — want to connect?"_
5. Emit OASIS event `autopilot.connect.nudge_sent`

**APIs used:**
- `GET /api/v1/match/daily`
- `GET /api/v1/personalization/topics`
- Notification service

**Success metric:** Accept rate on nudge-prompted matches vs. organic

**Requires:** AP-0101 (matches must exist)

---

## AP-0103 — Mutual Accept Auto-Introduction

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Both users accept the same match (mutual accept detected) |
| **Skill** | `vitana-community` |

**What it does:**
When two users both accept a match, Autopilot sends a Vitana Bot chat message to each with an icebreaker based on their shared interests.

**Actions:**
1. Listen for `POST /api/v1/match/:id/state` with `state: accepted`
2. Check if counterpart also has `state: accepted` for same match
3. Query shared topics from `user_topic_profile` for both users
4. Generate icebreaker message (deterministic template, no LLM needed):
   _"You and [Name] both love [topic]. Say hi! Here's a conversation starter: [question]"_
5. Send via `POST /api/v1/chat/send` as Vitana Bot (`VITANA_BOT_USER_ID`)
6. Create `relationship_edge` (type: `matched`, origin: `autopilot`)
7. Emit OASIS event `autopilot.connect.introduction_sent`

**APIs used:**
- `POST /api/v1/match/:id/state`
- `POST /api/v1/chat/send`
- `GET /api/v1/personalization/topics`

**Success metric:** % of introduced pairs who exchange at least 1 message within 24h

---

## AP-0104 — First Conversation Starter

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Match accepted but no chat messages exchanged after 2 hours |
| **Skill** | `vitana-community` |

**What it does:**
If two matched users haven't started chatting yet, Vitana Bot sends a gentle suggestion with a tailored conversation topic.

**Actions:**
1. After AP-0103 introduction, wait 2 hours
2. Query `chat_messages` for the pair — check if empty
3. If no messages, send Vitana Bot nudge:
   _"Still thinking about what to say to [Name]? Try asking about their experience with [shared_topic]."_
4. Emit OASIS event `autopilot.connect.conversation_starter_sent`

**APIs used:**
- `GET /api/v1/chat/conversation/:peerId`
- `POST /api/v1/chat/send`

**Success metric:** % of nudged pairs who start chatting vs. control

**Requires:** AP-0103

---

## AP-0105 — Group Recommendation Push

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Weekly (Monday 10:00) or when new group is created |
| **Skill** | `vitana-community` |

**What it does:**
Recomputes group recommendations based on user interests, memory diary entries, and longevity signals, then pushes top 3 groups per user.

**Actions:**
1. Call `POST /api/v1/community/recommendations/recompute`
2. For each user, get top 3 from `GET /api/v1/community/recommendations`
3. For each recommendation, get rationale from `GET /api/v1/community/recommendations/:id/explain`
4. Send push: _"We found 3 groups you might love — [Group1] has [N] members interested in [topic]"_
5. Emit OASIS event `autopilot.community.groups_recommended`

**APIs used:**
- `POST /api/v1/community/recommendations/recompute`
- `GET /api/v1/community/recommendations`
- `GET /api/v1/community/recommendations/:id/explain`
- Notification service

**Success metric:** Group join rate from recommendations

---

## AP-0106 — "People You Know Are Here" Social Proof

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | User views group detail page but doesn't join within 1 hour |
| **Skill** | `vitana-community` |

**What it does:**
If a user browses a group but doesn't join, check if any of their connections are members. If yes, send a social proof nudge.

**Actions:**
1. Track group detail page view (frontend event → OASIS)
2. After 1 hour without join, query `community_group_members` for group
3. Cross-reference with user's `relationship_edges`
4. If connections found: _"[Name1] and [N] others you know are in [Group]. Join them?"_
5. Emit OASIS event `autopilot.community.social_proof_sent`

**APIs used:**
- `GET /api/v1/social/connections`
- Notification service

**Success metric:** Join rate after social proof vs. without

**Requires:** AP-0105

---

## AP-0107 — Proactive Social Alignment Suggestions

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Weekly batch or on-demand via API |
| **Skill** | `vitana-matchmaking` |

**What it does:**
Uses the D47 Social Alignment Engine to generate proactive suggestions across all domains (person, group, event, service, location). Surfaces them via the alignment API.

**Actions:**
1. Call `POST /api/v1/alignment/generate` — generates batch of suggestions
2. Filter by min relevance (75%), min shared signals (2)
3. Suggestions appear in app via `GET /api/v1/alignment/suggestions`
4. Track user actions: `POST /api/v1/alignment/action` (view/connect/save/not_now)
5. Cleanup expired: `POST /api/v1/alignment/cleanup`

**APIs used:**
- Full D47 Social Alignment API
- Max 20 suggestions per batch

**Notes:** Already implemented in gateway. Bridge skill wraps the existing API for heartbeat automation.

---

## AP-0108 — Match Quality Learning Loop

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | User gives feedback on a match (like/dislike/block/wrong_topic) |
| **Skill** | `vitana-matchmaking` |

**What it does:**
Processes match feedback to tune future matching. Updates topic profiles, applies dampening, and logs to personalization change log.

**Actions:**
1. Receive `POST /api/v1/match/:id/feedback`
2. Apply score deltas: like (+8), dislike (-6, dampen 7 days), block (-10, block 90 days), wrong_topic (shift topics)
3. Update `user_topic_profile` scores
4. Write to `personalization_change_log` for "Why improved?" transparency
5. Emit OASIS event `autopilot.match.feedback_processed`

**APIs used:**
- `POST /api/v1/match/:id/feedback`
- `GET /api/v1/personalization/changes`

**Notes:** Already implemented (VTID-01094). Bridge wraps for automated follow-up actions.

---

## AP-0109 — Proactive Match Batch Delivery

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Heartbeat or cron after daily match recompute |
| **Skill** | `vitana-matchmaking` |

**What it does:**
Triggers proactive batch message delivery for all pending matches that users haven't seen yet.

**Actions:**
1. Call `POST /api/v1/match/proactive/send`
2. System delivers match cards to all eligible users
3. Respects rate limits and quiet hours

**APIs used:**
- `POST /api/v1/match/proactive/send`

**Notes:** Endpoint already exists. Needs heartbeat trigger integration.

---

## AP-0110 — Opportunity Surfacing with Social Layer

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | D48 opportunity detected for user |
| **Skill** | `vitana-matchmaking` |

**What it does:**
Enriches D48 opportunities with social context — tells users which of their connections are also interested in the same opportunity.

**Actions:**
1. Listen for new entries in `contextual_opportunities`
2. For each opportunity, query user's `relationship_edges`
3. Cross-reference with other users' engaged/saved opportunities
4. Enrich notification: _"3 of your connections are interested in [opportunity]"_
5. Emit OASIS event `autopilot.opportunity.socially_enriched`

**APIs used:**
- `POST /api/v1/opportunity-surfacing/surface`
- `GET /api/v1/social/connections`

**Requires:** AP-0107
