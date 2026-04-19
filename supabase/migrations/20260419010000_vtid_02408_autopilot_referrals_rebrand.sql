-- Migration: 20260419010000_vtid_02408_autopilot_referrals_rebrand.sql
-- Purpose: VTID-02408 — Rebrand user-facing "VAEA" docs to "Autopilot Referrals".
--          Users know "Autopilot" (umbrella brand across all screens); spelling
--          "V-A-E-A" in voice is impossible. This migration rewrites the four
--          user-facing knowledge docs to lead with Autopilot as the name and
--          adds a new anchor doc at kb/autopilot/overview.md so queries like
--          "what can Autopilot do" surface the Referrals capability.
--
-- Touches BOTH:
--   - public.knowledge_docs (assistant/orb/operator retrieval)
--   - public.kb_documents   (admin UI, baseline entries)
--
-- Internal engineering name VAEA stays in tables, routes, code — not touched.
--
-- Idempotent: upserts by path (knowledge_docs) and DELETE-then-INSERT by
--             title (kb_documents).

BEGIN;

-- ===========================================================================
-- 1. knowledge_docs — retrieval path
-- ===========================================================================

-- DOC A — Autopilot overview (new anchor doc)

SELECT public.upsert_knowledge_doc(
  p_title := 'What Vitana Autopilot Does',
  p_path  := 'kb/autopilot/overview.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['autopilot','overview','capabilities','vitana','assistant','referrals'],
  p_content := $CONTENT$
# What Vitana Autopilot Does

**Autopilot** is Vitana's always-on AI agent. It watches the things
you care about, suggests actions that move you forward, and — with
your permission — can take some of those actions on your behalf.
You'll see the **Autopilot** pill in the header of every screen in
Vitana.

## What Autopilot can do today

Autopilot's capabilities come in two directions:

### For YOU — personal productivity & wellbeing

- **Suggest actions** based on what's happening in your life —
  check your health scores, journal, book a meetup, reach out to
  a connection.
- **Book events & meetups** — when you accept a suggestion,
  Autopilot adds it to your calendar and handles the logistics.
- **Journal prompts** — time-aware prompts based on your day and
  your health signals.
- **Proactive nudges** — if you drift from a goal you set,
  Autopilot speaks up.

### FOR you — earning with the community (Referrals)

This is the newest capability. When someone in the Vitana community
asks a buying question — *"where can I get a good sleep tracker?"*,
*"anyone recommend a breathwork teacher?"* — Autopilot can notice
the question, match it to products or services you've curated, and
draft a helpful reply with your referral link. When the asker
uses your link, you earn a commission.

This is called **Autopilot Referrals**.

- Controlled by three switches in **AI Assistant → Referrals**:
  receive / give / make-money-goal.
- Your referral catalog lives in **Business Hub → Sell & Earn →
  Referrals**.
- Community channels Autopilot listens to live in **Settings →
  Connected Apps → Autopilot**.
- Everything shadow-drafted until you approve. Nothing posts
  without your explicit opt-in.

See the Autopilot Referrals docs for the full story: Overview,
Catalog, Settings, FAQ.

## How Autopilot stays out of your way

- **Observe-only by default.** Every new capability starts in
  observe mode — Autopilot watches and drafts but never posts
  until you raise the rate limits.
- **Per-capability switches.** You can turn Referrals on without
  affecting personal nudges and vice versa.
- **Dismissal trains.** If Autopilot suggests something you
  don't want, dismiss it — it learns.
- **Rate-limited.** You set how often Autopilot can take action.
  Default for new capabilities: zero per day.

## Where you'll see Autopilot

- **Every screen header** — the Autopilot pill shows how many
  pending suggestions you have.
- **AI Assistant → Autopilot & Automation tab** — your
  general autopilot preferences.
- **AI Assistant → Referrals tab** — Referrals-specific
  settings (the three switches, autonomy, disclosure, expertise).
- **Business Hub → Sell & Earn → Referrals** — the referral
  workspace (catalog, shadow drafts, audit trail).
- **Business Hub → Analytics → Performance** — Referrals
  activity stats.
- **Settings → Connected Apps → Autopilot** — which community
  channels Autopilot listens to.

## Frequent questions

**"What's VAEA?"** — Our internal name for Autopilot Referrals
(Vitana Autonomous Economic Actor). You won't see it in the
app — just "Autopilot Referrals."

**"Does Autopilot see my private messages?"** — No. Only
channels you explicitly register in Settings → Connected Apps →
Autopilot. Direct messages, calendar, health data — none of it
without your explicit grant.

**"Can I turn Autopilot off?"** — Yes. All capabilities are
opt-in and independently toggleable. AI Assistant → Autopilot &
Automation has the master switch.

$CONTENT$
);

-- DOC 1 — Referrals overview (renamed from VAEA)

SELECT public.upsert_knowledge_doc(
  p_title := 'Autopilot Referrals — How It Earns For You',
  p_path  := 'kb/vaea/overview.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['autopilot','referrals','earn','commission','catalog','business-hub','vaea'],
  p_content := $CONTENT$
# Autopilot Referrals — How It Earns For You

**Autopilot Referrals** is the earning capability of Vitana's
Autopilot. When someone in the community asks a buying question —
*"where can I get a good sleep tracker?"*, *"anyone recommend a
breathwork teacher?"*, *"looking for a longevity clinic in
Berlin"* — Autopilot watches, recognises the buying intent,
matches it to products and services you've curated, and (with
your permission) drafts a helpful reply that includes your
referral link.

When the asker uses that link, you earn a commission. That's
the core loop. Members help each other; the person who helped
gets paid.

(Internally engineers call this VAEA — Vitana Autonomous Economic
Actor. You'll only ever see "Autopilot Referrals" in the app.)

## What makes Autopilot Referrals different from a generic affiliate bot

1. **It's personal.** Autopilot only recommends items from YOUR
   catalog — the products you've tried, the services you offer,
   the affiliate links you've chosen to trust.
2. **It's honest.** Every drafted reply includes a disclosure
   ("I earn a small commission if you use this link"). For pure
   affiliate-network items, Autopilot also offers a non-affiliate
   alternative so the asker can skip the referral if they prefer.
3. **It's opt-in, twice.** Autopilot only gives recommendations
   on your behalf if you turn on "Give recommendations". It only
   acts autonomously if you additionally set "Goal: make money".
   Both are off by default.
4. **It's transparent.** Every message Autopilot scans, drafts,
   or stays quiet about is logged in your Business Hub so you
   can see exactly what it's doing.

## The three switches that control Autopilot Referrals

### 1. Receive recommendations (on by default)
When you ask a question in the community, Autopilot can quietly
query other members' Autopilots to find the best match from
people who've actually used the product or service.

### 2. Give recommendations / earn (off by default)
Autopilot may offer YOUR catalog back to other members' askers.
This is how you earn. Off by default — you opt in when you're
ready with a catalog you're proud of.

### 3. Goal: make money (off by default, requires #2 on)
Promotes "give" from propose-and-approve to autonomous. Without
this switch, every outbound reply is drafted for you to review
first. With this switch AND "give" on, Autopilot can post on
your behalf within the rate limits and autonomy settings you
configured. Disabled in the UI until "give" is on — the second
switch requires explicit consent.

## Where you'll find Autopilot Referrals in the app

- **Business Hub → Sell & Earn → Referrals tab** — your referral
  catalog (add / remove items), plus the audit trail of what
  Autopilot saw and why it replied or stayed quiet. Shadow drafts
  appear in a strip above the tabs whenever Autopilot has
  something for you to review.
- **AI Assistant → Referrals tab** — the three switches, plus
  your autonomy default, your disclosure text, and your expertise
  zones (topic areas Autopilot is allowed to speak on).
- **Settings → Connected Apps → Autopilot** — the community
  channels Autopilot listens to (Maxina groups, Slack, Discord,
  etc.). Each channel has its own on/off and dry-run toggle.
- **Business Hub → Analytics → Performance** — the Autopilot
  referrals card shows how many questions Autopilot scanned, how
  many drafts it produced, and how many referrals it helped earn
  in the last 7 days.

## What Autopilot Referrals does today (and what's coming)

Rolling out in phases. Right now you're in **observe mode**:
Autopilot detects buying intent, scores it, matches it against
your catalog, and writes shadow drafts — but **nothing is posted
yet**. Shadow drafts exist so you can see what Autopilot would
say, tune your catalog and expertise zones, and build confidence
before any reply goes out in public.

- **Phase 1 — observe (live now).** Detect, score, match, draft,
  audit. No posting. No peer-to-peer.
- **Phase 2 — approve-and-post.** One-tap approval on a draft
  sends the reply to the community channel. Rate-limited and
  disclosure-enforced.
- **Phase 3 — mesh.** Peer-to-peer between members' Autopilots.
  Your Autopilot queries other Autopilots for recommendations
  when you ask a question; other Autopilots reply with offers;
  yours presents the best match. Machines negotiate so you and
  the seller don't have to.

Everything stays opt-in at each phase. The "make money" switch
is what promotes you from phase to phase within the features
available.

## Safety you can see

- **Every reply includes a disclosure.** Your wording, appended
  verbatim.
- **Non-affiliate alternative** for affiliate-network items.
- **Expertise zones** — Autopilot stays silent outside topics
  you said you know.
- **Rate limits** — default zero auto-replies per day.
- **Per-channel dry-run** — shadow-only even when autonomy is
  higher.
- **Blocked counterparties** — specific people/domains Autopilot
  must never engage with.

## Shadow drafts — the main thing to understand in Phase 1

In observe mode, every draft Autopilot produces has status
`shadow`. Shadow means: written, visible, dismissible by you —
but never sent. It's the safest possible posture for a new
agent capability: you see exactly what it would have said, in
context, before authorising it to say anything at all.

When a draft appears, the Business Hub shows: the original
community question (with a link), Autopilot's drafted reply,
the matched catalog item and why, the tier (own / vetted /
affiliate), and a dismiss button.

Dismiss trains the system. Shadow drafts auto-expire after 72
hours if you neither dismiss nor approve (Phase 2+).

$CONTENT$
);

-- DOC 2 — Catalog

SELECT public.upsert_knowledge_doc(
  p_title := 'Autopilot Referrals — Your Catalog',
  p_path  := 'kb/vaea/catalog.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['autopilot','referrals','catalog','affiliate','commission','tiers','vaea'],
  p_content := $CONTENT$
# Autopilot Referrals — Your Catalog

Your catalog is the complete list of products and services
Autopilot is allowed to recommend on your behalf. Autopilot can
only recommend what you've added here — it cannot invent or
scrape new items.

Find it in **Business Hub → Sell & Earn → Referrals**.

## The three tiers

Autopilot ranks candidates using three priority tiers, in this
order:

### 1. Own (highest priority)
Products or services YOU offer directly. Your coaching packages,
your events, your merch. When an asker's question matches
something in your Own tier, Autopilot recommends it first —
it's your business.

### 2. Vetted partner
Products from people or brands you've personally vetted. You've
tried it. You know the founder. You've seen the results. Strong
recommendations but not yours — usually a commission agreement
you negotiated directly.

### 3. Affiliate network (lowest priority, highest volume)
Generic affiliate links from networks like Amazon Associates,
iHerb, Impact, ShareASale. Breadth, but weakest personal
endorsement. Autopilot only falls back here when nothing in Own
or Vetted Partner matches.

## Vetting status

Each item carries a vetting flag:

- **unvetted** — added but not tried. Autopilot mentions it
  cautiously ("worth a look").
- **tried** — you've used it yourself.
- **endorsed** — you actively recommend it. Autopilot leads
  with stronger language ("I've tried this and it holds up").

## Personal note — the secret weapon

When you add an item, include a personal note: *"Switched from X
to this and my HRV improved in two weeks."* Autopilot uses your
note verbatim as the lead line in any draft reply. Not marketing
copy — your voice. This is why Autopilot's replies don't feel
robotic: the note is the human part.

## Commission percent

Optional field per item. Useful for you to track which items
earn the most, visible in Analytics. Not included in the public
reply — the disclosure says "I earn a small commission", not
"I earn 15%".

## How matching works under the hood

When Autopilot scores a community question, it extracts topic
keywords. Then it queries your catalog, computing a score for
each active item:

- **Topic overlap (60%)** — does the topic appear in the item's
  category / title / description?
- **Tier weight (25%)** — Own beats vetted beats affiliate.
- **Vetting weight (15%)** — endorsed beats tried beats unvetted.

The top match (if the combined score clears 0.2) becomes the
draft. Scores are visible on every shadow draft so you can see
why Autopilot picked the match it did.

$CONTENT$
);

-- DOC 3 — Settings

SELECT public.upsert_knowledge_doc(
  p_title := 'Autopilot Referrals — Settings',
  p_path  := 'kb/vaea/settings.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['autopilot','referrals','settings','autonomy','disclosure','privacy','expertise','vaea'],
  p_content := $CONTENT$
# Autopilot Referrals — Settings

All the Referrals settings live in one place: **AI Assistant →
Referrals tab**. The channels Autopilot listens to live in
**Settings → Connected Apps → Autopilot**.

## The three switches

1. **Receive recommendations** — on by default. Autopilot can
   query peers when you ask a question.
2. **Give recommendations (earn)** — off by default. Autopilot
   may offer your catalog to other members. The switch that
   turns earning on.
3. **Goal: make money** — off by default, disabled until #2 is
   on. Promotes "give" from propose-and-approve to autonomous
   within your rate limits.

## Autonomy modes

Each channel can have its own autonomy setting, defaulting to
the one you chose in the AI Assistant tab:

- **Silent** — scan and log but never draft.
- **Draft to me** (default) — Autopilot drafts replies; you
  approve or dismiss each one. Safest active mode.
- **One-tap approve** — drafts appear with a single tap to send.
  (Phase 2+.)
- **Auto-post** — Autopilot sends replies within your rate
  limits and disclosure rules. (Phase 2+ and only when "Goal:
  make money" is on.)

## Disclosure text

The line Autopilot appends to every reply that contains an
affiliate link. Default: *"I earn a small commission if you use
this link — happy to share non-affiliate alternatives too."*
Customise to fit whatever platform's rules. Autopilot uses your
version verbatim.

## Expertise zones

Comma-separated list of topics Autopilot is allowed to speak on.
Examples: `longevity, sleep, supplements, breathwork, HRV`.
Autopilot scores every detected question for topic match against
these zones. Off-topic messages get a low score and don't become
drafts — even if a catalog item might technically fit. Protects
your reputation.

## Rate limits

- **Max replies per day** — hard cap. Default: 0 (observation
  only). Raise gradually.
- **Min minutes between replies** — minimum gap so you don't
  look like a spam bot. Default: 30 minutes.

## Blocked counterparties

People or domains Autopilot must never engage with.
Competitors, old partners, anyone you want to stay at arm's
length. Checked against every detected message before scoring.

## Mesh scope (Phase 3+)

- **Maxina-only** (default) — Autopilot only participates in
  peer-to-peer matching within the Maxina community.
- **Open** — cross-community once the mesh opens up. Off until
  you understand the privacy implications.

## Listener channels (Connected Apps → Autopilot)

Each row is a community channel Autopilot is connected to.
Platforms: maxina, slack, discord, telegram, reddit, custom.

Per channel you control:
- **Active** toggle — pause/resume without deleting.
- **Dry-run** toggle — scan but never post, even if autonomy
  is higher.
- **Autonomy override** — per-channel setting that overrides
  the global default.
- **Display name** — friendly label for the UI.

New channels default to dry-run.

$CONTENT$
);

-- DOC 4 — FAQ

SELECT public.upsert_knowledge_doc(
  p_title := 'Autopilot Referrals — FAQ',
  p_path  := 'kb/vaea/faq.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['autopilot','referrals','faq','questions','help','vaea'],
  p_content := $CONTENT$
# Autopilot Referrals — FAQ

## What is Autopilot Referrals, in one sentence?

Autopilot Referrals notices when someone in the community is
asking a buying question and offers them a relevant
recommendation from your catalog — so you earn a commission by
helping.

## I heard "VAEA" — is that the same thing?

Yes. VAEA (Vitana Autonomous Economic Actor) is the internal
engineering name. You'll only ever see "Autopilot Referrals" in
the app.

## Will Autopilot post without my permission?

No. Today (Phase 1) Autopilot Referrals is in observe mode — it
drafts but never posts. In Phase 2, drafts require your one-tap
approval. Only when you explicitly flip the "Goal: make money"
switch (and only after "Give recommendations" is also on) can
Autopilot post autonomously, and only within the rate limits
and channels you've whitelisted.

## How do I earn with Autopilot Referrals?

Three steps:
1. Build a catalog in Business Hub → Sell & Earn → Referrals.
   Add your own products first (the "Own" tier), then vetted
   partners, then affiliate-network items.
2. Turn on the **Give recommendations** switch in the AI
   Assistant → Referrals tab.
3. Review shadow drafts as they appear. When you're confident,
   raise the rate limits and let approved drafts go out.

When an asker uses your referral link, the affiliate network /
vetted partner / your own checkout attributes the sale to you
and pays commission via whatever mechanism that item uses.
Autopilot is a matching layer — it doesn't process the payout.

## What does Autopilot Referrals never do?

- Never recommends something not in your catalog.
- Never posts without a disclosure line.
- Never sends a reply if the question is outside your
  expertise zones.
- Never engages with people or domains in your blocked list.
- Never exceeds your rate limits.
- Never leaks your identity to a peer's Autopilot in Phase 3
  before you accept an offer.

## Where do I find it?

- **AI Assistant → Referrals tab**
- **Business Hub → Sell & Earn → Referrals sub-tab**
- **Settings → Connected Apps → Autopilot**
- **Business Hub → Analytics → Performance**

## What's the difference between Autopilot Referrals and the
other Autopilot suggestions?

Autopilot's everyday suggestions help YOU — book a meetup, check
your health scores, journal. Autopilot Referrals is about YOU
helping OTHERS who are asking a buying question. Different
direction of value. Both run side by side; each has its own on/
off.

## What if Autopilot recommends the wrong thing?

Dismiss the draft. Every dismissal is a training signal.
Adjust your expertise zones if Autopilot is speaking on topics
you don't actually cover; tighten your catalog if a specific
item is matching too broadly; add a personal note to items that
need context.

## Can I turn Autopilot Referrals off completely?

Yes. Flip all three switches off in the AI Assistant →
Referrals tab, or set every channel in Connected Apps →
Autopilot to inactive. Autopilot will scan nothing and draft
nothing. You can turn it back on later with your catalog and
history intact. Your general Autopilot suggestions keep working
— Referrals is its own independent capability.

## Does Autopilot Referrals see my private conversations?

No. Autopilot only listens to channels you explicitly register
in Connected Apps → Autopilot. Direct messages, calendar,
health data — none of it.

## Why do I need to verify each channel manually?

Community rules differ. Some Slack workspaces prohibit affiliate
links. Some Discord servers require a specific disclosure
format. Some forums ban commercial replies in certain
sub-channels. Autopilot can't reliably detect these rules — you
enable the channels you know are fine.

## What does "mesh" mean?

Machine-to-machine referral. When the mesh (Phase 3) is live,
your Autopilot can quietly ask other members' Autopilots for
recommendations when you have a buying question — and theirs
can ask yours. Two machines negotiate the best match so two
humans don't have to post in the group and wait. Still opt-in
on both sides; still full audit trail; still Maxina-bounded by
default.

## How do I see what Autopilot is doing right now?

**Business Hub → Sell & Earn → Referrals tab**. The drafts
strip above the tab bar shows anything pending. The "What
Autopilot saw" section shows every message scanned — including
the ones Autopilot stayed quiet on and why. Full transparency
by design.

$CONTENT$
);

-- ===========================================================================
-- 2. kb_documents — admin UI path. DELETE old baseline copies by title,
--    then re-INSERT with new titles & bodies.
-- ===========================================================================

DELETE FROM public.kb_documents
WHERE tenant_id IS NULL
  AND source = 'baseline'
  AND title IN (
    -- old VAEA titles from VTID-02407
    'VAEA — Your Community Referral Agent',
    'VAEA Referral Catalog — Tiers, Vetting, and How It Ranks',
    'VAEA Settings — Autonomy, Disclosure, Expertise Zones',
    'VAEA — Frequently Asked Questions',
    -- new titles (in case of re-run)
    'What Vitana Autopilot Does',
    'Autopilot Referrals — How It Earns For You',
    'Autopilot Referrals — Your Catalog',
    'Autopilot Referrals — Settings',
    'Autopilot Referrals — FAQ'
  );

-- Insert Autopilot overview + 4 Referrals docs (same bodies as knowledge_docs above)

INSERT INTO public.kb_documents (tenant_id, source, title, body, status, topics, visibility)
SELECT NULL, 'baseline', title, content, 'indexed', tags, '{}'::jsonb
FROM public.knowledge_docs
WHERE path IN (
  'kb/autopilot/overview.md',
  'kb/vaea/overview.md',
  'kb/vaea/catalog.md',
  'kb/vaea/settings.md',
  'kb/vaea/faq.md'
);

-- ===========================================================================
-- 3. VTID ledger entry
-- ===========================================================================

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-02408', 'PLATFORM', 'VAEA', 'in_progress',
  'Rebrand VAEA user-facing docs to Autopilot Referrals',
  'Rewrites four user-facing knowledge docs (overview, catalog, settings, faq) and adds a new Autopilot umbrella doc. "VAEA" stays as internal engineering name only; every user-facing surface now says "Autopilot Referrals" (or just "Autopilot" in context). Syncs both knowledge_docs (retrieval) and kb_documents (admin UI).',
  'Reason: "VAEA" is impossible to spell in voice. "Autopilot" is already the umbrella brand users know. Positioning Referrals as a capability OF Autopilot makes it discoverable for users who ask "what can Autopilot do".',
  'DOCUMENTATION',
  'knowledge_rebrand',
  'platform',
  jsonb_build_object(
    'new_anchor_doc', 'kb/autopilot/overview.md',
    'renamed_docs', jsonb_build_array(
      'kb/vaea/overview.md',
      'kb/vaea/catalog.md',
      'kb/vaea/settings.md',
      'kb/vaea/faq.md'
    ),
    'user_facing_name', 'Autopilot Referrals',
    'internal_engineering_name', 'VAEA'
  ),
  NOW(), NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  summary = EXCLUDED.summary,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

COMMIT;
