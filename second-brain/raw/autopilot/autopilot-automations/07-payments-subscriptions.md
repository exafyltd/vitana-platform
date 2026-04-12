# AP-0700: Payments, Wallet & Vitana Token (VTN)

> Automations for Stripe payment lifecycle, subscription management, wallet operations, Vitana Token (VTN) launch and economy, creator payouts via Stripe Connect, and financial monetization readiness.

---

## AP-0701 — Payment Failure Detection & Retry

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Heartbeat loop (every 15 min) |
| **Skill** | `vitana-stripe` |

**What it does:**
Proactively detects failed payments and retries them.

**Actions:**
1. Query `stripe_subscriptions` where `status IN ('past_due', 'unpaid')`
2. For each: call `vitana-stripe.retry_payment`
3. Log to `autopilot_logs`

**Notes:** Already implemented in OpenClaw bridge heartbeat.

---

## AP-0702 — Subscription Created Audit

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | New subscription created via webhook |
| **Skill** | `vitana-stripe` |

**What it does:**
Logs all subscription creation events to the audit trail.

**Notes:** Already implemented in OpenClaw bridge.

---

## AP-0703 — Plan Upgrade Suggestion

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | User hits free plan limits |
| **Skill** | `vitana-stripe` |

**What it does:**
When a user approaches or hits free plan limits, suggests upgrading with clear value proposition.

**Actions:**
1. Monitor usage against plan limits
2. At 80% usage: _"You're getting great value from Vitana! Upgrade to Pro for unlimited [feature]."_
3. At 100%: _"You've reached your free limit. Upgrade to keep going."_
4. No pressure tactics — just transparent information

---

## AP-0704 — Subscription Expiry Warning

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | 7 days before subscription renewal fails |
| **Skill** | `vitana-stripe` |

**What it does:**
Warns users before their payment method expires or subscription lapses.

---

## AP-0705 — Payment Method Update Reminder

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Payment fails + 24h |
| **Skill** | `vitana-stripe` |

**What it does:**
After a payment retry fails, notifies the user to update their payment method.

---

## AP-0706 — Creator Stripe Connect Onboarding

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User creates first service or product listing |
| **Skill** | `vitana-stripe` |

**What it does:**
Guides business users through Stripe Connect onboarding when they list their first service or product in the Discover marketplace.

**Actions:**
1. Detect first `POST /api/v1/catalog/services` or `POST /api/v1/catalog/products` from user
2. Check `stripe_account_id` on `app_users` — if null, start onboarding flow
3. Call `POST /api/v1/creators/onboard` to create Stripe Connect Express account
4. Send push: _"To receive payments, complete your payout setup — takes 2 minutes"_
5. If onboarding incomplete after 48h: send reminder with account link
6. Once `stripe_charges_enabled = true`: _"You're all set to receive payments!"_
7. Emit OASIS event `autopilot.wallet.creator_onboarded`

**APIs used:**
- `POST /api/v1/creators/onboard` (VTID-01231)
- `stripe_connect_webhook` for status tracking
- `app_users.stripe_account_id`, `stripe_charges_enabled`, `stripe_payouts_enabled`

**Notes:** Platform takes 10% fee, creator receives 90% via Stripe Connect Express.

---

## AP-0707 — Creator Payout Monitoring

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Heartbeat or Stripe webhook |
| **Skill** | `vitana-stripe` |

**What it does:**
Monitors creator payouts and notifies on successful transfers, failed payouts, or payout schedule changes.

**Actions:**
1. Listen for Stripe Connect webhooks: `payout.paid`, `payout.failed`, `account.updated`
2. On successful payout: _"You earned [amount] this week from [N] transactions. Nice!"_
3. On failed payout: _"Your payout couldn't be processed — check your banking details"_
4. Track `stripe_payouts_enabled` status changes
5. Emit OASIS event `autopilot.wallet.payout_processed`

**APIs used:**
- `stripe-connect-webhook.ts` (VTID-01231)
- RPC: `get_user_stripe_status`, `update_user_stripe_status`

---

## AP-0708 — Wallet Credit Rewards for Engagement

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User completes reward-eligible action |
| **Skill** | `vitana-wallet` (NEW) |

**What it does:**
Awards wallet credits for engagement actions that build community value. Credits can be used toward marketplace purchases, premium features, or converted to VTN.

**Reward-eligible actions:**
| Action | Credits |
|--------|---------|
| Complete onboarding profile | 50 |
| Upload first lab report | 100 |
| Accept a match and send message | 20 |
| Attend a live room (>10 min) | 30 |
| Create a group that reaches 5 members | 75 |
| Refer a friend who completes onboarding | 200 |
| Write a product/service review | 25 |
| Achieve health goal milestone | 50 |
| 30-day streak (daily app usage) | 100 |

**Actions:**
1. Detect reward-eligible event from OASIS event stream
2. Credit user wallet (idempotent — each event ID credited once)
3. Send push: _"You earned [N] credits for [action]! Your balance: [total]"_
4. Log to `monetization_signals` for tracking
5. Emit OASIS event `autopilot.wallet.credits_awarded`

**APIs needed (NEW):**
- `POST /api/v1/wallet/credit` — add credits to user wallet
- `GET /api/v1/wallet/balance` — get current balance

**Database needed:**
```sql
CREATE TABLE wallet_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount integer NOT NULL,        -- positive = credit, negative = debit
  type text NOT NULL,             -- 'reward', 'purchase', 'transfer', 'vtn_convert', 'refund'
  source_event_id text,           -- idempotency: OASIS event ID
  description text,
  balance_after integer NOT NULL,
  created_at timestamptz DEFAULT now()
);
```

---

## AP-0709 — Vitana Token (VTN) Launch Automation

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | VTN token launch event |
| **Skill** | `vitana-wallet` |

**What it does:**
Manages the Vitana Token launch lifecycle: initial distribution, conversion from credits, and ongoing token economy.

**Actions:**
1. On VTN launch day: notify all users _"The Vitana Token (VTN) is live! Your [N] credits have been converted to [M] VTN"_
2. Convert existing wallet credits to VTN at launch rate
3. Enable VTN balance display in wallet UI
4. Activate VTN payment option in marketplace
5. Emit OASIS event `autopilot.wallet.vtn_launched`

**Sub-automations for ongoing VTN economy:**
- **AP-0709a**: VTN earned for health milestones (Vitana Index improvement)
- **AP-0709b**: VTN earned for community contribution (groups, events, referrals)
- **AP-0709c**: VTN spent in marketplace (products, services, premium rooms)
- **AP-0709d**: VTN staking rewards for long-term holders

**Notes:**
- VTN is an internal utility token — not a cryptocurrency (regulatory compliance)
- Exchange rate and economics defined in token whitepaper (separate doc)
- Token economics VTID to be allocated

---

## AP-0710 — Monetization Readiness Scoring

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Before any paid suggestion (AP-0615, AP-1102, AP-1203) |
| **Skill** | `vitana-wallet` |

**What it does:**
Uses the D36 Financial Sensitivity & Monetization Readiness Engine (VTID-01130) to determine if it's appropriate to surface a paid suggestion.

**Actions:**
1. Compute monetization context: `POST /api/v1/financial-monetization/context`
2. Get current envelope: `GET /api/v1/financial-monetization/envelope`
3. Check: readiness_score, value_perception, emotional_state, budget_signals
4. If readiness HIGH and no vulnerability: allow paid suggestion
5. If readiness LOW or vulnerability detected: defer to free alternatives
6. Record attempt: `POST /api/v1/financial-monetization/attempt`
7. Emit OASIS event `autopilot.wallet.monetization_scored`

**APIs used:**
- Full D36 Financial Monetization API (VTID-01130)
- `monetization_signals`, `value_signals`, `monetization_attempts` tables

**Core rules (from VTID-01130):**
- Never lead with price — always lead with value
- Never stack multiple paid suggestions in one session
- No monetization when emotional vulnerability detected
- Explicit user "no" blocks monetization immediately
- Zero social pressure

---

## AP-0711 — Weekly Earnings Report for Creators

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Weekly (Monday 10:00) |
| **Skill** | `vitana-stripe` |

**What it does:**
Sends business users a weekly earnings summary: revenue, transactions, top services/products, client reviews.

**Actions:**
1. Query Stripe Connect for weekly earnings
2. Compile: total revenue, number of transactions, top-selling items, average rating
3. Send: _"Your week on Vitana Business: [amount] earned from [N] transactions. Top: [service/product]"_
4. Include actionable tip: _"Tip: Creators who offer live consultations earn 3x more — try it?"_
5. Emit OASIS event `autopilot.wallet.creator_earnings_report`

**Cross-references:** AP-1101, AP-1203

---

## AP-0712 — Spending Insights for Users

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Monthly (1st of month) |
| **Skill** | `vitana-wallet` |

**What it does:**
Monthly spending summary showing how users invested in their health: services used, products purchased, credits earned and spent.

**Actions:**
1. Query `wallet_transactions` for last month
2. Compile: total spent, credits earned, VTN balance, top categories
3. Cross-reference with `usage_outcomes`: _"You spent [amount] on [service] and reported [outcome]"_
4. Suggest: _"Based on your outcomes, you might also like [related product/service]"_

**APIs used:**
- `wallet_transactions`, `usage_outcomes`, `user_offers_memory` tables
