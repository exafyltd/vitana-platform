# Autopilot Automations

> The 12 automation domains that define every proactive behavior in Vitana's Autopilot, covering 108 total automations with permanent AP-XXXX IDs, trigger patterns, and cross-domain chaining.

## Content

### ID Scheme and Registry

Every automation has a permanent `AP-XXXX` ID that never changes, organized into 12 domains with 100-ID ranges. The registry lives in the `autopilot-automations/` directory with one file per domain. IDs are never reused, even for deprecated automations.

### The 12 Automation Domains

| Range | Domain | Automations | Implemented | Key Focus |
|-------|--------|-------------|-------------|-----------|
| AP-0100 | **Connect People** | 10 | 3 | Daily matching, nudges, introductions, icebreakers, social alignment |
| AP-0200 | **Community & Groups** | 10 | 2 | Group lifecycle, auto-creation from interest clusters, meetup suggestions, group health monitoring |
| AP-0300 | **Events & Live Rooms** | 8 | 3 | Daily.co room scheduling, graduated reminders, post-event feedback, trending topic rooms |
| AP-0400 | **Sharing & Growth** | 10 | 0 | WhatsApp sharing, social media cards, referral tracking, viral loops, weekly recaps |
| AP-0500 | **Engagement Loops** | 8 | 2 | Morning briefings, weekly digests, re-engagement for dormant users, milestone celebrations |
| AP-0600 | **Health & Wellness** | 15 | 3 | PHI redaction, lab report ingestion, biomarker trends, quality-of-life recommendations, wearable anomaly detection |
| AP-0700 | **Payments & VTN** | 12 | 3 | Payment retry, Stripe Connect onboarding, wallet credits, VTN token economy, monetization readiness |
| AP-0800 | **Personalization Engines** | 5 | 0 | Social comfort filtering, taste alignment, opportunity surfacing, life-stage awareness, overload detection |
| AP-0900 | **Memory & Intelligence** | 5 | 0 | Memory-informed matching, fact extraction from conversations, relationship graph maintenance, semantic search |
| AP-1000 | **Platform Operations** | 5 | 2 | VTID lifecycle, governance flags, post-deploy health checks, error rate alerts |
| AP-1100 | **Business Hub & Marketplace** | 10 | 0 | Service/product listing, Discover personalization, client-service matching, shop setup wizard |
| AP-1200 | **Live Rooms Commerce** | 10 | 0 | Paid room setup, booking & payment, upsell from free content, consultation matching, revenue reports |

**Total: 108 automations, 18 implemented, 90 planned, 0 live in production.**

### Trigger Patterns

Automations are triggered by one of three patterns:

1. **Cron/Scheduled** -- Time-based execution (e.g., daily at 08:00 local, weekly Monday 10:00, heartbeat every 15min)
2. **Event-Driven** -- Respond to user actions or system events (e.g., mutual match accept, payment failure, meetup creation)
3. **Context-Change** -- Detect state changes (e.g., user idle > 3 days, group activity spike, biomarker shift from normal to critical)

### Output Types

- **Push Notifications** -- Personalized messages via FCM push (respects quiet hours)
- **Vitana Bot Chat Messages** -- In-app messages sent as the Vitana Bot user
- **API Calls** -- Automated calls to internal APIs (match recompute, room creation, wallet credit)
- **OASIS Events** -- Telemetry events emitted for every automation execution (e.g., `autopilot.connect.nudge_sent`)
- **Data Mutations** -- Database writes (relationship edges, wallet transactions, recommendation records)

### Key Cross-Domain Flows

These flows chain automations across domains to create complete user journeys:

- **Health -> Business -> Live Rooms (Quality of Life)**: Lab ingestion (AP-0607) -> Trend analysis (AP-0608) -> Recommendations (AP-0609) -> Professional referral (AP-0612) -> Consultation matching (AP-1208) -> Booking (AP-1202) -> Outcome tracking (AP-1105)
- **Social -> Sharing -> Growth (Viral Loop)**: Daily match (AP-0101) -> Introduction (AP-0103) -> Invite after positive (AP-0404) -> WhatsApp share (AP-0401) -> Viral signup (AP-0410) -> Referral reward (AP-0405) -> Wallet credits (AP-0708)
- **Creator -> Business -> Revenue**: Shop setup (AP-1106) -> Stripe Connect (AP-0706) -> Service distribution (AP-1101) -> Paid room setup (AP-1201) -> Booking (AP-1202) -> Revenue report (AP-1205)
- **Engagement -> Wallet -> VTN (Token Economy)**: Credits for engagement (AP-0708) -> VTN launch (AP-0709) -> Spending insights (AP-0712) -> Monetization readiness (AP-0710) -> Product matching (AP-1102)

### Safety and Ethical Guardrails

- **PHI Redaction Gate (AP-0601)**: Mandatory middleware on all health data -- pattern-based PHI detection, local Ollama LLM only
- **Consent Check (AP-0603)**: Hard gate before any health data processing
- **Health Capacity Awareness (AP-0613)**: Suppresses social nudges when health capacity is LOW; only wellness check-ins when CRITICAL
- **Monetization Readiness (AP-0710)**: Never surface paid suggestions when user is emotionally vulnerable or shows overload signals
- **Overload Detection (AP-0805)**: Throttles notifications when user shows fatigue; only P0 safety/payment notifications bypass

### Status Lifecycle

| Status | Meaning |
|--------|---------|
| PLANNED | Defined and scoped, not yet implemented |
| IN_PROGRESS | Currently being built |
| IMPLEMENTED | Code exists, not yet deployed to production |
| LIVE | Running in production |
| DEPRECATED | Superseded or removed |

### Conventions

- IDs are permanent and never reused
- Each automation references existing API endpoints it depends on
- Each automation names the OpenClaw bridge skill that implements it
- Priority levels: P0 (must-have) -> P1 (important) -> P2 (nice-to-have) -> P3 (future)
- Dependencies use `requires: [AP-XXXX]` notation

## Related Pages

- [[autopilot-system]]
- [[autopilot]]
- [[recommendation-engine]]
- [[cognee-integration]]
- [[autonomous-execution]]

## Sources

- `raw/autopilot/autopilot-automations/README.md`
- `raw/autopilot/autopilot-automations/01-connect-people.md`
- `raw/autopilot/autopilot-automations/02-community-groups.md`
- `raw/autopilot/autopilot-automations/03-events-live-rooms.md`
- `raw/autopilot/autopilot-automations/04-sharing-growth.md`
- `raw/autopilot/autopilot-automations/05-engagement-loops.md`
- `raw/autopilot/autopilot-automations/06-health-wellness.md`
- `raw/autopilot/autopilot-automations/07-payments-subscriptions.md`
- `raw/autopilot/autopilot-automations/08-personalization-engines.md`
- `raw/autopilot/autopilot-automations/09-memory-intelligence.md`
- `raw/autopilot/autopilot-automations/10-platform-operations.md`
- `raw/autopilot/autopilot-automations/11-business-hub-marketplace.md`
- `raw/autopilot/autopilot-automations/12-live-rooms-commerce.md`

## Last Updated

2026-04-12
