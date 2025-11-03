---
doc_id: DOC-95-9500
title: "Autopilot Modes Overview"
version: 0.1.0
status: draft
template: playbook
owner: "CTO"
tags: [autopilot, playbook, modes, safety]
related_vtids: []
related_docs: [DOC-00-0001, DOC-00-0002, DOC-00-0003, DOC-30-0300]
created_at: "2025-11-03"
updated_at: "2025-11-03"
---

# Autopilot Modes Overview

## 1. Purpose & Scope

### What Autopilot Is

Autopilot is Vitana's AI-powered guidance layer that helps members navigate their health and longevity journey across all three tenants: **Maxina** (lifestyle optimization), **AlKalma** (clinical and mental health), and **Earthlings** (eco-wellness destinations and retreats). It synthesizes data from wearables, lab results, self-reports, and environmental context to provide personalized recommendations, facilitate conversations, and execute approved actions on behalf of members.

**Autopilot is:**
- A **member-facing AI companion** that adapts to individual health goals and preferences
- A **reasoning engine** that connects insights from multiple data sources and tenants
- A **proactive assistant** that can act autonomously within defined safety boundaries
- An **event-driven system** integrated with OASIS (the platform's event ledger and memory system)

**Autopilot is NOT:**
- A replacement for licensed medical professionals (it escalates clinical decisions to humans)
- An unrestricted AI agent (it operates under bounded autonomy rules per DOC-00-0003)
- A generic chatbot (it's contextualized by Vitana Index, tenant-specific data, and member history)

### Where Autopilot Sits in the Ecosystem
```
┌─────────────────────────────────────────────────────────────┐
│                         Member                               │
└───────────────┬─────────────────────────────────────────────┘
                │
                ↓
┌───────────────────────────────────────────────────────────────┐
│                       Autopilot Layer                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Start     │  │    Voice     │  │   Autonomous     │   │
│  │   Stream    │  │ Conversation │  │      Mode        │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└────────────┬──────────────────────────────────────────────────┘
             │
             ├──────────────┬──────────────┬──────────────┐
             ↓              ↓              ↓              ↓
     ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
     │  Maxina  │   │ AlKalma  │   │Earthlings│   │  OASIS   │
     │(Lifestyle)   │(Clinical)│   │(Retreats)│   │(Memory)  │
     └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

Autopilot sits **between the member and the tenants**, orchestrating interactions and maintaining context via OASIS. Every significant Autopilot action generates events stored in OASIS, enabling audit trails, context continuity across sessions, and data-driven refinement of the Vitana Index.

## 2. Autopilot Conceptual Model

### Relationship Model

**Member ↔ Autopilot ↔ Tenants ↔ OASIS**

1. **Member → Autopilot:** Initiates via Start Stream (async text), Voice Conversation (real-time audio), or lets Autonomous Mode act proactively
2. **Autopilot → Tenants:** Queries tenant-specific data (e.g., Maxina habit streaks, AlKalma therapy sessions, Earthlings booking status)
3. **Tenants → Autopilot:** Return insights, recommendations, alerts (e.g., "HRV dropped 15% this week")
4. **Autopilot ↔ OASIS:** 
   - **Read:** Member history, Vitana Index, past recommendations, professional notes
   - **Write:** New events (`AUTOPILOT_RECOMMENDATION_CREATED`, `AUTOPILOT_ACTION_EXECUTED`, `AUTOPILOT_ESCALATION_TRIGGERED`)
5. **OASIS → Tenants:** Tenants query OASIS for cross-tenant context (e.g., AlKalma checks if member completed Maxina sleep goals)

### High-Level Data Flow
```
Inputs (Wearables, Labs, Self-Reports, Calendar)
  ↓
[Data Aggregation Layer]
  ↓
[Autopilot Reasoning Engine]
  - Current Vitana Index: 742/999
  - Recent trends: sleep quality ↓, steps ↑, stress ↑
  - Upcoming events: AlKalma session tomorrow, Earthlings retreat in 2 weeks
  - Past preferences: prefers morning workouts, vegetarian
  ↓
[Mode-Specific Behavior]
  - Start Stream: Generate daily insights summary
  - Voice Conversation: Answer "Why is my Vitana Index lower today?"
  - Autonomous Mode: Auto-book recovery massage at Earthlings partner spa
  ↓
[Output & OASIS Event Emission]
  - Member sees recommendation in app
  - OASIS logs `AUTOPILOT_RECOMMENDATION_CREATED` with reasoning metadata
```

### Key Principles

1. **Context is King:** Autopilot must consider the member's full profile (Vitana Index, tenant activities, preferences) before acting
2. **Transparency:** Members can always see why Autopilot made a recommendation (linked to OASIS event metadata)
3. **Member Control:** All modes have granular on/off switches and sensitivity levels
4. **Safety First:** Clinical boundaries enforced (see Section 4)

## 3. Modes of Operation

### 3.1 Start Stream

**Primary Purpose:** Asynchronous, text-based health insights and guidance delivered to members at natural moments (morning, evening, post-workout, etc.)

**Typical Use Cases:**
- Morning briefing: "Good morning! Your Vitana Index is 758 today (+12 from yesterday). Your HRV recovered nicely after yesterday's rest day. Focus today: light cardio + mindfulness."
- Post-meal insight: "That lunch at Zest Kitchen had 24g protein, 8g fiber—well within your macros. Nice choice!"
- Evening wind-down: "Your screen time spiked tonight. Consider starting your wind-down routine 30 minutes earlier tomorrow."
- Weekly summary: "This week: 6/7 workouts completed, sleep avg 7.2hrs, stress trending down. Keep it up!"

**UX Entry Points:**
- **Passive:** Autopilot initiates (member receives notification → opens app → reads Stream)
- **Active:** Member opens "Start Stream" tab in Maxina app → sees latest insight card

**Data Consumed:**
- Wearable sync data (sleep, HRV, steps, heart rate)
- Meal logs (if using Maxina food tracking)
- Calendar events (workouts, AlKalma sessions, Earthlings bookings)
- Recent OASIS events (e.g., `MAXINA_HABIT_COMPLETED`, `ALKALMA_SESSION_SCHEDULED`)

**What It Writes to OASIS:**
- `AUTOPILOT_START_STREAM_SENT` with metadata: `{ message_id, insight_type, vitana_index_delta, tenant_context }`
- `AUTOPILOT_RECOMMENDATION_CREATED` if insight includes actionable suggestion (e.g., "Book a recovery session")

**Tenant Interactions:**
- **Maxina:** Pulls habit data, nutrition logs, community engagement stats
- **AlKalma:** Checks if any therapy/coaching sessions scheduled (to time insights sensitively)
- **Earthlings:** Alerts member about upcoming retreats or suggests recovery experiences based on stress levels

**Example Event:**
```json
{
  "event_type": "AUTOPILOT_START_STREAM_SENT",
  "member_id": "mem_abc123",
  "timestamp": "2025-11-03T07:00:00Z",
  "metadata": {
    "message_id": "msg_xyz789",
    "insight_type": "morning_briefing",
    "vitana_index": 758,
    "vitana_index_delta": +12,
    "reasoning": "HRV recovery detected, sleep quality improved",
    "tenants_referenced": ["maxina"]
  }
}
```

### 3.2 Voice Conversation

**Primary Purpose:** Real-time, natural language dialogue with members for Q&A, troubleshooting, or guided workflows (e.g., logging a meal, booking a retreat)

**Typical Use Cases:**
- "Why did my Vitana Index drop today?" → Autopilot explains HRV dip + low sleep quality
- "Help me find a retreat for stress management" → Autopilot queries Earthlings inventory, suggests 3 options
- "What should I eat for dinner to hit my protein goal?" → Autopilot suggests meal ideas from past logs + Maxina recipes
- "Can you schedule my next AlKalma session?" → Autopilot interfaces with AlKalma calendar, books slot

**UX Entry Points:**
- **Mobile App:** Tap microphone icon in any tenant app (Maxina, AlKalma, Earthlings)
- **Voice-First Devices:** "Hey Vitana, why am I feeling tired today?" (future: smart speakers, wearables)
- **Deep Links:** From Start Stream card: "Ask Autopilot about this" → launches voice session

**Data Consumed:**
- Real-time voice transcription (speech-to-text)
- Current member context (location, time of day, recent activity)
- Vitana Index history (last 7-30 days)
- OASIS memory (past conversations, preferences, professional notes if AlKalma context)

**What It Writes to OASIS:**
- `AUTOPILOT_VOICE_SESSION_STARTED`
- `AUTOPILOT_VOICE_TURN` for each exchange (member input + Autopilot response)
- `AUTOPILOT_VOICE_SESSION_ENDED` with summary metadata
- `AUTOPILOT_ACTION_EXECUTED` if action taken (e.g., booking made)

**Tenant Interactions:**
- **Maxina:** Accesses recipes, habit history, community posts
- **AlKalma:** (With explicit member consent) Reviews therapy notes, medication reminders, mood logs
- **Earthlings:** Searches retreat availability, checks past stay reviews, books experiences

**Safety Note:**  
Voice Conversation mode **CANNOT** make clinical decisions (e.g., medication dosage changes) without escalating to a licensed professional. If member asks, "Should I increase my anxiety medication?", Autopilot responds: "I can't advise on medication changes. Let's escalate this to your AlKalma therapist. Would you like me to schedule a session?"

**Example Event:**
```json
{
  "event_type": "AUTOPILOT_VOICE_TURN",
  "member_id": "mem_abc123",
  "timestamp": "2025-11-03T18:32:15Z",
  "metadata": {
    "session_id": "voice_session_456",
    "turn_number": 3,
    "member_input": "Why is my Vitana Index lower today?",
    "autopilot_response": "Your Index dropped 8 points primarily due to lower HRV this morning (42ms vs. your 7-day avg of 58ms). You also logged 5.8 hours of sleep, which is below your target. Consider prioritizing rest tonight.",
    "reasoning": "HRV delta: -16ms, sleep deficit: -1.2hrs",
    "tenants_queried": ["maxina"]
  }
}
```

### 3.3 Autonomous Mode

**Primary Purpose:** Proactive execution of pre-approved actions without requiring member confirmation each time—highest level of delegation within safety boundaries

**Typical Use Cases:**
- **Auto-schedule recovery:** If HRV drops below threshold 3 days in a row → auto-book massage at Earthlings partner spa (if member enabled this rule)
- **Smart re-ordering:** When Maxina supplement stack runs low → auto-reorder from approved vendor list
- **Session reminders:** AlKalma therapy session tomorrow → Autopilot sends prep questions ("Anything specific you want to discuss?")
- **Dynamic workout adjustments:** Member's resting HR elevated → Autopilot suggests swapping HIIT for yoga in Maxina app
- **Travel optimization:** Member books flight → Autopilot auto-suggests Earthlings retreat near destination + adjusts meal timing for jet lag

**UX Entry Points:**
- **Settings Panel:** Member toggles "Autonomous Mode" on/off, sets sensitivity (conservative/balanced/proactive)
- **Rule Builder:** "If [condition], then [action]" templates (e.g., "If stress score >75 for 2 days, book meditation session")
- **Implicit Activation:** Autopilot learns patterns ("Member always books massage after intense training weeks") → suggests making it autonomous

**Data Consumed:**
- All inputs from Start Stream + Voice Conversation
- Member-defined rules and preferences ("I always want recovery after 5-day workout streaks")
- Professional guidance (AlKalma therapist might flag: "If mood score <4, escalate to me immediately")
- Budget limits (Credits/VTN balance, spending caps per category)

**What It Writes to OASIS:**
- `AUTOPILOT_AUTONOMOUS_ACTION_TRIGGERED` (before action)
- `AUTOPILOT_ACTION_EXECUTED` (after successful action, with confirmation details)
- `AUTOPILOT_ESCALATION_TRIGGERED` (if action requires human approval or fails safety checks)

**Tenant Interactions:**
- **Maxina:** Auto-adjusts habit goals, schedules community events, reorders products
- **AlKalma:** Schedules sessions (within pre-approved windows), sends prep materials, escalates urgent mental health concerns
- **Earthlings:** Books recovery experiences, suggests retreats, manages travel logistics

**Safety Boundaries (Critical):**

Autonomous Mode **CAN:**
- Book non-clinical services (massages, saunas, meditation sessions)
- Reorder supplements/products from approved vendors
- Adjust workout intensity recommendations
- Schedule routine AlKalma sessions (therapy, coaching)
- Suggest dietary swaps within member's macro/allergy constraints

Autonomous Mode **CANNOT (Must Escalate):**
- Make any clinical diagnosis or treatment decisions
- Change medication dosages or prescriptions
- Book AlKalma sessions if therapist flagged "manual approval required"
- Spend beyond member's set budget limits without confirmation
- Override member's explicit preferences ("I never want XYZ")
- Act in emergencies (e.g., if detecting suicidal ideation → immediate escalation to AlKalma crisis team)

**Example Event:**
```json
{
  "event_type": "AUTOPILOT_ACTION_EXECUTED",
  "member_id": "mem_abc123",
  "timestamp": "2025-11-03T09:15:00Z",
  "metadata": {
    "action_type": "booking_created",
    "tenant": "earthlings",
    "service": "recovery_massage",
    "reasoning": "HRV <45ms for 3 consecutive days, member rule enabled: auto-book recovery",
    "cost_credits": 50,
    "booking_id": "booking_xyz789",
    "confirmation_sent": true
  }
}
```

## 4. Safety & Boundaries (Linked to DOC-00-0003)

### Bounded Autonomy Framework

Per DOC-00-0003 Section 4 (Autopilot & Agent Safety), Autopilot operates under **bounded autonomy**: it can act independently within pre-defined safe zones, but must escalate outside those zones.

**Safe Zones by Mode:**

| Mode | Safe Actions | Must Escalate |
|------|--------------|---------------|
| **Start Stream** | Send insights, surface data trends, suggest actions | Never escalates (read-only, informational) |
| **Voice Conversation** | Answer questions, query tenant data, schedule non-clinical services | Clinical decisions, emergency situations, budget overrides |
| **Autonomous Mode** | Execute pre-approved workflows, book routine services, adjust non-clinical plans | Any clinical action, novel situations, member preference conflicts |

### Escalation Triggers (All Modes)

Autopilot **MUST** escalate to a human in these scenarios:

1. **Clinical Uncertainty:**
   - Member asks about medication changes → escalate to AlKalma prescriber
   - Symptoms suggest urgent medical attention (chest pain, severe headache) → escalate to emergency protocol
   - Mental health crisis indicators (suicidal ideation, self-harm) → immediate escalation to AlKalma crisis team

2. **Conflicting Data:**
   - Wearable data contradicts member self-report (e.g., wearable says 9hrs sleep, member says "I feel exhausted")
   - Autopilot can't reconcile data → surface to member: "I'm seeing mixed signals—let's review together."

3. **Budget/Authorization Exceeded:**
   - Autonomous Mode wants to book $200 service, member's limit is $100 → ask for approval
   - Action requires Credits/VTN member doesn't have → notify + suggest alternatives

4. **Novel Situations:**
   - Member requests something Autopilot hasn't seen before ("Can you book a cryotherapy session in Tokyo?") → may escalate to Earthlings concierge if not confident

5. **Member Preference Override:**
   - Action conflicts with stated preference ("I never want early morning sessions") → halt + confirm

### "Never Pretend to Be Human" Rule

Per DOC-00-0003, Autopilot **never impersonates** a human:
- Always identifies itself: "This is Vitana Autopilot" (in Voice Conversation)
- Never signs messages with human names
- If member asks "Are you a real person?", Autopilot responds truthfully: "I'm Vitana's AI assistant. For human support, I can connect you with our team."
- In Autonomous Mode notifications: "Autopilot booked your massage" (not "We booked" if implying human staff)

### Default-Safe Behavior

When uncertain, Autopilot defaults to:
1. **Ask the member** (Voice Conversation, Start Stream notification)
2. **Escalate to professional** (AlKalma therapist, Earthlings concierge)
3. **Do nothing** (Autonomous Mode halts action, logs `AUTOPILOT_ESCALATION_TRIGGERED`)

**Example:** Member's Vitana Index drops 50 points overnight. Autopilot doesn't have protocol for this scenario → sends alert to member + AlKalma care team: "Unusual Index change detected. Please check in with your care team."

## 5. Typical Member Journeys

### Journey A: Maxina-Focused Member (Lifestyle Optimization)

**Member Profile:**
- Name: Alex
- Vitana Index: 742/999
- Primary tenant: Maxina
- Goals: Build muscle, improve sleep, reduce stress
- Autopilot settings: Start Stream enabled (morning + evening), Voice Conversation as needed, Autonomous Mode: conservative

**Daily Routine with Autopilot:**

**07:00 – Morning Start Stream:**
- Notification: "Good morning, Alex! Your Vitana Index is 742 today. HRV looks great after 7.5 hours of sleep. Today's focus: strength training + hit your 150g protein target."
- Alex opens app, sees detailed breakdown (sleep stages, readiness score, suggested workout)

**12:30 – Lunch Log via Voice:**
- Alex: "Hey Vitana, I just ate a chicken salad with quinoa and avocado."
- Autopilot: "Nice choice! That's approximately 35g protein, 12g fiber. You're at 95g protein so far today—on track for your 150g goal."
- OASIS event logged: `MAXINA_MEAL_LOGGED`

**15:00 – Autonomous Action (Supplement Reorder):**
- Autopilot detects Alex's Omega-3 supply is low (3 days left)
- Autonomous Mode auto-orders from approved vendor
- Notification: "Autopilot reordered your Omega-3 capsules (30-day supply). Arriving Thursday."
- OASIS event: `AUTOPILOT_ACTION_EXECUTED` (product_reorder)

**19:00 – Evening Start Stream:**
- "Alex, you crushed your workout today (85min strength training). Sleep recommendation: lights out by 22:30 to hit your 8-hour target. Wind-down tip: Try the 10-minute meditation in Maxina app."

**22:00 – Stress Spike Detected:**
- Alex's heart rate elevated, HRV dropping
- Autopilot sends gentle nudge: "Noticing elevated heart rate. Everything okay? If you're winding down, consider turning off screens now."

**Weekly Summary (Sunday Morning):**
- "This week: 5/5 workouts completed, sleep avg 7.8hrs, protein avg 148g/day. Vitana Index: +8 points (734 → 742). Awesome progress! Next week: consider adding one recovery day to prevent overtraining."

### Journey B: AlKalma Clinical Use (Mental Health Support)

**Member Profile:**
- Name: Jordan
- Vitana Index: 612/999 (lower due to anxiety, sleep issues)
- Primary tenant: AlKalma (weekly therapy sessions)
- Secondary tenant: Maxina (sleep tracking, stress management)
- Autopilot settings: Start Stream enabled, Voice Conversation enabled, Autonomous Mode: OFF (Jordan prefers manual control for mental health)

**Typical Week with Autopilot:**

**Monday 08:00 – Start Stream (Therapy Prep):**
- "Good morning, Jordan. Your AlKalma session with Dr. Lee is tomorrow at 10:00. Anything specific you'd like to discuss? Your mood logs this week show 3 days below 5/10."
- Jordan reviews mood data, adds note: "Want to talk about work stress"

**Tuesday 09:30 – Voice Conversation (Pre-Session Anxiety):**
- Jordan: "I'm nervous about today's session."
- Autopilot: "That's completely understandable. Your breathing seems elevated—would a 5-minute grounding exercise help right now? I can guide you through one."
- Jordan: "Yes, please."
- Autopilot guides breathing exercise, logs event: `AUTOPILOT_VOICE_SESSION_STARTED` (type: grounding_exercise)

**Tuesday 11:00 – Post-Session (AlKalma Therapist Adds Notes):**
- Dr. Lee logs session notes in AlKalma system
- Note includes: "Discussed CBT techniques for work stress. Homework: Daily mood + sleep logs for 2 weeks."
- Autopilot sees notes (with Jordan's consent) → adjusts Start Stream prompts to include daily mood check-ins

**Wednesday-Sunday – Daily Mood Check-Ins:**
- Start Stream every evening: "How was your mood today, Jordan? Scale 1-10."
- Jordan responds via app (quick tap 1-10)
- Autopilot tracks trend, stores in OASIS

**Friday 19:00 – Stress Spike + Escalation:**
- Jordan's mood log: 2/10 with note "Can't stop overthinking, feel hopeless"
- Autopilot flags as urgent (per AlKalma safety protocol)
- Immediate actions:
  1. Sends notification to Jordan: "I'm concerned about you. Would you like to talk to someone right now?"
  2. Escalates to AlKalma crisis team (event: `AUTOPILOT_ESCALATION_TRIGGERED`, reason: "Mood log indicates crisis")
  3. If Jordan doesn't respond within 15 min, escalates to emergency contact

**Saturday 10:00 – Check-In Call (Human AlKalma Staff):**
- AlKalma team member calls Jordan, assesses safety
- Jordan confirms they're okay, just had rough evening
- Staff logs follow-up in OASIS, Autopilot resumes normal operation

**Key Difference from Maxina Journey:**
- **Escalation is frequent** in AlKalma context (by design)
- **Autonomous Mode disabled** for clinical decisions
- **Human-in-the-loop** for all mental health interventions

### Journey C: Earthlings Retreat Planning & Follow-Up

**Member Profile:**
- Name: Sam
- Vitana Index: 680/999
- Primary tenant: Earthlings (booked 7-day retreat in Bali)
- Secondary tenants: Maxina (wellness tracking), AlKalma (stress management)
- Autopilot settings: Start Stream enabled, Voice Conversation enabled, Autonomous Mode: balanced

**Pre-Retreat (2 Weeks Out):**

**Week 1 – Voice Conversation (Retreat Discovery):**
- Sam: "I need a break. Find me a wellness retreat for stress relief."
- Autopilot queries Earthlings inventory:
  - Filters by: stress relief programs, available dates, within budget (2,500 Credits)
  - Returns 3 options: Bali (7 days, yoga + meditation), Costa Rica (5 days, surf + nature), Iceland (10 days, hot springs + hiking)
- Sam chooses Bali
- Autopilot books retreat, sends confirmation (event: `AUTOPILOT_ACTION_EXECUTED`, type: booking_created)

**Week 2 – Autonomous Actions (Pre-Retreat Prep):**
- Autopilot detects flight booked to Bali
- Autonomous actions:
  1. Suggests jet lag protocol in Maxina app (adjust sleep 30 min/day for 3 days pre-departure)
  2. Auto-adds "pack yoga mat" to Sam's task list
  3. Books airport lounge access (pre-approved via Earthlings membership perks)
  4. Sends Start Stream: "Your retreat starts in 7 days! Here's your pre-retreat checklist: adjust sleep schedule, pack light, set out-of-office"

**During Retreat (7 Days in Bali):**

- **Start Stream paused** (per Sam's "vacation mode" preference)
- **Passive tracking only:** Wearable syncs sleep + HRV, no active interventions
- **Emergency override:** If wearable detects medical anomaly (e.g., resting HR >120), Autopilot would send alert even in vacation mode

**Post-Retreat (Day 8-14):**

**Day 8 – Return Home + Start Stream Resumes:**
- "Welcome back, Sam! Your retreat data is impressive: HRV avg 72ms (up from 58ms pre-retreat), sleep quality 94%. Let's lock in those gains."

**Day 9 – Voice Conversation (Integration Planning):**
- Sam: "I loved the morning yoga in Bali. How do I keep this up at home?"
- Autopilot:
  - Searches Maxina for local yoga studios
  - Suggests 3 studios within 2 miles
  - Offers to add "7:00 AM yoga" to Sam's calendar 3x/week
- Sam approves → Autopilot adds recurring event (event: `AUTOPILOT_ACTION_EXECUTED`, type: habit_scheduled)

**Day 10-14 – Autonomous Maintenance:**
- Monitors Sam's adherence to new yoga habit
- If Sam misses 2 sessions → sends gentle Start Stream: "Noticed you skipped yoga yesterday. Everything okay? Want to reschedule or adjust the frequency?"

**Week 3 – Earthlings Follow-Up Offer:**
- Start Stream: "Your Vitana Index is now 712 (+32 since Bali!). Earthlings has a virtual meditation series starting next month—would you like to enroll? (20 Credits/month)"
- Sam enrolls via app → Autonomous Mode schedules first session

**Key Integration Points:**
- **Cross-tenant:** Earthlings retreat impacts Maxina habits + AlKalma stress levels
- **OASIS continuity:** All retreat data (sleep, activities, insights) stored in OASIS → informs future recommendations
- **Autonomous follow-through:** Autopilot doesn't just book the retreat—it ensures post-retreat integration into daily life

## 6. Inputs, Signals & Events

### Data Inputs

Autopilot consumes data from multiple sources:

**1. Wearables (Passive Sync):**
- Sleep (duration, stages, quality score)
- Heart rate variability (HRV)
- Resting heart rate
- Steps, active minutes, calorie burn
- Stress score (if device supports)

**2. Lab Results (Via AlKalma Integration):**
- Blood biomarkers (glucose, cholesterol, inflammation markers)
- Hormone panels (testosterone, cortisol, thyroid)
- Genetic data (if member opted in)

**3. Self-Reports (Active Member Input):**
- Mood logs (1-10 scale + optional notes)
- Meal logs (photos, text, or voice descriptions)
- Symptom tracking (headaches, pain levels, energy)
- Journal entries (if member uses Maxina or AlKalma journaling features)

**4. Calendar & Location:**
- Scheduled events (workouts, AlKalma sessions, Earthlings bookings)
- Travel plans (flight bookings, timezone changes)
- Location context (home, gym, retreat center) → used for contextual nudges

**5. Professional Inputs (AlKalma):**
- Therapist session notes (with explicit member consent)
- Medication prescriptions and dosage changes
- Safety flags ("escalate if mood <3/10")

**6. Tenant-Specific Signals:**
- **Maxina:** Habit streak progress, community engagement, product usage
- **AlKalma:** Session attendance, therapy homework completion, crisis alerts
- **Earthlings:** Booking history, retreat feedback, travel preferences

### OASIS Event Types

Autopilot emits and consumes events in OASIS. Key event types:

**Autopilot-Generated Events:**
```typescript
// Start Stream
AUTOPILOT_START_STREAM_SENT
AUTOPILOT_RECOMMENDATION_CREATED

// Voice Conversation
AUTOPILOT_VOICE_SESSION_STARTED
AUTOPILOT_VOICE_TURN (each exchange)
AUTOPILOT_VOICE_SESSION_ENDED

// Autonomous Mode
AUTOPILOT_AUTONOMOUS_ACTION_TRIGGERED (before execution)
AUTOPILOT_ACTION_EXECUTED (after successful action)
AUTOPILOT_ESCALATION_TRIGGERED (when human intervention required)

// General
AUTOPILOT_CONFIG_CHANGED (when member updates settings)
AUTOPILOT_ERROR (technical failures, logged for debugging)
```

**Example Event Payload:**
```json
{
  "event_type": "AUTOPILOT_RECOMMENDATION_CREATED",
  "member_id": "mem_abc123",
  "timestamp": "2025-11-03T14:20:00Z",
  "vtid": null,
  "metadata": {
    "recommendation_id": "rec_xyz789",
    "recommendation_type": "recovery_booking",
    "tenant": "earthlings",
    "reasoning": "HRV <45ms for 3 days, member rule: auto-suggest recovery",
    "suggested_action": "Book 60-min massage at Serenity Spa",
    "estimated_cost_credits": 50,
    "confidence_score": 0.87,
    "related_data_sources": ["wearable_hrv", "member_rules", "earthlings_inventory"]
  }
}
```

**Tenant Events Consumed by Autopilot:**
```typescript
// Maxina
MAXINA_HABIT_COMPLETED
MAXINA_MEAL_LOGGED
MAXINA_WORKOUT_COMPLETED
MAXINA_COMMUNITY_POST_CREATED

// AlKalma
ALKALMA_SESSION_SCHEDULED
ALKALMA_SESSION_COMPLETED
ALKALMA_MOOD_LOG_SUBMITTED
ALKALMA_CRISIS_ALERT

// Earthlings
EARTHLINGS_BOOKING_CREATED
EARTHLINGS_RETREAT_COMPLETED
EARTHLINGS_FEEDBACK_SUBMITTED

// Cross-Tenant
VITANA_INDEX_UPDATED (when Index recalculated)
MEMBER_PROFILE_UPDATED
```

### VTID Usage (Infrastructure Actions Only)

Autopilot **does not create member-facing VTIDs**. However, if Autopilot detects a technical issue (e.g., "Wearable sync failing for 3 days") and needs to trigger an infrastructure fix, it can:
1. Create internal VTID (e.g., `OPS-INFRA-1234`)
2. Emit event: `AUTOPILOT_VTID_CREATED` with reason
3. Notify DevOps team via OASIS → Gateway → DevOps Chat

**Example:**
- Member's wearable hasn't synced in 72 hours
- Autopilot (Autonomous Mode) detects anomaly
- Creates VTID: `OPS-INFRA-5421` ("Wearable sync failure for mem_abc123")
- Escalates to DevOps → they investigate (API issue, not member's fault)

## 7. Configuration & Member Controls

### Notification Preferences

Members control **how** Autopilot reaches them:

**Channels:**
- In-app notifications (default: ON)
- Push notifications (default: ON for critical only)
- Email digests (default: OFF, opt-in for weekly summaries)
- SMS (default: OFF, opt-in for urgent AlKalma escalations)

**Frequency (Start Stream):**
- **Frequent:** 3-5 insights/day (morning, midday, evening, post-workout, bedtime)
- **Balanced:** 2 insights/day (morning + evening)
- **Minimal:** 1 insight/day (morning only)
- **Custom:** Member defines specific times

**Do Not Disturb:**
- Set quiet hours (e.g., 22:00-07:00 → no notifications except emergencies)
- Vacation mode (pauses Start Stream + Autonomous Mode, wearable tracking continues)

### Sensitivity Levels (Autonomous Mode)

**Conservative:**
- Only executes high-confidence, low-risk actions
- Examples: reorder products, send reminders, schedule routine sessions
- Escalates everything else to member approval

**Balanced (Default):**
- Executes moderate-confidence actions within budget limits
- Examples: book recovery services, adjust workout plans, suggest dietary swaps
- Escalates clinical decisions, novel situations

**Proactive:**
- Acts on broader range of signals (e.g., books retreat if stress >80 for 5 days)
- Still respects hard boundaries (no clinical actions, no budget overrides)
- Escalates less frequently, but logs all actions in OASIS for transparency

**Off:**
- Autonomous Mode disabled entirely
- All actions require manual member approval (Start Stream + Voice Conversation still available)

### Privacy & Data Scopes

Members control **what data** Autopilot can access:

**Wearable Data:**
- ✅ Always accessible (core to Vitana Index)
- Member can pause sync temporarily (e.g., during vacation)

**Lab Results:**
- ⚙️ Opt-in (default: ON if member uploads labs to AlKalma)
- Can be restricted to specific biomarkers (e.g., share glucose but not hormone panels)

**Meal Logs:**
- ⚙️ Opt-in (default: ON if using Maxina food tracking)
- Can disable at any time

**AlKalma Session Notes:**
- ⚙️ Opt-in (default: OFF, requires explicit consent)
- Therapist can also restrict specific notes from Autopilot access
- If enabled, used only for contextual Start Stream insights (never shared with other tenants)

**Location Data:**
- ⚙️ Opt-in (default: ON for contextual nudges like "gym nearby")
- Can restrict to city-level vs. precise GPS

**Community Data (Maxina):**
- ✅ Accessible (public posts, community engagement)
- Private messages never accessed by Autopilot

### Opt-In/Opt-Out Per Tenant

Members can enable/disable Autopilot per tenant:

| Tenant | Start Stream | Voice Conversation | Autonomous Mode |
|--------|--------------|---------------------|-----------------|
| Maxina | ON | ON | Balanced |
| AlKalma | ON | ON | **OFF** (default) |
| Earthlings | ON | ON | Conservative |

**Rationale:** Clinical contexts (AlKalma) default to manual control to ensure member agency in mental health decisions.

### Advanced: Rule Builder (Future Feature)

Members will be able to create custom "if-then" rules:

**Example Rules:**
- "If HRV <50ms for 3 days, auto-book recovery massage" (Earthlings)
- "If mood log <4/10, remind me to call my therapist" (AlKalma)
- "If I skip workouts 3 days in a row, suggest lighter activity (don't guilt-trip me)" (Maxina)
- "If I'm traveling to a new city, auto-suggest Earthlings partner experiences nearby"

Rules are stored in OASIS, validated by Autopilot safety checks before execution.

## 8. Future Extensions (Roadmap)

### Planned Enhancements

**Q2 2026: Multi-Modal Autopilot**
- **Video Conversations:** Screen-share for guided workouts, meal prep tutorials
- **AR Overlays:** Wearable glasses integration (e.g., "HRV reminder: take 3 deep breaths now")
- **Biometric Feedback Loops:** Real-time HRV/EEG during meditation → Autopilot adjusts guidance

**Q3 2026: Shared Autopilot Views (Professional Collaboration)**
- AlKalma therapists can see Autopilot insights for their clients (with consent)
- Two-way feedback: Therapist flags concerns → Autopilot adjusts recommendations
- Use case: Therapist says "Don't push workouts this week, focus on rest" → Maxina Autopilot temporarily lowers intensity

**Q4 2026: Predictive Models**
- **Vitana Index Forecasting:** "At current trajectory, your Index will hit 800 in 6 weeks"
- **Risk Alerts:** "Your HRV trend suggests burnout risk in 2 weeks—consider scheduling recovery now"
- **Personalized Retreat Matching:** ML model predicts which Earthlings experiences will maximize member's Index gains

**2027: Social Autopilot (Opt-In)**
- Connect with other members for shared goals (e.g., "Find running partners with similar pace + Index range")
- Group retreat recommendations ("Your friends Alex + Jordan might enjoy this retreat")
- Community challenges orchestrated by Autopilot ("10-day meditation sprint, who's in?")

### Explicit Scope Boundaries

**What This Doc Covers:**
- Conceptual behavior and flows of Autopilot modes
- Safety rules and escalation protocols
- High-level integration with tenants + OASIS

**What This Doc Does NOT Cover:**
- **API Specifications:** (Will live in DOC-95-95XX series, e.g., DOC-95-9510 "Autopilot API Reference")
- **LLM/ML Architecture:** (Will live in DOC-40-04XX series, e.g., DOC-40-0400 "Data & AI Architecture")
- **OASIS Schema Details:** (Covered in DOC-30-0301 "OASIS System & Event Model")
- **VTID Deep Dive:** (Covered in DOC-30-0302 "VTID Numbering System")
- **Tenant-Specific Workflows:** (Covered in DOC-20-02XX series for Maxina, AlKalma, Earthlings)

---

## Summary

Autopilot is Vitana's AI-powered guidance layer, operating in three modes: **Start Stream** (asynchronous insights), **Voice Conversation** (real-time dialogue), and **Autonomous Mode** (proactive action execution). It synthesizes data from wearables, labs, self-reports, and tenant systems (Maxina, AlKalma, Earthlings) to deliver personalized, context-aware recommendations while maintaining strict safety boundaries.

**Key Principles:**
1. **Bounded Autonomy:** Acts independently within safe zones, escalates outside them
2. **Member Control:** Granular settings for notifications, sensitivity, data access
3. **Transparency:** All actions logged in OASIS, reasoning always available
4. **Safety First:** Clinical decisions require human professionals, never bypassed
5. **Cross-Tenant:** Connects insights from lifestyle, clinical, and retreat experiences

**Next Steps:**
- Review this playbook with Product, Engineering, and Clinical teams
- Build API specifications (DOC-95-9510+)
- Define ML model architecture (DOC-40-04XX)
- Pilot Autonomous Mode with beta members in Maxina (low-risk actions only)
- Develop AlKalma-specific safety protocols with licensed therapists

---

**Owner:** CTO  
**Review Cadence:** Quarterly (or after major Autopilot feature releases)  
**Feedback:** Share improvements via DevOps chat or email CTO@vitana.com
