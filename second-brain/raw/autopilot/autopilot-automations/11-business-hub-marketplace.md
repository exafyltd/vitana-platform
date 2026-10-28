# AP-1100: Business Hub & Marketplace

> Automations for setting up and running a business within Vitana — service listings, product catalog, Discover marketplace, creator tools, client management, and service-product matching.

---

## AP-1101 — Service Listing Publication & Distribution

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Creator publishes a new service via `POST /api/v1/catalog/services` |
| **Skill** | `vitana-marketplace` (NEW) |

**What it does:**
When a business user creates a service listing (coaching, consulting, therapy, nutrition, fitness), Autopilot distributes it to relevant potential clients in the Discover section.

**Actions:**
1. Receive new service creation event
2. Extract `service_type` (coach, doctor, lab, wellness, nutrition, fitness, therapy, other) and `topic_keys`
3. Find users whose `user_topic_profile` aligns with the service topics (score > 60)
4. Also find users with relevant `biomarker_results` or `vitana_index_scores` weakness in the pillar
5. Add service to personalized Discover feed for matching users
6. If high alignment: surface via `GET /api/v1/offers/recommendations`
7. Create `relationship_edge` (type: `saved`, origin: `autopilot_marketplace`) for top 50 matches
8. Emit OASIS event `autopilot.marketplace.service_listed`

**APIs used:**
- `POST /api/v1/catalog/services` (VTID-01092)
- `GET /api/v1/offers/recommendations`
- `services_catalog`, `user_topic_profile`, `relationship_edges` tables

**Success metric:** Service view rate within 7 days of listing, booking rate

---

## AP-1102 — Product Listing & AI-Picks Matching

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Creator publishes a new product via `POST /api/v1/catalog/products` |
| **Skill** | `vitana-marketplace` |

**What it does:**
When a product is listed (supplement, device, food, wearable, app), matches it to users whose health profile would benefit. Powers the "AI Picks" section in Discover.

**Actions:**
1. Receive new product creation event
2. Extract `product_type` (supplement, device, food, wearable, app, other) and `topic_keys`
3. Cross-reference with:
   - `recommendations` table: users who have open recommendations matching the product category
   - `user_offers_memory`: users who previously viewed/saved similar products
   - `usage_outcomes`: users who reported positive outcomes with similar products
4. Add to "AI Picks" feed for matching users
5. Check AP-0710 (monetization readiness) before surfacing as paid suggestion
6. Emit OASIS event `autopilot.marketplace.product_listed`

**APIs used:**
- `POST /api/v1/catalog/products` (VTID-01092)
- `products_catalog`, `recommendations`, `user_offers_memory`, `usage_outcomes` tables

**Safety:**
- Health product recommendations require AP-0609 alignment (quality-of-life engine)
- AP-0710 monetization readiness must pass
- Never push supplements during emotional vulnerability (AP-0613)

---

## AP-1103 — Discover Section Personalization

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User opens Discover section or daily refresh |
| **Skill** | `vitana-marketplace` |

**What it does:**
Personalizes the Discover section feed by combining health profile, topic interests, social signals, and purchase history.

**Actions:**
1. Get user context: `user_topic_profile`, `vitana_index_scores`, `relationship_edges`
2. Score all active services and products:
   - Topic alignment (40% weight)
   - Health relevance — weak pillars that this product/service addresses (30% weight)
   - Social proof — connections who used this service/product (20% weight)
   - Outcome data — `usage_outcomes` from similar users (10% weight)
3. Rank and return top results per category (nutrition, fitness, sleep, mental health, recovery, cognitive, hydration)
4. Include "Because you..." explanations for each recommendation
5. Emit OASIS event `autopilot.marketplace.discover_personalized`

**APIs used:**
- `GET /api/v1/offers/recommendations` (VTID-01092)
- `GET /api/v1/offers/memory` — user's interaction history
- All catalog and profile tables

**Success metric:** Click-through rate on personalized vs. non-personalized results

---

## AP-1104 — Client-Service Matching Automation

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | User searches for a service or asks ORB for a recommendation |
| **Skill** | `vitana-marketplace` |

**What it does:**
When a user explicitly looks for a professional (doctor, coach, nutritionist), matches them with the best fit from the services catalog.

**Actions:**
1. Detect service search (Discover section filter or ORB conversation)
2. Query `services_catalog` filtered by user's needs
3. Score candidates by: topic alignment, availability, reviews/outcomes, location proximity, price fit
4. Present top 3 with personalized rationale
5. Track via `user_offers_memory` (state: viewed → saved → used)
6. Emit OASIS event `autopilot.marketplace.client_matched`

**APIs used:**
- `GET /api/v1/offers/recommendations`
- `services_catalog`, `user_offers_memory` tables

---

## AP-1105 — Post-Service Outcome Tracking

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | 7 days after user marks a service as `used` |
| **Skill** | `vitana-marketplace` |

**What it does:**
Follows up with users after they use a service, collects outcome data, and uses it to improve future recommendations.

**Actions:**
1. Detect `user_offers_memory.state = 'used'` for services
2. Wait 7 days, then prompt via ORB: _"How was your session with [provider]? Did it help with [topic]?"_
3. Collect outcome: `POST /api/v1/offers/outcome` with `perceived_impact` (better/same/worse)
4. Update `relationship_edge` strength: better (+15), same (0), worse (-20)
5. Feed outcome into recommendations engine for future users
6. If outcome = 'better': suggest booking again or trying related services
7. Emit OASIS event `autopilot.marketplace.outcome_recorded`

**APIs used:**
- `POST /api/v1/offers/outcome` (VTID-01092)
- `usage_outcomes`, `relationship_edges` tables

**Success metric:** Repeat booking rate for positively-reviewed services

---

## AP-1106 — Shop Setup Wizard

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User taps "Start Selling" or "Create Business" |
| **Skill** | `vitana-marketplace` |

**What it does:**
Guides new creators through the complete business setup flow: profile → listings → payment setup → first share.

**Actions:**
1. Step 1: Business profile — name, description, category, expertise areas (`topic_keys`)
2. Step 2: First listing — service or product with details and pricing
3. Step 3: Stripe Connect — trigger AP-0706 (creator onboarding)
4. Step 4: Share — trigger AP-0401 (WhatsApp share link) for their shop
5. Progress tracking: nudge if setup incomplete after 48h
6. Celebrate completion: _"Your shop is live! Your first listing is visible to [N] potential clients"_
7. Emit OASIS events for each step

**Cross-references:** AP-0706, AP-0401, AP-0403

---

## AP-1107 — Product Review Follow-Up

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | 14 days after product purchase |
| **Skill** | `vitana-marketplace` |

**What it does:**
Prompts buyers to review products after they've had time to use them.

**Actions:**
1. Detect product purchase in `user_offers_memory` (state: `used`)
2. Wait 14 days
3. Prompt: _"How is [product] working for you? A quick review helps other members."_
4. Collect: star rating (1-5), written review, outcome (better/same/worse)
5. Surface review to future buyers in Discover
6. Award AP-0708 credits for completed review
7. Emit OASIS event `autopilot.marketplace.review_collected`

**Requires:** AP-0708 (wallet credits for review)

---

## AP-1108 — Creator Analytics & Growth Tips

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Weekly (with AP-0711 earnings report) |
| **Skill** | `vitana-marketplace` |

**What it does:**
Provides creators with actionable analytics: profile views, conversion rates, and growth tips.

**Actions:**
1. Compile: listing views, save rate, booking/purchase rate, review scores
2. Compare to category averages
3. Suggest improvements: _"Listings with photos get 3x more views"_, _"Try offering a live room Q&A (AP-1201)"_
4. Highlight top traffic sources (Discover, ORB suggestion, social share)
5. Send via in-app dashboard + push summary

---

## AP-1109 — Seasonal & Trending Recommendations for Creators

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Monthly or when community trends shift |
| **Skill** | `vitana-marketplace` |

**What it does:**
Analyzes community health trends and topic popularity to suggest what creators should offer next.

**Actions:**
1. Aggregate: trending `topic_keys` across `user_topic_profile`, search queries, group discussions
2. Find gaps: topics with high demand but few listings in `services_catalog` / `products_catalog`
3. Notify relevant creators: _"[Topic] is trending — you're an expert. Consider listing a [service_type]?"_
4. Track whether creator acts on the suggestion

---

## AP-1110 — Cross-Sell Service to Product Buyers

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | User purchases a product (supplement, device) |
| **Skill** | `vitana-marketplace` |

**What it does:**
After a user buys a product, suggests relevant services that complement it (e.g., buy vitamin D supplement → suggest nutritionist consultation).

**Actions:**
1. Detect product purchase in `user_offers_memory`
2. Map product `topic_keys` to complementary services in `services_catalog`
3. Check AP-0710 (monetization readiness) — don't stack suggestions
4. Wait 3 days, then suggest: _"Getting the most from [product]? A [service_type] can help you optimize your results."_
5. Track conversion from cross-sell

**Safety:**
- Only suggest after positive use (not immediately at purchase)
- Respect AP-0805 overload detection
- Maximum 1 cross-sell per product purchase