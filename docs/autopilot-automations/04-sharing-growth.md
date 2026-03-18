# AP-0400: Sharing & Growth

> Automations for viral sharing, WhatsApp distribution, social media growth, referral tracking, and community expansion. This is the **#1 priority for growth**.

---

## AP-0401 — WhatsApp Event Share Link

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User taps "Share" on an event/meetup |
| **Skill** | `vitana-sharing` (NEW) |

**What it does:**
Generates a deep link with UTM tracking, formats a WhatsApp-ready message template, and opens the native share sheet.

**Actions:**
1. Generate deep link: `https://vitana.app/event/{id}?utm_source=whatsapp&utm_medium=share&utm_campaign=event_share&ref={user_id}`
2. Format WhatsApp message template:
   ```
   Hey! Join me at "{Event Title}" on {date} 🌿
   {N} people are already going.

   Join here: {deep_link}
   ```
3. Return `whatsapp://send?text={encoded_message}` URI
4. Log share action to `autopilot_logs` with referrer tracking
5. Emit OASIS event `autopilot.sharing.whatsapp_event_shared`

**APIs needed (NEW):**
- `POST /api/v1/sharing/generate-link` — deep link with UTM + referral
- `POST /api/v1/sharing/format-whatsapp` — message template formatting

**Success metric:** Click-through rate on shared links, signups from shared links

---

## AP-0402 — WhatsApp Group Invite

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Group creator taps "Invite via WhatsApp" |
| **Skill** | `vitana-sharing` |

**What it does:**
Generates a group invite link for external sharing via WhatsApp, with group context embedded.

**Actions:**
1. Generate invite link: `https://vitana.app/group/{id}/join?ref={user_id}&utm_source=whatsapp`
2. Format message:
   ```
   Join our "{Group Name}" group on Vitana!
   We discuss {topic} — {N} members and growing.

   Join here: {invite_link}
   ```
3. Return WhatsApp share URI
4. Track in `autopilot_logs` with `action: 'sharing.whatsapp_group_invite'`
5. Emit OASIS event `autopilot.sharing.whatsapp_group_invited`

**Success metric:** New members from WhatsApp invites

---

## AP-0403 — Social Media Event Card Generator

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Meetup created (auto) or user taps "Share on Social" |
| **Skill** | `vitana-sharing` |

**What it does:**
Generates a shareable Open Graph (OG) image card for events with title, date, attendee count, and topic. Uses the existing `og-match` edge function as a base.

**Actions:**
1. Generate OG card with: event title, date/time, attendee count, topic icon, Vitana branding
2. Upload to CDN (Supabase Storage)
3. Create shareable URL with OG meta tags: `https://vitana.app/share/event/{id}`
4. Notify event creator: _"Your event card is ready to share! Post it on Instagram, Facebook, or X."_
5. Emit OASIS event `autopilot.sharing.social_card_generated`

**APIs needed (NEW):**
- `POST /api/v1/sharing/generate-card` — OG card image generation
- Supabase Storage for card hosting

**Existing resource:** `supabase/functions/og-match/` — OG image generation function (adapt for events)

---

## AP-0404 — "Invite a Friend" After Positive Experience

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User gives `like` feedback on match OR rates meetup 4+/5 |
| **Skill** | `vitana-sharing` |

**What it does:**
Capitalizes on positive moments to encourage referrals. Detects when a user has a great experience and prompts them to invite someone.

**Actions:**
1. Detect positive signals:
   - `POST /api/v1/match/:id/feedback` with `feedback_type: 'like'`
   - Post-event rating >= 4/5
   - 3+ match accepts in one day
2. Wait 30 minutes (don't interrupt the positive moment)
3. Send push: _"Glad you're enjoying Vitana! Know someone who'd love it? Invite them."_
4. Include pre-filled referral link with personal invite code
5. Emit OASIS event `autopilot.sharing.invite_prompted`

**APIs used:**
- `POST /api/v1/match/:id/feedback` (trigger)
- `POST /api/v1/sharing/generate-link` (referral link)
- Notification service

**Success metric:** Referral rate after positive experience vs. cold invite

**Requires:** AP-0108

---

## AP-0405 — Referral Tracking & Reward

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | New user signs up via referral link |
| **Skill** | `vitana-sharing` |

**What it does:**
Tracks the complete referral chain from share → click → signup → activation. Notifies referrer and credits rewards.

**Actions:**
1. On signup, check `ref` parameter from URL
2. Create `referral` record: `referrer_id`, `referred_id`, `source` (whatsapp/social/direct), `utm_params`
3. Send referrer notification: _"Your friend [Name] just joined Vitana!"_
4. After referred user completes onboarding (7 days active): credit referrer reward (wallet credits, pro trial, etc.)
5. Emit OASIS event `autopilot.sharing.referral_completed`

**Database needed (NEW):**
```sql
CREATE TABLE referrals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  referrer_id uuid NOT NULL,
  referred_id uuid NOT NULL,
  source text,       -- whatsapp, social, direct, email
  utm_campaign text,
  status text,       -- clicked, signed_up, activated, rewarded
  created_at timestamptz DEFAULT now()
);
```

**Success metric:** Referral-to-activation conversion rate

---

## AP-0406 — Auto-Post Community Highlights

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Weekly cron (Friday 14:00) |
| **Skill** | `vitana-sharing` |

**What it does:**
Aggregates community highlights (new members, popular events, active groups) and queues a social media post for admin approval.

**Actions:**
1. Aggregate weekly stats: new members, most active groups, best-attended events, trending topics
2. Generate post template:
   ```
   This week in the Vitana community:
   ✦ {N} new members joined
   ✦ Most popular event: "{Event}" ({M} attendees)
   ✦ Trending topic: {topic}
   ✦ {K} new connections made

   Join us: vitana.app
   ```
3. Queue for admin review (do NOT auto-post)
4. Store in `social_post_queue` table
5. Emit OASIS event `autopilot.sharing.highlights_queued`

**Notes:**
- All stats are anonymized (no user names in public posts)
- Admin must approve before any external posting
- Support formats: Instagram, X/Twitter, LinkedIn, Facebook

---

## AP-0407 — User Profile Share Card

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | User taps "Share my profile" |
| **Skill** | `vitana-sharing` |

**What it does:**
Generates a privacy-safe profile card showing only interests/topics (never health data) for external sharing.

**Actions:**
1. Query user's top 5 topics from `user_topic_profile`
2. Generate card with: display name, topic interests, member since date, Vitana branding
3. NO health data, NO personal details, NO connection count
4. Create shareable URL: `https://vitana.app/u/{username}`
5. Emit OASIS event `autopilot.sharing.profile_card_generated`

**Notes:** PHI redaction must run on profile data before card generation (AP-0601)

---

## AP-0408 — Event Countdown Share Prompt

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | 48 hours before a meetup with 5+ RSVPs |
| **Skill** | `vitana-sharing` |

**What it does:**
Prompts attendees to share the event externally to attract more participants.

**Actions:**
1. Detect meetups starting in 48h with 5+ RSVPs
2. Send to all RSVP'd users: _"[Event] is in 2 days! Help spread the word — share with friends"_
3. Include pre-formatted WhatsApp + social share buttons
4. Track shares per event for social proof
5. Emit OASIS event `autopilot.sharing.countdown_share_prompted`

**Requires:** AP-0401

---

## AP-0409 — "Your Week on Vitana" Shareable Recap

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Weekly (Sunday morning with weekly summary) |
| **Skill** | `vitana-sharing` |

**What it does:**
Generates a personal, shareable weekly recap showing engagement (not health data).

**Actions:**
1. Compile: connections made, events attended, groups active in, topics explored
2. Generate visual recap card (like Spotify Wrapped but for community)
3. Send to user: _"Your week on Vitana: [N] connections, [M] events, [K] conversations"_
4. Include "Share your recap" button (social/WhatsApp)
5. Emit OASIS event `autopilot.sharing.weekly_recap_generated`

**Notes:**
- Never include health metrics in shareable content
- User must explicitly choose to share (opt-in only)

---

## AP-0410 — Viral Loop: Shared Event → New User Onboarding

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Non-member clicks a shared event/group link |
| **Skill** | `vitana-sharing` |

**What it does:**
When someone outside Vitana clicks a shared link, creates a smooth onboarding flow that lands them directly in the relevant context.

**Actions:**
1. Non-member clicks `https://vitana.app/event/{id}?ref={user_id}`
2. Show event preview (no login required): title, description, attendee count, topic
3. CTA: "Join Vitana to RSVP" → streamlined signup
4. After signup, auto-RSVP to the event + connect with referrer
5. Create `referral` record linking to referrer
6. Notify referrer: _"Someone joined through your share of [Event]!"_
7. Emit OASIS event `autopilot.sharing.viral_signup`

**Success metric:** Signup rate from shared links, time to first connection

**Requires:** AP-0405
