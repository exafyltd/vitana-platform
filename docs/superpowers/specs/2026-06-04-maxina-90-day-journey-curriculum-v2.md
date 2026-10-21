# Maxina 90-Session Journey Curriculum v2

Date: 2026-06-04

This v2 replaces the first 90-topic concept with a Life Compass-led onboarding curriculum: 90 usage sessions, 250 clickable topic cards, and a progressive story that connects health, trust, community, and optional business creation inside the longevity economy.

"Session" means usage session or lesson number, not calendar day. Users can browse ahead, replay topics, and move faster than one session per calendar day. A session is complete only after a tiny guided-practice action.

## Recommendation

Use exactly 250 clickable topic cards:

- Sessions 1-20: 2 cards per session, 40 cards total. This avoids early overload.
- Sessions 21-90: 3 cards per session, 210 cards total. This gives enough depth once the user understands the rhythm.
- Total: 250 cards.

This is the best balance. 200 topics would cover the app, but not the vision. 300 topics would risk feeling like a course catalog. 250 gives enough room for health, trust, community, assistant behavior, privacy, marketplace, sharing, live rooms, business creation, and financial-freedom pathways.

## Narrative Spine

The Journey is not "health first, business later." It is one integrated quality-of-life story:

1. The world is changing quickly because of AI.
2. It is easier than ever to create, publish, automate, sell, and learn.
3. It is also harder to know what is true, who to trust, and what path is healthy.
4. Vitana gives the user a guided plan.
5. Health is the first asset: more energy, better sleep, stronger mindset, clearer decisions.
6. Community creates trust: like-minded people, shared experience, accountability, learning.
7. Trust creates opportunity: profile, posts, events, live rooms, offers, services, referrals.
8. Opportunity can become income for users who want that.
9. Income and financial freedom improve quality of life.
10. Vitanaland is the ecosystem that connects this into the longevity economy.

The business and longevity-economy promise is present from the beginning, but not promoted aggressively. Early copy should say "this can later help you build income if that becomes part of your Life Compass." The full business case opens only after explicit user intent.

## Business Interest Gating

Add a `business_interest_level` signal:

- `none`: Do not promote business. Keep only light references to future opportunity.
- `curious`: Show optional "where this can lead" cards and simple examples.
- `active`: Teach offers, live rooms, sharing, invitations, campaigns, wallet, and earnings.
- `builder`: Use whitepaper-backed facts, market positioning, financial models, and strategy.

Business depth is triggered when the user:

- selects Life Compass goals such as financial freedom, passive income, build a business, or new income
- taps Longevity Economy or Positioning in the Longevity Economy
- asks how to earn, build a business, create passive income, or promote an offering
- opens Business Hub, Sell & Earn, Sharing, Campaigns, or Wallet earning views with clear intent

For users without business intent, the Journey should remain focused on health, energy, trust, community, and quality of life.

## Whitepaper Fact Bank

Use these only for `active` or `builder` users, or when the user explicitly taps a business topic:

- The longevity economy is projected at $27 trillion by 2026, representing more than 20% of global GDP.
- The global wellness economy reached $6.8 trillion in 2024 and is projected to reach $9.8 trillion by 2029.
- AI and robotics are expected to reshape 50-55% of jobs in the next two to three years.
- 170 million new jobs are projected by 2030, alongside 92 million displaced jobs.
- The gig economy is projected to grow from $582 billion in 2025 to about $2.18 trillion by 2034.
- The global population aged 60 and older is projected to reach 2.1 billion by 2050.
- Vitanaland is positioned as the operating system for the longevity economy: health, community, events, services, AI guidance, trust, and business tools in one ecosystem.
- Vitanaland's model emphasizes direct provider income, preventive wellness, community services, platform operations, and quality and trust systems.
- Vitanaland projects $205 billion in cumulative economic value creation by 2035 across provider income, healthcare savings, and community multiplier effects.

## Topic Card Rules

Every topic card needs:

- topic id
- day number
- display label: 1-4 words maximum
- optional helper text: one short sentence maximum
- title
- short spoken Vitana explanation
- practice action
- completion event
- manual or knowledge source
- safety level
- business gate, if any

The visible My Journey catalog must stay simple. The user should see short clickable labels such as "What Is Vitanaland", "Maxina Community", "Vitana Assistant", "Life Compass", "Vitana Index", "Find a Match", or "Create Event". The deeper explanation happens only after the user taps the topic and Vitana starts teaching by voice.

For first-time users, the first 20 topics must answer the basic orientation questions before teaching workflows:

- What is Vitanaland?
- What is the Maxina community?
- Who is Vitana?
- What is My Journey?
- What is the Life Compass?
- What is the Vitana Index?
- What does the ORB do?
- What does Vitana remember?
- What can I safely ask Vitana to do?
- What is the first tiny practice?

Topic states:

- preview
- ready
- done
- mastered
- skipped

## Knowledge Base Checklist Ownership

The 250-topic checklist must be editable inside Admin Pages, not maintained only in code or Markdown. Add a Knowledge Base tab named `Checklist`.

The `Checklist` tab is the editorial source of truth for the My Journey onboarding catalog. Admin users must be able to create, edit, reorder, disable, translate, preview, and publish checklist topics without developer involvement.

My Journey reads only the published checklist version. Draft edits stay invisible to users until an admin publishes them. Every published version should keep an audit trail so the team can see who changed topic labels, Vitana scripts, practice actions, unlock rules, and manual sources.

The Admin checklist editor must validate the rules in this document:

- exactly 90 usage sessions for the main onboarding journey
- exactly 250 published topic cards unless a deliberate curriculum version changes this rule
- 2 cards per session for sessions 1-20
- 3 cards per session for sessions 21-90
- display labels limited to 1-4 words
- each topic connected to a Vitana explanation, practice action, completion event, and knowledge source
- business-gated topics marked explicitly
- disabled or draft topics excluded from the user-facing catalog

## Coverage Matrix

The catalog must explicitly cover every Community-role product surface, not only the narrative. This matrix is the guardrail for quality review.

| Product area | Required coverage | Topic IDs |
|---|---|---|
| My Journey, Life Compass, and core story | Quality-of-life promise, Life Compass, usage-session model, business curiosity without pressure | T001-T010, T021-T022, T039-T040, T158-T160, T248-T250 |
| Vitana Assistant, ORB, Autopilot, and voice | Ask, explain, open, act, next best action, voice settings and confirmation behavior | T003-T004, T019-T020, T041-T043, T239-T241 |
| Health and Vitana Index | Five pillars, Index, sleep, hydration, movement, nutrition, mental wellness, biomarkers, plans, services, education, safety boundaries | T009-T014, T023-T032, T044-T067 |
| Memory and Diary | Memory overview, what Vitana knows, 13 categories, add memory, diary, timeline, recall, correct or forget, permissions, export | T015-T016, T033-T034, T068-T079 |
| Calendar, reminders, notifications, and Inbox | Reminders, calendar, agenda, create event, reschedule, Inbox, inspiration, archived, messaging, voice notes | T035-T038, T080-T085, T122-T124, T233-T235 |
| Profile, public profile, and trust | Profile edit, public preview, visibility, profile preview, QR/share, trust signals | T017-T018, T089-T094, T215-T217 |
| Find a Match and relationship graph | Match types, why this match, match list search, filters, accept/dismiss/connect, clients, partners, event companions | T095-T100, T191-T193 |
| Activity intents and open asks | Post activity, seek meetup partners, view matches, respond, share intent, fulfill intent | T101-T106 |
| Feed, groups, challenges, and community hub | Community overview, highlights, rankings, feed, posts, comments, groups, group detail, group chat, challenges | T086-T115 |
| Events and meetups | Search events, filter, event drawer, RSVP, ticket safety, calendar, attendee matching, create event, create meetup, invite, edit/cancel | T116-T133, T194-T196 |
| Live Rooms | Browse, join, listen, speak, chat, create, schedule, go live, record, highlights, summaries | T134-T142, T200-T202 |
| Media Hub | Shorts, podcasts, music, bookmarks, player overlays, uploads, rights, moderation, content as business asset | T143-T154, T203-T205 |
| Discover and marketplace | Search products, services, providers, events, product detail, suitability, Universal Cart, orders, checkout safety, refunds | T161-T172 |
| Wallet and subscriptions | Wallet overview, credits, rewards, subscriptions, billing, transactions, payment methods, Vitana Coin, exchange, earnings, payouts | T173-T178, T236-T238 |
| Sharing and campaigns | Sharing overview, channels, social share consent, campaign draft, distribution, schedule, analytics, posts history, data consent | T179-T187, T227-T232 |
| Business Hub and longevity economy | Business path, skill inventory, business post, clients, partners, events, services, live rooms, media, Sell and Earn, reseller links, marketplace autopilot, business safety | T188-T205, T206-T247 |
| Settings, support, and safety | Privacy, consent, connected apps, billing, support/refunds, safety boundaries, non-diagnostic health, no false claims | T015-T016, T060-T064, T170-T172, T242-T244 |

## 250 Topic Card Catalog

| Session | Story purpose | Clickable topic cards |
|---:|---|---|
| 1 | Explain the ecosystem before any workflow. | T001 What Is Vitanaland; T002 Maxina Community |
| 2 | Introduce the assistant and voice interface. | T003 Vitana Assistant; T004 ORB Voice |
| 3 | Explain 90 sessions, jumping, and practice qualification. | T005 My Journey; T006 Usage Sessions |
| 4 | Define the user's personal goal system. | T007 Life Compass; T008 Choose Goal |
| 5 | Introduce Vitana Index early. | T009 Vitana Index; T010 Improve Index |
| 6 | Teach the health model simply. | T011 Five Pillars; T012 Weakest Pillar |
| 7 | Explain the quality-of-life promise. | T013 Quality of Life; T014 Health First |
| 8 | Establish safety and control. | T015 Privacy Control; T016 Memory Permission |
| 9 | Explain why profile matters. | T017 Profile Basics; T018 Trust Signal |
| 10 | Teach first voice commands. | T019 Ask Vitana; T020 Open Screen |
| 11 | Explain daily onboarding rhythm. | T021 Daily Loop; T022 First Practice |
| 12 | Start with recovery. | T023 Sleep; T024 Log Sleep |
| 13 | Give a fast health win. | T025 Hydration; T026 Log Water |
| 14 | Connect movement to energy. | T027 Movement; T028 Log Movement |
| 15 | Keep nutrition simple. | T029 Nutrition; T030 Meal Note |
| 16 | Build mental strength. | T031 Mental Strength; T032 One-Minute Reset |
| 17 | Make memory practical. | T033 Daily Diary; T034 Voice Diary |
| 18 | Teach follow-through. | T035 Reminders; T036 Set Reminder |
| 19 | Turn intention into schedule. | T037 Calendar; T038 Schedule Action |
| 20 | Let the user choose depth. | T039 Future Paths; T040 Business Curiosity |
| 21 | Establish the daily operating loop. | T041 Daily Loop; T042 Try Autopilot; T043 Finish or Snooze |
| 22 | Teach Home as the daily command center. | T044 Home overview; T045 Context tab; T046 AI Feed judgment |
| 23 | Show how the Index becomes actionable. | T047 Index Drivers; T048 Pillar Subscores; T049 Choose Driver |
| 24 | Deepen recovery guidance. | T050 Sleep Trend; T051 Sleep Plan; T052 Bedtime Reminder |
| 25 | Connect daily trackers. | T053 Hydration rhythm; T054 Nutrition pattern; T055 Movement style |
| 26 | Connect calm to decisions. | T056 Mental wellness pattern; T057 Breathing or meditation log; T058 Stress insight |
| 27 | Add education without overload. | T059 Health education; T060 Conditions and risks boundaries; T061 Professional or support boundary |
| 28 | Preview richer health data safely. | T062 Biomarkers Preview; T063 Connected Apps; T064 Connect Later |
| 29 | Turn health into a plan. | T065 Health Plans; T066 Services Hub; T067 Plan Step |
| 30 | Teach the full Memory system. | T068 Memory overview; T069 What Vitana knows; T070 Thirteen memory categories |
| 31 | Teach memory capture and search. | T071 Add Memory; T072 Memory Timeline; T073 Recall Memory |
| 32 | Teach memory control. | T074 Correct Memory; T075 Memory Permissions; T076 Data Export |
| 33 | Make diary more than journaling. | T077 Diary streak and rewards; T078 Photo diary; T079 Pillar lift from diary |
| 34 | Teach calendar operations. | T080 Calendar Agenda; T081 Create Calendar Event; T082 Reschedule Event |
| 35 | Teach Inbox and communication. | T083 Inbox Overview; T084 Inbox Tabs; T085 Draft Voice Note |
| 36 | Move from self to community. | T086 Community hub; T087 Today's highlights and rankings; T088 Global and community search |
| 37 | Teach the Feed. | T089 Feed Tabs; T090 Post Draft; T091 React Safely |
| 38 | Teach profile trust before contact. | T092 Profile Preview; T093 Public profile visibility; T094 QR and profile sharing |
| 39 | Teach Find a Match as a core system. | T095 Find a Match; T096 Match Types; T097 Why This Match |
| 40 | Teach match actions. | T098 Match List; T099 Search Matches; T100 Connect or Dismiss |
| 41 | Teach activity seeking and open asks. | T101 Post Activity; T102 Seek Meetup; T103 Intent Matches |
| 42 | Teach the intent loop. | T104 Respond Match; T105 Share Intent; T106 Fulfill Intent |
| 43 | Teach groups. | T107 Browse Groups; T108 Save Group; T109 Group Draft |
| 44 | Teach inside a group. | T110 Group Detail; T111 Group Chat; T112 Invite Members |
| 45 | Teach challenges. | T113 Challenges; T114 Challenge Progress; T115 Share Achievement |
| 46 | Teach event discovery. | T116 Events Search; T117 Event Filters; T118 Save Event |
| 47 | Teach event details and participation. | T119 Event Drawer; T120 Free RSVP; T121 Ticket Safety |
| 48 | Connect events to planning and matching. | T122 Add to Calendar; T123 Event Reminders; T124 Attendee Matching |
| 49 | Teach event creation explicitly. | T125 Create Event; T126 Event Basics; T127 Event Draft |
| 50 | Teach meetup creation explicitly. | T128 Create Meetup; T129 Activity, location, and time; T130 Invite members to meetup |
| 51 | Teach meetup management. | T131 Meetup Drawer; T132 Local Meetup; T133 Meetup Changes |
| 52 | Teach Live Rooms participation. | T134 Browse Live Rooms; T135 Join Listener; T136 Speak or Chat |
| 53 | Teach Live Room creation. | T137 Schedule Live Room; T138 Room topic and description; T139 Go Live safety |
| 54 | Teach Live Room media lifecycle. | T140 Live Room recordings; T141 Highlights and moments; T142 Room summaries |
| 55 | Teach Media Hub as its own surface. | T143 Media Hub overview; T144 Watch Shorts; T145 Save or bookmark media |
| 56 | Teach podcasts. | T146 Play Podcasts; T147 Audio Bar; T148 Podcast Routine |
| 57 | Teach music. | T149 Play Music; T150 Focus Music; T151 Media Overlay |
| 58 | Teach media upload. | T152 Upload Short; T153 Upload Podcast; T154 Publishing Rights |
| 59 | Close community foundation. | T155 Community recap; T156 Choose next social action; T157 Community trust becomes opportunity |
| 60 | Open the optional business doorway. | T158 Path Choice; T159 Economy Positioning; T160 Business Interest |
| 61 | Teach Discover as search, not sales. | T161 Discover Overview; T162 Search Discover; T163 Why Recommended |
| 62 | Teach product literacy. | T164 Supplements and products; T165 Product detail and suitability; T166 Save, wishlist, or cart |
| 63 | Teach provider discovery. | T167 Wellness services; T168 Providers, doctors, and coaches; T169 Provider profile trust |
| 64 | Teach commerce safety. | T170 Universal Cart; T171 Purchase Rules; T172 Refund Path |
| 65 | Teach wallet and subscription status. | T173 Wallet overview; T174 Credits, rewards, subscriptions; T175 Current plan and billing |
| 66 | Teach wallet value layers. | T176 Rewards Program; T177 Payment Methods; T178 Vitana Coin |
| 67 | Teach sharing as consent-based. | T179 Sharing overview; T180 Channel connector; T181 Social share consent |
| 68 | Teach campaigns. | T182 Campaign basics; T183 Create campaign draft; T184 Distribution and schedule |
| 69 | Teach sharing feedback and audit. | T185 Sharing analytics; T186 Posts history; T187 Data consent audit |
| 70 | Teach Business Hub without forcing it. | T188 My Business overview; T189 Business path check; T190 Skill inventory |
| 71 | Connect business to matching. | T191 Business Post; T192 Find Clients; T193 Match List |
| 72 | Teach events as business assets. | T194 Event Asset; T195 Event Plan; T196 Ticket Sales |
| 73 | Teach services as offers. | T197 Service as offer; T198 Outcome, audience, duration, price; T199 Service draft |
| 74 | Teach live rooms as trust assets. | T200 Live Trust; T201 Business Live Room; T202 Invite People |
| 75 | Teach media as business asset. | T203 Media Asset; T204 Content Plan; T205 Campaign Asset |
| 76 | Use whitepaper facts only after intent. | T206 Fact Bank; T207 $27T Economy; T208 Plain Summary |
| 77 | Explain AI work shift for builder users. | T209 Future Work; T210 Job Reshaping; T211 AI-Amplified Skill |
| 78 | Teach market sizing for builders. | T212 Market Size; T213 Wellness Economy; T214 Sector Fit |
| 79 | Teach demographic demand. | T215 Demographic Demand; T216 Aging Market; T217 Demand Fit |
| 80 | Teach decentralized work. | T218 Gig Proof; T219 Gig Economy; T220 Flexible Earning |
| 81 | Build the first offer ladder. | T221 Offer Ladder; T222 Offer Types; T223 First Offer |
| 82 | Teach Sell and Earn. | T224 Sell and Earn inventory; T225 Reseller link; T226 Commission tracking |
| 83 | Teach promotion channels. | T227 Promotion Channels; T228 Social Channels; T229 Share Copy |
| 84 | Teach campaign optimization. | T230 Campaign metrics; T231 Reach, clicks, engagement; T232 Improve one campaign |
| 85 | Teach client operations. | T233 Client management; T234 Booking, calendar, follow-up; T235 Delivery checklist |
| 86 | Teach earnings and payouts. | T236 Earnings and payouts; T237 Pending, available, history; T238 Withdrawal readiness |
| 87 | Teach Marketplace Autopilot. | T239 Marketplace Autopilot; T240 Opportunity suggestions; T241 Review why and permissions |
| 88 | Teach business safety. | T242 Responsible recommendations; T243 No false claims; T244 Trust and safety checklist |
| 89 | Convert learning into a sprint. | T245 Seven-day business sprint; T246 Vitana next best action; T247 Choose sprint metric |
| 90 | Graduate without removing Journey. | T248 Graduation; T249 Full Mode; T250 Next Milestone |

## Implementation Plan

### Phase 1: Content Model

Create `journey_topics` or `journey_lessons` with:

- `topic_id`
- `curriculum_version`
- `day_number`
- `position_in_day`
- `chapter_id`
- `title`
- `short_description`
- `display_label`
- `voice_script_id`
- `manual_path`
- `practice_action_type`
- `completion_event`
- `safety_level`
- `business_gate`
- `fallback_topic_id`
- `unlock_rule`
- `tenant`
- `role`
- `enabled`
- `status`
- `published_at`
- `updated_by_admin_id`

Create or extend Knowledge Base content storage so each checklist topic can point to:

- Vitana voice script
- transcript or silent-mode summary
- manual or knowledge source
- guided-practice definition
- feature unlock rule
- admin notes
- change history

Create `user_journey_progress` with:

- `user_id`
- `topic_id`
- `state`
- `started_at`
- `completed_at`
- `mastered_at`
- `skipped_at`
- `replay_count`
- `practice_payload`

Create or extend `user_capability_awareness` for mastery signals outside onboarding.

### Phase 1A: Admin Knowledge Base Checklist

Add `Admin Pages -> Knowledge Base -> Checklist`.

The checklist tab should provide:

- searchable table of all 250 topic cards
- filters for day, chapter, product area, state, business gate, and enabled/disabled
- inline editing for label, title, short description, day number, sort position, and topic state
- detail editor for Vitana script, transcript, practice action, completion event, unlock rule, manual source, and safety level
- validation before publish
- draft, preview, publish, and rollback
- import/export for bulk curriculum work
- audit log showing admin, timestamp, and changed fields

The My Journey UI must not hardcode the checklist. It should load the published checklist from the Knowledge Base and fall back only to a bundled seed version if the backend is unavailable.

### Phase 2: My Journey UI

My Journey should become the onboarding home:

- one scrollable catalog
- 90 usage sessions grouped into chapters
- 2 cards per session for sessions 1-20
- 3 cards per session for sessions 21-90
- previewable future sessions
- topic replay
- progress state per topic
- "business path" filter visible only after intent
- always-accessible account, billing, privacy, support, and emergency/safety paths

Recommended chapter grouping:

- Days 1-20: Trust, Life Compass, and first health wins
- Days 21-35: Home, health depth, Memory, Calendar, and Inbox
- Days 36-45: Community hub, Feed, Profile, Find a Match, activity intents, Groups, and Challenges
- Days 46-59: Events, meetups, Live Rooms, Media Hub, and community recap
- Days 60-69: Discover, Wallet, Sharing, campaigns, distribution, and consent
- Days 70-75: Business doorway, matching, events, services, live rooms, and media as assets
- Days 76-90: Builder mode, whitepaper facts, Sell and Earn, campaigns, clients, payouts, safety, and graduation

### Phase 3: Vitana Voice Behavior

Tapped topic flow:

1. Vitana explains the topic in one short pass.
2. Vitana offers the tiny guided practice.
3. The user completes or skips.
4. Vitana records `teacher_event`.
5. Vitana records completion only after the practice action.
6. Vitana suggests one next best action.

Use existing ORB behavior:

- teach-only for "what is this"
- navigate-only for "open this"
- teach-then-navigate for "how do I"
- confirmation for sending messages, purchases, bookings, profile changes, subscription changes, data sharing, and financial actions

### Phase 4: Business Gating

Default users should see only light business mentions.

Business-interested users should unlock:

- Longevity Economy
- Positioning in the Longevity Economy
- Business Hub
- Find Clients or Partners
- Create Event
- Create Service
- Event as Business Asset
- Sell and Earn
- Reseller Links
- Promotions
- Live Room as Trust Builder
- Media as Business Asset
- Social Sharing
- Wallet Earnings
- Marketplace Autopilot
- Whitepaper Facts
- Builder Strategy

If the user chooses health-only, business cards should remain previewable but not pushed.

### Phase 5: Measurement

Track:

- topic start rate
- explanation replay rate
- practice completion rate
- skip rate
- drop-off per day
- business_interest_level changes
- first community action
- first memory recall
- first calendar event or reminder
- first Inbox triage or voice note draft
- first profile trust signal
- first Find a Match action
- first activity intent or open ask
- first event search, save, or RSVP
- first Create Event draft
- first Create Meetup draft
- first Media Hub play
- first media upload draft
- first sharing consent review
- first invitation draft
- first live room plan
- first offer draft
- first campaign draft
- first wallet earning view

Success metrics:

- day 1 completion
- day 7 retention
- day 20 Life Compass clarity
- day 35 personal intelligence adoption: health loop, Memory, Calendar, Inbox
- day 45 first community connection action
- day 59 first event, meetup, live room, or media action
- day 69 Discover, Wallet, Sharing, and consent literacy
- day 75 business path asset preview for interested users
- day 90 graduation or Growth Mode continuation

## Product Decision

The final recommendation is:

- Use 250 topic cards.
- Keep the full app behind My Journey for first-time users.
- Do not hard-switch onboarding off after 90 lessons.
- After day 90, convert My Journey into Growth Mode.
- Mention longevity economy early as a possible path, not as a pitch.
- Store the 250-topic checklist in Admin Pages under `Knowledge Base -> Checklist`, with My Journey consuming the published version.
- Use the whitepaper facts only for explicit business interest.
- Treat financial freedom as a legitimate Life Compass goal.
- Teach that health creates capacity, community creates trust, trust creates opportunity, and opportunity can create income.
