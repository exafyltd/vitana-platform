# AP-0200: Community & Groups

> Automations for group lifecycle, meetup creation, invitations, and fostering active community participation.

---

## AP-0201 — Auto-Create Group from Interest Cluster

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Heartbeat detects 5+ users sharing a topic with no existing group |
| **Skill** | `vitana-community` |

**What it does:**
Detects clusters of users who share strong topic affinity but have no group to connect in. Suggests group creation to the most active user in the cluster.

**Actions:**
1. Query `user_topic_profile` — find topics with 5+ users scoring > 70
2. Check `community_groups` — is there a group with this `topic_key`?
3. If no group exists, identify most active user (highest topic score + most connections)
4. Send push: _"5 people share your passion for [topic] — want to start a group?"_
5. If accepted, call `POST /api/v1/community/groups` with topic pre-filled
6. Auto-invite the other cluster members via `POST /api/v1/community/groups/:id/invite`
7. Emit OASIS event `autopilot.community.group_suggested`

**APIs used:**
- `POST /api/v1/community/groups`
- `POST /api/v1/community/groups/:id/invite`

**Success metric:** Groups created from suggestions that reach 5+ active members in 30 days

---

## AP-0202 — Group Invite Follow-Up

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Group invitation pending > 48 hours |
| **Skill** | `vitana-community` |

**What it does:**
Sends a gentle reminder when a group invitation hasn't been acted on.

**Actions:**
1. Query `community_group_invitations` where `status = 'pending'` and `created_at < now() - 48h`
2. For each, send reminder push: _"[Inviter] invited you to join [Group] — [N] members are discussing [topic]"_
3. Max 1 reminder per invitation (mark as reminded to prevent repeat)
4. Emit OASIS event `autopilot.community.invite_reminder_sent`

**APIs used:**
- `POST /api/v1/community/invitations/:id/accept` (user-initiated)
- Notification service

**Success metric:** Acceptance rate after reminder vs. no reminder

---

## AP-0203 — New Member Welcome in Group

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | User joins a group |
| **Skill** | `vitana-community` |

**What it does:**
Sends a welcome message from Vitana Bot in the group context and notifies existing members.

**Actions:**
1. Detect join via `POST /api/v1/community/groups/:id/join` or invitation accept
2. Send Vitana Bot message to new member: _"Welcome to [Group]! Here's what this group is about: [description]. [N] members are active this week."_
3. Notify group creator: _"[Name] just joined [Group]!"_
4. If group has > 3 members, also notify recent active members
5. Emit OASIS event `autopilot.community.member_welcomed`

**APIs used:**
- `POST /api/v1/chat/send` (Vitana Bot)
- Notification service

---

## AP-0204 — Auto-Suggest Meetup from Group Activity

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | 5+ chat messages in a group within 1 hour |
| **Skill** | `vitana-community` + `vitana-daily` |

**What it does:**
When a group is buzzing with conversation, suggest creating a live meetup so members can talk face-to-face.

**Actions:**
1. Detect activity spike in group chat (5+ messages in 60min window)
2. Check if group has any upcoming meetups in next 48h — skip if yes
3. Send suggestion to group creator: _"[Group] is active today! Want to schedule a live session?"_
4. If accepted, call `POST /api/v1/community/meetups` with group context
5. Auto-invite all active members from the conversation
6. Emit OASIS event `autopilot.community.meetup_suggested`

**APIs used:**
- `POST /api/v1/community/meetups`
- `POST /api/v1/live-rooms` (for Daily.co room)
- Notification service

**Requires:** AP-0301 (Daily.co room creation)

---

## AP-0205 — Group Health Monitor

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Weekly heartbeat |
| **Skill** | `vitana-community` |

**What it does:**
Monitors group activity levels and takes proactive action for groups going dormant.

**Actions:**
1. For each group, count messages and meetups in last 14 days
2. If zero activity: notify group creator _"[Group] has been quiet — want to start a discussion or schedule a meetup?"_
3. If 1-2 activities: suggest a topic to discuss based on members' `user_topic_profile`
4. If thriving (5+ activities): celebrate with group _"[Group] had a great week!"_
5. Emit OASIS event `autopilot.community.group_health_checked`

**Success metric:** Dormant groups reactivated within 7 days of nudge

---

## AP-0206 — Cross-Group Introduction

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | User active in 2+ groups with overlapping topics |
| **Skill** | `vitana-community` |

**What it does:**
When a user bridges two groups, suggest they invite members from one group to the other where relevant.

**Actions:**
1. Detect users who are members of 2+ groups
2. Find topic overlap between the groups
3. If overlap > 60%, suggest to the bridge user: _"Members of [Group A] might love [Group B] — want to share it?"_
4. If accepted, generate group invite links for sharing
5. Emit OASIS event `autopilot.community.cross_group_suggested`

**Requires:** AP-0105

---

## AP-0207 — Meetup RSVP Encouragement

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Meetup created with < 3 RSVPs, 24h before start |
| **Skill** | `vitana-community` |

**What it does:**
Encourages more RSVPs for meetups that have low attendance commitment.

**Actions:**
1. Query meetups starting in next 24h with < 3 RSVPs
2. Find group members who haven't RSVP'd
3. Send push: _"[Meetup] is tomorrow! [N] people are going — join them?"_
4. If matched members are attending, personalize: _"[Name] is going to [Meetup] — come along!"_
5. Emit OASIS event `autopilot.community.rsvp_encouraged`

**APIs used:**
- `community_meetup_attendance`
- Notification service

---

## AP-0208 — Post-Meetup Connection Prompt

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Meetup end time passed |
| **Skill** | `vitana-community` |

**What it does:**
After a meetup ends, prompts attendees to connect with people they met.

**Actions:**
1. Query `community_meetup_attendance` where `status = 'attended'` for ended meetup
2. For each attendee pair that isn't already connected (check `relationship_edges`)
3. Send prompt: _"How was [Meetup]? Want to connect with [Name] who was there?"_
4. If accepted, create `relationship_edge` (origin: `meetup`)
5. Emit OASIS event `autopilot.community.post_meetup_connect`

**APIs used:**
- `POST /api/v1/match/:id/state`
- Notification service

**Success metric:** New connections formed after meetups

---

## AP-0209 — Group Creation from Match Cluster

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | 3+ mutual match accepts around same topic |
| **Skill** | `vitana-community` |

**What it does:**
When multiple users accept matches with each other around a shared topic, suggest forming a group.

**Actions:**
1. Detect cluster: 3+ users with mutual accepted matches
2. Find common `topic_key` across the cluster
3. Send to cluster: _"You and [N] others all connected over [topic] — want to create a group?"_
4. If any user accepts, create group and invite others
5. Emit OASIS event `autopilot.community.cluster_group_suggested`

**Requires:** AP-0103

---

## AP-0210 — Community Digest for Group Creators

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Weekly (Sunday 18:00) |
| **Skill** | `vitana-community` |

**What it does:**
Sends group creators a weekly digest of their group's activity, growth, and engagement.

**Actions:**
1. For each group, compile: new members, messages sent, meetups held, active discussions
2. Send to creator: _"Your group [Name] this week: +[N] new members, [M] messages, [K] meetups"_
3. Include suggestion if metrics are declining
4. Emit OASIS event `autopilot.community.creator_digest_sent`

**APIs used:**
- Notification service (push + inapp)
