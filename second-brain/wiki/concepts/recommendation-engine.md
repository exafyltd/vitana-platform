# Recommendation Engine

> The Autopilot recommendation engine is the AI-powered suggestion pipeline that analyzes community users across multiple dimensions, generates personalized action suggestions from templates, and schedules their delivery respecting user preferences and quiet hours.

## Content

### Community User Analyzer

The recommendation engine works by analyzing each user's full context to determine which action templates are relevant. The analysis gathers:

- **Profile data** -- User demographics, preferences, onboarding status
- **Recent activity** -- Last 10 diary entries, app usage patterns, interaction history
- **Wallet state** -- Balances, transaction patterns, subscription status
- **Calendar** -- Upcoming events, scheduling patterns
- **Health data** -- Vitana Index scores, biomarker results, wearable trends
- **Social graph** -- Connection count, relationship edges, group memberships
- **Topic profile** -- Interest scores from `user_topic_profile`

### Template System

Action templates are reusable blueprints stored in `autopilot_action_templates`. Each template defines:

- **`template_code`** -- Unique identifier (e.g., `community_weekly_post`)
- **`category`** -- Feature area (health, community, discover, wallet, calendar, memory)
- **`title_template`** / **`reason_template`** -- Parameterized strings (e.g., "Share your {activity} progress this week")
- **`trigger_conditions`** -- When to fire (scheduled via cron, event-based, or context-change)
- **`required_context`** -- What data must be available (activity_type, metric_value, user_community_ids, etc.)
- **`execution_handler`** -- Function name in the handler registry
- **`integration_type`** -- Which Vitana subsystem (community_posts, wallet_transfers, etc.)
- **`metadata`** -- Icon, estimated time, reward amount

Templates are organized in directories by feature area:
```
/templates
  /health     -- daily_health_check, supplement_reminder, wellness_milestone
  /community  -- weekly_post, reply_to_thread, welcome_new_member
  /discover   -- content_recommendation, learning_goal, explore_topic
  /wallet     -- send_currency, celebrate_earnings, exchange_reminder
  /calendar   -- schedule_event, event_reminder, reschedule_suggestion
  /memory     -- capture_moment, reflect_on_entry, anniversary_reminder
```

### AI Suggestion Pipeline

The suggestion flow runs on each trigger cycle:

1. **Gather context** -- Parallel fetch of profile, preferences, activity, wallet, calendar, health
2. **Filter templates** -- Match applicable templates against user context and trigger conditions
3. **AI personalization** -- Send templates + context to Gemini 2.5 Flash via Lovable AI gateway. The AI selects the most relevant templates, personalizes titles/reasons, sets priorities, and provides specific execution data.
4. **Create instances** -- Instantiate `autopilot_actions` records for the user with personalized content
5. **Respect limits** -- Honor `max_prompts_per_day` (default 5) and quiet hours

### Action Catalog Scale

The full Autopilot action catalog contains **169 actions** across 9 modules:

| Module | Actions | Levels |
|--------|---------|--------|
| Community | 30 | A1-A5 |
| Discover | 23 | A1-A5 |
| Health | 30 | A1-A5 |
| Sharing | 22 | A1-A5 |
| Wallet | 20 | A1-A5 |
| Business | 24 | A1-A5 |
| AI | 17 | A1-A5 |
| Memory | 14 | A1-A5 |
| Admin | 20 | A1-A5 |
| Settings | 15 | A1-A4 |

### Scheduling

- **Hourly cron** -- `autopilot-suggest` edge function runs every hour to generate new actions
- **Heartbeat loop** -- Some automations (payment retry, meetup reminders) run on 15-minute heartbeat intervals
- **Daily delivery** -- Primary match delivery at 08:00 local time; morning briefing at 07:00; diary reminder at 21:00; weekly reflection Friday 20:00
- **Weekly batches** -- Community digest Sunday 18:00; earnings reports Monday 10:00; group recommendations Monday 10:00

### Personalization Layers

The engine leverages multiple D-engines (D28-D51) for deeper personalization:

- **D35 Social Context Engine** -- Filters suggestions through user comfort preferences (group size, involves new people, visibility, timing)
- **D39 Taste & Lifestyle Alignment** -- Scores events/products by taste bundle alignment (> 60% threshold)
- **D48 Opportunity Surfacing** -- Prioritizes by category: Health > Social Belonging > Personal Growth > Exploration > Commerce
- **D51 Overload Detection** -- Throttles notifications when user shows fatigue; only P0 bypasses
- **D36 Financial Monetization** -- Gates paid suggestions by readiness score, value perception, emotional state, budget signals

### Feedback Loop

User feedback on actions (completed, skipped, dismissed, helpful, not_helpful) is stored in `autopilot_feedback` and linked to templates. This data feeds back into:
- Template performance metrics
- AI suggestion tuning
- Per-user preference learning
- Success rate optimization

### Match Quality Learning (AP-0108)

Specific to person matching, the feedback loop applies score deltas:
- Like: +8
- Dislike: -6, dampen for 7 days
- Block: -10, block for 90 days
- Wrong topic: shift topic profile scores

Changes are written to `personalization_change_log` for transparency ("Why improved?").

## Related Pages

- [[autopilot-system]]
- [[autopilot-automations]]
- [[autopilot]]
- [[cognee-integration]]

## Sources

- `raw/autopilot/AUTOPILOT_ARCHITECTURE.md`
- `raw/autopilot/AUTOPILOT_CAPABILITIES.md`
- `raw/autopilot/AUTOPILOT_ACTION_CATALOG.md`
- `raw/autopilot/autopilot-automations/01-connect-people.md`
- `raw/autopilot/autopilot-automations/08-personalization-engines.md`

## Last Updated

2026-04-12
