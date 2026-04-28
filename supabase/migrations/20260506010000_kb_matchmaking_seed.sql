-- VTID-DANCE-D13 — Knowledge Base seed for matchmaking + dance
--
-- The matchmaking and dance specialised market are LIVE in production
-- but ORB had no narrative knowledge to draw on when users asked
-- "how does this work?" Result: terse one-sentence functional replies
-- that put first-time users off. This seed gives the assistant
-- voice-friendly explanatory content (200–400 words each, ~15–30s
-- when read aloud) so curious users get oriented properly.
--
-- Supervisors can extend / edit / replace these documents via the
-- existing admin UI at /admin/knowledge/Documents. New uploads go to
-- the same knowledge_docs table and the assistant picks them up via
-- search_knowledge_docs() automatically.

-- Helper: idempotent upsert via path uniqueness.
INSERT INTO public.knowledge_docs (title, path, content, source_type, tags) VALUES

-- ─── 1. The big-picture matchmaking explainer ───────────────────────
('How Vitana matchmaking works',
 'matchmaking/overview.md',
 'Vitana''s matchmaking is voice-first. You tell me what you''re looking for and I find the right people, events, or services for you across the community.

The way it works has three layers. First, you speak — "I''m looking for someone to dance with on Saturday," or "I want to learn salsa," or "I need a kitchen contractor in Vienna." I understand the kind of intent (partner-finding, learning, hiring, mutual help) and what details matter for it.

Second, I post your ask into our community catalogue so others can see and respond. Even when no one matches yet, your post is visible — that''s deliberate, because in a growing community somebody will arrive tomorrow looking for exactly what you asked today.

Third, I run a matchmaker that re-ranks candidates with reasoning. It''s not a dumb keyword filter — it considers your style preferences, your past matches, your location, your goals from the Life Compass, and even who you''ve responded to before. It explains every match: "Here''s why this person fits — same dance style, intermediate level, same city, free Tuesday evenings."

You can refine results by asking me follow-up questions. If your first ask was vague, I''ll suggest two or three small clarifications — what style, what time, what location — but you can always say "just show me what you''ve got" to skip them.

The community is at an early stage right now, so when matches are sparse, I''ll be honest about it and offer alternatives: people with similar profile preferences, upcoming events, or sharing your post with friends so they can find you. As more members join, the matches sharpen automatically.

The whole goal is that you can find people, learn skills, offer your services, or join activities just by talking — without filling out forms.',
 'markdown',
 ARRAY['vitana_system','matchmaking','overview','onboarding']),

-- ─── 2. Find a dance partner ────────────────────────────────────────
('How to find a dance partner with Vitana',
 'matchmaking/dance/find-partner.md',
 'Finding a dance partner on Vitana is as simple as telling me what you have in mind.

Just say something like: "I want to find someone to dance with," "Looking for a salsa partner Saturday night," or "Anyone going out dancing this weekend?" — and I''ll handle the rest.

If you give me details up front — style, level, location, time — I match precisely. If your ask is broad, I''ll ask you two or three small questions: what style do you have in mind, when, and roughly where? Each question is optional. You can always say "just post it" to skip ahead.

I''ll show you who in our community is also looking — usually with a short reason: "Maria3 dances salsa, intermediate level, lives in Vienna, free Tuesday evenings — strong fit." If nobody has an open ask matching yours yet, I''ll surface community members whose profiles say they dance the style you''re after, so you can message them directly.

You can also post your ask BEFORE the match exists. Your post stays visible in the community board until it''s fulfilled — somebody arriving next week looking for the same thing will find you automatically.

If you want to amplify your ask faster, I can share your post directly with friends in your Vitana network. Just say "share with @maria and @daniel" and they''ll get a chat with your post inline — they can express interest in one tap.

For dance specifically, our system understands the standard styles — salsa, tango, bachata, kizomba, swing, ballroom, hip-hop, contemporary — plus your level (beginner, social, intermediate, advanced, professional) and your role preference (lead, follow, either). All of that information helps the match quality.

Set your dance preferences in your profile under "My dance preferences" so I bias every match toward styles you actually dance.',
 'markdown',
 ARRAY['vitana_system','matchmaking','dance','partner_finding','dance_partner','onboarding']),

-- ─── 3. Learn dance from a teacher ──────────────────────────────────
('How to learn dance with Vitana — finding a teacher',
 'matchmaking/dance/learn-from-teacher.md',
 'If you want to learn dance, Vitana finds you a teacher in two ways: people in the community offering lessons, and existing classes you can join.

Just say: "I want to learn salsa," "Find me a tango teacher," or "Looking for someone to teach me bachata, beginner level, in Vienna" — and I take it from there.

I''ll match you against three sources at once. First, community members offering instruction: people who''ve posted that they teach. Second, scheduled classes and live rooms in the Vitana events catalogue, including online sessions. Third, when you give specific filters (gender, age, location radius, price range), I respect those, especially for one-on-one private lessons.

For each match, I''ll tell you what makes it a fit: style, level they teach, location, price, format (in person, online, or both), and schedule. You can ask follow-up questions before deciding ("how much does she charge?", "can I do my first lesson online?") and I''ll pull the answer if it''s in their post.

Vitana protects you on quality. Teachers offering paid lessons go through a trust-tier check: anyone teaching has to be community-verified at minimum, anyone charging more than 50 euros per lesson needs to be pro-verified. Reviews and completed-lesson counts come with the teacher''s profile.

Payments for paid lessons go through escrow — you pay when you book, the teacher receives the money after the lesson is confirmed. If something goes wrong, you can dispute and the platform mediates.

If nobody specific matches your filters yet, I''ll broaden the search progressively (same style any city, then any dance teacher in your area) and tell you what I broadened. You can always pin yourself: "Notify me when a salsa teacher posts in Vienna." Your subscription stays active until matched.',
 'markdown',
 ARRAY['vitana_system','matchmaking','dance','learning','learn_dance','teacher_search','onboarding']),

-- ─── 4. Teach dance via Vitana (for instructors) ────────────────────
('Teaching dance through Vitana — offering lessons',
 'matchmaking/dance/offer-teaching.md',
 'If you teach dance — professionally or just to share what you know — Vitana helps you reach the right students.

Tell me: "I teach salsa Tuesday evenings," "I''m offering tango lessons in Vienna, beginner-friendly, 40 euros per hour," or "I''m a hip-hop instructor, both in person and online" — and I''ll set up your offering in the catalogue.

Your offering shows up two ways: as an open post on our community board, and as a match candidate when somebody asks for the style you teach. The matchmaker considers your style, level, format (in person, online, or both), schedule, and price when ranking you for incoming students.

To offer paid lessons, your account needs at least the community-verified trust tier — three vouches from existing members, or a manual upgrade by the team. To charge more than 50 euros per session, you need pro-verified status, which goes through a profile review.

Pricing is flexible. You can offer free lessons (no trust requirement above community-verified), pay-what-you-want, fixed price, or sliding scale. If you want to charge, Vitana handles the booking and escrow through Stripe — students pay when they book, you receive the money after the lesson, minus a small platform fee that decreases with your subscription tier.

Free-tier accounts can post free lessons only. To attach a price tag (a paid lesson, paid class, paid workshop), you need a Pro or Biz subscription. Biz unlocks recurring paid series like "weekly Tuesday class" — important if you run a regular schedule.

Set your dance preferences and teaching specialty in your profile. The matchmaker biases incoming asks toward instructors whose declared specialties align — so a student asking for "intermediate salsa, Cuban style" finds you faster if your profile says exactly that.

Reviews and completion counts build over time. The local heroes leaderboard surfaces top teachers per city weekly, giving early instructors organic visibility.',
 'markdown',
 ARRAY['vitana_system','matchmaking','dance','teaching','offer_lessons','instructor','professional','onboarding']),

-- ─── 5. Why matches may be sparse early on ──────────────────────────
('Why I sometimes say "you''re early" — sparse matches in a growing community',
 'matchmaking/early-stage-honesty.md',
 'Vitana''s community is growing, which means in many categories you might post an ask and not find a match right away. I''ll always be honest with you about that — I won''t fake density that doesn''t exist.

When I detect that the available pool of matching people is small, I switch to what I call solo mode. In solo mode I''ll surface anyone broadly compatible — even if their ask doesn''t exactly match yours — and tell you transparently: "You''re among the first looking for this in our community right now."

Why it works this way: tight filters in a small community would mean zero matches almost always. So instead of hiding low-quality fits, I show you what''s there and label it honestly as "low specificity" or "soft match." You decide whether to message them anyway.

When the pool is bigger, I use stricter filters. The same ask in a city with a hundred active dancers gets you tighter, higher-confidence matches with better explanations. The system adjusts automatically — you don''t have to know which mode you''re in.

There are three things you can do when matches are sparse. First, post your ask anyway — it stays visible until somebody arrives looking for the same thing. Second, share your post directly with friends in Vitana — they get a one-tap "Express interest" card in their chat, fastest path to a real conversation. Third, browse the members directory and message someone whose profile preferences match what you want.

The Open Asks page in your community feed shows every public post with no matches yet — if you''re someone who likes to be helpful, that''s where you find people you can connect to immediately.

As more people join, your matches sharpen automatically. Every member who joins your dance style or your city makes everyone''s matches better. So inviting a friend to Vitana doesn''t just help them — it helps your own matches too.',
 'markdown',
 ARRAY['vitana_system','matchmaking','early_stage','sparse_pool','onboarding','community_growth']),

-- ─── 6. Sharing posts amplifies your search ─────────────────────────
('Sharing your posts to find matches faster',
 'matchmaking/sharing-posts.md',
 'When you post something on Vitana — looking for a dance partner, hiring a contractor, finding a hiking buddy — your post lives on the community board automatically. But if you already know people who might be interested, sharing your post directly is the fastest way to a real response.

You can share in three ways. First, by voice: "Share my dance post with @maria and @daniel." I resolve the names, ask you to confirm, and send the post directly to their chat with a card preview and an "Express interest" button right inside. They tap once and you''re in conversation.

Second, by tapping the share button on any post — your own or someone else''s — you get a sheet with the same options: in-app friends, copy public link, WhatsApp, email, or your phone''s native share menu. The public link works for anyone, even people not yet on Vitana, with a preview that shows what the post is about.

Third, ORB and the system both let you share AS PART of posting. If you ask "share this with my dance friends after you post," I''ll do both in one go.

Sharing is idempotent. If you accidentally share the same post to the same person twice, the second share is silent — no duplicate spam in their inbox.

There are sensible limits. Free accounts can share each post with up to 50 people in total, and up to 20 in one batch. Pro raises that to 200 / 50, and Biz removes the per-post cap. The same recipient receives at most ten inbound shares per day from people who aren''t mutual friends — protecting everyone from spam.

For sensitive posts (looking for a romantic life partner), sharing reveals your identity to the recipient. I''ll warn you before you confirm, because in those cases mutual reveal is the default privacy mode.

Sharing is the single biggest growth lever Vitana has. The community grows, your matches grow, your friends find what they need, and the platform sharpens for everyone.',
 'markdown',
 ARRAY['vitana_system','matchmaking','sharing','direct_invite','growth','onboarding']),

-- ─── 7. Privacy in matchmaking ──────────────────────────────────────
('Privacy in Vitana matchmaking',
 'matchmaking/privacy.md',
 'Privacy in Vitana works differently for different kinds of intents. The default is sensible for the kind of search you''re doing.

For most asks — finding a dance partner, hiring a service, looking for a tutor, posting an event — your post is public to the community by default. People can see your @vitana-id, the post title, and the description. They can''t see your private profile fields unless you''ve marked them public.

For finding a romantic life partner, the privacy is much stricter. Vitana uses what''s called mutual reveal mode: nobody sees your identity until BOTH sides have explicitly expressed interest in each other. If I say "I see a potential match," you''ll know there''s a candidate but not who it is. The other person sees the same thing about you. Only when both of you say "yes, I''m interested" does the system reveal both identities — and even then, you can withdraw at any time.

You can override the defaults. Every post lets you set visibility to public, tenant-only (just members of your active community), private (only you), or mutual reveal. The dance preferences in your profile have their own visibility — you can mark them public, tenant-only, or private from the profile editor.

Your @vitana-id itself is permanent and globally unique, but it''s your CHOICE whether to be discoverable in the public members directory. There''s a toggle in privacy settings called "Discover me on the members list" — by default it''s on, but you can turn it off and you''ll only appear when somebody explicitly searches for you.

Voice messages, intent posts, profile preferences, and reputation reviews are stored in the platform but never shared with external services without your active consent. The matchmaker agent runs on Vitana''s own infrastructure on Google Cloud, not on third-party LLMs.

If you ever want to know what data the platform has about you, ask me: "What does Vitana know about me?" and I''ll walk you through it.',
 'markdown',
 ARRAY['vitana_system','privacy','matchmaking','partner_seek','mutual_reveal','onboarding','data']),

-- ─── 8. Open Asks feed ──────────────────────────────────────────────
('The Open Asks feed — discover what the community needs',
 'community/open-asks-feed.md',
 'Open Asks is a public feed in your community section that shows every post in Vitana that hasn''t found a match yet. Think of it as a bulletin board where people are still waiting for a response — and where helpful members go to find ways to contribute.

You can find Open Asks in two ways: by tapping the Open Asks card on the community feed home, or by going directly to /comm/open-asks. The page shows posts ordered by most recent first, with filters by intent kind (looking to learn, offering to teach, buying, selling, activity partner, social, mutual aid) and a "dance only" toggle.

Each card shows the asker''s @vitana-id, the title, a short excerpt, the kind of intent, when it was posted, and the location or dance variety if those are set. Tapping a card opens the public post page where you can see the full details and respond.

Why is this here? Two reasons. First, social proof: when you post your own ask, it goes into the same feed and other people will see it. Knowing that helps people post more confidently — your ask isn''t invisible. Second, organic discovery: maybe somebody is asking for exactly the help you can offer, just without the matchmaker connecting you yet. The feed lets you find them yourself.

The feed updates constantly. As soon as a post gets a match (somebody responds, or the matchmaker finds a fit), it leaves the Open Asks list — keeping the feed focused on what still needs attention.

If you''re a teacher, a service provider, or someone with broad interests — checking Open Asks once a day is the most efficient way to find conversations you''re a natural fit for. The matchmaker handles direct matching; Open Asks handles the long tail.

For first-time users: Open Asks is also a great way to understand what the Vitana community is actually doing. Browse it for five minutes and you''ll get a real sense of who''s here and what they''re looking for.',
 'markdown',
 ARRAY['vitana_system','community','open_asks','feed','discovery','onboarding'])

ON CONFLICT (path) DO UPDATE SET
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  tags = EXCLUDED.tags,
  updated_at = now();

-- Recompute word_count for the upserted rows.
UPDATE public.knowledge_docs
   SET word_count = array_length(regexp_split_to_array(content, '\s+'), 1)
 WHERE path LIKE 'matchmaking/%' OR path = 'community/open-asks-feed.md';
