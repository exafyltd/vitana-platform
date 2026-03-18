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
| AP-0700 – AP-0799 | Payments & Subscriptions | [07-payments-subscriptions.md](./07-payments-subscriptions.md) |
| AP-0800 – AP-0899 | Personalization Engines | [08-personalization-engines.md](./08-personalization-engines.md) |
| AP-0900 – AP-0999 | Memory & Intelligence | [09-memory-intelligence.md](./09-memory-intelligence.md) |
| AP-1000 – AP-1099 | Platform Operations | [10-platform-operations.md](./10-platform-operations.md) |

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
| Health & Wellness | 6 | 3 | 0 | 3 | 0 |
| Payments & Subscriptions | 5 | 2 | 0 | 3 | 0 |
| Personalization Engines | 5 | 5 | 0 | 0 | 0 |
| Memory & Intelligence | 5 | 5 | 0 | 0 | 0 |
| Platform Operations | 5 | 3 | 0 | 2 | 0 |
| **TOTAL** | **72** | **54** | **0** | **18** | **0** |

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
