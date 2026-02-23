# VTID-01231: Autopilot Top 20 Executions

**Status:** Draft
**Created:** 2026-02-23
**Purpose:** Define the 20 highest-impact autonomous actions the Vitana AI Assistant will execute on behalf of users. This is the implementation priority list - we build exactly these, in this order.

---

## Ranking Criteria

Each execution is scored 1-5 on three dimensions:

| Dimension | Definition |
|-----------|------------|
| **User Impact** | How much does this improve the user's life? (health, time, wellbeing) |
| **Wow Factor** | Does this feel like magic? Would users tell friends about it? |
| **Buildability** | Can we build this with existing infrastructure? (5 = ready today, 1 = major new integration) |

**Score = (Impact x 2) + Wow + Buildability** (max 20, impact weighted double)

---

## The Top 20

### #1. Morning Briefing
**Score: 19** | Impact: 5 | Wow: 5 | Build: 4

> *"Good morning. Your sleep was 6.2h last night, below your 7h target for the 3rd day. Your mood trend is dipping. You have a live room on Breathwork at 11am - good fit given your stress signals. Your diary streak is 12 days. Here's your prompt for today."*

**What it does:** Every morning, assembles a personalized briefing from health scores, diary streak, upcoming community events, active signals, and today's recommended focus area.

**Why it's #1:** This is the anchor habit. Users open the app for THIS. It demonstrates the system knows them, connects dots across domains, and sets the tone for the day. Every other autopilot action feeds into making this briefing better.

**Data sources:** vitana_index_scores, d44_predictive_signals, diary entries, live_rooms, memory garden
**Existing infra:** Health compute pipeline, diary templates, live rooms API, D44 signals
**New work needed:** Assembly endpoint, morning trigger (cron), notification delivery

---

### #2. Health Drift Early Warning
**Score: 19** | Impact: 5 | Wow: 5 | Build: 4

> *"I've noticed your physical score dropped from 78 to 64 over the past 9 days. The main driver is sleep quality (down 22%). This pattern preceded a similar dip in October that lasted 3 weeks. Small suggestion: try shifting your last meal 1 hour earlier - this helped last time."*

**What it does:** When D44 detects health_drift, the autopilot doesn't just flag it - it explains the pattern, connects it to past episodes from memory, and suggests a specific low-effort intervention from D49.

**Why it's high:** This is the core promise of a health platform. Catching problems before they become serious, with evidence-based reasoning the user can trust.

**Data sources:** d44_predictive_signals, vitana_index_scores, memory timeline, D49 mitigations
**Existing infra:** D44 signal detection, D49 mitigation engine, memory timeline
**New work needed:** Signal-to-action pipeline, historical pattern matching, notification trigger

---

### #3. Smart Diary Prompt
**Score: 18** | Impact: 5 | Wow: 4 | Build: 4

> *"You mentioned feeling disconnected from your running habit 5 days ago. Your movement score has been flat since. Want to reflect on what's blocking you? [Start guided entry] or [Quick note]"*

**What it does:** Instead of generic "How are you today?" prompts, the autopilot generates contextual diary prompts based on recent signals, memory garden goals, and detected gaps.

**Why it's high:** Diary engagement is the #1 predictor of platform value. Better prompts = better entries = better data = better everything else. The "it remembers what I said" moment is powerful.

**Data sources:** memory garden (goals, habits), d44_signals, diary history, vitana_index_scores
**Existing infra:** Diary templates, memory retrieval, garden nodes
**New work needed:** Contextual prompt generator, timing logic

---

### #4. Pattern Insight Reveal
**Score: 18** | Impact: 5 | Wow: 5 | Build: 3

> *"I found something interesting: On weeks where you attend at least one live room, your mental score averages 12 points higher. You haven't joined one in 16 days. There's a Longevity Nutrition session tomorrow at 7pm - matches your top topic."*

**What it does:** Cross-domain pattern analysis that reveals hidden connections between user behaviors and outcomes. Surfaces correlations the user would never notice themselves.

**Why it's high:** This is the "holy shit it actually understands me" moment. Connecting social behavior to mental health scores, or sleep to nutrition patterns, feels genuinely intelligent.

**Data sources:** vitana_index_scores (historical), live_rooms attendance, diary entries, relationship_edges
**Existing infra:** Health scores, community events, memory timeline
**New work needed:** Correlation engine (lightweight - compare averages across behavioral segments), insight templating

---

### #5. Risk Mitigation Nudge
**Score: 17** | Impact: 5 | Wow: 4 | Build: 3

> *"Your cognitive load signal has been elevated for 4 days. Based on your patterns, this usually leads to poor sleep within 48 hours. Three things that helped before: 1) Evening walks (you rated +3 impact), 2) Skipping screens after 9pm, 3) 10-min breathwork. Want me to set a reminder for any of these tonight?"*

**What it does:** Takes D44 risk signals and D49 mitigations, enriches them with the user's own outcome history (usage_outcomes table), and offers to set up the intervention.

**Why it's high:** Preventive action with personalized evidence. "This helped YOU before" is far more convincing than generic advice.

**Data sources:** d44_predictive_signals, d49_mitigations, usage_outcomes, user_offers_memory
**Existing infra:** D44, D49, outcome tracking
**New work needed:** Enrichment pipeline (match mitigations to personal outcomes), reminder system

---

### #6. Community Match & Nudge
**Score: 17** | Impact: 4 | Wow: 5 | Build: 3

> *"There's a new member in the Munich Biohacking group who also journals about cold exposure and sleep optimization - your top 2 topics. They're attending the Ice Bath Fundamentals meetup on Saturday. 3 other people you've interacted with in live rooms are going. Want to RSVP?"*

**What it does:** Matches users to community events and people based on diary topics, relationship graph, and coattendance history. Makes the community feel curated, not random.

**Why it's high:** Social connection is a longevity factor. Most health platforms ignore this. The wow factor of "it found someone like me" drives word-of-mouth growth.

**Data sources:** memory garden (topics), relationship_edges, community groups, meetups, live_rooms
**Existing infra:** Topic matching, relationship graph, meetup RSVP
**New work needed:** Community matching algorithm, coattendance scoring, notification

---

### #7. Goal Progress Check-in
**Score: 17** | Impact: 4 | Wow: 4 | Build: 4

> *"3 weeks ago you set a goal to meditate daily. Your diary mentions meditation on 8 of 21 days (38%). Your mental score is 6 points higher on meditation days. Want to adjust the goal, or should I suggest a smaller starting habit?"*

**What it does:** Tracks goals extracted from diary/memory garden, measures progress against diary entries and health data, and proactively checks in with evidence.

**Why it's high:** Goal tracking that actually connects to outcomes. Most goal apps just count streaks. This shows the user WHY their goal matters with their own data.

**Data sources:** memory garden (goals), diary entries, vitana_index_scores
**Existing infra:** Garden nodes, diary retrieval, health scores
**New work needed:** Goal progress calculator, check-in trigger, evidence assembler

---

### #8. Service/Product Recommendation with Reasoning
**Score: 16** | Impact: 4 | Wow: 4 | Build: 3

> *"Based on your sleep score decline and your diary mention of wanting to try magnesium: 'Magnesium L-Threonate by XYZ' is used by 14 members with similar profiles. 9 reported better sleep within 2 weeks (avg +8 sleep score). 2 dismissed it. Want to save it or see alternatives?"*

**What it does:** Combines the user's expressed interest (memory), their health signals, and community outcome data to make product/service recommendations with transparent reasoning.

**Why it's high:** Recommendations backed by "people like you" data from the actual community, not generic reviews. The transparency of "9 reported better, 2 dismissed" builds trust.

**Data sources:** user_offers_memory, products_catalog, usage_outcomes, memory (expressed interest), d44_signals
**Existing infra:** Offers recommendation engine, outcome tracking, relationship strength
**New work needed:** Cohort outcome aggregation, interest-signal matching

---

### #9. Weekly Vitana Index Report
**Score: 16** | Impact: 4 | Wow: 4 | Build: 3

> *"Your week in review: Physical 72 (+3), Mental 68 (-5), Nutritional 81 (=), Social 45 (-12), Environmental 77 (+1). Your social score dropped significantly - you had zero community interactions this week vs. 3 last week. Your strongest day was Thursday (diary: 'Great hike with Anna'). One focus for next week?"*

**What it does:** Weekly summary connecting health scores to actual life events from diary and community. Identifies the best and worst days with real context, not just numbers.

**Why it's high:** Numbers alone are meaningless. Tying scores to real events makes the data actionable and the platform feel intelligent.

**Data sources:** vitana_index_scores, diary entries, live_rooms, relationship_edges, memory timeline
**Existing infra:** Health compute, diary, community tracking
**New work needed:** Weekly aggregation, event-score correlation, report assembly

---

### #10. Routine Instability Alert
**Score: 16** | Impact: 4 | Wow: 4 | Build: 3

> *"Your evening routine has been inconsistent for 8 days. You normally journal between 9-10pm (captured in 85% of weeks), but you've missed 6 of the last 8 days. Routine consistency correlates with +11 on your mental score. Quick check-in: [Feeling fine, just busy] [Something changed] [Help me get back on track]"*

**What it does:** Detects routine_instability from D44, enriches with the user's specific routine patterns from diary timestamps, and offers graduated responses instead of one-size-fits-all advice.

**Data sources:** d44_predictive_signals (routine_instability), diary timestamps, vitana_index_scores
**Existing infra:** D44 detection, diary history
**New work needed:** Routine pattern extractor, graduated response flow

---

### #11. Positive Momentum Celebration
**Score: 15** | Impact: 4 | Wow: 4 | Build: 2

> *"3 week streak: your physical score has improved every week (+4, +6, +3). Your diary shows consistent morning walks and better sleep habits since you started the Longevity Basics group. Keep it up - members who maintain this trajectory for 6+ weeks see lasting improvements."*

**What it does:** When D44 detects positive_momentum, the autopilot celebrates with specific attribution to what the user is doing right. Reinforcement, not just problem detection.

**Why it's high:** Most health platforms only alert on problems. Celebrating wins is psychologically powerful and builds habit reinforcement. Users feel seen.

**Data sources:** d44_predictive_signals (positive_momentum), vitana_index_scores, diary, community engagement
**Existing infra:** D44 detection, health scores, diary
**New work needed:** Attribution engine (which behaviors drove improvement), celebration templating

---

### #12. Social Withdrawal Intervention
**Score: 15** | Impact: 5 | Wow: 3 | Build: 2

> *"You haven't interacted with any community members in 18 days. Your social score is at 38, the lowest in 3 months. No pressure - but there's a casual Coffee & Chat room happening tomorrow morning, just 30 minutes, with 4 members you've talked to before. Sometimes showing up is enough."*

**What it does:** Detects social_withdrawal from D44, checks relationship history to find familiar faces in upcoming events, and extends a low-pressure invitation.

**Why it's high:** Social isolation is a leading longevity risk factor. This intervention is genuinely life-improving. The tone matters enormously - empathetic, not pushy.

**Data sources:** d44_predictive_signals (social_withdrawal), relationship_edges, live_rooms, meetups
**Existing infra:** D44, relationship graph, community events
**New work needed:** Familiar-face matching, empathetic tone templates, soft-touch notification

---

### #13. Location-Based Wellness Discovery
**Score: 14** | Impact: 3 | Wow: 5 | Build: 3

> *"You're near Englischer Garten (your most visited park, 23 check-ins). There's a new outdoor yoga session happening there in 45 minutes, organized by the Munich Wellness group. 2 members from your network are attending. Your movement score could use a boost this week."*

**What it does:** Combines location proximity, visit history, community events, health signals, and relationship graph to surface hyper-relevant real-world opportunities.

**Why it's high:** The wow factor of contextual, location-aware suggestions that actually make sense for THIS user is very high. Makes the digital platform bridge to physical world.

**Data sources:** locations (visit history), meetups, community groups, relationship_edges, vitana_index_scores
**Existing infra:** Location check-ins, nearby discovery, meetup RSVP
**New work needed:** Location trigger system, multi-signal relevance scoring

---

### #14. Diary Insight Extraction
**Score: 14** | Impact: 3 | Wow: 4 | Build: 4

> *"From your last 7 diary entries, I've extracted: You mentioned 'tired' 4 times (increasing trend), you referenced Anna in a positive context 3 times (relationship strength +8), and you expressed interest in trying intermittent fasting. Want me to track your energy mentions and find fasting resources from the community?"*

**What it does:** After diary submission, the autopilot extracts structured insights (emotions, relationships, interests, health signals) and offers to act on them.

**Why it's high:** Turns free-form journaling into structured intelligence. The user writes naturally; the system extracts value. Makes every diary entry feel productive.

**Data sources:** diary entries, memory garden, relationship_edges
**Existing infra:** Diary API, garden node extraction, entity extraction (Cognee)
**New work needed:** Post-diary insight pipeline, action suggestion engine

---

### #15. Wearable Data Story
**Score: 14** | Impact: 3 | Wow: 4 | Build: 3

> *"Your wearable data this week: 52,400 steps (down 18% from last week), average resting HR 64 (stable), sleep average 6.8h (your target: 7.5h). Interesting: on days where your step count exceeded 8,000, your sleep quality was 23% better that night. Your best sleep night (Thursday) followed your highest step day."*

**What it does:** Transforms raw wearable numbers into a narrative with personal correlations. Finds the user's own patterns between activity and outcomes.

**Data sources:** wearable data (steps, HR, sleep), vitana_index_scores
**Existing infra:** Wearable ingest pipeline, health compute
**New work needed:** Correlation narrative engine, weekly wearable digest

---

### #16. Preference Shift Detection
**Score: 13** | Impact: 3 | Wow: 4 | Build: 3

> *"I've noticed a shift in your interests over the past month. Your diary mentions of 'running' dropped from 8x/month to 1x, while 'swimming' appeared 6 times (new topic). Your saved services shifted from running coaches to aquatic centers. Want me to update your profile topics and find swimming-related community events?"*

**What it does:** Detects preference_shift from D44 and cross-references with diary topics, service interactions, and community engagement to confirm and act on the shift.

**Data sources:** d44_predictive_signals (preference_shift), memory garden, user_offers_memory, diary
**Existing infra:** D44, memory garden, offers tracking
**New work needed:** Preference shift confirmation logic, profile update flow

---

### #17. Lab Report Action Plan
**Score: 13** | Impact: 4 | Wow: 3 | Build: 2

> *"Your latest lab report shows Vitamin D at 22 ng/mL (low - target is 40-60). 3 actions: 1) 'Vitamin D3+K2 supplement' - used by 28 members, 19 saw improvement at next test. 2) Outdoor morning light exposure (aligns with your walking goal). 3) Schedule follow-up test in 8 weeks. Want me to set these up?"*

**What it does:** After lab report ingestion, generates a plain-language action plan with community-backed product suggestions, lifestyle adjustments from existing goals, and follow-up scheduling.

**Data sources:** lab reports, products_catalog, usage_outcomes, memory garden (goals)
**Existing infra:** Lab ingest, product catalog, outcome tracking
**New work needed:** Lab interpretation engine (rule-based, not medical advice), action plan assembly

---

### #18. Evening Wind-Down Prompt
**Score: 13** | Impact: 3 | Wow: 3 | Build: 4

> *"Winding down for the night. Quick check: How was today's energy level? [1-5]. Your 3 highlights from the day (from your diary): morning walk, productive work session, good conversation with Max. Sleep tip based on your data: you sleep 18 minutes longer on nights you journal before 10pm. It's 9:42pm now."*

**What it does:** Evening routine prompt that combines diary highlights, a quick metric capture, and a personalized sleep optimization tip from the user's own data.

**Data sources:** diary entries (today), vitana_index_scores, sleep data, memory
**Existing infra:** Diary, health scores, memory
**New work needed:** Evening trigger, personal sleep insight engine

---

### #19. Meetup Follow-Up
**Score: 12** | Impact: 3 | Wow: 3 | Build: 3

> *"You attended the Holistic Nutrition live room yesterday with 8 others. Quick follow-up: Was it valuable? [Yes/Neutral/No]. You interacted most with Sarah M. and Tom K. (both new connections). The group's next session is in 2 weeks on Gut-Brain Axis. Want me to RSVP you?"*

**What it does:** After attending a community event, prompts for feedback, highlights new connections made, and suggests next engagement to maintain momentum.

**Data sources:** live_rooms (attendance, highlights), relationship_edges (new), meetups (upcoming)
**Existing infra:** Live rooms, relationship tracking, meetup RSVP
**New work needed:** Post-event trigger, connection highlight engine

---

### #20. Quarterly Life Review
**Score: 12** | Impact: 4 | Wow: 4 | Build: 1

> *"Your Q1 2026 review: Physical score +8 (biggest gain: consistent movement), Mental score -3 (biggest factor: work stress in February), Social score +15 (you joined 3 groups and attended 12 events). Top achievement: 45-day diary streak. Biggest challenge: sleep consistency. 3 goals from your diary that are still active: [1] meditation daily, [2] reduce sugar, [3] join a running group. Want to set Q2 priorities?"*

**What it does:** Comprehensive quarterly review assembling data from all domains into a life progress report.

**Why it's here (not higher):** Extremely high wow factor but only happens 4x/year and requires significant data assembly. Build score is low because it needs the most cross-domain integration.

**Data sources:** All domains - health scores, diary, memory garden, community, signals, outcomes
**Existing infra:** All individual data sources exist
**New work needed:** Cross-domain aggregation engine, quarterly trigger, progress narrative

---

## Summary: Ranked Implementation Order

| # | Execution | Score | Build Effort | Key Dependency |
|---|-----------|-------|-------------|----------------|
| 1 | Morning Briefing | 19 | Medium | Notification delivery |
| 2 | Health Drift Early Warning | 19 | Medium | D44 → action pipeline |
| 3 | Smart Diary Prompt | 18 | Low | Memory garden |
| 4 | Pattern Insight Reveal | 18 | Medium | Correlation engine |
| 5 | Risk Mitigation Nudge | 17 | Medium | D49 + outcome enrichment |
| 6 | Community Match & Nudge | 17 | Medium | Topic matching |
| 7 | Goal Progress Check-in | 17 | Low | Garden goals + diary |
| 8 | Service/Product Rec with Reasoning | 16 | Medium | Cohort outcome aggregation |
| 9 | Weekly Vitana Index Report | 16 | Medium | Score-event correlation |
| 10 | Routine Instability Alert | 16 | Low | D44 + diary timestamps |
| 11 | Positive Momentum Celebration | 15 | Low | D44 + attribution |
| 12 | Social Withdrawal Intervention | 15 | Medium | D44 + familiar faces |
| 13 | Location-Based Wellness Discovery | 14 | High | Location triggers |
| 14 | Diary Insight Extraction | 14 | Low | Cognee + garden |
| 15 | Wearable Data Story | 14 | Medium | Correlation narrative |
| 16 | Preference Shift Detection | 13 | Medium | D44 + profile update |
| 17 | Lab Report Action Plan | 13 | High | Lab interpretation rules |
| 18 | Evening Wind-Down Prompt | 13 | Low | Evening trigger |
| 19 | Meetup Follow-Up | 12 | Low | Post-event trigger |
| 20 | Quarterly Life Review | 12 | High | Cross-domain aggregation |

---

## Implementation Waves

### Wave 1: Daily Anchors (Build first - these drive daily engagement)
| # | Execution | Effort |
|---|-----------|--------|
| 1 | Morning Briefing | Medium |
| 3 | Smart Diary Prompt | Low |
| 18 | Evening Wind-Down Prompt | Low |

**Why first:** These three create the daily rhythm. User opens app in morning (briefing), gets prompted during day (diary), and closes out at night (wind-down). This is the engagement loop that makes everything else valuable.

### Wave 2: Health Intelligence (The core value proposition)
| # | Execution | Effort |
|---|-----------|--------|
| 2 | Health Drift Early Warning | Medium |
| 5 | Risk Mitigation Nudge | Medium |
| 10 | Routine Instability Alert | Low |
| 11 | Positive Momentum Celebration | Low |

**Why second:** These transform D44 signals from backend data into user-facing value. The signal detection infrastructure already exists - we just need the "last mile" to the user.

### Wave 3: Insight & Reflection (The "wow" moments)
| # | Execution | Effort |
|---|-----------|--------|
| 4 | Pattern Insight Reveal | Medium |
| 7 | Goal Progress Check-in | Low |
| 9 | Weekly Vitana Index Report | Medium |
| 14 | Diary Insight Extraction | Low |

**Why third:** These are the moments users screenshot and share. Cross-domain insights that feel genuinely intelligent.

### Wave 4: Community & Social (Growth driver)
| # | Execution | Effort |
|---|-----------|--------|
| 6 | Community Match & Nudge | Medium |
| 12 | Social Withdrawal Intervention | Medium |
| 19 | Meetup Follow-Up | Low |

**Why fourth:** Community features drive growth and retention. Social connection is a longevity factor. But they require the daily engagement loop (Wave 1) to be working first.

### Wave 5: Recommendations & Discovery (Monetization path)
| # | Execution | Effort |
|---|-----------|--------|
| 8 | Service/Product Rec with Reasoning | Medium |
| 13 | Location-Based Wellness Discovery | High |
| 15 | Wearable Data Story | Medium |
| 16 | Preference Shift Detection | Medium |
| 17 | Lab Report Action Plan | High |

**Why fifth:** These have revenue potential (service/product recommendations) but need user trust established first through Waves 1-4.

### Wave 6: Deep Intelligence (Long-term retention)
| # | Execution | Effort |
|---|-----------|--------|
| 20 | Quarterly Life Review | High |

**Why last:** Maximum cross-domain integration required. But when it works, it's the most powerful retention feature on the platform.

---

## Shared Infrastructure Needed

Before building individual executions, these shared components support multiple features:

| Component | Used By | Effort |
|-----------|---------|--------|
| **Notification Delivery Engine** | All 20 executions | Medium |
| **Timing/Trigger System** (morning, evening, post-event, weekly) | #1, #3, #9, #18, #19, #20 | Medium |
| **Insight Assembly Pipeline** (combine multi-domain data into narrative) | #1, #4, #9, #15, #20 | Medium |
| **Action Confirmation Flow** (user confirms before execution) | #5, #6, #8, #12, #13, #17 | Low |
| **Personal Correlation Engine** (find patterns in user's own data) | #4, #7, #9, #15, #18 | Medium |
| **OASIS Event Emission** (audit trail for all autopilot actions) | All 20 executions | Already exists |

---

## What This List Does NOT Include

Deliberately excluded:

| Excluded | Reason |
|----------|--------|
| Calendar integration | Requires Google Workspace OAuth - separate VTID |
| Email sending | Requires email service integration - separate VTID |
| WhatsApp/SMS | Requires Twilio - separate VTID |
| Payment processing | Requires Stripe - separate VTID |
| Third-party bookings | Requires vendor APIs - separate VTID |

These are valuable but require new external integrations. The top 20 above are buildable with what exists today.

---

## Success Metrics per Wave

| Wave | Key Metric | Target |
|------|------------|--------|
| Wave 1 | Daily active users opening briefing | >60% of active users |
| Wave 2 | Signal-to-action conversion | >25% of signals acted on |
| Wave 3 | Insight shares/screenshots | >10% of insights shared |
| Wave 4 | Community event attendance | +30% from baseline |
| Wave 5 | Recommendation engagement | >20% save or try rate |
| Wave 6 | Quarterly review completion | >50% of active users |
