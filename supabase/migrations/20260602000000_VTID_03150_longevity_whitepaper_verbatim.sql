-- VTID-03150 — Replace VTID-03147 KB content with Vitanaland Whitepaper
-- (May 2026) verbatim wording.
--
-- VTID-03147 seeded 7 knowledge_docs under
-- kb/instruction-manual/longevity-economy/ and 3 system_capabilities rows
-- (vitanaland_platform / longevity_economy / vitanaland_business_model)
-- using in-repo source material as a stand-in because the whitepaper PDF
-- was not in context at write time. The author has now re-shared the
-- PDF and explicitly requested the whitepaper's own wording.
--
-- This migration:
--   1. Re-upserts all 7 knowledge_docs with whitepaper-verbatim content
--      (definition box, three characteristics, "What Is Vitanaland?"
--      one-sentence box, For Users / For Professionals / For Investors
--      paragraphs, Universal Human Contribution paragraph, Industrial vs
--      Longevity table, $27T / $6.8T / 2.1B headline numbers, the 45/22/
--      18/8/7% economic-model distribution, the Maxina + Mariia Maksina
--      paragraph, the closing quote). Each chapter still ends with a
--      "How to talk about it" hint for the Teacher; everything above
--      that hint is whitepaper-original text quoted verbatim.
--   2. UPDATEs the 3 system_capabilities rows' teacher_intro_de /
--      teacher_intro_en to use the whitepaper's positioning language
--      ("operating system for the Longevity Economy", "infrastructure for
--      a new economy", "Universal Human Contribution", "more human than
--      ever before"). DE versions are faithful translations of the
--      English whitepaper text, not paraphrases.
--
-- Source document: Vitanaland Whitepaper, "The Operating System for the
-- Longevity Economy", Dragan Alexander, Exafy LTD, Abu Dhabi UAE, May
-- 2026 (sections 1, 2, 4.1, 5.1, 7.1, 8, 9.3, 11 + the closing quote).

BEGIN;

-- =====================================================================
-- Part 1: knowledge_docs — re-upsert with whitepaper-verbatim content
-- =====================================================================

SELECT upsert_knowledge_doc(
  p_title       := 'What Vitanaland Is',
  p_path        := 'kb/instruction-manual/longevity-economy/01-what-is-vitanaland.md',
  p_content     := $CONTENT$---
chapter: 01
title: What Vitanaland Is
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Section 8 "What Is Vitanaland?"
keywords: [vitanaland, what is vitanaland, platform, operating system, longevity economy, positioning, was ist vitanaland]
related_concepts: ["02", "03", "05"]
---

## In one sentence (whitepaper, Section 8)

> Vitanaland is the operating system for the Longevity Economy — the connected ecosystem that brings together health, community, events, services, AI guidance, trust, and business tools in one place.

The Longevity Economy is the growing world around living healthier, longer, and better. It includes health, prevention, wellness, nutrition, movement, sleep, mental wellbeing, care, social connection, events, services, products, experts, and new businesses that help people improve their quality of life. Vitanaland brings these parts together in one connected ecosystem.

## For Users (whitepaper, Section 8)

> For users, Vitanaland is a personal place to organize their longevity journey. It helps people improve their health, build better daily habits, meet like-minded people, join communities, find events, discover services, and get guidance from Vitana, the AI assistant inside the platform.

## For Professionals and Businesses (whitepaper, Section 8)

> For professionals, creators, coaches, event hosts, and businesses, Vitanaland is a place to offer services, build an audience, create events, sell products, and grow a business inside the longevity market.

## For Investors and Partners (whitepaper, Section 8)

> For investors and partners, Vitanaland is more than a wellness app. It is infrastructure for a new economy. It connects users, experts, services, communities, events, data, AI, trust, and business tools in one ecosystem.

## What makes Vitanaland different (whitepaper, Section 8)

What separates Vitanaland from most AI tools and wellness platforms is that it is not only a chatbot, not only a tracker, and not only a social network. Vitanaland combines personal AI guidance, health and lifestyle support, community and relationship matching, events, expert discovery, marketplace tools, trust systems, and business tools in one place.

Vitana, the AI guide, uses context to understand what a person needs. It can help users find the right people, the right events, the right services, and the right next steps. This makes the platform more personal and more useful over time.

## The Goal of Vitanaland (whitepaper, Section 8)

> Help people live healthier and better lives. Help people find meaningful relationships and communities. Help professionals and creators build new longevity businesses. Help the Longevity Economy grow through one connected ecosystem.

## How to talk about it

When someone asks "What is Vitanaland?", lead with the one-sentence definition above word-for-word. Then pick the audience-appropriate paragraph (For Users / For Professionals / For Investors) and quote it. Do not improvise alternative wording — these passages are the official positioning text from the May 2026 whitepaper.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','vitanaland','platform','whitepaper']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'The Longevity Economy',
  p_path        := 'kb/instruction-manual/longevity-economy/02-the-longevity-economy.md',
  p_content     := $CONTENT$---
chapter: 02
title: The Longevity Economy
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Section 2 "What Is the Longevity Economy?" + Section 5.1
keywords: [longevity economy, definition, $27 trillion, $6.8 trillion, wellness economy, 20% gdp, longevity-ökonomie]
related_concepts: ["01", "04", "06"]
---

## Definition (whitepaper, Section 2)

> The Longevity Economy is the growing world of economic activity built around living healthier, longer, and better. It includes health, prevention, wellness, nutrition, movement, sleep, mental wellbeing, care, social connection, events, services, products, the experts who provide them, and the new businesses that help people improve their quality of life.

For most of the industrial era, "the economy of aging" was understood narrowly — as hospitals, pharmaceuticals, insurance, and institutional eldercare. The Longevity Economy is far broader. It spans the entire human lifespan and treats health not as the absence of disease, but as something to be actively built: through daily habits, preventive engagement, community, purpose, and connection.

It is, in essence, the sum of every economic exchange that helps a person add healthy, meaningful years to their life — and life to their years. A coach guiding a client toward better sleep is part of it. A neighbor cooking nutritious meals for an aging resident is part of it. A dance event that brings isolated people into joyful, physical, social contact is part of it. So are biomarker testing, walkable community design, mental-wellness apps, longevity-focused real estate, and AI assistants that help people navigate all of the above.

## Three characteristics (whitepaper, Section 2 — verbatim)

> **It optimizes for health and trust** rather than scale and efficiency. Value is created through personalized service and sustained relationships, not standardized mass production.
>
> **It is local and human.** Communities themselves become marketplaces; individuals become economic nodes who can provide care, coaching, food, companionship, and coordination to the people around them.
>
> **It treats technology as an amplifier, not a replacement.** AI and robotics remove the friction — discovery, coordination, trust, logistics — that historically made human-centered services hard to scale, freeing people to do the genuinely human work that remains in demand.

## Scale (whitepaper, Sections 1, 2, 5.1)

- **$27 trillion** — the projected size of the global longevity economy by 2026, representing more than 20% of global GDP.
- **More than 20% of global GDP** — the Longevity Economy is not a niche; on conservative estimates it already represents over a fifth of all economic activity on Earth, and it is growing faster than GDP as a whole.
- **$6.8 trillion** — the global wellness economy in 2024, projected to reach $9.8 trillion by 2029 at 7.6% annual growth (Global Wellness Institute, 2025).
- The wellness economy has doubled since 2013 and is now substantially larger than the global pharmaceutical industry. All 11 wellness sectors now exceed their 2019 values.

## How to talk about it

When someone asks "What is the Longevity Economy?", quote the boxed definition word-for-word, then optionally name 2–3 of the concrete examples from the second paragraph (the sleep coach, the nutritious-meal neighbor, the dance event). If they want scale, lead with "$27 trillion by 2026 — more than 20% of global GDP." Do not invent your own definition.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','definition','market_size','whitepaper']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'How Vitanaland Makes Money (Economic Model)',
  p_path        := 'kb/instruction-manual/longevity-economy/03-vitanaland-business-model.md',
  p_content     := $CONTENT$---
chapter: 03
title: How Vitanaland Makes Money (Economic Model)
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Section 9.3 "Economic Model and Value Distribution"
keywords: [business model, economic model, revenue, value distribution, 45% providers, no ads, geschäftsmodell]
related_concepts: ["02", "05"]
---

## The Vitanaland economic model (whitepaper, Section 9.3 — verbatim)

> Vitanaland's economic model represents a fundamental departure from both traditional healthcare and institutional care systems and conventional gig economy platforms.

### Traditional Longevity Economy cost structure

In the traditional model, a significant portion of spending is absorbed by administrative overhead (18%), insurance intermediaries (12%), and physical infrastructure (10%) — leaving only 35% for actual healthcare systems and 25% for institutional care.

### Vitanaland decentralized value distribution

> - **45% Direct to Care Providers** — ensuring that those delivering human-centered services receive fair, sustainable compensation
> - **22% Preventive Wellness** — investing in programs and services that reduce long-term health costs
> - **18% Community Services** — supporting local infrastructure, coordination, and community-building activities
> - **8% Platform Operations** — maintaining and improving the technology infrastructure
> - **7% Quality & Trust Systems** — ensuring safety, verification, and continuous quality improvement

## Value Redistribution box (whitepaper, Section 9.3 — verbatim)

> The Vitanaland model increases the share of economic value flowing directly to providers from roughly 25–35% in traditional systems to 45%, while simultaneously reducing total system costs through AI-powered efficiency and preventive health investment.

Vitanaland therefore positions itself not merely as a technology platform, but as the operating system of the Longevity Economy — the infrastructure layer for decentralized human collaboration, and the foundation for a future where AI amplifies humanity instead of replacing it.

## Cost-benefit (whitepaper, Section 10.2 — per 10,000 population, 10-year)

| Metric | Traditional | Vitanaland | Δ |
| --- | --- | --- | --- |
| Annual system cost per user | $8,400 | $5,200 | -38% |
| Provider compensation (annual) | $2,100 | $3,800 | +81% |
| Administrative overhead | $1,512 (18%) | $416 (8%) | -72% |
| Institutional care days per 100 elders | 42 | 18 | -57% |
| Social-connection score (0–100) | 34 | 68 | +100% |
| Provider satisfaction (0–100) | 28 | 76 | +171% |
| Emergency-care visits per 100 users | 23 | 14 | -39% |

## Projected economic impact (whitepaper, Section 10.1)

> **$205 Billion** — total projected cumulative economic value creation by Vitanaland by 2035, comprising $80B in provider income, $64.5B in healthcare savings, and $60.5B in community economic multiplier effects.

## How to talk about it

For "How does Vitanaland make money?" the answer is the 45/22/18/8/7% distribution — quote those five bullets in order. Add the Value-Redistribution sentence ("from roughly 25–35% in traditional systems to 45%") whenever the listener needs the *why*. For investor-grade conversations, anchor on "$205 billion total projected value creation by 2035" and the cost-benefit table above.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','business_model','value_distribution','whitepaper','investor']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Universal Human Contribution',
  p_path        := 'kb/instruction-manual/longevity-economy/04-universal-human-contribution.md',
  p_content     := $CONTENT$---
chapter: 04
title: Universal Human Contribution
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Section 7.1 "From Universal Basic Income to Universal Human Contribution"
keywords: [universal human contribution, uhc, ubi, decentralized economy, contribution, beitrag]
related_concepts: ["02", "07"]
---

## From Universal Basic Income to Universal Human Contribution (whitepaper, Section 7.1 — verbatim)

> Many governments and economists have debated Universal Basic Income (UBI) as a response to automation-driven job displacement. While UBI addresses the symptom — income loss — it does not address the cause: the displacement of meaningful human contribution, social connection, and purposeful activity that employment traditionally provides.
>
> Vitanaland introduces a broader concept: **Universal Human Contribution**. Instead of distributing value passively, the Longevity Economy enables individuals to actively participate in decentralized economic ecosystems supported by AI and robotics. People no longer need to rely solely on corporations, centralized employment, or institutional gatekeepers. Instead, they can cook, teach, care, farm, coach, transport, protect, support, guide, create, and contribute directly to their communities.
>
> AI continuously identifies community demand, economic opportunities, health needs, trusted matches, and optimized participation pathways. This creates the possibility for millions of people to:
>
> - Improve personal health through preventive engagement
> - Improve social connection through meaningful service
> - Build meaningful local businesses with low barriers to entry
> - Generate recurring income through trusted participation
> - Participate in a healthier, more human economic system
>
> The future economy therefore becomes not less human, but more human than ever before.

## How to talk about it

UHC is the answer to "Why not just give everyone UBI?" Quote the first paragraph word-for-word — UBI addresses the *symptom* (income loss), UHC addresses the *cause* (displacement of meaningful contribution). Then read the five-bullet list of what the platform enables. The closing line ("not less human, but more human than ever before") is also the whitepaper's closing quote — use it as the natural conversational landing.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','uhc','purpose','whitepaper']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Vitanaland for Investors',
  p_path        := 'kb/instruction-manual/longevity-economy/05-investor-perspective.md',
  p_content     := $CONTENT$---
chapter: 05
title: Vitanaland for Investors
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Sections 1, 3, 4, 5, 8, 9.3, 10
keywords: [investor, investment, positioning, market size, $27 trillion, moat, business case, anleger]
related_concepts: ["01", "02", "03"]
---

## The investor sentence (whitepaper, Section 8 — verbatim)

> For investors and partners, Vitanaland is more than a wellness app. It is infrastructure for a new economy. It connects users, experts, services, communities, events, data, AI, trust, and business tools in one ecosystem.

## The central thesis (whitepaper, Section 1 — verbatim)

> Unlike previous industrial transitions that centralized economic power into large corporations, AI dramatically lowers barriers for individual economic participation. For the first time in human history, billions of people can directly monetize their skills, local communities can become self-sustaining economic ecosystems, and AI can coordinate human contribution at massive scale without centralized intermediaries.

## Three converging mega-trends (whitepaper, Section 1)

> - **Technological Disruption:** AI and robotics will reshape 50–55% of all jobs within the next two to three years, while creating entirely new categories of human-centered work.
> - **Demographic Transformation:** The global population aged 60 and older will double to 2.1 billion by 2050, creating massive demand for health, wellness, and care services.
> - **Economic Decentralization:** The gig economy is projected to grow from $582 billion in 2025 to over $2.1 trillion by 2034, demonstrating the shift toward flexible, platform-based work.

## Market size (whitepaper, Sections 1, 5.1)

- **$27 trillion** global longevity economy by 2026 — more than 20% of global GDP.
- **$6.8 trillion** global wellness economy in 2024 → **$9.8 trillion** by 2029 at 7.6% annual growth.
- AgeTech segment alone reaches **$2.7 trillion by 2025** (21% annual growth).
- Wellness Real Estate growing **15.8%** annually; Traditional & Complementary Medicine **10.8%**; Mental Wellness **10.1%**.

## Defensibility (whitepaper, Section 9.1 — four integrated layers)

Vitanaland's architecture consists of four integrated layers that, in combination, constitute the structural moat:

1. **Intelligence Layer** — AI assistants with contextual intelligence and infinite memory, specifically attuned to longevity science, care protocols, community dynamics, and local economic patterns. Not a general-purpose AI tool.
2. **Trust & Identity Layer** — verification, reputation scoring, peer review, and quality-assurance that replace traditional institutional gatekeepers. Trust becomes portable across communities and services.
3. **Marketplace Layer** — specialized longevity marketplaces connecting providers and consumers across all categories of human-centered services, with AI-powered matching that optimizes for compatibility, proximity, schedule alignment, and quality outcomes.
4. **Economic Layer** — frictionless payments, income tracking, benefits accrual, and financial services tailored to decentralized workers. Designed to *return* maximum value to providers, not extract it.

## Economic impact (whitepaper, Section 10)

> **$205 Billion** — total projected cumulative economic value creation by Vitanaland by 2035, comprising $80B in provider income, $64.5B in healthcare savings, and $60.5B in community economic multiplier effects.

Conservative adoption trajectory: 150 → 450 active providers per 10,000 population; average monthly provider income $800 (Year 1) → $2,400 (Year 10); platform coverage scaling from 500,000 to 50 million users over 10 years.

## The investor frame in one paragraph

For an investor, Vitanaland is the operating-system bet on the Longevity Economy: $27 trillion market, three converging mega-trends (AI labor reshape, demographic doubling of 60+, gig-economy growth to $2.1T), four integrated structural layers (intelligence, trust, marketplace, economic), and an economic model that returns 45% directly to providers versus 25–35% in traditional systems — designed to compound platform value with every additional year of use.

## How to talk about it

For investor questions, always lead with the Section-8 investor paragraph ("more than a wellness app. It is infrastructure for a new economy.") and then choose the right depth: the three mega-trends if they need *why now*, the four-layer architecture if they need *why defensible*, and the $205B projection plus the 10-year cost-benefit table if they need *what's the return*. Never improvise the headline numbers; quote the whitepaper figures.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','investor','market_size','whitepaper']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Industrial Economy vs. Longevity Economy',
  p_path        := 'kb/instruction-manual/longevity-economy/06-industrial-vs-longevity.md',
  p_content     := $CONTENT$---
chapter: 06
title: Industrial Economy vs. Longevity Economy
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Section 4.1 "The Industrial vs. Longevity Economy Paradigm"
keywords: [industrial economy, longevity economy, paradigm shift, decentralization, local economy, paradigma]
related_concepts: ["02", "07"]
---

## The paradigm shift (whitepaper, Section 4.1 — verbatim)

> The industrial economy was optimized around scale, standardization, centralization, and efficiency. The Longevity Economy optimizes around health, trust, personalization, local ecosystems, quality of life, and human relationships. This fundamental shift creates millions of new forms of economic participation that were previously difficult to scale.

## Side-by-side table (whitepaper, Section 4.1 — verbatim Table 2)

| Dimension | Industrial Economy | Longevity Economy |
| --- | --- | --- |
| Primary Optimization | Scale and Efficiency | Health and Trust |
| Value Creation | Standardized Production | Personalized Services |
| Geographic Focus | Global Centralization | Local Ecosystems |
| Labor Model | Full-time Employment | Flexible Contribution |
| Success Metric | GDP Growth | Quality of Life |
| Technology Role | Replace Human Labor | Amplify Human Capability |
| Trust Mechanism | Institutional Brands | Community Reputation |

## New economic opportunities the Longevity Economy unlocks (whitepaper, Section 4.1 — verbatim)

> - Cooking healthy meals for neighbors and community members
> - Local longevity farming and sustainable food production
> - Preventive health coaching and wellness guidance
> - Childcare support and early childhood development
> - Elder care and companionship services
> - Emotional companionship and social connection facilitation
> - Mobility assistance and transportation services
> - Home wellness services and healthy environment consulting
> - Local logistics and community coordination
> - Biomarker interpretation and personalized health insights
> - AI-assisted microbusinesses and local entrepreneurship

These opportunities were historically difficult to scale because trust was fragmented, coordination costs were high, logistics were inefficient, and discovering customers required expensive infrastructure. AI removes these barriers. Robotics automates infrastructure. Communities become marketplaces. Humans become local economic nodes.

## How to talk about it

When someone asks "How is the Longevity Economy different from the regular / industrial economy?", walk the table dimension-by-dimension (it's the cleanest single artifact in the whitepaper). For "what kind of jobs does it create?", read the 11-bullet opportunities list. Close with the verbatim sentence "Communities become marketplaces. Humans become local economic nodes."
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','paradigm','industrial_vs_longevity','whitepaper']::text[]
);

SELECT upsert_knowledge_doc(
  p_title       := 'Maxina — Vitanaland in the Real World',
  p_path        := 'kb/instruction-manual/longevity-economy/07-maxina-real-world.md',
  p_content     := $CONTENT$---
chapter: 07
title: Maxina — Vitanaland in the Real World
tenant: vitanaland
source: Vitanaland Whitepaper May 2026 — Section 8 "Maxina: Vitanaland in the Real World"
keywords: [maxina, mariia maksina, lets dance, rtl, mallorca, maxina experience, real world application]
related_concepts: ["01"]
---

## The first application built on Vitanaland (whitepaper, Section 8 — verbatim)

> The first application built on top of Vitanaland is **Maxina**. Maxina is a community for fitness, dance, movement, and healthy living. It is connected with Mariia Maksina and the Maxina Experience events. These events bring people together through dance, music, movement, energy, and real-life connection.

## Who is Mariia Maksina? (whitepaper, Section 8 — verbatim)

> Mariia Maksina is a celebrated professional dancer best known as a featured performer on Let's Dance — one of the most successful live entertainment shows in Germany, broadcast on the RTL television network to millions of viewers and fans. Her celebrity status and reach give the Maxina community the visibility, attention, and credibility needed to draw people into the movement and inspire genuine participation.
>
> The management behind Mariia Maksina is preparing a concert tour built around the Maxina Experience events, carried by the slogan "…And Everybody is Dancing!" The mission is to motivate and inspire people toward movement and physical activity — not through obligation, but through the passion for dance and fitness. Mariia's profile transforms Maxina from a community concept into a real cultural movement, and demonstrates how a recognized creator can anchor a thriving longevity business on top of the Vitanaland ecosystem.

## The Maxina Experience (whitepaper, Section 8 — verbatim)

> The Maxina Experience takes place in Mallorca, Spain, and is especially directed to people from German-speaking countries: Germany, Austria, and Switzerland. The program includes dancing with Mariia Maksina and the spirit of the slogan:
>
> > "…and Everybody is Dancing!"
> > — The Maxina Experience, Mallorca, Spain

Maxina shows how Vitanaland can be used in the real world. A creator, expert, or community leader can build a community, organize events, connect with members, offer experiences, and grow a longevity-related business on top of the Vitanaland ecosystem.

## How to talk about it

When asked "What is Maxina?" lead with the first paragraph verbatim. If they ask "Who is Mariia Maksina?", quote the Let's Dance / RTL paragraph word-for-word — this is the canonical bio. If they ask "Where does it happen?", quote the Mallorca paragraph including the slogan. Maxina is the proof-of-concept for the platform; treat it as such, not as the platform itself.
$CONTENT$,
  p_source_type := 'markdown',
  p_tags        := ARRAY['instruction_manual','longevity_economy','maxina','mariia_maksina','whitepaper']::text[]
);

-- =====================================================================
-- Part 2: UPDATE system_capabilities teacher_intro_* to whitepaper voice
-- =====================================================================
-- Each script is 3-4 sentences, anchored in verbatim whitepaper phrases:
--   - "operating system for the Longevity Economy"
--   - "the connected ecosystem that brings together health, community,
--     events, services, AI guidance, trust, and business tools in one place"
--   - "more than a wellness app. It is infrastructure for a new economy."
--   - "Universal Human Contribution"
--   - "not less human, but more human than ever before"
--   - "45% directly to providers" / "25-35% in traditional systems to 45%"
-- DE versions are faithful translations of those English phrases, not
-- paraphrases.

UPDATE system_capabilities
SET teacher_intro_de = 'Vitanaland ist das Betriebssystem für die Longevity Economy — das vernetzte Ökosystem, das Gesundheit, Community, Events, Dienste, KI-Begleitung, Vertrauen und Business-Werkzeuge an einem Ort zusammenführt. Es ist mehr als eine Wellness-App: Es ist Infrastruktur für eine neue Wirtschaft, in der Menschen, Experten, Dienste, Communities, Events, Daten, KI, Vertrauen und Business-Werkzeuge in einem Ökosystem verbunden sind. Das Ziel: Menschen helfen, gesünder und besser zu leben, sinnvolle Beziehungen und Communities zu finden, Profis beim Aufbau neuer Longevity-Businesses zu unterstützen und die Longevity Economy als ein einziges, verbundenes System wachsen zu lassen. Magst du, dass ich dir als Nächstes erkläre, was die Longevity Economy konkret ist?',
    teacher_intro_en = 'Vitanaland is the operating system for the Longevity Economy — the connected ecosystem that brings together health, community, events, services, AI guidance, trust, and business tools in one place. It is more than a wellness app: it is infrastructure for a new economy, connecting users, experts, services, communities, events, data, AI, trust, and business tools in one ecosystem. The goal is to help people live healthier and better lives, find meaningful relationships and communities, help professionals build new longevity businesses, and grow the Longevity Economy through one connected ecosystem. Want me to walk you through what the Longevity Economy actually is next?'
WHERE capability_key = 'vitanaland_platform';

UPDATE system_capabilities
SET teacher_intro_de = 'Die Longevity Economy ist die wachsende Welt wirtschaftlicher Aktivität rund um das Ziel, gesünder, länger und besser zu leben — sie umfasst Gesundheit, Prävention, Ernährung, Bewegung, Schlaf, mentales Wohlbefinden, Pflege, soziale Verbindung, Events, Dienste, Produkte und die Menschen und Unternehmen, die all das ermöglichen. Sie ist kein Nischenmarkt: Auf konservativer Schätzung 27 Billionen Dollar bis 2026, mehr als 20 Prozent des weltweiten Bruttoinlandsprodukts — und sie wächst schneller als die Gesamtwirtschaft. Drei Eigenschaften unterscheiden sie von der Industrieökonomie: sie optimiert für Gesundheit und Vertrauen statt für Skalierung, sie ist lokal und menschlich (Communities werden Marktplätze, Menschen werden lokale Wirtschaftsknoten), und sie behandelt Technologie als Verstärker, nicht als Ersatz. Soll ich dir zeigen, wie Vitanaland konkret in dieser Economy Geld verdient?',
    teacher_intro_en = 'The Longevity Economy is the growing world of economic activity built around living healthier, longer, and better — it includes health, prevention, nutrition, movement, sleep, mental wellbeing, care, social connection, events, services, products, and the people and businesses that make all of that possible. It is not a niche: on conservative estimates it is $27 trillion by 2026 — more than 20 percent of global GDP — and it is growing faster than the overall economy. Three characteristics distinguish it from the industrial economy: it optimizes for health and trust rather than scale, it is local and human (communities become marketplaces, individuals become local economic nodes), and it treats technology as an amplifier, not a replacement. Want me to show you how Vitanaland concretely earns money inside this economy?'
WHERE capability_key = 'longevity_economy';

UPDATE system_capabilities
SET teacher_intro_de = 'Vitanaland leitet wirtschaftlichen Wert grundlegend anders um als das traditionelle System: In klassischen Strukturen verschwinden 18 Prozent in Verwaltung, 12 Prozent bei Versicherungsvermittlern und 10 Prozent in physischer Infrastruktur — bei uns fließen 45 Prozent direkt an die Dienstleister, 22 Prozent in präventive Wellness, 18 Prozent in Gemeinschaftsdienste, 8 Prozent in den Betrieb der Plattform und 7 Prozent in Qualitäts- und Vertrauenssysteme. Damit steigt der Anteil, der direkt bei den Menschen ankommt, die die Leistung erbringen, von 25 bis 35 Prozent in traditionellen Systemen auf 45 Prozent — bei gleichzeitig sinkenden Gesamtkosten durch KI-gestützte Effizienz und Prävention. Bis 2035 erwarten wir kumulierten Wirtschaftswert von 205 Milliarden Dollar: 80 Milliarden Einkommen für Dienstleister, 64,5 Milliarden Gesundheitskosten-Ersparnis und 60,5 Milliarden lokaler Wirtschaftsmultiplikator. Soll ich dir Universal Human Contribution erklären — das Konzept dahinter?',
    teacher_intro_en = 'Vitanaland redistributes economic value fundamentally differently from the traditional system: in conventional structures, 18 percent disappears into administration, 12 percent into insurance intermediaries, and 10 percent into physical infrastructure — at Vitanaland, 45 percent flows directly to care providers, 22 percent to preventive wellness, 18 percent to community services, 8 percent to platform operations, and 7 percent to quality and trust systems. That moves the share of economic value reaching the people actually delivering the service from roughly 25 to 35 percent in traditional systems up to 45 percent, while simultaneously reducing total system costs through AI-powered efficiency and preventive health investment. By 2035 we project $205 billion in cumulative economic value creation: $80B in provider income, $64.5B in healthcare savings, and $60.5B in community economic multiplier effects. Want me to walk you through Universal Human Contribution — the concept underneath this model?'
WHERE capability_key = 'vitanaland_business_model';

COMMIT;
