# Autopilot

> The Autopilot is Vitana's user-facing AI assistant product that proactively suggests and executes actions across Community, Discover, Wallet, Calendar, Health, and Memory -- controlled by operators via templates, governance flags, and per-user preferences.

## Content

### What It Does for Users

The Autopilot appears to end users as an intelligent assistant that:

- **Suggests daily actions** -- Personalized cards showing relevant things to do (connect with a match, attend an event, log health data, share content)
- **Executes on tap** -- Users can approve suggested actions with one tap; the system handles the API calls, data writes, and notifications
- **Delivers briefings** -- Morning briefing at 07:00 with matches, meetups, unread messages; weekly digest on Sundays; weekly reflection on Fridays
- **Sends nudges** -- Re-engagement for dormant users (7-day, 14-day, 30-day cascade then stop), conversation continuity prompts, milestone celebrations
- **Respects boundaries** -- Quiet hours suppression, per-user max actions per day, health capacity awareness that reduces social pressure when appropriate

### User-Facing Categories

| Category | Description |
|----------|-------------|
| `health` | Biomarker tracking, wellness check-ins, supplement reminders, AI health plans |
| `community` | Events, groups, connections, match introductions, icebreakers |
| `media` | Content posts, live streams, group discussions |
| `discover` | Product/service recommendations, marketplace suggestions |
| `calendar` | Event scheduling, reminders, appointment management |

### User Controls

Users configure Autopilot behavior through preferences:

- **Enable/disable** -- Global toggle per user (`enabled: true/false` in prompt prefs)
- **Quiet hours** -- Start/end times with category exceptions (e.g., health for medication reminders)
- **Max actions per day** -- Default 5, user-configurable
- **Category toggles** -- Enable/disable specific categories
- **Feedback** -- Rate actions as helpful/not helpful; skip or dismiss; block specific action types

### Operator Controls

Operators manage the Autopilot through:

- **Template Management UI** -- Create, edit, delete, test templates with sample data; view performance metrics; enable/disable templates globally
- **Governance Flags** -- `EXECUTION_DISARMED` halts all autonomous actions; `AUTOPILOT_LOOP_ENABLED` controls the heartbeat loop
- **Priority System** -- P0 (must-have for launch) through P3 (future); P0 safety/payment notifications bypass overload protection
- **VTID Lifecycle** -- The Autopilot Controller (VTID-01178) and Event Loop (VTID-01179) manage the full automation lifecycle
- **Analytics Dashboard** -- Execution success rates, user engagement rates, template performance, system health metrics

### Product Surface Areas

| Surface | Integration |
|---------|-------------|
| Autopilot Popup | UI card selection from suggested actions |
| VITANALAND Orb | Voice command triggers for natural language action execution |
| AI Chat | Conversational action suggestions based on context |
| Background Scheduler | Cron-based automated recurring actions (no user presence required) |
| Settings Panel | User preference configuration |
| Push Notifications | FCM push for time-sensitive actions |

### Scale

- **169 cataloged actions** across 9 modules (Community, Discover, Health, Sharing, Wallet, Business, AI, Memory, Admin/Settings)
- **108 automation definitions** across 12 domains with permanent AP-XXXX IDs
- **18 implemented**, 90 planned, 0 live in production
- **100+ execution handlers** in the handler registry

### Safety Model

The Autopilot enforces a layered safety model:

1. **Action levels** -- A1 (read) through A5 (multi-step); A4/A5 require explicit user confirmation
2. **PHI protection** -- All health data processed locally via Ollama; PHI redaction before external LLM
3. **Financial safety** -- Monetization readiness scoring before any paid suggestion; never stack multiple paid suggestions
4. **Emotional safety** -- Health capacity awareness gates social nudges; no monetization during vulnerability
5. **Notification hygiene** -- Overload detection, quiet hours, graduated re-engagement (stop after 30 days of silence)

## Related Pages

- [[autopilot-system]]
- [[autopilot-automations]]
- [[recommendation-engine]]
- [[cognee-integration]]
- [[crewai]]

## Sources

- `raw/autopilot/AUTOPILOT_ARCHITECTURE.md`
- `raw/autopilot/AUTOPILOT_CAPABILITIES.md`
- `raw/autopilot/AUTOPILOT_ACTION_CATALOG.md`
- `raw/autopilot/autopilot-automations/README.md`

## Last Updated

2026-04-12
