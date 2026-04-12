# Autopilot System

> The Autopilot is Vitana's AI-powered proactive action engine that integrates across all platform features (Community, Discover, Wallet, Calendar, Health, Memory) to suggest and execute personalized user actions at scale.

## Content

### Architecture Overview

The Autopilot system is built on four primary layers:

1. **AI Suggestion Engine** -- Uses Lovable AI (Gemini 2.5 Flash) plus context analysis and user preferences to generate personalized action suggestions. Gathers user context (profile, preferences, recent activity, wallet, calendar, health) and matches it against applicable templates.

2. **Action Registry System** -- A template-based system where each action template defines trigger conditions, context requirements, an execution handler, and integration points. Templates are organized by feature area: health, community, discover, wallet, calendar, memory.

3. **Execution Engine** -- Supabase Edge Functions (`autopilot-execute`) that invoke a handler registry of 100+ handlers. Each handler follows a validate-execute-reward-return pattern. Execution is logged in `autopilot_execution_logs` with duration, status, and result data.

4. **Scheduler** -- Cron-based triggers running hourly (`autopilot-suggest`) that generate new actions for active users. Supports scheduled, event-driven, and context-change triggers. Respects user quiet hours and per-user action limits (`max_prompts_per_day`, default 5).

### Database Schema

Core tables powering the system:

- **`autopilot_action_templates`** -- Reusable blueprints with `template_code`, category, title/reason templates, default priority, integration type, execution handler, trigger conditions, and required context (JSONB).
- **`autopilot_actions`** -- User-specific action instances with status lifecycle (`pending` -> `executing` -> `completed` / `skipped` / `failed`), execution data, scheduling, context snapshot, and analytics tracking.
- **`autopilot_execution_logs`** -- Audit trail for every execution attempt with status, error message, duration, and result data.
- **`autopilot_feedback`** -- User feedback loop (completed, skipped, dismissed, helpful, not_helpful) tied to templates for learning.
- **`autopilot_trigger_logs`** -- Debugging and optimization history for all trigger evaluations.

### Capability Levels (A1-A5)

The Autopilot classifies all 169 cataloged actions into five capability levels:

| Level | Type | Risk | Confirmation | Description |
|-------|------|------|--------------|-------------|
| A1 | Informational | Low | None | Read-only retrieval and summaries |
| A2 | Navigational | Low | None | UI navigation, no data mutation |
| A3 | Transactional (Low-Risk) | Medium | Optional | Safe data mutations, user's own data, reversible |
| A4 | Transactional (High-Risk) | High | Required | Payments, PHI, external APIs, money movement |
| A5 | Autonomous Multi-Step | High | Required at checkpoints | Multiple sequenced API calls across modules |

### Integration Points

The Autopilot connects to every major Vitana subsystem:

- **Community** -- Post creation, thread replies, welcome messages, connection requests
- **Wallet** -- Vitana currency transfers, exchange suggestions, credit rewards
- **Calendar** -- Event scheduling, invitations, reminders
- **Health** -- Supplement logging, streak tracking, health points, biomarker analysis
- **Discover** -- Product/service recommendations, cart operations
- **Memory** -- Diary capture, reflection prompts, anniversary reminders

### Frontend Integration

The React frontend uses a `useAutopilot()` hook providing:
- Real-time Supabase subscription to `autopilot_actions` table changes
- Query-based fetching of pending actions sorted by priority
- Mutation-based action execution via `supabase.functions.invoke('autopilot-execute')`

### Execution Modes

| Mode | Trigger | User Presence | Example |
|------|---------|---------------|---------|
| On-Demand | User action (click, voice) | Required | Ticket purchase, checkout |
| Background | Schedule or trigger event | Not required | Daily briefing, data refresh |
| Hybrid | Scheduled with notification | Optional | Weekly wellness plan |

### Development Roadmap

- **Phase 1 (Foundation)**: Database schema, basic execution engine, 10 core templates
- **Phase 2 (AI Integration)**: AI suggestion engine, context gathering, intelligent prioritization, feedback loop
- **Phase 3 (Scaling)**: Template management UI, 50+ templates, execution handler registry, analytics
- **Phase 4 (Intelligence)**: Behavioral learning, predictive timing, cross-feature optimization

## Related Pages

- [[autopilot-automations]]
- [[recommendation-engine]]
- [[autonomous-execution]]
- [[autopilot]]
- [[cognee-integration]]

## Sources

- `raw/autopilot/AUTOPILOT_ARCHITECTURE.md`
- `raw/autopilot/AUTOPILOT_CAPABILITIES.md`
- `raw/autopilot/AUTOPILOT_ACTION_CATALOG.md`

## Last Updated

2026-04-12
