# AP-0700: Payments & Subscriptions

> Automations for Stripe payment lifecycle, subscription management, and plan-related operations.

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
