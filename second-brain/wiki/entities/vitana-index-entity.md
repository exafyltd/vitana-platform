# Vitana Index (Product Feature)

> The 0-999 vitality scoring system at the heart of Vitanaland -- a continuously updating composite measure that drives Autopilot personalization, daily priorities, matchmaking, and marketplace recommendations.

## Feature Overview

The Vitana Index is a single number (0-999) displayed prominently on both the [[home-dashboard|Home Dashboard]] and the Health Dashboard. It synthesizes data from five health pillar sub-scores, biomarkers, wearable devices, lifestyle patterns, environmental factors, and emotional state into one reading of overall vitality. It updates continuously as new data arrives.

## Product Components

### Score Display
- **Primary score** -- 0-999 number at top of dashboard
- **Pillar sub-scores** -- Individual scores for Nutrition, Hydration, Exercise, Sleep, Mental Health
- **Trend arrows** -- Up/steady/dipping indicators compared to recent days
- **Zone indicator** -- Which of four zones the user occupies

### Four Zones

| Zone | Range | Dashboard Behavior |
|------|-------|--------------------|
| Critical | 0-99 | Stabilization mode: single most urgent action, clinical consultation encouragement |
| Unstable | 100-399 | Foundation building: targeted habit introduction, greatest-leverage recommendations |
| Functional | 400-699 | Optimization: fine-tuning, pillar interaction analysis, community engagement push |
| High Vitality | 700-999 | Maintenance, advanced optimization, mentorship opportunity surfacing |

### Score Explanation
When users ask about their Index, the ORB provides:
- Which pillars are driving the score up/down
- What changed recently and why
- The single most impactful action to take right now
- Trajectory context (not just current value but direction of travel)

### Data Integration Points

| Source | Data Type | Weight |
|--------|-----------|--------|
| Health pillar tracking | Daily nutrition, hydration, exercise, sleep, mood logs | Core (highest weight) |
| Wearable devices | HR, HRV, sleep stages, steps, workouts | Significant (continuous, passive) |
| Lab results | CRP, HbA1c, glucose, lipids, vitamins, hormones | Significant (clinical reliability) |
| Behavioral patterns | Consistency, regularity, habit stability | Heavy weighting |
| Environmental data | Air quality, seasonal patterns, location factors | Modifier |
| Emotional state | Stress, purpose, social engagement | Modifier |
| Community engagement | Participation frequency, depth, reciprocity | Contributes to social component |

### Calculation Mechanics
- Dynamic weighting by reliability (more data = more weight)
- Recency curve (recent data weighs more than old data)
- Trajectory calculated via rolling window comparisons (2-week vs. month, month vs. quarter)
- Continuous recalculation on every new data input
- Missing data handled by reduced confidence, not penalty

## How It Drives Other Features

- **Autopilot** -- Index shifts trigger guidance priority changes
- **Daily Priorities** -- Pillar status determines which actions surface on [[home-dashboard|Home Dashboard]]
- **Matchmaking** -- Pillar strengths and gaps inform [[matchmaking-system|match suggestions]]
- **Discover** -- Weakest pillars drive [[discover-marketplace|product/service recommendations]]
- **Longevity Economy** -- Health milestones (Index level achievements) earn [[financial-longevity|credits]]
- **Onboarding** -- Baseline Index established during longevity onboarding protocol

## Status

- **Tenant**: maxina (Maxina experience, though Index infrastructure likely shared)
- **Status**: live

## Related Pages

- [[vitana-index]] -- Conceptual deep-dive on the scoring system
- [[health-tracking]] -- Data collection that feeds the Index
- [[home-dashboard]] -- Where the Index is displayed and drives priorities
- [[maxina]] -- The Autopilot system the Index powers
- [[memory-garden-entity]] -- Health data storage underlying the Index

## Sources

- `raw/knowledge-base/knowledge-base/en/01-foundation/04-vitana-index.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/01-how-the-index-works.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/02-improving-your-score.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/03-index-zones-explained.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/04-data-sources.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/01-health-dashboard.md`

## Last Updated

2026-04-12
