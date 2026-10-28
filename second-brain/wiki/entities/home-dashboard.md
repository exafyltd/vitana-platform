# Home Dashboard

> The personalized daily command center that users see first when opening Vitanaland -- displaying their Vitana Index, daily priorities, and four tabs (Context, Actions, Matches, AI Feed) all driven by the Autopilot.

## Feature Overview

The Home Dashboard is the front page of the longevity journey. It is not a static screen of numbers but a living, daily-refreshed summary synthesized by the Autopilot from health data, goals, community activity, and behavioral patterns. Designed for clarity: even on the busiest days, users can absorb the essentials in seconds.

## Layout

### Top Section
- **[[vitana-index-entity|Vitana Index]]** -- Current score with explanation of recent movement (why it went up or dipped)
- **Daily Priorities** -- The handful of actions identified as most impactful for today

### Four Tabs

#### Context Tab
The "situational awareness" view:
- Vitana Index trend visualization
- Individual pillar status (five health pillars)
- Recent activity summary
- Community happenings relevant to the user

This is the "longevity snapshot at a glance."

#### Actions Tab
The "to-do list for vitality":
- Autopilot-generated action items
- Each item is specific, actionable, and explained ("Log your meals today -- I noticed you have not tracked nutrition in three days")
- Completing actions feeds data back to the Autopilot, updates pillar scores, and refines future recommendations
- Uncompleted actions are gently revisited if still relevant, or adjusted based on observed patterns

Example actions:
- Log your meals today
- Take a 20-minute walk
- Hydrate -- aim for eight glasses
- Check in on your mood
- Reach out to someone in your community
- Review your health plan tasks

#### Matches Tab
Curated connections from the [[matchmaking-system|matchmaking system]]:
- People, groups, events, services, products, locations, and live rooms matched to the user's profile
- Every match includes a "Why this match" explanation
- Driven by Vitana Index data, health goals, community activity, and preferences

#### AI Feed Tab
Personalized content stream:
- Articles, insights, and longevity tips
- Community highlights
- Content selected based on user identity, interests, and journey stage

## Daily Priorities (Deep Dive)

Daily Priorities are the heart of the Home Dashboard. The Autopilot generates them each morning through a multi-step process:

1. **Assess pillar state** -- Which pillars are declining, stable, or improving
2. **Analyze recent behavior** -- Logging consistency, activity trends, social engagement over days/weeks
3. **Factor in goals** -- Align with user-stated objectives (cardiovascular health, stress management, etc.)
4. **Consider context** -- Day of week, upcoming events, seasonal factors

Priorities are:
- Simple, clear, actionable (phrased as doable tasks, not abstract goals)
- Accompanied by a "why" explanation
- Connected to Vitana Index improvement
- Respectful of off days ("I am not here to judge you")

Completing priorities creates a feedback loop: data feeds Autopilot, Autopilot updates patterns, Index adjusts, future priorities refine.

## Autopilot Integration

The Autopilot drives everything on the Home Dashboard:
- When sleep patterns shift, the dashboard responds with sleep-focused priorities
- When fitness milestones are hit, the dashboard celebrates
- When social activity declines, gentle nudges toward connection appear
- Content, matches, and actions all adapt continuously

## Growth Over Time

The Dashboard evolves with the user:
- **Week 1** -- Relatively simple; broad priorities, introductory matches, general content
- **Months later** -- Deeply personalized; sharp priorities targeting specific challenges, refined matches, resonant content
- **After 6 months** -- Unique to each user; reflects their specific health profile, relationships, goals, and life

## Health Dashboard (Companion)

Distinct from the Home Dashboard, the Health Dashboard is a dedicated health tracking view (part of the Health Tracking feature) that shows:
- Vitana Index with pillar sub-scores and trend arrows
- Quick-action buttons (Log Meal, Record Water, Add Exercise, Rate Sleep, Check Mood)
- Widgets: Daily Progress, Active Goals, Recent Trends, Autopilot Insights
- Customizable widget layout

The Home Dashboard provides the daily overview; the Health Dashboard provides the detailed health tracking interface.

## Status

- **Tenant**: all (available across all tenants)
- **Status**: live

## Related Pages

- [[vitana-index-entity]] -- The score displayed at the top of the dashboard
- [[vitana-index]] -- How the scoring system works
- [[matchmaking-system]] -- Matches surfaced in the Matches tab
- [[health-tracking]] -- Data feeding the Context and Actions tabs
- [[discover-marketplace]] -- Products/services that may appear in Matches tab
- [[maxina]] -- The Autopilot intelligence behind every dashboard element
- [[memory-garden-entity]] -- Personal knowledge powering dashboard personalization

## Sources

- `raw/knowledge-base/knowledge-base/en/11-home-dashboard/01-home-overview.md`
- `raw/knowledge-base/knowledge-base/en/11-home-dashboard/02-daily-priorities.md`
- `raw/knowledge-base/knowledge-base/en/11-home-dashboard/03-context-tab.md`
- `raw/knowledge-base/knowledge-base/en/11-home-dashboard/04-actions-tab.md`
- `raw/knowledge-base/knowledge-base/en/11-home-dashboard/05-matches-tab.md`
- `raw/knowledge-base/knowledge-base/en/11-home-dashboard/06-ai-feed-tab.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/01-health-dashboard.md`

## Last Updated

2026-04-12
