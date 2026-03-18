# Vitana Autopilot Automations Registry

> **Single source of truth** for all Autopilot automations.
> Every automation has a permanent `AP-XXXX` ID that never changes.
> Canonical KB reference: `95-playbooks-autopilot-doc-95-9501`

## ID Scheme

```
Format:  AP-XXXX
Example: AP-0101 = "Daily match delivery"
```

| Range | Domain | File |
|-------|--------|------|
| AP-0100 – AP-0199 | Connect People | [01-connect-people.md](./01-connect-people.md) |
| AP-0200 – AP-0299 | Community & Groups | [02-community-groups.md](./02-community-groups.md) |
| AP-0300 – AP-0399 | Events & Live Rooms | [03-events-live-rooms.md](./03-events-live-rooms.md) |
| AP-0400 – AP-0499 | Sharing & Growth | [04-sharing-growth.md](./04-sharing-growth.md) |
| AP-0500 – AP-0599 | Engagement Loops | [05-engagement-loops.md](./05-engagement-loops.md) |
| AP-0600 – AP-0699 | Health & Wellness | [06-health-wellness.md](./06-health-wellness.md) |
| AP-0700 – AP-0799 | Payments, Wallet & VTN | [07-payments-subscriptions.md](./07-payments-subscriptions.md) |
| AP-0800 – AP-0899 | Personalization Engines | [08-personalization-engines.md](./08-personalization-engines.md) |
| AP-0900 – AP-0999 | Memory & Intelligence | [09-memory-intelligence.md](./09-memory-intelligence.md) |
| AP-1000 – AP-1099 | Platform Operations | [10-platform-operations.md](./10-platform-operations.md) |
| AP-1100 – AP-1199 | Business Hub & Marketplace | [11-business-hub-marketplace.md](./11-business-hub-marketplace.md) |
| AP-1200 – AP-1299 | Live Rooms Commerce | [12-live-rooms-commerce.md](./12-live-rooms-commerce.md) |
| AP-1300+ | Reserved for future domains | — |

## Statuses

| Status | Meaning |
|--------|---------|
| `PLANNED` | Defined and scoped, not yet implemented |
| `IN_PROGRESS` | Currently being built |
| `IMPLEMENTED` | Code exists, not yet deployed to production |
| `LIVE` | Running in production |
| `DEPRECATED` | Superseded or removed |

## Summary Dashboard

| Domain | Total | Planned | In Progress | Implemented | Live |
|--------|-------|---------|-------------|-------------|------|
| Connect People | 10 | 7 | 0 | 3 | 0 |
| Community & Groups | 10 | 8 | 0 | 2 | 0 |
| Events & Live Rooms | 8 | 5 | 0 | 3 | 0 |
| Sharing & Growth | 10 | 10 | 0 | 0 | 0 |
| Engagement Loops | 8 | 6 | 0 | 2 | 0 |
| Health & Wellness | 15 | 12 | 0 | 3 | 0 |
| Payments, Wallet & VTN | 12 | 9 | 0 | 3 | 0 |
| Personalization Engines | 5 | 5 | 0 | 0 | 0 |
| Memory & Intelligence | 5 | 5 | 0 | 0 | 0 |
| Platform Operations | 5 | 3 | 0 | 2 | 0 |
| Business Hub & Marketplace | 10 | 10 | 0 | 0 | 0 |
| Live Rooms Commerce | 10 | 10 | 0 | 0 | 0 |
| **TOTAL** | **108** | **90** | **0** | **18** | **0** |

## How to Add a New Automation

1. Pick the next available `AP-XXXX` ID in the correct range
2. Add the entry to the appropriate domain file
3. Fill in all fields (trigger, actions, APIs, skill, priority)
4. Set status to `PLANNED`
5. Update the summary dashboard counts in this README
6. Commit with message: `docs(autopilot): add AP-XXXX {short description}`

## Conventions

- IDs are **permanent** — never reuse a deprecated ID
- Each automation references the **existing API endpoints** it depends on
- Each automation names the **OpenClaw bridge skill** that implements it
- Priority: `P0` (must-have for launch) → `P1` (important) → `P2` (nice-to-have) → `P3` (future)
- Dependencies between automations use `requires: [AP-XXXX]` notation

## Key Cross-Domain Flows

These flows show how automations chain across domains to create complete user journeys:

### Health → Business → Live Rooms (Quality of Life Flow)
```
AP-0607 (Lab Ingestion) → AP-0608 (Trend Analysis) → AP-0609 (Recommendations)
  → AP-0612 (Professional Referral) → AP-1104 (Client-Service Matching)
  → AP-1208 (Consultation Matching) → AP-1202 (Booking & Payment)
  → AP-1105 (Outcome Tracking) → AP-0615 (Health-Aware Products)
```

### Social → Sharing → Growth (Viral Loop)
```
AP-0101 (Daily Match) → AP-0103 (Introduction) → AP-0404 (Invite After Positive)
  → AP-0401 (WhatsApp Share) → AP-0410 (Viral Signup) → AP-0405 (Referral Reward)
  → AP-0708 (Wallet Credits)
```

### Creator → Business → Revenue (Business Setup Flow)
```
AP-1106 (Shop Setup) → AP-0706 (Stripe Connect) → AP-1101 (Service Distribution)
  → AP-1201 (Paid Room Setup) → AP-1202 (Booking) → AP-1205 (Revenue Report)
  → AP-0711 (Weekly Earnings) → AP-1108 (Growth Tips)
```

### Engagement → Wallet → VTN (Token Economy Flow)
```
AP-0708 (Credits for Engagement) → AP-0709 (VTN Launch) → AP-0712 (Spending Insights)
  → AP-0710 (Monetization Readiness) → AP-1102 (Product Matching)
```
