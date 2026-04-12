# The Vitana Index Scoring System

> A single score from 0 to 999 that captures overall vitality, serving as both a personal compass and the feedback loop driving Maxina's Autopilot personalization engine.

## What It Is

The Vitana Index is Maxina's core measurement of longevity trajectory. It synthesizes health pillar data, lifestyle patterns, social engagement, lab results, wearable data, and emotional state into one number. It is explicitly described as "not a grade or judgment" but as "a compass" -- showing whether the life being built today supports the future the user wants.

## How It Is Calculated

### Foundation: Five Pillar Sub-Scores

Each of the five health pillars produces an independent sub-score:

| Pillar | Data Sources |
|--------|-------------|
| Nutrition | Meal logs, conversational food mentions, dietary patterns |
| Hydration | Water intake logs, fluid timing patterns |
| Exercise | Wearable activity data, workout logs, movement consistency |
| Sleep | Wearable sleep stages, self-reported quality, HRV during rest |
| Mental Health | Mood check-ins, stress self-reports, social engagement, HRV |

Sub-scores are composites built from self-reports, wearable data, lab results, and observed behavioral patterns.

### Weighted Combination

The five pillar sub-scores combine into the overall Index, but the weights are dynamic:

- **Reliability weighting**: Pillars with more data carry more weight. High-confidence data (e.g., nightly sleep tracker) contributes more than sparse data.
- **Recency weighting**: Recent data matters more than old data. A recency curve gradually reduces the influence of older readings so the Index always reflects current trajectory.

### Additional Modifiers

Beyond the core pillars, several signals modify the Index:

- **Lab results and biomarkers** -- CRP, HbA1c, fasting glucose, lipid panels, Vitamin D, hormones. Carry significant weight due to clinical reliability.
- **Wearable consistency** -- Continuous data streams produce more accurate scores than sporadic tracking.
- **Lifestyle behavior patterns** -- Consistency is weighted heavily; steady moderate habits score higher than erratic extreme ones.
- **Environmental context** -- Air quality, seasonal patterns, altitude, temperature when available.
- **Emotional state indicators** -- Stress, purpose, social connection tracked via conversation, self-reports, HRV, community engagement.

### Trajectory Over Snapshots

A core design principle: the Index prioritizes direction of travel over any single reading. Rolling windows compare current two-week average against previous month, current month against previous quarter. A rising 550 tells a better story than a declining 700.

### Update Frequency

The Index recalculates continuously as new data arrives -- every wearable sync, every meal log, every conversation. Presentation emphasizes meaningful trends over moment-to-moment noise.

## The Four Zones

| Zone | Range | Meaning | ORB Focus |
|------|-------|---------|-----------|
| **Critical** | Below 100 | Multiple pillars severely compromised; long-term risk | Stabilization -- identify single most urgent area, one practical step. Encourage clinical consultation. |
| **Unstable** | 100-400 | Functioning but with significant gaps; inconsistency | Build foundational habits. Greatest leverage for dramatic improvement. |
| **Functional** | 400-700 | Solid foundation, actively managing health | Optimize and fine-tune. Pillar interaction analysis. Community engagement emphasis. |
| **High Vitality** | 700+ | Exceptional trajectory, sustained balanced effort | Maintenance, advanced optimization, mentorship opportunities. |

Zones are not permanent. Users move between them throughout life. The system celebrates upward crossings and flags downward crossings with compassion and a recovery plan.

## Data Sources

Three main categories feed the Index:

### 1. Wearable Devices
Supported: Apple Watch, Fitbit, Oura Ring, Garmin, and expanding. Data includes heart rate, HRV, sleep stages, steps, workouts, calories burned. Connected via standard health platform APIs (read-only access).

### 2. Lab Results and Biomarkers
Key markers: CRP, HbA1c, fasting glucose, lipid panel, Vitamin D, hormones, nutrient levels, organ function markers. Entered via upload, manual entry, or conversation. Tracked longitudinally for trend analysis.

### 3. Self-Reporting and ORB Conversations
Manual tracking (meals, hydration, mood, diary entries) plus information extracted from natural conversations. Confidence levels assigned: high (direct statements), moderate (inferences), lower (observed patterns).

### Missing Data Handling
The Index works with whatever data is available. Limited data produces lower-confidence estimates. Users are encouraged to add sources for accuracy but are never penalized unfairly for gaps.

## Relationship to Autopilot

The Vitana Index drives the [[home-dashboard|Autopilot system]]. When the Index shifts, Autopilot responds by adjusting guidance priorities. It identifies the pillar or dimension offering the greatest leverage for improvement and channels recommendations there. This creates a continuous feedback loop: data feeds Index, Index drives Autopilot, Autopilot drives personalized actions, actions generate new data.

## Related Pages

- [[longevity-philosophy]] -- The philosophy that the Index makes measurable
- [[health-tracking]] -- How day-to-day data feeds the Index
- [[home-dashboard]] -- Where the Index is displayed and drives daily priorities
- [[vitana-index-entity]] -- The Vitana Index as a product feature

## Sources

- `raw/knowledge-base/knowledge-base/en/01-foundation/04-vitana-index.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/01-how-the-index-works.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/02-improving-your-score.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/03-index-zones-explained.md`
- `raw/knowledge-base/knowledge-base/en/05-vitana-index/04-data-sources.md`
- `raw/knowledge-base/knowledge-base/en/01-foundation/05-how-autopilot-works.md`

## Last Updated

2026-04-12
