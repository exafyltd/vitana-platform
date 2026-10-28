-- Migration: 20260418060000_vtid_02406_vaea_knowledge_hub_seed.sql
-- Purpose: VTID-02406 — Seed the Knowledge Hub with user-facing VAEA docs so
--          the Assistant / Operator Chat / Brain can answer questions like
--          "What is VAEA?", "How do I earn with VAEA?", "Where do I find
--          VAEA settings?", "Can VAEA post on my behalf?" with grounded
--          answers instead of hallucinating.
--
-- Inserts via public.upsert_knowledge_doc() so it's idempotent and safe to
-- re-run when the docs are revised.

-- ===========================================================================
-- DOC 1 — VAEA overview (the anchor doc — answers "What is VAEA?")
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'VAEA — Your Community Referral Agent',
  p_path  := 'kb/vaea/overview.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vaea','referrals','economic-actor','business-hub','maxina'],
  p_content := $CONTENT$
# VAEA — Your Vitana Autonomous Economic Actor

VAEA (Vitana Autonomous Economic Actor) is your personal referral agent
inside Vitana. When someone in the community asks a buying question —
"where can I get a good sleep tracker?", "anyone recommend a breathwork
teacher?", "looking for a longevity clinic in Berlin" — VAEA watches,
recognises the buying intent, matches it to the products and services
you've curated, and (with your permission) drafts a helpful reply that
includes your referral link.

When the asker uses that link, you earn a commission. That's the core
loop. Members help each other; the person who helped gets paid.

## What makes VAEA different from a generic affiliate bot

1. **It's personal.** VAEA only recommends items from YOUR catalog — the
   products you've tried, the services you offer, the affiliate links
   you've chosen to trust.
2. **It's honest.** Every drafted reply includes a disclosure ("I earn a
   small commission if you use this link"). For pure affiliate network
   items, VAEA also offers a non-affiliate alternative so the asker can
   skip the referral if they prefer.
3. **It's opt-in, twice.** VAEA only gives recommendations on your
   behalf if you turn on "Give recommendations". It only acts
   autonomously if you additionally set "Goal: make money". Both are
   off by default.
4. **It's transparent.** Every message VAEA scans, drafts, or stays
   quiet about is logged in your Business Hub so you can see exactly
   what it's doing.

## The three switches that control VAEA

Everything VAEA does is governed by three toggles you control yourself.

### 1. Receive recommendations (on by default)
When you ask a question in the community, your VAEA can quietly query
other members' VAEAs to find the best match from people who've
actually used the product or service. You get a recommendation from
someone you trust — the community's shared knowledge, filtered.

### 2. Give recommendations / earn (off by default)
Your VAEA may offer YOUR catalog back to other members' askers. This
is how you earn. Off by default — you opt in when you're ready with a
catalog you're proud of.

### 3. Goal: make money (off by default, requires #2 on)
Promotes "give" from propose-and-approve to autonomous. Without this
switch, every outbound reply is drafted for you to review first. With
this switch AND "give" on, VAEA can post on your behalf within the
rate limits and autonomy settings you configured. Disabled in the UI
until "give" is on — the second switch requires explicit consent.

## Where you'll find VAEA in the app

VAEA lives across the surfaces you already know:

- **Business Hub → Sell & Earn → Referrals tab** — your referral
  catalog (add / remove items), plus the audit trail of what VAEA
  saw and why it replied or stayed quiet. Shadow drafts appear in a
  strip above the tabs whenever VAEA has something for you to review.
- **AI Assistant → Referrals tab** — the three switches, plus your
  autonomy default, your disclosure text, and your expertise zones
  (topic areas VAEA is allowed to speak on).
- **Settings → Connected Apps → Agent Ingest** — the community
  channels VAEA listens to (Maxina groups, Slack, Discord, etc.).
  Each channel has its own on/off and dry-run toggle.
- **Business Hub → Analytics → Performance** — the VAEA detections
  card shows how many questions VAEA scanned, how many drafts it
  produced, and how many referrals it helped earn in the last 7 days.

## What VAEA does today (and what's coming)

VAEA is rolling out in phases. Right now you're in **observe mode**:
VAEA detects buying intent, scores it, matches it against your
catalog, and writes shadow drafts — but **nothing is posted yet**.
Shadow drafts exist so you can see what VAEA would say, tune your
catalog and expertise zones, and build confidence before any reply
goes out in public.

Phases:
- **Phase 1 — observe (live now).** Detect, score, match, draft,
  audit. No posting. No peer-to-peer communication between VAEAs.
- **Phase 2 — approve-and-post.** One-tap approval on a draft sends
  the reply to the community channel. Rate-limited and disclosure-
  enforced.
- **Phase 3 — mesh.** Peer-to-peer between members' VAEAs. Your
  VAEA queries other VAEAs for recommendations when you ask a
  question; other VAEAs reply with offers; yours presents the best
  match. Machines negotiate so you and the seller don't have to.

Everything stays opt-in at each phase. The "make money" switch is
what promotes you from phase to phase within the features available.

## Safety you can see

- **Every reply includes a disclosure.** You pick the wording
  ("I earn a small commission if you use this link — happy to share
  non-affiliate alternatives too.") and VAEA appends it verbatim.
- **Non-affiliate alternative.** For affiliate-network items (not
  your own products, not your vetted partners), VAEA adds a line
  saying the asker can skip the link and search the product name
  directly. Honest recommendation, same outcome either way.
- **Expertise zones.** VAEA only acts on topics you've said you
  know. Outside those topics, it stays silent even if intent is
  detected. Protects your reputation.
- **Rate limits.** You control how many replies per day and the
  minimum time between replies. Default: zero auto-replies per day
  until you raise the limit.
- **Per-channel dry-run.** New channels default to dry-run: VAEA
  shadow-drafts but never posts, even if autonomy is set higher.
  You flip dry-run off channel-by-channel, not all at once.
- **Blocked counterparties.** Specific people or domains VAEA must
  never engage with — competitors, exes, anyone you'd rather not
  interact with commercially.

## Shadow drafts — the main thing to understand in Phase 1

In observe mode, every draft VAEA produces has status `shadow`.
Shadow means: written, visible, dismissible by you — but never sent.
It's the safest possible posture for a new agent: you see exactly
what it would have said, in context, before authorising it to say
anything at all.

When a draft appears, the Business Hub shows:
- the original community question (and a link to the source)
- VAEA's drafted reply (with your disclosure included)
- the catalog item it matched and why (score + reasoning)
- the platform tier (own / vetted partner / affiliate network)
- a dismiss button to reject it

Dismiss trains the system. Shadow drafts auto-expire after 72 hours
if you neither dismiss nor approve (Phase 2+).

$CONTENT$
);

-- ===========================================================================
-- DOC 2 — Catalog tiers (answers "How do I set up what VAEA recommends?")
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'VAEA Referral Catalog — Tiers, Vetting, and How It Ranks',
  p_path  := 'kb/vaea/catalog.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vaea','referrals','catalog','affiliate','commission','tiers'],
  p_content := $CONTENT$
# VAEA Referral Catalog

Your catalog is the complete list of products and services VAEA is
allowed to recommend on your behalf. VAEA can only recommend what
you've added here — it cannot invent or scrape new items.

Find it in **Business Hub → Sell & Earn → Referrals**.

## The three tiers

VAEA ranks candidates using three priority tiers, in this order:

### 1. Own (highest priority)
Products or services YOU offer directly. Your coaching packages,
your events, your merch. When an asker's question matches something
in your Own tier, VAEA recommends it first — it's your business.

### 2. Vetted partner
Products or services from people or brands you've personally
vetted. You've tried the product. You know the founder. You've
seen the results. These are strong recommendations but not yours
— a commission agreement you negotiated directly.

### 3. Affiliate network (lowest priority, highest volume)
Generic affiliate links from networks like Amazon Associates,
iHerb, Impact, ShareASale, etc. These have the most breadth but
the weakest personal endorsement. VAEA only falls back to these
when nothing in Own or Vetted Partner matches.

## Vetting status

Each item carries a vetting flag:

- **unvetted** — added but not tried. VAEA mentions it more
  cautiously ("worth a look").
- **tried** — you've used it yourself. VAEA mentions it with your
  personal experience.
- **endorsed** — you actively recommend it. VAEA leads with
  stronger language ("I've tried this and it holds up").

## Personal note — the secret weapon

When you add a catalog item, you can include a personal note
("Switched from X to this and my HRV improved in two weeks").
VAEA uses this verbatim as the lead line in any draft reply. Not
marketing copy — your voice. This is why VAEA's replies don't feel
robotic: the note is the human part.

## Commission percent

Optional field on each item. Useful for you to track which items
earn the most per referral, visible in Analytics. Not included in
the public reply — the disclosure says "I earn a small commission",
not "I earn 15%".

## How matching works under the hood

When VAEA scores a community question, it extracts topic keywords.
Then it queries your catalog, computing a score for each active
item:

- **Topic overlap (60%)** — does the extracted topic appear in the
  item's category / title / description?
- **Tier weight (25%)** — Own beats vetted beats affiliate.
- **Vetting weight (15%)** — endorsed beats tried beats unvetted.

The top match (if the combined score clears 0.2) becomes the draft.
Scores are visible on every shadow draft so you can see why VAEA
picked the match it did.

$CONTENT$
);

-- ===========================================================================
-- DOC 3 — Settings explainer (answers "How do I configure VAEA?")
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'VAEA Settings — Autonomy, Disclosure, Expertise Zones',
  p_path  := 'kb/vaea/settings.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vaea','settings','autonomy','disclosure','privacy','expertise'],
  p_content := $CONTENT$
# Configuring VAEA

All VAEA settings live in one place: **AI Assistant → Referrals (VAEA)
tab**. The channels VAEA listens to live in **Settings → Connected
Apps → Agent Ingest**.

## The three switches (the most important controls)

1. **Receive recommendations** — on by default. Your VAEA can query
   peers when you ask a question.
2. **Give recommendations (earn)** — off by default. Your VAEA may
   offer your catalog to other members. This is the switch that
   turns earning on.
3. **Goal: make money** — off by default and disabled until #2 is on.
   Promotes "give" from propose-and-approve to autonomous within
   your rate limits.

## Autonomy modes

Each channel can have its own autonomy setting, defaulting to what
you chose in the AI Assistant tab:

- **Silent** — VAEA scans and logs but never drafts anything.
  Good for learning what a channel is like before giving VAEA
  a voice on it.
- **Draft to me** (default) — VAEA drafts replies; you approve
  or dismiss each one. Safest active mode.
- **One-tap approve** — drafts appear with a single tap to send.
  Faster but still human-in-the-loop. (Available in Phase 2+.)
- **Auto-post** — VAEA sends replies on your behalf within your
  rate limits and disclosure rules. (Available in Phase 2+ only
  when "Goal: make money" is on.)

## Disclosure text

The line VAEA appends to every reply that contains an affiliate
link. Default: *"I earn a small commission if you use this link —
happy to share non-affiliate alternatives too."* You can customise
the wording; VAEA will use your version verbatim. Community rules
around affiliate disclosure vary — update this to fit whatever
platform you're active on.

## Expertise zones

Comma-separated list of topics VAEA is allowed to speak on.
Examples: `longevity, sleep, supplements, breathwork, HRV`. VAEA
scores every detected question for topic match against these zones.
Messages outside your expertise zones get a low match score and
don't become drafts — even if you have a catalog item that might
technically fit. This protects your reputation from drive-by
off-topic recommendations.

## Rate limits

- **Max replies per day** — hard cap on how many replies VAEA
  posts in 24 hours. Default: 0 (observation only). Raise this
  gradually as you build trust.
- **Min minutes between replies** — minimum gap so you don't
  look like a spam bot. Default: 30 minutes.

## Blocked counterparties

A list of people or domains VAEA must never engage with. Use
this for competitors, old partners you'd rather not interact
with commercially, or anyone you want to stay at arm's length.
VAEA checks every detected message against this list before
scoring.

## Mesh scope (Phase 3+)

- **Maxina-only** (default) — your VAEA only participates in
  peer-to-peer matching within the Maxina community. Bounded
  trust network.
- **Open** — your VAEA can participate in cross-community
  matching once the mesh opens up. Off until you understand
  the privacy implications.

## Listener channels (Agent Ingest)

Each row in Agent Ingest is a community channel VAEA is
connected to. Platforms supported: maxina, slack, discord,
telegram, reddit, custom.

Per channel you control:
- **Active** toggle — pause/resume without deleting
- **Dry-run** toggle — scan but never post, even if autonomy
  is higher
- **Autonomy** override — per-channel setting that overrides
  the global default
- **Display name** — friendly label for the UI

New channels default to dry-run so nothing surprising happens.

$CONTENT$
);

-- ===========================================================================
-- DOC 4 — FAQ (direct answers to the most likely user questions)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'VAEA — Frequently Asked Questions',
  p_path  := 'kb/vaea/faq.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vaea','faq','questions','help'],
  p_content := $CONTENT$
# VAEA — Frequently Asked Questions

## What is VAEA, in one sentence?

VAEA is your personal agent inside Vitana that notices when someone
in the community is asking a buying question and offers them a
relevant recommendation from your catalog — so you earn a
commission by helping.

## Will VAEA post without my permission?

No. Today (Phase 1) VAEA is in observe mode — it drafts but never
posts. In Phase 2, drafts require your one-tap approval. Only when
you explicitly flip the "Goal: make money" switch (and only after
"Give recommendations" is also on) can VAEA post autonomously, and
only within the rate limits and channels you've whitelisted.

## How do I earn with VAEA?

Three steps:
1. Build a catalog in Business Hub → Sell & Earn → Referrals.
   Add your own products first (the "Own" tier), then vetted
   partners, then affiliate-network items.
2. Turn on the **Give recommendations** switch in the AI
   Assistant → Referrals tab.
3. Review shadow drafts as they appear. When you're confident,
   raise the rate limits and let approved drafts go out.

When an asker uses your referral link, the affiliate network /
vetted partner / your own checkout attributes the sale to you and
pays commission via whatever mechanism that item uses. VAEA
itself is a matching layer — it doesn't process the payout.

## What does VAEA never do?

- Never recommends something not in your catalog.
- Never posts without a disclosure line.
- Never sends a reply if the question is outside your expertise
  zones.
- Never engages with people or domains in your blocked list.
- Never exceeds your rate limits.
- Never leaks your identity to a peer VAEA in Phase 3 before you
  accept an offer.

## Where do I find VAEA?

- **Settings** → AI Assistant → Referrals tab
- **Business Hub** → Sell & Earn → Referrals sub-tab
- **Settings** → Connected Apps → Agent Ingest
- **Business Hub** → Analytics → Performance (stats card)

## What's the difference between VAEA and the Autopilot recommendations?

Autopilot suggests things for YOU to do — book a meetup, check
your health scores, journal. VAEA is about YOU helping OTHERS
who are asking. Different direction of value. Both can run in
parallel — one is your personal productivity agent, the other is
your economic agent.

## What if I try VAEA and it recommends the wrong thing?

Dismiss the draft. Every dismissal is a training signal. Adjust
your expertise zones if VAEA is speaking on topics you don't
actually cover; tighten your catalog if a specific item is
matching too broadly; add a personal note to items that need
context.

## Can I turn VAEA off completely?

Yes. Flip all three switches off in the AI Assistant → Referrals
tab, or set every channel in Agent Ingest to inactive. VAEA will
scan nothing and draft nothing. You can turn it back on later
with your catalog and history intact.

## Does VAEA see my private conversations?

No. VAEA only listens to channels you explicitly register in
Agent Ingest. It cannot see your direct messages, your calendar,
your health data, or anything else in Vitana that you haven't
given it explicit access to.

## Why do I need to verify each channel manually?

Because community rules differ. Some Slack workspaces prohibit
affiliate links entirely. Some Discord servers require a
specific disclosure format. Some forums ban commercial replies
in certain sub-channels. VAEA can't reliably detect these rules
— you enable the channels you know are fine, and VAEA respects
that boundary.

## What does "mesh" mean?

Machine-to-machine referral. When the mesh (Phase 3) is live,
your VAEA can quietly ask other members' VAEAs for
recommendations when you have a buying question — and theirs can
ask yours. Two machines negotiate the best match so two humans
don't have to post in the group and wait. Still opt-in on both
sides; still full audit trail; still Maxina-bounded by default.

## How do I see what VAEA is doing right now?

**Business Hub → Sell & Earn → Referrals tab**. The drafts strip
above the tab bar shows anything pending. The "What VAEA saw"
section shows every message scanned — including the ones VAEA
stayed quiet on and why. Full transparency by design.

$CONTENT$
);

-- ===========================================================================
-- Tag the VTID
-- ===========================================================================

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-02406', 'PLATFORM', 'VAEA', 'in_progress',
  'VAEA Knowledge Hub seed — user-facing docs',
  'Seeds knowledge_docs with four VAEA documents (overview, catalog, settings, FAQ) so Assistant / Operator Chat / Brain can ground answers about VAEA in real docs instead of hallucinating. Idempotent via upsert_knowledge_doc().',
  'Docs are the knowledge-hub layer for the retrieval-router''s vitana_system rule. Tagged with vaea, referrals, economic-actor, etc. for tag-based filtering.',
  'DOCUMENTATION',
  'knowledge_seed',
  'platform',
  jsonb_build_object(
    'docs', jsonb_build_array(
      'kb/vaea/overview.md',
      'kb/vaea/catalog.md',
      'kb/vaea/settings.md',
      'kb/vaea/faq.md'
    )
  ),
  NOW(), NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  summary = EXCLUDED.summary,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
