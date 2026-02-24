# VTNA Credit-Spending Business Model
**Vitana Platform - Monetization Architecture**
**Status:** DRAFT - Pending Approval
**Date:** 2026-02-24

---

## Executive Summary

This document defines a **credit-based spending model** for the Vitana Platform, inspired by usage-based platforms like Lovable. All users get access to the full feature set for free, but with **time-limited sessions**. Users purchase **VTNA Token credit bundles** to extend session time, unlock premium durations, and access advanced health/wellness services.

The model is designed to maximize long-term user engagement and spending by providing genuine value first, then gating continued access behind credits that deplete over time.

---

## 1. Core Business Model Principle

```
FREE TIER = Full Feature Access + Time Limits
CREDITS   = Time Extension + Premium Services + Physical Products
```

Every user sees and can try **every feature**. The gate is **time**, not features.
This creates a "taste and invest" loop: users experience value, then spend credits to continue.

---

## 2. VTNA Token Economics

### 2.1 Token Definition

| Property | Value |
|----------|-------|
| Token Name | VTNA Token |
| Symbol | VTNA |
| Base Unit | 1 VTNA = 1 credit |
| Smallest Unit | 0.01 VTNA |
| Exchange Rate | 1 USD = 10 VTNA (fixed at launch) |
| Storage | Supabase `credit_wallets` table |
| Expiry | None (purchased credits never expire) |

### 2.2 Credit Bundle Packages

| Bundle | Price (USD) | VTNA Tokens | Bonus | Effective Rate |
|--------|-------------|-------------|-------|----------------|
| Starter | $10 | 100 VTNA | -- | $0.10/VTNA |
| Plus | $20 | 220 VTNA | +10% | $0.091/VTNA |
| Pro | $50 | 600 VTNA | +20% | $0.083/VTNA |
| Premium | $100 | 1,300 VTNA | +30% | $0.077/VTNA |
| Elite | $200 | 2,800 VTNA | +40% | $0.071/VTNA |

**Volume incentive:** Higher bundles get better rates, encouraging larger purchases.

### 2.3 Earning Free Credits

Users can earn bonus VTNA through engagement (capped monthly):

| Action | VTNA Earned | Monthly Cap |
|--------|-------------|-------------|
| Daily diary entry | 2 VTNA | 60 VTNA |
| Complete health check-in | 3 VTNA | 90 VTNA |
| Attend a live room (full session) | 5 VTNA | 50 VTNA |
| Refer a friend (who signs up) | 25 VTNA | 100 VTNA |
| Rate a service/product | 1 VTNA | 30 VTNA |
| Complete a guided template | 2 VTNA | 40 VTNA |

**Max free earnings:** ~370 VTNA/month ($37 equivalent) - enough to sustain light usage, not enough for power users.

---

## 3. Feature Tiers & Credit Costs

### 3.1 Category A: AI & ORB Features

These are the **primary credit consumers** - real-time AI costs money to run.

| Feature | Free Tier | Credit Cost |
|---------|-----------|-------------|
| **ORB Voice Conversation** | 5 min/day | 5 VTNA / 10 min block |
| **ORB Text Chat** | 20 messages/day | 2 VTNA / 50 messages |
| **AI Memory Recall** | Basic (last 7 days) | 3 VTNA / 30 days deep recall |
| **Intelligence Engines (D-series)** | Summary view only | 5 VTNA / full analysis |
| **Predictive Signals (D44)** | 1 signal/day | 3 VTNA / unlimited signals (24h) |
| **Risk Forecasting (D45)** | Weekly summary | 5 VTNA / daily forecasts (7 days) |
| **Opportunity Surfacing (D48)** | 2/day | 3 VTNA / unlimited (24h) |
| **Overload Detection (D51)** | Alert only | 3 VTNA / full analysis + guidance |
| **Personalized Recommendations** | 3/day | 2 VTNA / unlimited (24h) |

### 3.2 Category B: Health & Wellness

These drive the **highest value perception** - health is personal and urgent.

| Feature | Free Tier | Credit Cost |
|---------|-----------|-------------|
| **Health Dashboard** | View last 7 days | 3 VTNA / 30-day view |
| **Daily Health Summary** | Basic (3 metrics) | 5 VTNA / full summary (24h) |
| **Longevity Signals** | Weekly digest | 5 VTNA / daily signals (7 days) |
| **Health Capacity Awareness (D37)** | Energy level only | 5 VTNA / full capacity report |
| **Risk Mitigation (D49)** | 1 suggestion/day | 3 VTNA / full suite (24h) |
| **Guided Diary Templates** | 1/day (basic) | 2 VTNA / all templates (24h) |
| **Lab Report Analysis** | Upload only, no AI review | 10 VTNA / AI-powered analysis |
| **Wearable Data Sync** | Manual sync 1x/day | 5 VTNA / continuous sync (7 days) |

### 3.3 Category C: Community & Live Rooms

These create **social pressure to spend** - users want to participate with their community.

| Feature | Free Tier | Credit Cost |
|---------|-----------|-------------|
| **Join Public Live Rooms** | 15 min/session | 5 VTNA / full session access |
| **Create Live Rooms** | 1 room/week, 30 min max | 10 VTNA / room (unlimited duration) |
| **Event Management** | View events only | 5 VTNA / create events (24h) |
| **RSVP to Events** | 2 RSVPs/week | 2 VTNA / unlimited RSVPs (7 days) |
| **Community Groups** | Join 2 groups | 3 VTNA / unlimited groups (30 days) |
| **Matchmaking** | 1 match/week | 5 VTNA / 5 matches |
| **Relationship Graph** | View only | 3 VTNA / interaction tools (7 days) |

### 3.4 Category D: Advanced Services (Premium Credit Sinks)

These are **high-value, high-cost** services that drive significant spending.

| Service | Credit Cost | Description |
|---------|-------------|-------------|
| **Lab Test Ordering** | 50-200 VTNA | Partner lab test kits shipped to user |
| **Genomic Testing Kit** | 300 VTNA | DNA analysis kit + AI report |
| **Wearable Device Purchase** | 100-500 VTNA | Partner wearables (Oura, Whoop, etc.) |
| **1:1 Coach Session** | 50 VTNA | 30-min session with wellness coach |
| **Nutritionist Consultation** | 75 VTNA | Personalized nutrition plan |
| **Sleep Analysis Report** | 30 VTNA | Deep AI analysis of sleep patterns |
| **Longevity Blueprint** | 100 VTNA | Comprehensive longevity plan |
| **Stress Recovery Protocol** | 40 VTNA | Personalized stress management plan |
| **Social Wellness Audit** | 25 VTNA | Relationship health assessment |
| **Movement Optimization** | 35 VTNA | Exercise plan based on health data |

### 3.5 Category E: Automation & Productivity

| Feature | Free Tier | Credit Cost |
|---------|-----------|-------------|
| **Task Extraction (Autopilot)** | 3 tasks/day | 5 VTNA / unlimited (24h) |
| **Smart Scheduling** | View only | 5 VTNA / AI scheduling (7 days) |
| **Memory Export** | Once/month | 3 VTNA / on-demand export |
| **Knowledge Hub Search** | 5 searches/day | 2 VTNA / unlimited (24h) |

---

## 4. Free Tier Philosophy

### 4.1 What Stays Free Forever (No Limits)

These features are always free to ensure user retention and platform stickiness:

1. **Account creation & profile**
2. **Basic diary entries** (text only, 1/day)
3. **View health dashboard** (current day)
4. **Browse community feed**
5. **View live room listings**
6. **View services & products catalog**
7. **Basic ORB greeting** (first interaction)
8. **Push notifications & alerts**
9. **Settings & preferences**
10. **Memory governance** (view, lock, delete own data)
11. **Feedback submission**
12. **Basic matchmaking profile**

### 4.2 Time-Limited Free Access

All other features follow the "taste and invest" model:

```
User opens feature → Gets free trial time → Timer visible
Timer expires → Gentle prompt: "Add 5 VTNA to continue (10 more minutes)"
                              → Option: "Buy credits"
                              → Option: "Try again tomorrow"
```

**Timer UX principles:**
- Timer always visible but non-intrusive
- Warning at 2 minutes remaining
- Graceful session end (save state, no data loss)
- No mid-sentence cutoffs for ORB conversations
- Credits auto-deducted if user has balance and opts in

---

## 5. Credit Spending Mechanics

### 5.1 Spending Models

| Model | How It Works | Used By |
|-------|-------------|---------|
| **Time Block** | Buy X minutes of access | ORB, Live Rooms |
| **Per-Use** | Pay per action/analysis | Lab Reports, Matchmaking |
| **Day Pass** | Unlimited feature access for 24h | Signals, Recommendations |
| **Week Pass** | Unlimited feature access for 7 days | Wearable Sync, Scheduling |
| **One-Time** | Single purchase, permanent | Lab Kits, Wearables, Genomics |

### 5.2 Auto-Spend (Opt-In)

Users can enable auto-spend for features they use frequently:

```
Settings → Credit Management → Auto-Spend
  ☑ ORB Voice: Auto-extend when timer runs out (5 VTNA/block)
  ☑ Live Rooms: Auto-extend sessions (5 VTNA/session)
  ☐ Health Dashboard: Keep 30-day view active (3 VTNA/month)

  Daily spend limit: [50] VTNA
```

### 5.3 Credit Flow

```
Purchase (Stripe) → credit_transactions (credit) → credit_wallets (balance++)
                                                        │
Feature Use → credit_transactions (debit) ← credit_wallets (balance--)
                                                        │
Earn (engagement) → credit_transactions (earn) → credit_wallets (balance++)
```

---

## 6. Database Schema (New Tables)

### 6.1 `credit_wallets`

```sql
CREATE TABLE credit_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  lifetime_purchased NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  lifetime_spent NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  lifetime_earned NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  auto_spend_enabled BOOLEAN NOT NULL DEFAULT false,
  daily_spend_limit NUMERIC(12,2) DEFAULT 50.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);
```

### 6.2 `credit_transactions`

```sql
CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  wallet_id UUID NOT NULL REFERENCES credit_wallets(id),
  transaction_type TEXT NOT NULL,  -- 'purchase', 'spend', 'earn', 'refund', 'bonus', 'adjustment'
  amount NUMERIC(12,2) NOT NULL,  -- Positive for credit, negative for debit
  balance_after NUMERIC(12,2) NOT NULL,
  description TEXT NOT NULL,
  feature_key TEXT,                -- Which feature was used (e.g., 'orb_voice', 'live_room')
  reference_id TEXT,               -- External reference (Stripe payment_intent, etc.)
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 6.3 `credit_bundles`

```sql
CREATE TABLE credit_bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,       -- 'starter', 'plus', 'pro', 'premium', 'elite'
  price_usd NUMERIC(10,2) NOT NULL,
  vtna_amount NUMERIC(12,2) NOT NULL,
  bonus_vtna NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_vtna NUMERIC(12,2) NOT NULL,
  stripe_price_id TEXT,            -- Stripe Price object ID
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 6.4 `feature_credit_config`

```sql
CREATE TABLE feature_credit_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT NOT NULL UNIQUE,  -- 'orb_voice', 'orb_chat', 'live_room_join', etc.
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,            -- 'ai', 'health', 'community', 'services', 'automation'
  free_tier_limit TEXT NOT NULL,     -- Description of free limit
  free_tier_quantity INT,            -- Numeric limit (messages, minutes, etc.)
  free_tier_period TEXT,             -- 'daily', 'weekly', 'monthly'
  credit_cost NUMERIC(8,2) NOT NULL,
  credit_unit TEXT NOT NULL,         -- 'per_10_min', 'per_50_messages', 'per_24h', 'per_use'
  spending_model TEXT NOT NULL,      -- 'time_block', 'per_use', 'day_pass', 'week_pass', 'one_time'
  auto_spend_eligible BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 6.5 `feature_usage_tracking`

```sql
CREATE TABLE feature_usage_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  feature_key TEXT NOT NULL,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  free_usage_count INT NOT NULL DEFAULT 0,
  free_usage_limit INT NOT NULL,
  paid_usage_count INT NOT NULL DEFAULT 0,
  credits_spent NUMERIC(8,2) NOT NULL DEFAULT 0,
  session_minutes_used INT DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, feature_key, usage_date)
);
```

### 6.6 `credit_purchases`

```sql
CREATE TABLE credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  bundle_id UUID NOT NULL REFERENCES credit_bundles(id),
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  amount_usd NUMERIC(10,2) NOT NULL,
  vtna_credited NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'completed', 'failed', 'refunded'
  completed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7. API Endpoints (New)

### 7.1 Credit Wallet

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/credits/wallet` | Get user's credit balance & stats |
| GET | `/api/v1/credits/transactions` | Get transaction history |
| PATCH | `/api/v1/credits/wallet/settings` | Update auto-spend settings |

### 7.2 Credit Purchases

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/credits/bundles` | List available bundles & pricing |
| POST | `/api/v1/credits/purchase` | Create Stripe checkout for bundle |
| POST | `/api/v1/credits/purchase/webhook` | Stripe webhook for purchases |
| GET | `/api/v1/credits/purchases` | Get purchase history |

### 7.3 Feature Access

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/credits/access/:featureKey` | Check if user has access (free or paid) |
| POST | `/api/v1/credits/spend` | Spend credits for feature access |
| GET | `/api/v1/credits/usage` | Get daily usage summary |
| GET | `/api/v1/credits/features` | List all features with pricing & limits |

### 7.4 Earning Credits

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/credits/earn` | Record earned credits (internal) |
| GET | `/api/v1/credits/earnings` | Get earning history |

---

## 8. Integration with Existing Systems

### 8.1 D36 Monetization Engine Integration

The existing D36 Financial Monetization Engine already handles:
- Financial sensitivity detection
- Monetization readiness scoring
- Value perception profiling
- Gating checks (trust, emotional state, cooldowns)

**New integration:** D36 will now also consider the user's credit balance and spending history when computing monetization envelopes. Users with low balances get softer prompts; users who spend freely get more suggestions.

### 8.2 ORB Integration

The ORB session manager will be enhanced to:
1. Check free tier minutes remaining at session start
2. Display timer during session
3. Prompt for credit extension before session ends
4. Auto-extend if auto-spend is enabled
5. Emit OASIS events for credit-related state changes

### 8.3 Live Rooms Integration

The existing paid room system (Stripe Connect) remains for creator rooms. The credit system adds:
1. Time-limited free access to public rooms (15 min)
2. Credit-based full session access
3. Creator room purchases can also use VTNA credits (converted at checkout)

### 8.4 Health Data Integration

Health features become the premium upsell path:
1. Free users see limited health data (current day, 3 metrics)
2. Credits unlock deep historical views, AI analysis, and predictive signals
3. Lab test ordering and wearable purchases are high-value credit sinks

### 8.5 OASIS Event Integration

All credit events emit to OASIS for audit trail:

| Event | Type |
|-------|------|
| Credit purchased | `credit.purchased` |
| Credit spent | `credit.spent` |
| Credit earned | `credit.earned` |
| Credit refunded | `credit.refunded` |
| Free limit reached | `credit.free_limit_reached` |
| Auto-spend triggered | `credit.auto_spend.triggered` |
| Wallet low balance | `credit.wallet.low_balance` |

---

## 9. Revenue Projections

### 9.1 User Spending Scenarios

| User Type | Monthly Spend (USD) | VTNA/Month | Behavior |
|-----------|--------------------:|------------|----------|
| Free only | $0 | 0 (+ ~370 earned) | Uses free tiers, earns through engagement |
| Light user | $10 | 100 | Buys Starter bundle monthly for ORB & health |
| Moderate user | $20-50 | 220-600 | Regular ORB usage, live rooms, health tracking |
| Power user | $50-100 | 600-1,300 | Daily heavy usage, lab tests, coaching |
| Premium user | $100-200 | 1,300-2,800 | Full platform usage, genomics, wearables |

### 9.2 Revenue Mix Targets

| Revenue Source | Year 1 Target |
|----------------|---------------|
| Credit bundle sales | 60% |
| Lab test orders | 15% |
| Wearable device sales | 10% |
| Creator room commissions (10%) | 8% |
| Coaching session commissions | 5% |
| Genomic testing | 2% |

---

## 10. Competitive Analysis: Lovable Model Comparison

| Aspect | Lovable | Vitana (Proposed) |
|--------|---------|-------------------|
| Currency | Credits | VTNA Tokens |
| Free tier | Feature access + limits | Full feature access + time limits |
| Primary gate | Message/action limits | Time limits + usage counts |
| Earn free | No | Yes (engagement rewards) |
| Bundle sizes | 3 tiers | 5 tiers with volume bonuses |
| Physical goods | No | Yes (lab kits, wearables, genomics) |
| Creator economy | No | Yes (Stripe Connect, 90/10 split) |
| AI cost driver | Code generation | Voice AI, health analysis, predictions |
| Social spending | No | Yes (live rooms, events, matchmaking) |

---

## 11. Implementation Phases

### Phase 1: Foundation (Weeks 1-3)
- Database tables (credit_wallets, credit_transactions, credit_bundles, feature_credit_config)
- Stripe Checkout integration for credit purchases
- Credit wallet API (balance, transactions, spend)
- Feature access gate middleware
- Admin bundle management

### Phase 2: Core Features (Weeks 4-6)
- ORB session time gating with credit extension
- Health dashboard gating
- Live room time gating
- Usage tracking for all gated features
- Auto-spend functionality
- Credit earning system

### Phase 3: Premium Services (Weeks 7-9)
- Lab test ordering integration (partner API)
- Wearable purchase flow
- Coaching session booking
- Genomic testing kit ordering
- Deep AI health analysis reports

### Phase 4: Optimization (Weeks 10-12)
- D36 engine integration with credit context
- A/B testing for credit prompts
- Spending analytics dashboard
- Dynamic pricing experimentation
- Referral reward system
- Low-balance notifications

---

## 12. Technical Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    Frontend (Lovable)                       │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Credit   │  │ Feature  │  │ Purchase │  │  Timer    │  │
│  │ Balance  │  │ Gates    │  │ Modal    │  │  Widget   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬──────┘  │
└───────┼──────────────┼──────────────┼──────────────┼────────┘
        │              │              │              │
┌───────┴──────────────┴──────────────┴──────────────┴────────┐
│                   Gateway API Layer                          │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ Credit       │  │ Feature       │  │ Purchase         │  │
│  │ Service      │  │ Access Gate   │  │ Service          │  │
│  │              │  │ (Middleware)   │  │ (Stripe)         │  │
│  └──────┬───────┘  └───────┬───────┘  └───────┬──────────┘  │
│         │                  │                   │             │
│  ┌──────┴──────────────────┴───────────────────┴──────────┐  │
│  │              D36 Monetization Engine                    │  │
│  │   (Sensitivity + Readiness + Value + Credits)          │  │
│  └────────────────────────┬───────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────┐
│                    Supabase (PostgreSQL)                      │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │ credit_      │  │ credit_        │  │ feature_         │  │
│  │ wallets      │  │ transactions   │  │ usage_tracking   │  │
│  ├──────────────┤  ├────────────────┤  ├──────────────────┤  │
│  │ credit_      │  │ credit_        │  │ feature_credit_  │  │
│  │ purchases    │  │ bundles        │  │ config           │  │
│  └──────────────┘  └────────────────┘  └──────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Existing: monetization_signals, value_signals,        │    │
│  │ monetization_attempts, app_users, live_rooms, etc.    │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 13. Governance & Ethics

Aligned with existing platform governance:

1. **User-benefit > monetization** - Credits enhance, never punish
2. **No dark patterns** - No fake urgency, no scarcity framing
3. **Transparent pricing** - All costs visible before spending
4. **No surprise charges** - Auto-spend is opt-in only with daily limits
5. **Data ownership** - Users can export data regardless of credit balance
6. **No paywall on safety** - Health alerts, critical signals always free
7. **Grace periods** - Sessions end gracefully, never mid-conversation
8. **Refund policy** - Unused credits refundable within 30 days
9. **D36 integration** - Monetization respects emotional state and trust

---

## 14. Key Metrics to Track

| Metric | Target |
|--------|--------|
| Free-to-paid conversion rate | 8-12% |
| Average revenue per paying user (ARPPU) | $35/month |
| Credit purchase frequency | 1.5x/month |
| Feature adoption (paid) | 40%+ of paying users use 3+ paid features |
| Churn rate (paid users) | <8%/month |
| Free engagement (earned credits) | 60%+ of free users earn credits monthly |
| Auto-spend adoption | 25%+ of paying users |
| Lab test conversion | 5% of paying users/quarter |
| Wearable purchase rate | 3% of paying users/quarter |

---

## 15. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Users feel nickeled-and-dimed | Generous free tiers + earn-back system |
| Low conversion from free | A/B test free limits, optimize trial experience |
| Credit purchase friction | Stripe Checkout (1-click), saved payment methods |
| Overspending complaints | Daily limits, spending reports, alerts |
| Feature complexity | Clear pricing page, in-app cost previews |
| Competition undercuts pricing | Focus on unique health + AI integration value |

---

## 16. File Structure (Implementation)

```
services/gateway/src/
  routes/
    credits.ts                    -- Credit wallet, purchase, spending routes
    credit-bundles.ts             -- Bundle listing and management
    feature-access.ts             -- Feature gating middleware
  services/
    credit-service.ts             -- Core credit operations
    credit-purchase-service.ts    -- Stripe checkout integration
    feature-access-service.ts     -- Usage tracking and gating logic
    credit-earning-service.ts     -- Engagement reward logic
  types/
    credits.ts                    -- TypeScript types for credit system

supabase/migrations/
    YYYYMMDD_vtna_credit_wallets.sql
    YYYYMMDD_vtna_credit_transactions.sql
    YYYYMMDD_vtna_credit_bundles.sql
    YYYYMMDD_vtna_feature_config.sql
    YYYYMMDD_vtna_usage_tracking.sql
    YYYYMMDD_vtna_credit_purchases.sql
```

---

## Appendix A: Complete Feature Key Registry

| Feature Key | Category | Display Name |
|-------------|----------|-------------|
| `orb_voice` | ai | ORB Voice Conversation |
| `orb_chat` | ai | ORB Text Chat |
| `memory_deep_recall` | ai | AI Memory Deep Recall |
| `intelligence_full` | ai | Full Intelligence Analysis |
| `predictive_signals` | ai | Predictive Signal Detection |
| `risk_forecasting` | ai | Risk Forecasting |
| `opportunity_surfacing` | ai | Opportunity Surfacing |
| `overload_analysis` | ai | Overload Detection & Analysis |
| `recommendations_unlimited` | ai | Personalized Recommendations |
| `health_dashboard_30d` | health | Health Dashboard (30-day) |
| `health_summary_full` | health | Full Daily Health Summary |
| `longevity_signals` | health | Longevity Signals |
| `health_capacity_full` | health | Full Health Capacity Report |
| `risk_mitigation_full` | health | Full Risk Mitigation Suite |
| `diary_templates_all` | health | All Guided Diary Templates |
| `lab_report_analysis` | health | AI Lab Report Analysis |
| `wearable_continuous_sync` | health | Continuous Wearable Sync |
| `live_room_full_session` | community | Live Room Full Session |
| `live_room_create` | community | Create Live Rooms |
| `event_create` | community | Event Creation |
| `rsvp_unlimited` | community | Unlimited RSVPs |
| `community_groups_unlimited` | community | Unlimited Community Groups |
| `matchmaking_multi` | community | Multiple Matches |
| `relationship_tools` | community | Relationship Interaction Tools |
| `lab_test_order` | services | Lab Test Ordering |
| `genomic_testing` | services | Genomic Testing Kit |
| `wearable_purchase` | services | Wearable Device Purchase |
| `coach_session` | services | 1:1 Coaching Session |
| `nutritionist_session` | services | Nutritionist Consultation |
| `sleep_analysis` | services | Deep Sleep Analysis |
| `longevity_blueprint` | services | Longevity Blueprint |
| `stress_recovery` | services | Stress Recovery Protocol |
| `social_wellness_audit` | services | Social Wellness Audit |
| `movement_optimization` | services | Movement Optimization Plan |
| `task_extraction_unlimited` | automation | Unlimited Task Extraction |
| `smart_scheduling` | automation | AI Smart Scheduling |
| `memory_export` | automation | On-Demand Memory Export |
| `knowledge_search_unlimited` | automation | Unlimited Knowledge Search |

---

## Appendix B: Seed Data for credit_bundles

```sql
INSERT INTO credit_bundles (name, slug, price_usd, vtna_amount, bonus_vtna, total_vtna, display_order) VALUES
  ('Starter',  'starter',  10.00,  100.00,   0.00,  100.00,  1),
  ('Plus',     'plus',     20.00,  200.00,  20.00,  220.00,  2),
  ('Pro',      'pro',      50.00,  500.00, 100.00,  600.00,  3),
  ('Premium',  'premium', 100.00, 1000.00, 300.00, 1300.00,  4),
  ('Elite',    'elite',   200.00, 2000.00, 800.00, 2800.00,  5);
```

---

**END OF DOCUMENT**
