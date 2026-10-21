# Health Tracking System

> A comprehensive multi-pillar health tracking system spanning nutrition, hydration, exercise, sleep, mental wellness, biomarkers, and wearable device integration -- all feeding into the Vitana Index.

## Overview

Health tracking in Vitanaland is organized around the five health pillars (Nutrition, Hydration, Exercise, Sleep, Mental Wellness) and extended by biomarker/lab tracking, wearable device integration, health services, health plans, and conditions/risk monitoring. The Health Dashboard serves as the central hub, displaying the Vitana Index, individual pillar sub-scores, trend arrows, quick-action logging buttons, and Autopilot insights.

## The Health Dashboard

The Health Dashboard is the single screen that brings together all health data:

- **Vitana Index** at the top with pillar sub-scores below
- **Trend arrows** showing up/steady/dipping compared to recent days
- **Quick-action buttons** for one-tap logging: Log a Meal, Record Water, Add Exercise, Rate Your Sleep, Check In on Mood
- **Widgets**: Daily Progress, Active Goals, Recent Trends, Autopilot Insights
- **Customizable layout** -- users rearrange widgets and quick actions to match their priorities

## Tracking by Pillar

### Nutrition
Two logging modes:
- **Quick Logging** -- Tap, select meal category (Breakfast/Lunch/Dinner/Snack), describe in a few words
- **Detailed Entry** -- Specific foods, approximate portions, post-meal feelings

Also accepts natural language via ORB conversation ("I had eggs and toast for breakfast").

Key focus areas (not calorie counting):
- Protein intake for muscle preservation (countering anabolic resistance)
- Inflammation-reducing foods (leafy greens, fatty fish, berries, nuts, olive oil)
- Micronutrient balance (vitamins, minerals, trace elements)
- Meal timing and consistency (circadian rhythm alignment)

### Hydration
- One-tap water logging with adjustable amounts
- Tracks electrolyte balance, mineral intake, fluid timing
- Highlights afternoon dips and inconsistent patterns
- Connected to cognitive function, joint health, kidney performance

### Exercise
- Log workouts, walks, yoga, any physical activity
- Quick presets for common activities
- Wearable auto-detection of workouts (duration, intensity, heart rate zones, calories)
- Tracks resistance training, cardiovascular fitness, mobility, functional capacity
- VO2 max as a key longevity predictor

### Sleep
- Manual: quality rating + bedtime/wake time each morning
- Wearable: automatic sleep stage tracking (deep, light, REM)
- Monitors circadian rhythm, deep sleep cycles, HRV, recovery patterns
- Sleep described as "the pillar that multiplies the benefits of every other pillar"

### Mental Wellness
- Quick emotional check-ins (mood/stress rating)
- Diary entries in [[memory-garden|Memory Garden]]
- Tracks emotional regulation, stress awareness, cognitive clarity, meaningful engagement
- Connected to HRV trends, community engagement patterns, self-reported state

## Biomarkers and Lab Results

Lab data provides the "beneath the surface" layer that daily tracking cannot capture. Three entry methods:
1. **Upload** -- PDF from doctor or testing service
2. **Manual entry** -- Individual marker values
3. **Conversation** -- Tell the ORB values directly

### Key Biomarkers Tracked

| Marker | Category | Significance |
|--------|----------|-------------|
| CRP | Inflammation | Chronic inflammaging driver |
| HbA1c | Metabolic | 2-3 month blood sugar average |
| Fasting Glucose | Metabolic | Insulin sensitivity snapshot |
| Lipid Panel | Cardiovascular | Triglyceride-to-HDL ratio especially informative |
| Vitamin D | Nutrient | Immune, bone, mood -- deficiency very common |
| Hormones | Hormonal | Testosterone, estrogen, thyroid, cortisol, insulin |
| Ferritin, B12, Folate | Nutrient | Energy, cognition, immunity |
| Liver/Kidney markers | Organ function | Early detection of system issues |

Biomarkers are interpreted in context (age, sex, history, other markers, trends) rather than just reference range comparison. Longitudinal tracking shows trends across multiple panels. The Autopilot may suggest specific tests based on detected gaps.

## Wearable Device Integration

### Supported Devices
- **Apple Watch** -- via Apple Health (heart rate, HRV, sleep stages, workouts, blood oxygen, respiratory rate)
- **Fitbit** -- sleep tracking, heart rate, activity, stress scores
- **Oura Ring** -- sleep/recovery specialist (sleep staging, HRV, body temperature, readiness)
- **Garmin** -- workout metrics, GPS, VO2 max estimates, training load

### Data Types Synced
Heart rate, resting heart rate, HRV, sleep stages, steps, active minutes, workouts, calories burned.

### Connection
Profile settings > Connections/Devices > authorize via device's official health platform. Read-only access. Historical data backfills, new data syncs automatically.

### Why Consistency Matters
Continuous wear produces true pattern data and higher-confidence Index calculations. Sporadic data reduces trend visibility and Index accuracy.

## Additional Health Features

- **Health Services Hub** -- Browse and book health professionals within the platform
- **Health Plans** -- Personalized, structured plans with tasks and milestones
- **Conditions and Risks** -- Track known conditions and monitor risk factors

## How It All Connects

All health tracking data flows into the [[vitana-index|Vitana Index]] through pillar sub-scores and modifier signals. The [[home-dashboard|Home Dashboard]] surfaces daily priorities based on pillar status. The Autopilot uses health data to personalize recommendations across all of Vitanaland -- including [[matchmaking-system|matchmaking]], [[discover-marketplace|Discover]] product suggestions, and community program recommendations.

## Related Pages

- [[vitana-index]] -- How health data becomes a single vitality score
- [[longevity-philosophy]] -- The five pillars and seven dimensions framework
- [[home-dashboard]] -- Where health data drives daily priorities
- [[discover-marketplace]] -- Products and services matched to pillar gaps
- [[memory-garden]] -- Health and wellness as one of thirteen memory categories

## Sources

- `raw/knowledge-base/knowledge-base/en/12-health-tracking/01-health-dashboard.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/02-tracking-nutrition.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/03-tracking-hydration.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/04-tracking-exercise.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/05-tracking-sleep.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/06-tracking-mental-wellness.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/07-biomarkers-and-labs.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/08-wearable-devices.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/09-health-services-hub.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/10-health-plans.md`
- `raw/knowledge-base/knowledge-base/en/12-health-tracking/11-conditions-and-risks.md`
- `raw/knowledge-base/knowledge-base/en/01-foundation/03-five-health-pillars.md`

## Last Updated

2026-04-12
