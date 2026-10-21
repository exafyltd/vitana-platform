-- VTID-03147 — Longevity Economy + Vitanaland knowledge base extension.
--
-- User request (2026-05-24): extend the Teacher / knowledge base so that
-- when investors or business-curious users ask "What is Vitanaland?",
-- "What is the Longevity Economy?", "How does Vitanaland make money?",
-- "What is Universal Human Contribution?", or similar, the Teacher /
-- assistant answers using the platform's canonical positioning rather
-- than improvised wording.
--
-- Sources of truth (already in the repo as of merge time):
--   - docs/knowledge-base/brand/maxina-longevity-manifesto.md
--   - docs/knowledge-base/en/06-financial-longevity/01-longevity-economy.md
--   - docs/knowledge-base/en/06-financial-longevity/02-earning-through-wellness.md
--   - docs/knowledge-base/en/06-financial-longevity/03-credits-cash-and-vtn.md
--   - docs/knowledge-base/en/07-maxina-experience/01-maxina-across-vitanaland.md
--   - docs/knowledge-base/en/07-maxina-experience/04-your-longevity-journey.md
--   - docs/knowledge-base/en/19-business-hub/01-business-hub-overview.md
--   - docs/knowledge-base/en/19-business-hub/05-sell-and-earn.md
--
-- This migration:
--   1. Inserts 7 long-form chapters under `kb/instruction-manual/longevity-economy/`
--      so `search_knowledge` returns them when the topic comes up in a session.
--   2. Inserts 3 `system_capabilities` rows for the discoverable concepts —
--      Longevity Economy, Vitanaland Platform, Vitanaland Business Model.
--      Pedagogical order 210-230 keeps them well below the highlights tier
--      (10-50) so a first-week user still hears about Life Compass / Vitana
--      Index / Autopilot / Diary / Activity Match first.
--   3. Locks DE+EN `teacher_intro_*` scripts for the 3 capabilities so the
--      Say-exactly pattern (VTID-03104) speaks them verbatim when the
--      Teacher introduces them.

BEGIN;

-- =====================================================================
-- Part 1: knowledge_docs chapters
-- =====================================================================

SELECT upsert_knowledge_doc(
  p_title       := 'What Vitanaland Is',
  p_path        := 'kb/instruction-manual/longevity-economy/01-what-is-vitanaland.md',
  p_content     := $CONTENT$---
chapter: 01
title: What Vitanaland Is
tenant: vitanaland
keywords: [vitanaland, what is vitanaland, platform, positioning, mission, longevity destination, was ist vitanaland, plattform]
related_concepts: ["02", "03", "04"]
---

## What it is

Vitanaland is a longevity destination — a unified platform where health, community, intelligence, and economics are designed to reinforce each other. It is not a wellness app, not a marketplace, and not a social network in the traditional sense. It is the place where your daily health work, your relationships with the people who matter, and the economic activity that supports your life are organized around one principle: living longer, stronger, and more connected.

## Why it exists

Most platforms in the wellness space optimize for engagement, advertising revenue, or product sales. Their economics are misaligned with health outcomes — the platform profits when you buy, not when you get healthier. Vitanaland rejects that model. We are building infrastructure for a different future: one where prevention replaces reaction, strength replaces fragility, community replaces isolation, purpose replaces distraction, and intelligence replaces guesswork.

Longevity is not about living forever. It is about living fully — for as long as possible. Lifespan is increasing, but healthspan is not. Chronic disease, isolation, normalized stress, and reactive health systems are the default. Vitanaland is the structural alternative.

## How it is organized

Inside Vitanaland, every tenant and every feature must serve vitality. The platform integrates:

- **A measurable vitality index** — your Vitana Index, a 0–999 score across the five health pillars (Nutrition, Hydration, Exercise, Sleep, Mental) plus a balance factor.
- **A community-powered longevity economy** — earning is tied to recommendations and behaviors that genuinely help others, not to advertising spend.
- **An AI-guided prevention system** — Vitana, the always-present intelligence, holds your full context across years and helps you act before problems escalate.
- **A destination where health, meaning, and prosperity align** — the Business Hub, Sell-and-Earn, Activity Match, Live Rooms, the Memory Garden, and the Diary all serve the same longevity mission.

## How to talk about it

When someone asks "What is Vitanaland?", do not list features. Lead with the principle: Vitanaland is the place where longevity is the organizing principle — measurable, structured, socially reinforced, and economically aligned with the health outcomes it produces. Then anchor with concrete examples (Vitana Index, the longevity economy, Vitana the AI) only as evidence of the principle.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','vitanaland','platform']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'The Longevity Economy',
  p_path        := 'kb/instruction-manual/longevity-economy/02-the-longevity-economy.md',
  p_content     := $CONTENT$---
chapter: 02
title: The Longevity Economy
tenant: vitanaland
keywords: [longevity economy, economic model, community economy, recommendations, trust-based earning, sell and earn, longevity-ökonomie, gesundheitsökonomie]
related_concepts: ["01", "03", "06"]
---

## What it is

The Longevity Economy is the economic model that powers Vitanaland. It is built on a simple principle that conventional wellness marketplaces violate: the platform's economics must be aligned with longevity outcomes. The activities that earn members value inside Vitanaland are the same activities that improve their health and strengthen their community.

## Why it is different

Most wellness marketplaces operate on the advertising model: companies pay to be promoted, platforms push products to users, and the user becomes the customer. The incentives are misaligned from the start — the products that get promoted are the ones with the highest margins, not the ones with the best outcomes.

Vitanaland's Longevity Economy is community-powered rather than advertiser-powered. The community decides what gets recommended based on what actually works. When a member shares a product, service, or experience that improved their health, that recommendation carries weight because it comes from real experience — not from a marketing budget. The system rewards value creation, which means the more helpful a member's contributions are, the more they earn.

## How earning works

There are three primary value streams inside the Longevity Economy:

- **Trust-based recommendations (Sell-and-Earn).** Members curate wellness lists — products, services, and resources they personally trust. When someone discovers and engages with a recommendation, the member earns a commission. This is not affiliate marketing in the traditional sense — there are no banner ads or pressure to move inventory. Recommendations flow through genuine relationships and relevance-based matching.
- **Professional services (Business Hub).** Wellness professionals — doctors, coaches, nutritionists, therapists, trainers, yoga instructors — operate full practices inside Vitanaland. Client acquisition is driven by relevance, not advertising; platform fees are transparent and sustainable rather than extractive.
- **Health-aligned credits.** Consistent health behavior, milestones, sustained Vitana Index improvement, and meaningful community engagement generate credits that hold real value inside the ecosystem. This is not a gamification trick — it is an economic incentive structure that reinforces the behaviors longevity science says matter most.

## Why money and longevity are inseparable

Chronic financial stress elevates cortisol, disrupts sleep, weakens immune function, and drives people toward the cheapest available food, which is almost always the least healthy. It reduces the ability to invest in preventive care, quality nutrition, and the social experiences that strengthen bonds. The body does not distinguish between the stress of a financial crisis and the stress of a physical threat — it responds the same way, with inflammation, hormonal disruption, and accelerated aging.

If longevity is the goal, financial resilience is not optional. It is foundational. That is why Vitanaland does not treat finances as something separate from the health journey. Financial wellbeing and physical wellbeing are part of the same system, reinforcing each other by design.

## How to talk about it

The Longevity Economy is not a marketing layer on top of a wellness app. It is the economic operating principle of the platform: align incentives with outcomes, reward authenticity, let recommendations flow through trust, and treat financial health as a pillar of physical health.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','economic_model','vitanaland']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'How Vitanaland Makes Money',
  p_path        := 'kb/instruction-manual/longevity-economy/03-vitanaland-business-model.md',
  p_content     := $CONTENT$---
chapter: 03
title: How Vitanaland Makes Money
tenant: vitanaland
keywords: [business model, revenue, monetization, platform fees, business hub, sell and earn, geschäftsmodell, einnahmen, monetarisierung]
related_concepts: ["02", "05"]
---

## What it is

Vitanaland operates a community-aligned business model rather than an advertising business model. Revenue flows from value that members and professionals create on the platform, with the platform earning a transparent share. This keeps the platform's incentives aligned with member outcomes: the platform grows when its members grow.

## Where the value comes from

Three primary value streams power the Vitanaland business model:

- **Sell-and-Earn commissions.** Every member can curate wellness lists and earn a share when their recommendations lead to qualifying engagement. Vitanaland's share of those commissions funds platform operations. Because Vitanaland earns only when a member earns, the platform's interest is in helping members make recommendations that actually work — not in pushing volume.
- **Business Hub services.** Wellness professionals — doctors, coaches, nutritionists, therapists, trainers, yoga instructors, complementary practitioners — operate practices through the Business Hub. Vitanaland charges a transparent, sustainable platform fee per session or booking. Client acquisition runs on relevance-based matching, not paid ads, so professionals are not paying advertising fees on top of platform fees.
- **Premium intelligence and concierge services.** Members who want deeper, longer, or specialist-grade intelligence from Vitana — extended memory windows, premium professional matchmaking, concierge-style coordination of services — can subscribe to higher tiers. The free tier delivers the core longevity experience; the premium tier deepens it without gating life-changing functionality.

## What it is NOT

Vitanaland does not sell its members' health data. There is no advertising marketplace selling member attention. There is no opaque "boost" market where professionals pay for placement above better-matched alternatives. Recommendations are driven by relevance, behavior, and community feedback — not by who paid the most.

## Why the model is sustainable

The model is sustainable because each revenue stream depends on a real outcome:

- A commission requires that a recommendation produced engagement, which requires that the recommendation was credible.
- A professional fee requires that a session happened, which requires that the matching produced a real client relationship.
- A premium subscription requires sustained perceived value over months and years, which requires that the intelligence actually improves the member's life.

When the platform fails to produce outcomes, revenue contracts. That is the discipline of an aligned model. When the platform produces outcomes, revenue compounds — because better recommendations strengthen the trust economy, better professional matches build healthier client bases, and a deeper intelligence layer makes both better over time.

## How to talk about it to investors and to members

For investors, the framing is: Vitanaland monetizes the value it helps members and professionals create, takes a transparent share, and refuses revenue streams that would misalign incentives with longevity outcomes. The TAM is the longevity economy itself — preventive health, behavioral health, longevity-aware financial activity, community-powered wellness — measured in the hundreds of billions of dollars globally and growing as healthspan-extension becomes the default consumer health goal.

For members, the framing is shorter: Vitanaland earns when you and your community thrive. We do not run ads, we do not sell your data, and we do not promote products you have not chosen to trust. Our incentives are pointed at your longevity, by design.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','business_model','vitanaland','investor']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Universal Human Contribution',
  p_path        := 'kb/instruction-manual/longevity-economy/04-universal-human-contribution.md',
  p_content     := $CONTENT$---
chapter: 04
title: Universal Human Contribution
tenant: vitanaland
keywords: [universal human contribution, uhc, purpose, ikigai, blue zones, contribution, mentorship, giving back, beitrag, sinn, lebensaufgabe]
related_concepts: ["02", "07"]
---

## What it is

Universal Human Contribution (UHC) is the principle that every person carries something valuable for others — experience, knowledge, time, attention, care, skill, or simply presence — and that the act of contributing what one has is itself a longevity intervention. UHC is not charity, volunteering, or unpaid work. It is the structural recognition that purpose is biologically protective and that platforms which give people meaningful ways to contribute extend lives.

## Why it matters for longevity

Research on centenarian populations — the Blue Zones communities that routinely produce people living past 100 — reveals a consistent finding: people with a strong sense of purpose live longer. The Japanese call it ikigai. The Costa Ricans call it plan de vida. Whatever the word, the meaning is the same — a reason to get up in the morning that goes beyond obligation.

Longevity research consistently shows that people who contribute to others — through mentorship, caregiving, teaching, community service, or sustained acts of help — experience measurable health benefits. Purpose reduces inflammation, improves immune function, correlates with longer telomeres, lowers mortality risk, and protects cognitive function into late life.

## How UHC is expressed inside Vitanaland

UHC is woven into every layer of the platform:

- **The Business Hub** lets wellness professionals turn their expertise into a sustained contribution to the community. Helping someone improve nutrition, manage stress, build strength, or navigate a health challenge is meaningful work — and meaningful work is biologically protective.
- **Sell-and-Earn** lets every member, not just professionals, contribute by curating what genuinely helped them. Honest recommendations from real experience are a contribution to the community's health.
- **Activity Match** turns the everyday desire for company — to run, cook, meditate, learn, or just talk — into matched pairs and groups, so that one person's intent becomes another person's invitation.
- **Mentorship and mastery** are the natural late-stage expression of a longevity journey. Members who have built a strong foundation, optimized their systems, and navigated their own challenges share what they learned. Vitanaland surfaces those opportunities deliberately, because contribution is not an optional decoration — it is part of the prescription.

## Why every contribution is valued

UHC rejects the idea that only credentialed expertise counts. A retired carpenter who teaches a teenager how to use tools is contributing. A grandmother who walks every morning and invites her neighbor along is contributing. A community member who recommends the supplement that finally fixed their sleep is contributing. The platform's design takes each of these contributions seriously, gives them visibility, and — where appropriate — couples them to economic reward through the Longevity Economy.

## How to talk about it

UHC is the answer to "Why should I bother helping anyone else when I'm just trying to take care of myself?" The answer is: because the research is unambiguous — contribution is part of how a body stays well into late life. Vitanaland is built so that taking care of yourself and contributing to others are the same motion, not competing demands.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','uhc','purpose','vitanaland']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Vitanaland for Investors',
  p_path        := 'kb/instruction-manual/longevity-economy/05-investor-perspective.md',
  p_content     := $CONTENT$---
chapter: 05
title: Vitanaland for Investors
tenant: vitanaland
keywords: [investor, investors, investment, positioning, market, tam, business case, defensibility, moat, investor questions, investor perspective, anleger, investor pitch]
related_concepts: ["01", "02", "03"]
---

## What an investor needs to understand first

Vitanaland is not a wellness app. Wellness apps are a saturated, low-defensibility category. Vitanaland is a longevity destination — a unified platform that brings together health measurement, community, AI, and an aligned economic layer around one organizing principle: longer, stronger, more connected lives.

The investor frame is: most of the consumer health market is being repriced as healthspan-extension becomes the default consumer goal. Vitanaland is positioned to be the platform on which that shift compounds, rather than another niche product riding the wave.

## Market

The addressable market is the Longevity Economy itself — preventive health, behavioral health, longevity-aware professional services, community-powered wellness, and longevity-aligned financial activity. Globally this is a multi-hundred-billion-dollar market that is growing as demographic, scientific, and consumer trends converge. The customer is anyone who is starting to take longevity seriously — and the share of the adult population for whom that is true is rising every year.

## Differentiation

Vitanaland's structural moat is the combination of four properties that are individually present elsewhere but rarely combined:

- **Measurement.** The Vitana Index gives every member a single, durable, multi-pillar score that the platform can act on. Without measurement, recommendations drift.
- **Aligned economics.** Revenue is earned only when members or professionals earn. The platform does not sell attention, does not sell data, and does not run an advertising marketplace. Members can verify this from the inside.
- **Persistent intelligence.** Vitana, the always-present AI, holds member context across years through the Memory Garden. The longer a member is on Vitanaland, the more useful the system becomes — and the higher the switching cost away from it.
- **Community as infrastructure.** Activity Match, Live Rooms, the Business Hub, and Sell-and-Earn make the community a productive layer, not a social feed. Members are not customers being sold to; they are participants in a longevity ecosystem.

## Business model

Three primary revenue streams, all aligned:

- **Sell-and-Earn commissions** — Vitanaland earns a share of commissions on recommendations that actually convert. The platform's revenue depends on recommendation quality.
- **Business Hub platform fees** — Wellness professionals pay a transparent, sustainable fee per session or booking. Client acquisition is relevance-driven; there is no advertising layer to fight.
- **Premium intelligence subscriptions** — Members who want deeper Vitana — extended memory, premium matchmaking, concierge coordination — subscribe to higher tiers. The free tier delivers core longevity functionality; premium deepens it.

The platform refuses to monetize through ads, data sales, or paid placement, because each of those would degrade the underlying longevity outcomes that the moat depends on.

## Defensibility and durability

The longer a member is on Vitanaland, the more valuable Vitanaland becomes to them — and the harder it is to replicate elsewhere. Memory accumulates. Trust accumulates. The community network thickens. Professional reputations and recommendation track records take years to build, and they are portable only at significant cost. The platform compounds with use, which is the structural property of durable platforms in every category.

## How to talk to an investor in one sentence

Vitanaland is the operating system for the Longevity Economy: it measures vitality, organizes community, persists context through AI, and aligns its economics with the outcomes it produces — and the structural property of the model is that every additional year of use deepens the moat.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','investor','business_model','vitanaland']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Trust-Based Earning and Recommendations',
  p_path        := 'kb/instruction-manual/longevity-economy/06-trust-based-earning.md',
  p_content     := $CONTENT$---
chapter: 06
title: Trust-Based Earning and Recommendations
tenant: vitanaland
keywords: [sell and earn, recommendations, trust, curated lists, passive income, affiliate, empfehlungen, verdienen]
related_concepts: ["02", "03"]
---

## What it is

Trust-based earning is the heart of the Longevity Economy's day-to-day mechanics. Every member can curate a personal list of wellness products, services, and resources they have personally used and genuinely benefited from, share that list with the community, and earn a commission when someone engages with a recommendation. The mechanism is called Sell-and-Earn.

## Why it works

The recommendations on Vitanaland carry weight because they come from real experience. A community member who shares a supplement that fixed their own sleep has lived through the result. A trainer who recommends a piece of equipment used it for years before recommending it. A nutritionist who lists a meal-planning service tested it on their own clients before adding it. The product gets weight from the experience, not from advertising spend.

The platform amplifies this: when a member's health profile, expressed goals, or pillar data align with something on a curator's list, Vitana surfaces the recommendation to that member. The distribution is driven by relevance, not by who paid for placement. Quality drives reach, not the other way around.

## How earning compounds

A recommendation that genuinely helps people keeps generating value over time. A curated list built three months ago can still produce income today if its items still work. This is not active marketing — it is sustained trust. Members who become known for the quality of their recommendations build a wellness reputation, and that reputation translates into a growing audience and a growing income stream.

The platform reinforces honest curation by making the relationship transparent. Members who engage with a recommendation can see that the curator earns from the engagement. That disclosure builds trust rather than eroding it, because the community understands and respects compensation for shared expertise.

## The responsible-recommendation principles

Sell-and-Earn is built on trust, and trust requires discipline:

- **Recommend from experience.** Only add items personally used and genuinely benefited from. Recommending something untested, solely for the commission, undermines credibility and potentially harms someone's health.
- **Be honest about limitations.** Nothing works for everyone. If a product helped but took six weeks, say so. If it works well for one pillar and not another, share that context. Nuance builds more trust than unqualified praise.
- **Prioritize outcomes over earnings.** If a product on a curator's list stops working — or worse, starts producing complaints — remove it immediately, regardless of how much income it generates. The community's health is always the priority.

## Why this differs from affiliate marketing

Conventional affiliate marketing rewards reach. Trust-based earning rewards relevance. A list with 30 banner-promoted products in a category produces less in Vitanaland than a list of 5 items the curator deeply trusts, because the platform's matching engine optimizes for outcome, not for clicks. The economic structure pushes the curator toward quality, not volume.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','sell_and_earn','recommendations','vitanaland']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Why Blue-Zones Research Anchors the Model',
  p_path        := 'kb/instruction-manual/longevity-economy/07-blue-zones-foundation.md',
  p_content     := $CONTENT$---
chapter: 07
title: Why Blue-Zones Research Anchors the Model
tenant: vitanaland
keywords: [blue zones, research, science, evidence, ikigai, plan de vida, social bonds, community longevity, blue zones forschung, langlebigkeit forschung]
related_concepts: ["02", "04"]
---

## What it is

The architecture of Vitanaland is grounded in the longevity research that came out of the Blue Zones — the small number of geographically distinct communities that reliably produce people living past 100 in unusually good health. Okinawa (Japan), Sardinia (Italy), Nicoya (Costa Rica), Ikaria (Greece), and Loma Linda (California, USA) are the canonical five. Decades of research across those communities surfaced a consistent set of structural factors that correlate with healthy long life, and those factors became design constraints for Vitanaland.

## The structural findings

The Blue Zones research and adjacent longevity literature converge on a small set of factors:

- **Sustained, low-intensity movement** woven into daily life rather than concentrated in scheduled exercise sessions.
- **Largely plant-forward, minimally processed nutrition** with the right combination of macronutrients for the population in question.
- **Strong, committed social bonds** that endure for years — the Okinawan Moai, the Sardinian village networks, the Loma Linda congregational bonds — not casual acquaintances.
- **Sense of purpose** — ikigai, plan de vida, a reason to get up in the morning — that persists into late life and is often connected to contribution to others.
- **Effective stress regulation** through community ritual, contemplative practice, or simply structural slowness.
- **Healthspan-aligned economics** — communities where economic activity is local, relational, and tied to the kind of work and recognition that does not erode the body.

## How Vitanaland is built around these findings

Every major feature inside Vitanaland is a structural translation of one or more Blue-Zones factors into a digital-first ecosystem:

- The **five health pillars** (Nutrition, Hydration, Exercise, Sleep, Mental) operationalize the movement, nutrition, and recovery findings.
- **Activity Match, Live Rooms, and community groups** are the digital equivalent of village networks and Moais — structural infrastructure for committed, repeated social engagement.
- **The Memory Garden and Diary** create the continuity that lets purpose survive across decades — the platform remembers who someone is and what matters to them across years.
- **Universal Human Contribution and the Business Hub** are the platform's recognition that purpose and contribution are biological factors, not optional decoration.
- **The Longevity Economy** is the structural translation of the Blue-Zones finding that local, relational economic activity is part of what protects people, not separate from it.

## Why this matters when explaining Vitanaland

Vitanaland is not biohacking culture. It is not a supplement marketplace, a longevity-tech hype play, or a wellness-influencer platform. It is an attempt to translate the structural conditions that produced the world's longest-lived populations into infrastructure that anyone can use — and to make those conditions accessible, not accidental.

When someone asks "What's the evidence base?", point them here: the Blue-Zones literature, the adjacent research on purpose and inflammation, the work on social bonds and mortality, and the body of preventive-cardiology and cellular-aging research (including the lines associated with researchers like David Sinclair). Vitanaland's design is downstream of that science, not upstream of it.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','research','blue_zones','vitanaland']::text[]
);

-- =====================================================================
-- Part 2: system_capabilities rows (3 new entries)
-- =====================================================================
-- pedagogical_order range 210-230 keeps these well below the existing
-- advanced tier cap (marketplace=200), so a first-week user still hears
-- about the action-oriented highlights first. These three only surface
-- when the LLM judges them topically relevant (e.g., user asks an
-- investor-style question, or asks "what is Vitanaland").

INSERT INTO system_capabilities (
  capability_key, display_name, description,
  required_role, required_integrations, helpful_for_intents,
  manual_path, pedagogical_order,
  teacher_intro_de, teacher_intro_en
) VALUES
  ('vitanaland_platform',
   'Vitanaland',
   'A longevity destination — the unified platform where health, community, AI, and an aligned economy reinforce each other.',
   'community', NULL,
   ARRAY['explain_platform','understand_mission','investor_question'],
   'kb/instruction-manual/longevity-economy/01-what-is-vitanaland.md',
   210,
   $DE$Vitanaland ist ein Ort, an dem Gesundheit, Gemeinschaft, künstliche Intelligenz und ein faires Wirtschaftsmodell zusammen einen Sinn ergeben — länger, stärker und verbundener zu leben. Wir bauen keine weitere Wellness-App, sondern eine Plattform, in der jedes Feature dem gleichen Ziel dient: messbare Vitalität, echte Gemeinschaft und eine Ökonomie, die sich an deinen Gesundheitsergebnissen orientiert — nicht an Werbung. Lebenslänge nimmt überall zu, aber die gesunde Lebenszeit nicht — wir wollen das ändern, und du bist Teil dieses Prinzips, sobald du im Inneren bist. Magst du, dass ich dir als Nächstes erkläre, wie die Longevity Economy konkret funktioniert?$DE$,
   $EN$Vitanaland is the place where health, community, AI, and a fair economic model add up to one thing — living longer, stronger, and more connected. We are not building another wellness app; we are building a platform where every feature serves the same goal: measurable vitality, real community, and an economy aligned with your health outcomes — not with advertising. Lifespan is rising everywhere, but healthy lifespan is not — we are here to change that, and you are part of that principle from the moment you step inside. Want me to walk you through how the Longevity Economy actually works next?$EN$
  ),
  ('longevity_economy',
   'Longevity Economy',
   'The community-powered economic model where earning is tied to recommendations and behaviors that actually help others live longer.',
   'community', NULL,
   ARRAY['explain_economy','earn_money','sell_and_earn','investor_question'],
   'kb/instruction-manual/longevity-economy/02-the-longevity-economy.md',
   220,
   $DE$Die Longevity Economy ist das wirtschaftliche Herz von Vitanaland — ein Modell, das Verdienen und Gesundheit nicht trennt, sondern verbindet. Du verdienst, indem du Empfehlungen aussprichst, die wirklich helfen, indem du Wissen teilst, das anderen weiterhilft, oder indem du als Fachperson eine echte Praxis mit Klienten aufbaust — nicht durch Werbung oder Datenverkauf. Auch finanzielle Stabilität gehört zur Langlebigkeit, weil chronischer Geldstress nachweislich Schlaf, Hormone und Immunsystem belastet — deshalb behandeln wir dein finanzielles und dein körperliches Wohl als ein System. Soll ich dir gleich zeigen, wie du persönlich davon Teil sein kannst?$DE$,
   $EN$The Longevity Economy is the economic heart of Vitanaland — a model that does not separate earning from health, it connects them. You earn by sharing recommendations that genuinely help, by contributing knowledge others can use, or by building a real client-facing practice as a professional — not through advertising or data sales. Financial stability is part of longevity, because chronic financial stress measurably damages sleep, hormones, and immune function — so we treat your financial wellbeing and your physical wellbeing as one system. Want me to show you how you can personally become part of it right away?$EN$
  ),
  ('vitanaland_business_model',
   'How Vitanaland Makes Money',
   'The aligned revenue model: commission share, Business Hub fees, and premium intelligence — no ads, no data sales, no paid placement.',
   'community', NULL,
   ARRAY['explain_business_model','investor_question','platform_economics'],
   'kb/instruction-manual/longevity-economy/03-vitanaland-business-model.md',
   230,
   $DE$Vitanaland verdient Geld nur dann, wenn auch die Mitglieder und Fachkräfte auf der Plattform verdienen — das ist der zentrale Mechanismus. Konkret heißt das drei Einnahmequellen, alle transparent: ein Anteil an erfolgreichen Empfehlungen (Sell-and-Earn), eine faire Plattformgebühr für jede Sitzung im Business Hub, und Premium-Abonnements für tiefere Intelligenz-Funktionen wie erweiterte Erinnerung oder Concierge-Begleitung. Was wir nicht tun: Werbung verkaufen, deine Gesundheitsdaten verkaufen oder bezahlte Platzierungen erlauben — denn jede dieser Optionen würde unsere Anreize gegen deine Langlebigkeit ausrichten. Soll ich dir erklären, wie die Anreize konkret funktionieren?$DE$,
   $EN$Vitanaland only earns when its members and professionals also earn — that is the core mechanism. In practice that means three revenue streams, all transparent: a share of successful recommendations (Sell-and-Earn), a fair platform fee on every session in the Business Hub, and premium subscriptions for deeper intelligence features like extended memory or concierge coordination. What we do not do: sell ads, sell your health data, or allow paid placement — because each of those would point our incentives away from your longevity. Want me to walk you through how those incentives actually work?$EN$
  )
ON CONFLICT (capability_key) DO UPDATE SET
  display_name              = EXCLUDED.display_name,
  description               = EXCLUDED.description,
  required_role             = EXCLUDED.required_role,
  required_integrations     = EXCLUDED.required_integrations,
  helpful_for_intents       = EXCLUDED.helpful_for_intents,
  manual_path               = EXCLUDED.manual_path,
  pedagogical_order         = EXCLUDED.pedagogical_order,
  teacher_intro_de          = EXCLUDED.teacher_intro_de,
  teacher_intro_en          = EXCLUDED.teacher_intro_en;

COMMIT;
