# Summary: Autopilot Capabilities Model

> Summary of the VITANA Autopilot Capabilities Model document (v1.0.0), which defines the complete action taxonomy with A1-A5 classification levels, per-module capability tables, API/screen mappings, tenant behavior, risk rules, and background vs on-demand execution modes.

## Content

### Document Purpose

This document (`AUTOPILOT_CAPABILITIES.md`) is the authoritative capability model for the Autopilot system. It classifies every action by risk level, maps actions to APIs and screens, defines preconditions and permissions, and specifies safety rules.

### Capability Classification (A1-A5)

The document defines five levels of action capability:

| Level | Name | Risk | Data Mutation | Confirmation | Key Property |
|-------|------|------|--------------|--------------|-------------|
| A1 | Informational | Low | None | None | Pure read, no side effects |
| A2 | Navigational | Low | None | None | Frontend-only, react-router navigate |
| A3 | Transactional (Low-Risk) | Medium | User's own data | Optional | Reversible, no financial impact |
| A4 | Transactional (High-Risk) | High | Critical data, money | Required | Payments, PHI, external APIs |
| A5 | Autonomous Multi-Step | High | Multiple entities | Required at checkpoints | Multiple sequenced API calls, rollback capability |

### Decision Tree

A clear flowchart for assigning levels: Does it modify data? (No -> A1/A2; navigate? -> A2, else A1). Yes -> Does it involve money/PHI/external APIs? (No -> A3). Yes -> Multiple steps? (No -> A4, Yes -> A5).

### Module Capabilities

The document defines capabilities per module with full tables:

- **Community** (30 capabilities): COMM-001 through COMM-030, from discovering people (A1) through planning weekly meetups (A5)
- **Discover** (23 capabilities): Product/service search, cart, orders, checkout, AI supplement stacks
- **Health** (30 capabilities): Biomarkers, trackers, AI plans, wearable connectivity, full health assessments
- **Sharing** (22 capabilities): Campaigns, channels, audience segments, distribution activation
- **Wallet** (20 capabilities): Balances, transactions, rewards, transfers, subscriptions
- **Business** (24 capabilities): Earnings, services, packages, clients, reseller features
- **AI** (17 capabilities): Conversations, insights, Autopilot actions, Vertex Live, voice workflows
- **Memory** (14 capabilities): Diary, AI memory, life events, pattern analysis, memory consolidation
- **Admin** (20 capabilities): Tenant management, user management, audit logs, automation rules
- **Settings** (15 capabilities): Profile, preferences, notifications, connected apps, account management

### Tenant-Specific Behavior

Different tenants (Maxina, Alkalma, Earthlings) have different feature availability. Health features like biomarkers and AI plans are Maxina-tenant-specific.

### Risk Classification and Safety Rules

- All A4/A5 actions require explicit user confirmation
- Financial operations need full audit logging
- PHI operations processed locally (Ollama)
- A5 workflows support pause/resume and managed rollback
- Background automation respects quiet hours with category-based exceptions

### Background vs On-Demand

- **On-demand only**: Money movement (A4-WALL-011/012/013), ticket purchase (A4-COMM-028), checkout (A4-DISC-017), privilege escalation (A4-ADMN-014), account deletion (A4-SETT-013)
- **Background capable**: All A1 actions (data refresh), scheduled reminders, campaign activation, daily briefing
- **Hybrid mode**: Auto-joined events with notification, weekly wellness plan ready for review

### Integration Points

| Component | Type | Description |
|-----------|------|-------------|
| VITANALAND Orb | Voice commands | Natural language action triggers |
| Autopilot Popup | UI selection | User picks from suggested actions |
| Background Scheduler | Cron-based | Automated recurring execution |
| AI Chat | Conversational | Context-aware suggestions |
| Settings Panel | Configuration | User preference management |

## Related Pages

- [[autopilot-system]]
- [[recommendation-engine]]
- [[autopilot]]
- [[summary-autopilot-architecture]]
- [[summary-autopilot-action-catalog]]

## Sources

- `raw/autopilot/AUTOPILOT_CAPABILITIES.md`

## Last Updated

2026-04-12
